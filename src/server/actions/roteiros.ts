"use server";

import { and, asc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z, type ZodError } from "zod";
import {
  conteudoRoteiroSchema,
  fusoValido,
  hoteisEVoosDosItens,
  IDIOMAS,
  roteiroInicial,
  type ConteudoRoteiro,
  type Idioma,
} from "@/domain/roteiro";
import { tarefasDoRoteiro } from "@/domain/tarefas";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { itensViagem, roteiros, viagens } from "@/server/db/schema";
import { agendarEnvios, enfileirarChecklistDoRoteiro } from "@/server/integracoes/eventos";
import { criarTarefasAutomaticas } from "@/server/operacao/tarefas-automaticas";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
// Qualquer usuário ativo (os cinco perfis). Toda escrita lê o roteiro `for update` e audita na mesma transação.
// Só `salvarRoteiro` e `trazerHoteisEVoos` mudam `atualizado_em` (D32): as ações de status gravam só as próprias colunas,
// então um editor aberto não entra em conflito por causa de uma aprovação.

type Falha = { ok: false; erro: string; campos?: Record<string, string>; conflito?: true };

const VIAGEM_NAO_ENCONTRADA: Falha = { ok: false, erro: "Viagem não encontrada" };
const NAO_VENDIDA: Falha = { ok: false, erro: "A viagem ainda não foi vendida" };
const NAO_ENCONTRADO: Falha = { ok: false, erro: "Roteiro não encontrado" };
const JA_TEM: Falha = { ok: false, erro: "Esta viagem já tem roteiro" };
const JA_APROVADO: Falha = { ok: false, erro: "Roteiro já aprovado pelo cliente" };
const JA_ENVIADO: Falha = { ok: false, erro: "Roteiro já marcado como enviado ao cliente" };
const NAO_APROVADO: Falha = { ok: false, erro: "O roteiro não está aprovado" };
const CONCORRENCIA: Falha = {
  ok: false,
  erro: "Este roteiro foi alterado por outra pessoa. Recarregue a página.",
  conflito: true,
};

type RoteiroDb = typeof roteiros.$inferSelect;

const ehFalha = (x: unknown): x is Falha => typeof x === "object" && x !== null && "ok" in x;

const codigoDe = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.cause?.code ?? x?.code;
};

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  console.error(mensagem, { code: codigoDe(e) });
  return new Error(mensagem);
}

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

const semId = (r: RoteiroDb) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id"));

const cabecalhoSchema = z.object({
  idioma: z.enum(IDIOMAS, "Escolha o idioma"),
  fuso: z.string().refine(fusoValido, "Fuso inválido"),
});

const documentoSchema = cabecalhoSchema.extend({
  abertura: z.string().max(4000, "Texto muito longo"),
});

function revalidar(viagemId: string, tarefasTambem = false) {
  revalidatePath("/roteiros");
  revalidatePath(`/viagens/${viagemId}/roteiro`);
  if (tarefasTambem) {
    revalidatePath("/tarefas");
    revalidatePath(`/viagens/${viagemId}/tarefas`);
  }
}

/** Viagem não excluída e vendida (sem lock: a venda não se desfaz). */
async function viagemVendida(tx: Transacao, viagemId: string) {
  const [v] = await tx
    .select({ id: viagens.id, status: viagens.status, consultorId: viagens.consultorId, inicio: viagens.inicio, fim: viagens.fim })
    .from(viagens)
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
  if (!v) return VIAGEM_NAO_ENCONTRADA;
  if (v.status !== "vendida") return NAO_VENDIDA;
  return v;
}

/** Itens não excluídos da viagem, só as colunas não financeiras usadas no pré-preenchimento. */
function itensDaViagem(tx: Transacao, viagemId: string) {
  return tx
    .select({ tipo: itensViagem.tipo, cidade: itensViagem.cidade, servico: itensViagem.servico, checkin: itensViagem.checkin, checkout: itensViagem.checkout })
    .from(itensViagem)
    .where(and(eq(itensViagem.viagemId, viagemId), isNull(itensViagem.excluidoEm)))
    .orderBy(asc(itensViagem.ordem));
}

/** Primeira leitura do roteiro na transação: travada; e a viagem dele, vendida. */
async function travarRoteiro(tx: Transacao, id: string) {
  const [r] = await tx.select().from(roteiros).where(eq(roteiros.id, id)).for("update");
  if (!r) return NAO_ENCONTRADO;
  const v = await viagemVendida(tx, r.viagemId);
  if (ehFalha(v)) return v;
  return { r, v };
}

const conferirVersao = (r: RoteiroDb, esperado: string) =>
  !!esperado && new Date(esperado).getTime() === r.atualizadoEm.getTime();

/** Cria o roteiro da viagem vendida: um dia por data, hotéis e voos dos itens não excluídos. */
export async function criarRoteiro(viagemId: string, dados: { idioma: Idioma; fuso: string }): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    const p = cabecalhoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);

    let r: { id: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const v = await viagemVendida(tx, viagemId);
        if (ehFalha(v)) return v;
        const conteudo = roteiroInicial({ inicio: v.inicio, fim: v.fim, itens: await itensDaViagem(tx, viagemId) });
        const agora = new Date();
        const [novo] = await tx
          .insert(roteiros)
          .values({ viagemId, status: "rascunho", idioma: p.data.idioma, fuso: p.data.fuso, abertura: "", conteudo, criadoPor: usuario.id, criadoEm: agora, atualizadoEm: agora })
          .returning();
        await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "roteiros", registroId: novo.id, acao: "criar", depois: semId(novo) });
        return { id: novo.id };
      });
    } catch (x) {
      if (codigoDe(x) === "23505") return JA_TEM;
      throw erroDeBanco("Erro ao criar o roteiro", x);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    return { ok: true, id: r.id };
  });
}

/** Grava o documento inteiro se ninguém o alterou desde `atualizadoEmEsperado` (ISO). Não muda o status. */
export async function salvarRoteiro(
  roteiroId: string,
  dados: { idioma: Idioma; fuso: string; abertura: string; conteudo: ConteudoRoteiro },
  atualizadoEmEsperado: string,
): Promise<{ ok: true; atualizadoEm: string } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(roteiroId)) return NAO_ENCONTRADO;
    const p = documentoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);

    let r: { viagemId: string; atualizadoEm: Date } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarRoteiro(tx, roteiroId);
        if (ehFalha(t)) return t;
        if (!conferirVersao(t.r, atualizadoEmEsperado)) return CONCORRENCIA;
        const c = conteudoRoteiroSchema(t.v.inicio, t.v.fim).safeParse(dados.conteudo);
        if (!c.success) return falhaDeValidacao(c.error);
        const [depois] = await tx
          .update(roteiros)
          .set({ idioma: p.data.idioma, fuso: p.data.fuso, abertura: p.data.abertura, conteudo: c.data, atualizadoEm: new Date() })
          .where(eq(roteiros.id, roteiroId))
          .returning();
        await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "roteiros", registroId: roteiroId, acao: "alterar", antes: semId(t.r), depois: semId(depois) });
        return { viagemId: t.r.viagemId, atualizadoEm: depois.atualizadoEm };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao salvar o roteiro", x);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, atualizadoEm: r.atualizadoEm.toISOString() };
  });
}

/** Substitui `hoteis` e `voos` pelos itens não excluídos da viagem (o resto do documento fica). */
export async function trazerHoteisEVoos(roteiroId: string, atualizadoEmEsperado: string): Promise<{ ok: true; atualizadoEm: string } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(roteiroId)) return NAO_ENCONTRADO;
    let r: { viagemId: string; atualizadoEm: Date } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarRoteiro(tx, roteiroId);
        if (ehFalha(t)) return t;
        if (!conferirVersao(t.r, atualizadoEmEsperado)) return CONCORRENCIA;
        const conteudo: ConteudoRoteiro = { ...t.r.conteudo, ...hoteisEVoosDosItens(await itensDaViagem(tx, t.r.viagemId)) };
        const [depois] = await tx
          .update(roteiros)
          .set({ conteudo, atualizadoEm: new Date() })
          .where(eq(roteiros.id, roteiroId))
          .returning();
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "roteiros",
          registroId: roteiroId,
          acao: "alterar",
          antes: { conteudo: t.r.conteudo, atualizadoEm: t.r.atualizadoEm },
          depois: { conteudo: depois.conteudo, atualizadoEm: depois.atualizadoEm },
        });
        return { viagemId: t.r.viagemId, atualizadoEm: depois.atualizadoEm };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao trazer hotéis e voos", x);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, atualizadoEm: r.atualizadoEm.toISOString() };
  });
}

/**
 * Mudança de status: trava, confere, grava só as colunas de `fn` (sem `atualizado_em`, D32) e audita só elas.
 * `fn` devolve as colunas e, opcionalmente, quantas tarefas criou.
 */
async function mudarStatus<T extends object>(
  roteiroId: string,
  mensagem: string,
  fn: (tx: Transacao, r: RoteiroDb, v: { id: string; consultorId: string }, usuarioId: string) => Promise<{ colunas: Partial<RoteiroDb>; extra: T } | Falha>,
): Promise<({ ok: true } & T) | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(roteiroId)) return NAO_ENCONTRADO;
    let r: { viagemId: string; extra: T } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarRoteiro(tx, roteiroId);
        if (ehFalha(t)) return t;
        const m = await fn(tx, t.r, t.v, usuario.id);
        if (ehFalha(m)) return m;
        await tx.update(roteiros).set(m.colunas).where(eq(roteiros.id, roteiroId));
        const antes = Object.fromEntries(Object.keys(m.colunas).map((k) => [k, t.r[k as keyof RoteiroDb]]));
        await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "roteiros", registroId: roteiroId, acao: "alterar", antes, depois: m.colunas });
        return { viagemId: t.r.viagemId, extra: m.extra };
      });
    } catch (x) {
      throw erroDeBanco(mensagem, x);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId, true);
    return { ok: true, ...r.extra };
  });
}

/** `rascunho` → `aguardando_cliente`, com quem e quando. */
export async function marcarEnviadoAoCliente(roteiroId: string): Promise<{ ok: true } | Falha> {
  return mudarStatus(roteiroId, "Erro ao marcar o roteiro como enviado", async (_tx, r, _v, usuarioId) => {
    if (r.status === "aprovado") return JA_APROVADO;
    if (r.status !== "rascunho") return JA_ENVIADO;
    return { colunas: { status: "aguardando_cliente", enviadoClienteEm: new Date(), enviadoClientePor: usuarioId }, extra: {} };
  });
}

/**
 * Aprovado pelo cliente (de `rascunho` ou `aguardando_cliente`, D16): grava quem e quando e cria as 3 tarefas do
 * roteiro na mesma transação. O `for update` serializa aprovações simultâneas; o índice único não deixa duplicar.
 * Com o Trello ligado, o checklist "Tarefas do roteiro" entra na fila na mesma transação.
 */
export async function aprovarRoteiro(roteiroId: string): Promise<{ ok: true; tarefasCriadas: number } | Falha> {
  let enfileirou = false;
  const res = await mudarStatus(roteiroId, "Erro ao aprovar o roteiro", async (tx, r, v, usuarioId) => {
    if (r.status === "aprovado") return JA_APROVADO;
    const doRoteiro = tarefasDoRoteiro();
    const tarefasCriadas = await criarTarefasAutomaticas(tx, usuarioId, v, doRoteiro, "roteiro");
    enfileirou = (await enfileirarChecklistDoRoteiro(tx, v.id, doRoteiro.map((x) => x.item))) !== null;
    return { colunas: { status: "aprovado", aprovadoEm: new Date(), aprovadoPor: usuarioId }, extra: { tarefasCriadas } };
  });
  if (res.ok && enfileirou) agendarEnvios();
  return res;
}

/** `aprovado` → `aguardando_cliente`; limpa quem e quando aprovou. As tarefas criadas ficam. */
export async function desfazerAprovacao(roteiroId: string): Promise<{ ok: true } | Falha> {
  return mudarStatus(roteiroId, "Erro ao desfazer a aprovação", async (_tx, r) => {
    if (r.status !== "aprovado") return NAO_APROVADO;
    return { colunas: { status: "aguardando_cliente", aprovadoEm: null, aprovadoPor: null }, extra: {} };
  });
}
