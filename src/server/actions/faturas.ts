"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { MSG_NUMERACAO_SO_AVANCA, numeroFaturaSchema } from "@/domain/faturas";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { comPerfil, ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { faturas, faturasContador } from "@/server/db/schema";
import { ehFalha, falha, type Falha } from "@/server/financeiro/baixas-viagem";
import { FATURA_NAO_ENCONTRADA, VENDA_NAO_ENCONTRADA, emitirFaturaNa, reemitirFaturaNa } from "@/server/financeiro/faturas";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Faturas (spec §6.4): emissão numerada pelo financeiro, reemissão com o mesmo número e o próximo número em
// Admin › Parâmetros (só o Diretor, só enquanto não há fatura). O núcleo está em `server/financeiro/faturas.ts`.

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

async function transacao<T extends { ok: true }>(mensagemErro: string, fn: (tx: Transacao) => Promise<T | Falha>): Promise<T | Falha> {
  try {
    return await db.transaction(fn);
  } catch (x) {
    throw erroDeBanco(mensagemErro, x);
  }
}

function revalidar(viagemId?: string) {
  revalidatePath("/financeiro", "layout");
  revalidatePath("/admin/parametros");
  if (viagemId) revalidatePath(`/viagens/${viagemId}`);
}

/** Emite a fatura da venda com o próximo número (1405, 1406…), sem buracos. */
export async function emitirFatura(vendaId: string): Promise<{ ok: true; numero: number } | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (u) => {
    if (!ehUuid(vendaId)) return VENDA_NAO_ENCONTRADA;
    const r = await transacao("Erro ao emitir a fatura", (tx) => emitirFaturaNa(tx, u.id, vendaId));
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, numero: r.numero };
  });
}

/** Reemite a fatura desatualizada: nova versão do retrato, mesmo número. */
export async function reemitirFatura(faturaId: string): Promise<{ ok: true; numero: number; versao: number } | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (u) => {
    if (!ehUuid(faturaId)) return FATURA_NAO_ENCONTRADA;
    const r = await transacao("Erro ao reemitir a fatura", (tx) => reemitirFaturaNa(tx, u.id, faturaId));
    if (ehFalha(r)) return r;
    revalidar(r.viagemId);
    return { ok: true, numero: r.numero, versao: r.versao };
  });
}

/**
 * Próximo número de fatura (só o Diretor), enquanto nenhuma fatura foi emitida. Trava o contador antes de
 * conferir as faturas: a emissão grava a fatura segurando a mesma trava, então as duas nunca se cruzam.
 */
export async function definirProximoNumeroFatura(numero: number): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], async (u) => {
    const p = numeroFaturaSchema.safeParse(numero);
    if (!p.success) return falha(p.error.issues[0].message);
    const r = await transacao("Erro ao definir o próximo número de fatura", async (tx): Promise<{ ok: true } | Falha> => {
      const [c] = await tx.select().from(faturasContador).where(eq(faturasContador.id, 1)).for("update");
      if (!c) throw new Error("Contador de faturas ausente");
      const [alguma] = await tx.select({ id: faturas.id }).from(faturas).limit(1);
      if (alguma) return falha(MSG_NUMERACAO_SO_AVANCA);
      if (c.proximo !== p.data) {
        await tx.update(faturasContador).set({ proximo: p.data }).where(eq(faturasContador.id, 1));
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "faturas_contador", registroId: "1", acao: "alterar", antes: { proximo: c.proximo }, depois: { proximo: p.data } });
      }
      return { ok: true };
    });
    if (!ehFalha(r)) revalidar();
    return r;
  });
}
