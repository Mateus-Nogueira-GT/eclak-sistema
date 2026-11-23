"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { dataEmCuiaba } from "@/domain/clientes";
import { dataBr, tarefaSchema, tarefasDaVenda, type TarefaEntrada } from "@/domain/tarefas";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { tarefas, usuarios, viagens } from "@/server/db/schema";
import { colunasDoPrazo, criarTarefasAutomaticas } from "@/server/operacao/tarefas-automaticas";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
// Qualquer usuário ativo (os cinco perfis). Toda escrita lê a tarefa `for update` e audita na mesma transação.

type Falha = { ok: false; erro: string; campos?: Record<string, string>; conflito?: true };

const VIAGEM_NAO_ENCONTRADA: Falha = { ok: false, erro: "Viagem não encontrada" };
const NAO_VENDIDA: Falha = { ok: false, erro: "A viagem ainda não foi vendida" };
const NAO_ENCONTRADA: Falha = { ok: false, erro: "Tarefa não encontrada" };
const NAO_CONCLUIDA: Falha = { ok: false, erro: "A tarefa não está concluída" };
const MSG_RESPONSAVEL = "Escolha um responsável ativo";
const RESPONSAVEL_INATIVO: Falha = { ok: false, erro: MSG_RESPONSAVEL, campos: { responsavel: MSG_RESPONSAVEL } };
const CONCORRENCIA: Falha = {
  ok: false,
  erro: "Esta tarefa foi alterada por outra pessoa. Recarregue a página.",
  conflito: true,
};

type TarefaLinhaDb = typeof tarefas.$inferSelect;

const ehFalha = (x: unknown): x is Falha => typeof x === "object" && x !== null && "ok" in x;

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

const semId = (t: TarefaLinhaDb) => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "id"));

function revalidar(viagemId: string) {
  revalidatePath("/tarefas");
  revalidatePath(`/viagens/${viagemId}/tarefas`);
}

/** Viagem não excluída e vendida (sem lock: a venda não se desfaz). */
async function viagemVendida(tx: Transacao, viagemId: string) {
  const [v] = await tx
    .select({ id: viagens.id, status: viagens.status, consultorId: viagens.consultorId, inicio: viagens.inicio, vendidaEm: viagens.vendidaEm })
    .from(viagens)
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
  if (!v) return VIAGEM_NAO_ENCONTRADA;
  if (v.status !== "vendida") return NAO_VENDIDA;
  return v;
}

/** Tarefa não excluída, travada, de viagem vendida. */
async function travarTarefa(tx: Transacao, id: string): Promise<TarefaLinhaDb | Falha> {
  const [t] = await tx
    .select()
    .from(tarefas)
    .where(and(eq(tarefas.id, id), isNull(tarefas.excluidoEm)))
    .for("update");
  if (!t) return NAO_ENCONTRADA;
  const v = await viagemVendida(tx, t.viagemId);
  if (ehFalha(v)) return v;
  return t;
}

/** Colunas gravadas a partir da entrada validada; o responsável usuário tem de estar ativo. */
async function colunasDaEntrada(tx: Transacao, e: ReturnType<typeof tarefaSchema.parse>) {
  if (e.responsavel?.tipo === "usuario") {
    const [u] = await tx
      .select({ id: usuarios.id })
      .from(usuarios)
      .where(and(eq(usuarios.id, e.responsavel.id), eq(usuarios.ativo, true)));
    if (!u) return RESPONSAVEL_INATIVO;
  }
  return {
    categoria: e.categoria,
    dia: e.dia,
    item: e.item,
    fazer: e.fazer,
    ...colunasDoPrazo(e.prazo),
    responsavelId: e.responsavel?.tipo === "usuario" ? e.responsavel.id : null,
    customerCare: e.responsavel?.tipo === "customer_care",
    observacao: e.observacao,
  };
}

/** Nova tarefa manual na viagem vendida, depois da última. */
export async function criarTarefa(viagemId: string, dados: TarefaEntrada): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    const p = tarefaSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);

    let r: { id: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const v = await viagemVendida(tx, viagemId);
        if (ehFalha(v)) return v;
        const campos = await colunasDaEntrada(tx, p.data);
        if (ehFalha(campos)) return campos;
        const [max] = await tx
          .select({ n: sql<number>`coalesce(max(${tarefas.ordem}), 0)::int` })
          .from(tarefas)
          .where(eq(tarefas.viagemId, viagemId));
        const agora = new Date();
        const [t] = await tx
          .insert(tarefas)
          .values({ viagemId, ...campos, ordem: max.n + 1, origem: "manual", criadoPor: usuario.id, criadoEm: agora, atualizadoEm: agora })
          .returning();
        await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "tarefas", registroId: t.id, acao: "criar", depois: semId(t) });
        return { id: t.id };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao criar a tarefa", x);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    return { ok: true, id: r.id };
  });
}

/** Edita a tarefa (também as automáticas) se ninguém a alterou desde `atualizadoEmEsperado` (ISO). */
export async function editarTarefa(
  id: string,
  dados: TarefaEntrada,
  atualizadoEmEsperado: string,
): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(id)) return NAO_ENCONTRADA;
    const p = tarefaSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);

    let r: { viagemId: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarTarefa(tx, id);
        if (ehFalha(t)) return t;
        if (!atualizadoEmEsperado || new Date(atualizadoEmEsperado).getTime() !== t.atualizadoEm.getTime()) return CONCORRENCIA;
        const campos = await colunasDaEntrada(tx, p.data);
        if (ehFalha(campos)) return campos;
        const [depois] = await tx
          .update(tarefas)
          .set({ ...campos, atualizadoEm: new Date() })
          .where(eq(tarefas.id, id))
          .returning();
        await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "tarefas", registroId: id, acao: "alterar", antes: semId(t), depois: semId(depois) });
        return { viagemId: t.viagemId };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao salvar a tarefa", x);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, id };
  });
}

/** Mudança de estado (concluir, desfazer, excluir): trava, confere, grava e audita só os campos mudados. */
async function mudar(
  id: string,
  mensagem: string,
  fn: (tx: Transacao, t: TarefaLinhaDb, usuarioId: string) => Promise<Partial<TarefaLinhaDb> | Falha>,
  acao: "alterar" | "excluir" = "alterar",
): Promise<{ ok: true } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(id)) return NAO_ENCONTRADA;
    let r: { viagemId: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarTarefa(tx, id);
        if (ehFalha(t)) return t;
        const depois = await fn(tx, t, usuario.id);
        if (ehFalha(depois)) return depois;
        await tx.update(tarefas).set(depois).where(eq(tarefas.id, id));
        const antes =
          acao === "excluir"
            ? semId(t)
            : Object.fromEntries(Object.keys(depois).map((k) => [k, t[k as keyof TarefaLinhaDb]]));
        await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "tarefas", registroId: id, acao, antes, depois });
        return { viagemId: t.viagemId };
      });
    } catch (x) {
      throw erroDeBanco(mensagem, x);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true };
  });
}

/** Marca como concluída por quem chama, agora. Já concluída → "Tarefa já concluída por <nome> em dd/mm/aaaa". */
export async function concluirTarefa(id: string): Promise<{ ok: true } | Falha> {
  return mudar(id, "Erro ao concluir a tarefa", async (tx, t, usuarioId) => {
    if (t.concluidaEm) {
      const [quem] = t.concluidaPor
        ? await tx.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, t.concluidaPor))
        : [];
      return { ok: false, erro: `Tarefa já concluída por ${quem?.nome ?? "outra pessoa"} em ${dataBr(dataEmCuiaba(t.concluidaEm))}` };
    }
    // Sem mexer em `atualizado_em`: a edição não grava a conclusão, então um formulário aberto não entra em conflito.
    return { concluidaEm: new Date(), concluidaPor: usuarioId };
  });
}

/** Volta a tarefa para aberta (limpa quem e quando concluiu). */
export async function desfazerConclusao(id: string): Promise<{ ok: true } | Falha> {
  return mudar(id, "Erro ao desfazer a conclusão", async (_tx, t) => {
    if (!t.concluidaEm) return NAO_CONCLUIDA;
    return { concluidaEm: null, concluidaPor: null };
  });
}

/** Exclusão lógica; vale para as automáticas, que não voltam. */
export async function excluirTarefa(id: string): Promise<{ ok: true } | Falha> {
  return mudar(
    id,
    "Erro ao excluir a tarefa",
    async () => {
      const agora = new Date();
      return { excluidoEm: agora, atualizadoEm: agora };
    },
    "excluir",
  );
}

/**
 * Cria as 5 tarefas da venda numa viagem vendida antes da 5a (idempotente: as que já existem, mesmo excluídas, não
 * se repetem). O "dia da venda" é `vendida_em` em Cuiabá: as tarefas podem nascer vencidas, mostrando o atraso real.
 */
export async function criarTarefasDaVenda(viagemId: string): Promise<{ ok: true; criadas: number } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    let r: number | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const v = await viagemVendida(tx, viagemId);
        if (ehFalha(v)) return v;
        const dia = dataEmCuiaba(v.vendidaEm ?? new Date());
        return criarTarefasAutomaticas(tx, usuario.id, v, tarefasDaVenda(dia, v.inicio), "venda");
      });
    } catch (x) {
      throw erroDeBanco("Erro ao criar as tarefas da venda", x);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    return { ok: true, criadas: r };
  });
}
