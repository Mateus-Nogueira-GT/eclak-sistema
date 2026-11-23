import "server-only";
import { and, eq } from "drizzle-orm";
import { cicloDoCartao } from "@/domain/caixa";
import { MSG_DESFACA_FATURA_CARTAO, MSG_FATURA_CARTAO_PAGA } from "@/domain/venda-entrada";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import { cartoesCorporativos, faturasCartao } from "@/server/db/schema";
import { falha, OK, type Falha, type Ok } from "@/server/financeiro/baixas-viagem";

// Fora dos arquivos "use server" de propósito: nada aqui pode virar endpoint. Núcleo das compras no cartão
// corporativo (lançamento manual a pagar no cartão de crédito e pagamento de viagem na forma "cartão corporativo"):
// achar/criar a fatura do ciclo e conferir se ela ainda aceita mudança. Sempre na transação da compra.
//
// Ordem das travas (a mesma em todo lugar, para não haver impasse): viagem (quando houver) → a compra (lançamento ou
// pagamento, `for update`) → o cartão (`for share`) → as faturas (`for update`). Nos lançamentos manuais (criar, editar,
// cancelar) as linhas são percorridas por data, então as faturas são travadas em ordem crescente; no
// `definirFormaFornecedor` as faturas antigas da conta (por id) e depois a nova. A baixa da fatura (Task 7) deve seguir
// a mesma ordem: descobrir as compras sem trava, travar as viagens (crescente), as compras, e só então a fatura.

export type Ciclo = { fechamento: string; vencimento: string };
export type FaturaCartaoLinha = typeof faturasCartao.$inferSelect;
export type Vinculo = { cartaoId: string; faturaCartaoId: string };

const CARTAO_INVALIDO = falha("Cartão não encontrado ou desativado", "cartaoId");
const FATURA_PAGA = falha(MSG_FATURA_CARTAO_PAGA);
const DESFACA_FATURA = falha(MSG_DESFACA_FATURA_CARTAO);

/** O cartão (`for share`: não muda de dias nem é desativado no meio da compra); com `exigeAtivo`, só se ativo. */
async function cartaoNa(tx: Transacao, cartaoId: string, exigeAtivo: boolean) {
  const [k] = await tx
    .select()
    .from(cartoesCorporativos)
    .where(exigeAtivo ? and(eq(cartoesCorporativos.id, cartaoId), eq(cartoesCorporativos.ativo, true)) : eq(cartoesCorporativos.id, cartaoId))
    .for("share");
  return k ?? null;
}

/**
 * A fatura do cartão no ciclo, `for update`; criada se ainda não existe (`on conflict do nothing` e releitura: duas
 * compras ao mesmo tempo no mesmo ciclo dão uma fatura só). `criada` diz se esta transação a criou.
 */
export async function faturaDoCicloNa(tx: Transacao, cartaoId: string, ciclo: Ciclo): Promise<{ fatura: FaturaCartaoLinha; criada: boolean }> {
  const ler = async () =>
    (
      await tx
        .select()
        .from(faturasCartao)
        .where(and(eq(faturasCartao.cartaoId, cartaoId), eq(faturasCartao.fechamento, ciclo.fechamento)))
        .for("update")
    )[0];
  const existente = await ler();
  if (existente) return { fatura: existente, criada: false };
  const [nova] = await tx
    .insert(faturasCartao)
    .values({ cartaoId, fechamento: ciclo.fechamento, vencimento: ciclo.vencimento })
    .onConflictDoNothing({ target: [faturasCartao.cartaoId, faturasCartao.fechamento] })
    .returning();
  if (nova) return { fatura: nova, criada: true };
  const outra = await ler();
  if (!outra) throw new Error("Fatura do cartão não encontrada depois do conflito");
  return { fatura: outra, criada: false };
}

/**
 * Vínculo da compra feita em `dataCompra` no cartão: a fatura do ciclo (criada e auditada se for a primeira compra
 * dele). Recusa cartão inexistente (ou desativado, com `exigeAtivo`: compra nova ou troca de cartão) no campo
 * `cartaoId`, e fatura já paga. Não grava na compra: o chamador grava o vínculo e audita a compra.
 */
export async function vincularCompraNa(
  tx: Transacao,
  usuarioId: string,
  cartaoId: string,
  dataCompra: string,
  exigeAtivo = true,
): Promise<Vinculo | Falha> {
  const k = await cartaoNa(tx, cartaoId, exigeAtivo);
  if (!k) return CARTAO_INVALIDO;
  const { fatura, criada } = await faturaDoCicloNa(tx, k.id, cicloDoCartao(dataCompra, k.diaFechamento, k.diaVencimento));
  if (criada) await registrarAuditoria(tx, { usuarioId, tabela: "faturas_cartao", registroId: fatura.id, acao: "criar", depois: fatura });
  if (fatura.status === "baixado") return FATURA_PAGA;
  return { cartaoId: k.id, faturaCartaoId: fatura.id };
}

/**
 * A compra pode sair da fatura `faturaCartaoId`? Trava a fatura (`for update`) e recusa se já foi paga ("Desfaça a
 * baixa da fatura do cartão antes"). Não grava na compra; a fatura nunca é apagada (sem compras, não aparece).
 */
export async function desvincularCompraNa(tx: Transacao, faturaCartaoId: string): Promise<Ok | Falha> {
  const [f] = await tx.select({ status: faturasCartao.status }).from(faturasCartao).where(eq(faturasCartao.id, faturaCartaoId)).for("update");
  return f && f.status === "baixado" ? DESFACA_FATURA : OK;
}
