import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Saldo, TipoMovimento } from "@/domain/estoque";
import type { Centro } from "@/domain/financeiro";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import { estoqueMovimentos, estoqueSaldos } from "@/server/db/schema";

// Núcleo das movimentações de estoque (fatia 5b), numa transação `tx` já aberta: travar o saldo do par produto/filial,
// gravar o saldo novo e gravar o movimento. Usado pelas actions do estoque e da caixa de experiência. Toda escrita
// audita na mesma transação. Nada aqui lança recusa: quem chama decide e desfaz.

export type SaldoLinha = typeof estoqueSaldos.$inferSelect;
export type Movimento = typeof estoqueMovimentos.$inferSelect;

/** Auditoria de alteração: `antes` só com as chaves alteradas. */
export async function auditarAlteracao<T>(
  tx: Transacao,
  usuarioId: string,
  tabela: string,
  registroId: string,
  linha: T,
  depois: Partial<T>,
  acao: "alterar" | "desativar" = "alterar",
): Promise<void> {
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, linha[k as keyof T]]));
  await registrarAuditoria(tx, { usuarioId, tabela, registroId, acao, antes, depois });
}

export const idDoSaldo = (produtoId: string, filial: Centro) => `${produtoId}:${filial}`;

export const saldoDe = (s: SaldoLinha): Saldo => ({ quantidade: s.quantidade, custoMedio: s.custoMedio });

/**
 * O saldo do par produto/filial travado (`for update`); a linha nasce zerada se não existe (`on conflict do nothing` e
 * releitura: duas primeiras movimentações ao mesmo tempo não criam duas linhas) e o nascimento é auditado.
 */
export async function travarSaldo(tx: Transacao, usuarioId: string, produtoId: string, filial: Centro): Promise<SaldoLinha> {
  const [nova] = await tx.insert(estoqueSaldos).values({ produtoId, filial }).onConflictDoNothing().returning();
  if (nova) await registrarAuditoria(tx, { usuarioId, tabela: "estoque_saldos", registroId: idDoSaldo(produtoId, filial), acao: "criar", depois: nova });
  const [s] = await tx
    .select()
    .from(estoqueSaldos)
    .where(and(eq(estoqueSaldos.produtoId, produtoId), eq(estoqueSaldos.filial, filial)))
    .for("update");
  return s;
}

export async function gravarSaldo(tx: Transacao, usuarioId: string, s: SaldoLinha, novo: Saldo): Promise<void> {
  const depois = { quantidade: novo.quantidade, custoMedio: novo.custoMedio };
  await tx.update(estoqueSaldos).set(depois).where(and(eq(estoqueSaldos.produtoId, s.produtoId), eq(estoqueSaldos.filial, s.filial)));
  await auditarAlteracao(tx, usuarioId, "estoque_saldos", idDoSaldo(s.produtoId, s.filial), s, depois);
}

/**
 * Grava o movimento (só inserção) com `custo_medio_antes` = o custo médio do saldo travado. `criado_em` vem de
 * `clock_timestamp()`, lido já com a trava do saldo: a ordem dos movimentos do par é a ordem das travas (o `now()`
 * padrão é o início da transação e poderia inverter duas transações concorrentes).
 */
export async function gravarMovimento(
  tx: Transacao,
  usuarioId: string,
  s: SaldoLinha,
  m: {
    tipo: TipoMovimento;
    quantidade: number;
    custoUnitario: bigint;
    motivo?: string | null;
    fornecedorId?: string | null;
    fornecedorTexto?: string | null;
    lancamentoId?: string | null;
    caixaId?: string | null;
  },
): Promise<Movimento> {
  const [mov] = await tx
    .insert(estoqueMovimentos)
    .values({
      produtoId: s.produtoId,
      filial: s.filial,
      tipo: m.tipo,
      quantidade: m.quantidade,
      custoUnitario: m.custoUnitario,
      custoMedioAntes: s.custoMedio,
      fornecedorId: m.fornecedorId ?? null,
      fornecedorTexto: m.fornecedorTexto ?? null,
      lancamentoId: m.lancamentoId ?? null,
      caixaId: m.caixaId ?? null,
      motivo: m.motivo ?? null,
      usuarioId,
      criadoEm: sql`clock_timestamp()`,
    })
    .returning();
  await registrarAuditoria(tx, { usuarioId, tabela: "estoque_movimentos", registroId: mov.id, acao: "criar", depois: mov });
  return mov;
}
