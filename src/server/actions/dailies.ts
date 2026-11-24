"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { comPerfil, ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { dailies, roteiros, usuarios, viagens } from "@/server/db/schema";
import {
  CONCORRENCIA,
  conferirVersao,
  ehFalha,
  gerarDailyNaTransacao,
  inserirDoDia,
  JA_ENVIADO,
  NAO_ENCONTRADO,
  NAO_VENDIDA,
  roteiroDoDia,
  semId,
  travarDoDia,
  type DailyDb,
  type Falha,
} from "@/server/operacao/dailies";
import { regrasVigentes } from "@/server/queries/regras";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
// Qualquer usuário ativo (os cinco perfis). Toda escrita trava a linha do daily `for update` e audita na mesma transação.
// `gerarDaily`, `salvarTextoDaily` e `salvarInterno` mudam `atualizado_em` (e devolvem o novo); as ações de estado
// (revisado, enviado, desfazer) gravam só as próprias colunas, para não invalidar um texto aberto na tela.
// Nenhuma recusa pela data (D26): a data só escolhe o botão na tela.

type Gravado = { ok: true; id: string; atualizadoEm: string };

const codigoDe = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.cause?.code ?? x?.code;
};

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  console.error(mensagem, { code: codigoDe(e) });
  return new Error(mensagem);
}

const textoSchema = z.string().trim().min(1, "Escreva a mensagem").max(8000, "Texto muito longo");
const internoSchema = z.object({
  plantaoId: z.string().refine(ehUuid, "Escolha um usuário ativo para o plantão").nullable(),
  interno: z.string().max(4000, "Texto muito longo"),
});

function revalidar(viagemId: string) {
  revalidatePath("/dailies");
  revalidatePath(`/viagens/${viagemId}/dailies`);
}

/**
 * Monta o texto do dia com o modelo (`textoDoDaily`) e o encerramento vigente e grava `estado = gerado`. Cria a linha
 * se ainda não existe; se existe (pendente, ou "Gerar de novo"), exige `atualizadoEmEsperado`. Daily enviado recusa.
 */
export async function gerarDaily(roteiroId: string, data: string, atualizadoEmEsperado?: string): Promise<Gravado | Falha> {
  return comPerfil([], async (usuario) => {
    // Fora da transação: `regrasVigentes` usa o pool e pode abrir a própria transação (versão inicial).
    const encerramento = (await regrasVigentes()).valores.encerramentoDaily;
    let r: { viagemId: string; d: DailyDb } | Falha;
    try {
      r = await db.transaction((tx) => gerarDailyNaTransacao(tx, { roteiroId, data, usuarioId: usuario.id, encerramento, atualizadoEmEsperado }));
    } catch (e) {
      throw erroDeBanco("Erro ao gerar o daily", e);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, id: r.d.id, atualizadoEm: r.d.atualizadoEm.toISOString() };
  });
}

/** Linha travada pelo id e a viagem dela, vendida. */
async function travarPorId(tx: Transacao, dailyId: string): Promise<{ d: DailyDb; viagemId: string } | Falha> {
  const [d] = await tx.select().from(dailies).where(eq(dailies.id, dailyId)).for("update");
  if (!d) return NAO_ENCONTRADO;
  const [v] = await tx
    .select({ id: viagens.id, status: viagens.status })
    .from(roteiros)
    .innerJoin(viagens, eq(viagens.id, roteiros.viagemId))
    .where(and(eq(roteiros.id, d.roteiroId), isNull(viagens.excluidoEm)));
  if (!v) return NAO_ENCONTRADO;
  if (v.status !== "vendida") return NAO_VENDIDA;
  return { d, viagemId: v.id };
}

/** Edita a mensagem ao cliente; o estado não muda (revisado continua "Pronto para enviar", D17). */
export async function salvarTextoDaily(dailyId: string, texto: string, atualizadoEmEsperado: string): Promise<Gravado | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(dailyId)) return NAO_ENCONTRADO;
    const p = textoSchema.safeParse(texto);
    if (!p.success) return { ok: false, erro: p.error.issues[0].message, campos: { texto: p.error.issues[0].message } };
    let r: { viagemId: string; d: DailyDb } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarPorId(tx, dailyId);
        if (ehFalha(t)) return t;
        if (t.d.estado === "enviado") return JA_ENVIADO;
        if (t.d.estado === "pendente") return { ok: false, erro: "Gere o texto antes de editar" } as Falha;
        if (!conferirVersao(t.d, atualizadoEmEsperado)) return CONCORRENCIA;
        const [depois] = await tx.update(dailies).set({ texto: p.data, atualizadoEm: new Date() }).where(eq(dailies.id, dailyId)).returning();
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "dailies",
          registroId: dailyId,
          acao: "alterar",
          antes: { texto: t.d.texto, atualizadoEm: t.d.atualizadoEm },
          depois: { texto: depois.texto, atualizadoEm: depois.atualizadoEm },
        });
        return { viagemId: t.viagemId, d: depois };
      });
    } catch (e) {
      throw erroDeBanco("Erro ao salvar o daily", e);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, id: r.d.id, atualizadoEm: r.d.atualizadoEm.toISOString() };
  });
}

/** Mudança de estado: trava, confere, grava só as colunas de `fn` (sem `atualizado_em`) e audita só elas. */
async function mudarEstado(
  dailyId: string,
  mensagem: string,
  fn: (d: DailyDb, usuarioId: string) => Partial<DailyDb> | Falha,
): Promise<{ ok: true } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(dailyId)) return NAO_ENCONTRADO;
    let r: { viagemId: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarPorId(tx, dailyId);
        if (ehFalha(t)) return t;
        const colunas = fn(t.d, usuario.id);
        if (ehFalha(colunas)) return colunas;
        await tx.update(dailies).set(colunas).where(eq(dailies.id, dailyId));
        const antes = Object.fromEntries(Object.keys(colunas).map((k) => [k, t.d[k as keyof DailyDb]]));
        await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "dailies", registroId: dailyId, acao: "alterar", antes, depois: colunas });
        return { viagemId: t.viagemId };
      });
    } catch (e) {
      throw erroDeBanco(mensagem, e);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true };
  });
}

/** `gerado` → `revisado` ("Pronto para enviar", D27). */
export async function marcarRevisado(dailyId: string): Promise<{ ok: true } | Falha> {
  return mudarEstado(dailyId, "Erro ao marcar o daily como revisado", (d, usuarioId) => {
    if (d.estado === "pendente") return { ok: false, erro: "Gere o texto antes de marcar como revisado" };
    if (d.estado === "enviado") return JA_ENVIADO;
    if (d.estado === "revisado") return { ok: false, erro: "Daily já revisado" };
    return { estado: "revisado", revisadoEm: new Date(), revisadoPor: usuarioId };
  });
}

/** De `gerado` ou `revisado` → `enviado`, com quem e quando. */
export async function marcarEnviado(dailyId: string): Promise<{ ok: true } | Falha> {
  return mudarEstado(dailyId, "Erro ao marcar o daily como enviado", (d, usuarioId) => {
    if (d.estado === "pendente") return { ok: false, erro: "Gere o texto antes de marcar como enviado" };
    if (d.estado === "enviado") return { ok: false, erro: "Daily já marcado como enviado" };
    return { estado: "enviado", enviadoEm: new Date(), enviadoPor: usuarioId };
  });
}

/** `enviado` → `revisado`; limpa quem e quando enviou. */
export async function desfazerEnvio(dailyId: string): Promise<{ ok: true } | Falha> {
  return mudarEstado(dailyId, "Erro ao desfazer o envio do daily", (d) => {
    if (d.estado !== "enviado") return { ok: false, erro: "O daily não está marcado como enviado" };
    return { estado: "revisado", enviadoEm: null, enviadoPor: null };
  });
}

/**
 * Versão interna (plantão e localizadores). Cria a linha em `pendente` se o dia ainda não tem; se tem, exige
 * `atualizadoEmEsperado`. Aceita também daily enviado (não é texto ao cliente).
 */
export async function salvarInterno(
  roteiroId: string,
  data: string,
  dados: { plantaoId: string | null; interno: string },
  atualizadoEmEsperado?: string,
): Promise<Gravado | Falha> {
  return comPerfil([], async (usuario) => {
    const p = internoSchema.safeParse(dados);
    if (!p.success) {
      const campo = String(p.error.issues[0].path[0] ?? "interno");
      return { ok: false, erro: p.error.issues[0].message, campos: { [campo]: p.error.issues[0].message } };
    }
    const interno = p.data.interno.trim() === "" ? null : p.data.interno;
    let r: { viagemId: string; d: DailyDb } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const x = await roteiroDoDia(tx, roteiroId, data);
        if (ehFalha(x)) return x;
        const antes = await travarDoDia(tx, roteiroId, data);
        // Só confere "ativo" quando o plantão muda: um plantão que ficou inativo depois não impede salvar os localizadores.
        if (p.data.plantaoId && p.data.plantaoId !== antes?.plantaoId) {
          const [u] = await tx
            .select({ id: usuarios.id })
            .from(usuarios)
            .where(and(eq(usuarios.id, p.data.plantaoId), eq(usuarios.ativo, true)));
          if (!u) return { ok: false, erro: "Escolha um usuário ativo para o plantão", campos: { plantaoId: "Escolha um usuário ativo para o plantão" } } as Falha;
        }
        const colunas = { plantaoId: p.data.plantaoId, interno, atualizadoEm: new Date() };
        if (!antes) {
          const novo = await inserirDoDia(tx, { roteiroId, data, estado: "pendente", ...colunas });
          if (ehFalha(novo)) return novo;
          await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "dailies", registroId: novo.id, acao: "criar", depois: semId(novo) });
          return { viagemId: x.r.viagemId, d: novo };
        }
        if (!conferirVersao(antes, atualizadoEmEsperado)) return CONCORRENCIA;
        const [depois] = await tx.update(dailies).set(colunas).where(eq(dailies.id, antes.id)).returning();
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "dailies",
          registroId: antes.id,
          acao: "alterar",
          antes: { plantaoId: antes.plantaoId, interno: antes.interno, atualizadoEm: antes.atualizadoEm },
          depois: { plantaoId: depois.plantaoId, interno: depois.interno, atualizadoEm: depois.atualizadoEm },
        });
        return { viagemId: x.r.viagemId, d: depois };
      });
    } catch (e) {
      throw erroDeBanco("Erro ao salvar a versão interna", e);
    }
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, id: r.d.id, atualizadoEm: r.d.atualizadoEm.toISOString() };
  });
}
