import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Regras } from "@/domain/regras";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import { cotacoes, itensViagem } from "@/server/db/schema";

// Fora dos arquivos "use server" de propósito: nada aqui pode virar endpoint. Usado pelas actions de itens e
// cotações e pelo envio para aprovação, sempre com a viagem já travada.

/** Linha auditada sem o id (que já é o `registroId`). */
const semControle = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id"));

export async function proximaOrdem(tx: Transacao, viagemId: string): Promise<number> {
  const [r] = await tx
    .select({ max: sql<number>`coalesce(max(${itensViagem.ordem}), 0)::int` })
    .from(itensViagem)
    .where(eq(itensViagem.viagemId, viagemId));
  return r.max + 1;
}

/**
 * Mantém o item automático `Taxa de roteiro`: existe (com uma cotação BRL escolhida no valor dos Parâmetros)
 * enquanto houver ≥ `taxaRoteiro.minimoItens` itens ativos que não são Taxa nem Aéreo; abaixo disso, sai
 * (exclusão lógica). Chamada depois de toda alteração de item/cotação e no envio para aprovação (antes do
 * snapshot), com a viagem travada.
 */
export async function sincronizarTaxaRoteiro(
  tx: Transacao,
  viagemId: string,
  regras: Regras,
  usuarioId: string,
  agora: Date,
): Promise<void> {
  const ativos = await tx
    .select()
    .from(itensViagem)
    .where(and(eq(itensViagem.viagemId, viagemId), isNull(itensViagem.excluidoEm)));
  const conta = ativos.filter((i) => i.tipo !== "Taxa" && i.tipo !== "Aéreo").length;
  const taxas = ativos.filter((i) => i.automatico);
  const deve = conta >= regras.taxaRoteiro.minimoItens;
  const valor = BigInt(regras.taxaRoteiro.valor);

  if (deve && taxas.length === 0) {
    const [item] = await tx
      .insert(itensViagem)
      .values({ viagemId, ordem: await proximaOrdem(tx, viagemId), tipo: "Taxa", servico: "Taxa de roteiro", automatico: true })
      .returning();
    const [cot] = await tx
      .insert(cotacoes)
      .values({ itemId: item.id, moeda: "BRL", valorOriginal: valor, valorBrl: valor, escolhida: true, criadoEm: agora })
      .returning();
    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "itens_viagem",
      registroId: item.id,
      acao: "criar",
      depois: { ...semControle(item), cotacao: semControle(cot) },
    });
    return;
  }

  if (!deve) {
    for (const t of taxas) {
      await tx.update(itensViagem).set({ excluidoEm: agora }).where(eq(itensViagem.id, t.id));
      await registrarAuditoria(tx, {
        usuarioId,
        tabela: "itens_viagem",
        registroId: t.id,
        acao: "excluir",
        antes: semControle(t),
        depois: { excluidoEm: agora },
      });
    }
    return;
  }

  // Já existe: acompanha o valor vigente dos Parâmetros.
  for (const t of taxas) {
    const cots = await tx
      .select()
      .from(cotacoes)
      .where(and(eq(cotacoes.itemId, t.id), isNull(cotacoes.excluidoEm)));
    for (const c of cots) {
      if (c.valorBrl === valor && c.valorOriginal === valor) continue;
      await tx.update(cotacoes).set({ valorOriginal: valor, valorBrl: valor }).where(eq(cotacoes.id, c.id));
      await registrarAuditoria(tx, {
        usuarioId,
        tabela: "cotacoes",
        registroId: c.id,
        acao: "alterar",
        antes: { valorOriginal: c.valorOriginal, valorBrl: c.valorBrl },
        depois: { valorOriginal: valor, valorBrl: valor },
      });
    }
  }
}
