import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { converter } from "@/domain/cambio";
import {
  MSG_CAMBIO_EFETIVO,
  MSG_COMISSAO_CANCELADA,
  MSG_COMISSAO_EM_ABERTO,
  MSG_COMISSAO_REGISTRADA,
  MSG_CONCILIADA,
  MSG_CONTA_BANCARIA,
  MSG_DIFERENCA_RECEBIDA,
  MSG_NAO_VENDIDA,
  MSG_PAGAMENTO_EM_ABERTO,
  MSG_PAGAMENTO_PAGO,
  MSG_PARCELA_CANCELADA,
  MSG_PARCELA_EM_ABERTO,
  MSG_PARCELA_RECEBIDA,
  type BaixaPagamentoValidada,
  type BaixaParcelaValidada,
  type ComissaoRecebidaValidada,
} from "@/domain/venda-entrada";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import { comissoes, contasBancarias, contasPagar, pagamentosFornecedor, parcelasReceber, viagens } from "@/server/db/schema";
import { travarViagem } from "@/server/trava-viagem";

// Fora dos arquivos "use server" de propósito: nada aqui pode virar endpoint. Núcleo das baixas da viagem
// (parcela, pagamento, comissão e os "desfazer"), o mesmo código para a tela da viagem e para a lista única do
// financeiro (individual ou em lote). Cada função recebe a transação de fora, descobre a viagem do registro, trava
// a viagem (`travarViagem`, reentrante na mesma transação), exige `vendida` e não conciliada, trava a linha pela
// cadeia de dono, confere a conta bancária (ativa), grava e audita. Recusa de regra de negócio volta como `Falha`
// (nunca lança) e é decidida antes de qualquer escrita: a action individual devolve a falha; o lote lança
// `Desfazer(falha)` para desfazer a transação inteira.

export type Falha = { ok: false; erro: string; campos?: Record<string, string> };
export type Ok = { ok: true };
/** Sucesso do núcleo: com a viagem alterada (para revalidar as telas dela). */
export type Feito = { ok: true; viagemId: string };

export const OK: Ok = { ok: true };

export const falha = (erro: string, campo?: string): Falha => (campo ? { ok: false, erro, campos: { [campo]: erro } } : { ok: false, erro });

export const ehFalha = (x: unknown): x is Falha => typeof x === "object" && x !== null && "ok" in x && (x as Falha).ok === false;

/** Recusa dentro da transação que precisa desfazer o que já foi gravado; vira a `falha` fora dela. */
export class Desfazer extends Error {
  constructor(readonly falha: Falha) {
    super(falha.erro);
  }
}

export const PARCELA_NAO_ENCONTRADA = falha("Parcela não encontrada");
export const PAGAMENTO_NAO_ENCONTRADO = falha("Pagamento não encontrado");
export const COMISSAO_NAO_ENCONTRADA = falha("Comissão não encontrada");
const NAO_VENDIDA = falha(MSG_NAO_VENDIDA);
const CONCILIADA = falha(MSG_CONCILIADA);

export type ViagemLinha = typeof viagens.$inferSelect;
export type ContaLinha = typeof contasPagar.$inferSelect;
export type PagamentoLinha = typeof pagamentosFornecedor.$inferSelect;
type ParcelaLinha = typeof parcelasReceber.$inferSelect;
type ComissaoLinha = typeof comissoes.$inferSelect;

/** Auditoria de alteração: `antes` só com as chaves alteradas. */
export async function auditarAlteracao<T extends { id: string }>(
  tx: Transacao,
  usuarioId: string,
  tabela: string,
  linha: T,
  depois: Partial<T>,
): Promise<void> {
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, linha[k as keyof T]]));
  await registrarAuditoria(tx, { usuarioId, tabela, registroId: linha.id, acao: "alterar", antes, depois });
}

/**
 * Descobre a viagem do registro (`viagemDe`, sem trava), trava a viagem, exige `vendida` e não conciliada (salvo
 * `aceitaConciliada`) e roda `fn` na transação `tx`. Devolve a viagem no sucesso.
 */
export async function naViagemVendidaNa(
  tx: Transacao,
  viagemDe: (tx: Transacao) => Promise<string | null>,
  naoEncontrado: Falha,
  fn: (tx: Transacao, v: ViagemLinha) => Promise<Ok | Falha>,
  aceitaConciliada = false,
): Promise<Feito | Falha> {
  const id = await viagemDe(tx);
  if (!id) return naoEncontrado;
  const v = await travarViagem(tx, id);
  if (!v) return naoEncontrado;
  if (v.status !== "vendida") return NAO_VENDIDA;
  if (v.conciliadaEm && !aceitaConciliada) return CONCILIADA;
  const r = await fn(tx, v);
  return ehFalha(r) ? r : { ok: true, viagemId: v.id };
}

// ---------------------------------------------------------------------------
// Leituras pela cadeia de dono (sem trava: só para achar a viagem; depois, `for update`)
// ---------------------------------------------------------------------------

async function viagemDoPagamento(tx: Transacao, pagamentoId: string): Promise<string | null> {
  const [c] = await tx
    .select({ viagemId: contasPagar.viagemId })
    .from(pagamentosFornecedor)
    .innerJoin(contasPagar, eq(contasPagar.id, pagamentosFornecedor.contaId))
    .where(and(eq(pagamentosFornecedor.id, pagamentoId), isNull(contasPagar.excluidoEm)));
  return c?.viagemId ?? null;
}

async function viagemDaComissao(tx: Transacao, comissaoId: string): Promise<string | null> {
  const [c] = await tx
    .select({ viagemId: contasPagar.viagemId })
    .from(comissoes)
    .innerJoin(contasPagar, and(eq(contasPagar.id, comissoes.contaId), eq(contasPagar.viagemId, comissoes.viagemId)))
    .where(and(eq(comissoes.id, comissaoId), isNull(contasPagar.excluidoEm)));
  return c?.viagemId ?? null;
}

async function viagemDaParcela(tx: Transacao, parcelaId: string): Promise<string | null> {
  const [p] = await tx.select({ viagemId: parcelasReceber.viagemId }).from(parcelasReceber).where(eq(parcelasReceber.id, parcelaId));
  return p?.viagemId ?? null;
}

/** Conta ativa da viagem travada, `for update`. */
export async function contaTravada(tx: Transacao, contaId: string, viagemId: string): Promise<ContaLinha | null> {
  const [c] = await tx
    .select()
    .from(contasPagar)
    .where(and(eq(contasPagar.id, contaId), eq(contasPagar.viagemId, viagemId), isNull(contasPagar.excluidoEm)))
    .for("update");
  return c ?? null;
}

/** Linhas de pagamento da conta, `for update`, pela ordem. */
export async function linhasDaConta(tx: Transacao, contaId: string): Promise<PagamentoLinha[]> {
  return tx
    .select()
    .from(pagamentosFornecedor)
    .where(eq(pagamentosFornecedor.contaId, contaId))
    .orderBy(asc(pagamentosFornecedor.numero))
    .for("update");
}

/**
 * Conta bancária da baixa: precisa existir e estar ativa (travada `for share` até o fim da transação, para não
 * ser desativada no meio). Senão, "Escolha a conta bancária" no campo `contaBancariaId`.
 */
async function recusaContaBancaria(tx: Transacao, contaBancariaId: string): Promise<Falha | null> {
  const [c] = await tx
    .select({ id: contasBancarias.id })
    .from(contasBancarias)
    .where(and(eq(contasBancarias.id, contaBancariaId), eq(contasBancarias.ativa, true), isNull(contasBancarias.excluidoEm)))
    .for("share");
  return c ? null : falha(MSG_CONTA_BANCARIA, "contaBancariaId");
}

/** A observação nova entra em linha nova no fim da que havia; sem nova, fica a que havia. */
const juntarObservacao = (antes: string | null, nova: string | null): string | null => (nova ? (antes ? `${antes}\n${nova}` : nova) : antes);

// ---------------------------------------------------------------------------
// Parcelas a receber
// ---------------------------------------------------------------------------

async function parcelaTravada(tx: Transacao, parcelaId: string, viagemId: string) {
  const [p] = await tx
    .select()
    .from(parcelasReceber)
    .where(and(eq(parcelasReceber.id, parcelaId), eq(parcelasReceber.viagemId, viagemId)))
    .for("update");
  return p ?? null;
}

/** Roda `mudar` sobre a parcela travada da viagem e grava o resultado (ou recusa, sem gravar nada). */
function naParcela(
  tx: Transacao,
  usuarioId: string,
  parcelaId: string,
  mudar: (tx: Transacao, p: ParcelaLinha) => Promise<Partial<ParcelaLinha> | Falha>,
): Promise<Feito | Falha> {
  return naViagemVendidaNa(
    tx,
    (t) => viagemDaParcela(t, parcelaId),
    PARCELA_NAO_ENCONTRADA,
    async (t, v) => {
      const p = await parcelaTravada(t, parcelaId, v.id);
      if (!p) return PARCELA_NAO_ENCONTRADA;
      const depois = await mudar(t, p);
      if (ehFalha(depois)) return depois;
      await t.update(parcelasReceber).set(depois).where(eq(parcelasReceber.id, p.id));
      await auditarAlteracao(t, usuarioId, "parcelas_receber", p, depois);
      return OK;
    },
  );
}

const recusaParcelaFechada = (p: ParcelaLinha): Falha | null =>
  p.status === "recebida" ? falha(MSG_PARCELA_RECEBIDA) : p.status === "cancelada" ? falha(MSG_PARCELA_CANCELADA) : null;

/**
 * Baixa da parcela: data, valor recebido, taxa efetiva (vazia = a prevista), conta bancária ativa e observação,
 * obrigatória quando o valor recebido é diferente do valor da parcela (a diferença entra na margem real). A
 * observação nova é acrescentada à que havia (o motivo de um cancelamento desfeito, a de uma baixa desfeita).
 */
export function baixarParcelaNa(tx: Transacao, usuarioId: string, parcelaId: string, dados: BaixaParcelaValidada): Promise<Feito | Falha> {
  return naParcela(tx, usuarioId, parcelaId, async (t, p) => {
    const recusa = recusaParcelaFechada(p);
    if (recusa) return recusa;
    if (dados.valorRecebido !== p.valor && !dados.observacao) return falha(MSG_DIFERENCA_RECEBIDA, "observacao");
    const semConta = await recusaContaBancaria(t, dados.contaBancariaId);
    if (semConta) return semConta;
    return {
      status: "recebida",
      recebidaEm: dados.recebidaEm,
      valorRecebido: dados.valorRecebido,
      taxaEfetiva: dados.taxaEfetiva,
      contaBancariaId: dados.contaBancariaId,
      observacao: juntarObservacao(p.observacao, dados.observacao),
    };
  });
}

/** Desfaz a baixa ou o cancelamento da parcela: volta a `a_receber`. Limpa só a baixa; a observação fica. */
export function desfazerBaixaParcelaNa(tx: Transacao, usuarioId: string, parcelaId: string): Promise<Feito | Falha> {
  return naParcela(tx, usuarioId, parcelaId, async (_t, p) =>
    p.status === "a_receber"
      ? falha(MSG_PARCELA_EM_ABERTO)
      : { status: "a_receber", recebidaEm: null, valorRecebido: null, taxaEfetiva: null, contaBancariaId: null },
  );
}

/** Cancela a parcela em aberto, com motivo (fica na observação). `motivo` já validado. */
export function cancelarParcelaNa(tx: Transacao, usuarioId: string, parcelaId: string, motivo: string): Promise<Feito | Falha> {
  return naParcela(tx, usuarioId, parcelaId, async (_t, p) => recusaParcelaFechada(p) ?? { status: "cancelada", observacao: motivo });
}

// ---------------------------------------------------------------------------
// Pagamentos ao fornecedor
// ---------------------------------------------------------------------------

/** Roda `mudar` sobre o pagamento travado (com a conta travada) e acerta o status da conta. */
function noPagamento(
  tx: Transacao,
  usuarioId: string,
  pagamentoId: string,
  mudar: (tx: Transacao, p: PagamentoLinha, conta: ContaLinha) => Promise<Partial<PagamentoLinha> | Falha>,
): Promise<Feito | Falha> {
  return naViagemVendidaNa(
    tx,
    (t) => viagemDoPagamento(t, pagamentoId),
    PAGAMENTO_NAO_ENCONTRADO,
    async (t, v) => {
      const [dono] = await t.select({ contaId: pagamentosFornecedor.contaId }).from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, pagamentoId));
      const conta = dono ? await contaTravada(t, dono.contaId, v.id) : null;
      if (!conta) return PAGAMENTO_NAO_ENCONTRADO;
      const linhas = await linhasDaConta(t, conta.id);
      const p = linhas.find((l) => l.id === pagamentoId);
      if (!p) return PAGAMENTO_NAO_ENCONTRADO;
      const depois = await mudar(t, p, conta);
      if (ehFalha(depois)) return depois;
      await t.update(pagamentosFornecedor).set(depois).where(eq(pagamentosFornecedor.id, p.id));
      await auditarAlteracao(t, usuarioId, "pagamentos_fornecedor", p, depois);
      const todasPagas = linhas.every((l) => (l.id === p.id ? depois.status : l.status) === "pago");
      const status = todasPagas ? "paga" : "a_pagar";
      if (conta.status !== status && conta.status !== "cancelada") {
        await t.update(contasPagar).set({ status }).where(eq(contasPagar.id, conta.id));
        await auditarAlteracao(t, usuarioId, "contas_pagar", conta, { status });
      }
      return OK;
    },
  );
}

/**
 * Baixa do pagamento: data, valor pago na moeda da conta e conta bancária ativa; fora do real, câmbio efetivo
 * obrigatório e o valor em reais é a conversão (meio para cima). A conta fica `paga` quando todas as linhas estão
 * pagas.
 */
export function baixarPagamentoNa(tx: Transacao, usuarioId: string, pagamentoId: string, dados: BaixaPagamentoValidada): Promise<Feito | Falha> {
  const { pagoEm, valorOriginalPago, cambioEfetivo, contaBancariaId } = dados;
  return noPagamento(tx, usuarioId, pagamentoId, async (t, p, conta) => {
    if (p.status === "pago") return falha(MSG_PAGAMENTO_PAGO);
    const cambio = conta.moeda === "BRL" ? null : cambioEfetivo;
    if (conta.moeda !== "BRL" && !cambio) return falha(MSG_CAMBIO_EFETIVO, "cambioEfetivo");
    const semConta = await recusaContaBancaria(t, contaBancariaId);
    if (semConta) return semConta;
    const valorBrlPago = cambio ? converter(valorOriginalPago, cambio) : valorOriginalPago;
    return { status: "pago", pagoEm, valorOriginalPago, cambioEfetivo: cambio, valorBrlPago, contaBancariaId };
  });
}

/** Desfaz a baixa do pagamento; a conta volta a `a_pagar`. */
export function desfazerBaixaPagamentoNa(tx: Transacao, usuarioId: string, pagamentoId: string): Promise<Feito | Falha> {
  return noPagamento(tx, usuarioId, pagamentoId, async (_t, p) =>
    p.status !== "pago"
      ? falha(MSG_PAGAMENTO_EM_ABERTO)
      : { status: "a_pagar", pagoEm: null, valorOriginalPago: null, cambioEfetivo: null, valorBrlPago: null, contaBancariaId: null },
  );
}

// ---------------------------------------------------------------------------
// Comissões a receber
// ---------------------------------------------------------------------------

function naComissao(
  tx: Transacao,
  usuarioId: string,
  comissaoId: string,
  mudar: (tx: Transacao, c: ComissaoLinha) => Promise<Partial<ComissaoLinha> | Falha>,
): Promise<Feito | Falha> {
  return naViagemVendidaNa(
    tx,
    (t) => viagemDaComissao(t, comissaoId),
    COMISSAO_NAO_ENCONTRADA,
    async (t, v) => {
      const [c] = await t
        .select({ c: comissoes })
        .from(comissoes)
        .innerJoin(contasPagar, eq(contasPagar.id, comissoes.contaId))
        .where(and(eq(comissoes.id, comissaoId), eq(comissoes.viagemId, v.id), eq(contasPagar.viagemId, v.id), isNull(contasPagar.excluidoEm)))
        .for("update");
      if (!c) return COMISSAO_NAO_ENCONTRADA;
      if (c.c.status === "cancelada") return falha(MSG_COMISSAO_CANCELADA);
      const depois = await mudar(t, c.c);
      if (ehFalha(depois)) return depois;
      await t.update(comissoes).set(depois).where(eq(comissoes.id, comissaoId));
      await auditarAlteracao(t, usuarioId, "comissoes", c.c, depois);
      return OK;
    },
  );
}

/** Comissão recebida: data, valor e conta bancária ativa. */
export function registrarComissaoNa(tx: Transacao, usuarioId: string, comissaoId: string, dados: ComissaoRecebidaValidada): Promise<Feito | Falha> {
  return naComissao(tx, usuarioId, comissaoId, async (t, c) => {
    if (c.status !== "prevista") return falha(MSG_COMISSAO_REGISTRADA);
    const semConta = await recusaContaBancaria(t, dados.contaBancariaId);
    if (semConta) return semConta;
    return { status: "recebida", recebidaEm: dados.recebidaEm, valorRecebido: dados.valorRecebido, motivo: null, contaBancariaId: dados.contaBancariaId };
  });
}

/** Comissão que não será recebida, com motivo (já validado). */
export function comissaoNaoRecebidaNa(tx: Transacao, usuarioId: string, comissaoId: string, motivo: string): Promise<Feito | Falha> {
  return naComissao(tx, usuarioId, comissaoId, async (_t, c) => (c.status !== "prevista" ? falha(MSG_COMISSAO_REGISTRADA) : { status: "nao_recebida", motivo }));
}

/** Desfaz o registro da comissão (recebida ou não recebida): volta a `prevista`. */
export function desfazerComissaoNa(tx: Transacao, usuarioId: string, comissaoId: string): Promise<Feito | Falha> {
  return naComissao(tx, usuarioId, comissaoId, async (_t, c) =>
    c.status === "prevista"
      ? falha(MSG_COMISSAO_EM_ABERTO)
      : { status: "prevista", recebidaEm: null, valorRecebido: null, motivo: null, contaBancariaId: null },
  );
}
