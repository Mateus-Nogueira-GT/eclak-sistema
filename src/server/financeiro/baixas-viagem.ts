import "server-only";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { converter } from "@/domain/cambio";
import {
  MSG_CAMBIO_EFETIVO,
  MSG_COMISSAO_CANCELADA,
  MSG_COMISSAO_EM_ABERTO,
  MSG_COMISSAO_REGISTRADA,
  MSG_CONCILIADA,
  MSG_COMPRA_NO_CARTAO,
  MSG_CONTA_BANCARIA,
  MSG_DESFACA_FATURA_CARTAO,
  MSG_DESFACA_REPASSE,
  MSG_DIFERENCA_RECEBIDA,
  MSG_ESCOLHA_FORNECEDOR_ANTES,
  MSG_FORNECEDOR_CARTAO,
  MSG_FORNECEDOR_JA_PAGO,
  MSG_NAO_CARTAO_FORNECEDOR,
  MSG_NAO_VENDIDA,
  MSG_PAGO_NO_CARTAO,
  MSG_PAGO_PELO_REPASSE,
  MSG_PAGAMENTO_EM_ABERTO,
  MSG_PAGAMENTO_PAGO,
  MSG_PARCELA_CANCELADA,
  MSG_PARCELA_EM_ABERTO,
  MSG_PARCELA_RECEBIDA,
  MSG_REPASSE_ESTRANGEIRA,
  MSG_REPASSE_MAIOR,
  MSG_USE_REPASSE,
  type BaixaPagamentoValidada,
  type BaixaParcelaValidada,
  type ComissaoRecebidaValidada,
} from "@/domain/venda-entrada";
import type { RepasseValidado } from "@/domain/financeiro-entrada";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import {
  comissoes,
  contasBancarias,
  contasPagar,
  lancamentosFinanceiros,
  pagamentosFornecedor,
  parcelasReceber,
  vendas,
  viagens,
} from "@/server/db/schema";
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
export const NAO_VENDIDA = falha(MSG_NAO_VENDIDA);
const USE_REPASSE = falha(MSG_USE_REPASSE);
const PAGO_PELO_REPASSE = falha(MSG_PAGO_PELO_REPASSE);
const NAO_CARTAO_FORNECEDOR = falha(MSG_NAO_CARTAO_FORNECEDOR);
export const CONCILIADA = falha(MSG_CONCILIADA);
const COMPRA_NO_CARTAO = falha(MSG_COMPRA_NO_CARTAO);
const DESFACA_FATURA_CARTAO = falha(MSG_DESFACA_FATURA_CARTAO);

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
  return (await contaBancariaAtiva(tx, contaBancariaId)) ? null : falha(MSG_CONTA_BANCARIA, "contaBancariaId");
}

/**
 * A conta bancária existe e está ativa? Trava a linha `for share` até o fim da transação (uma desativação ao mesmo
 * tempo espera, ou esta espera por ela e relê). Usada por toda baixa: da viagem e do lançamento manual.
 */
export async function contaBancariaAtiva(tx: Transacao, contaBancariaId: string): Promise<boolean> {
  const [c] = await tx
    .select({ id: contasBancarias.id })
    .from(contasBancarias)
    .where(and(eq(contasBancarias.id, contaBancariaId), eq(contasBancarias.ativa, true), isNull(contasBancarias.excluidoEm)))
    .for("share");
  return c !== undefined;
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
    if (p.meio === "cartao_fornecedor") return USE_REPASSE;
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

/** Parcela de volta a `a_receber`: limpa só a baixa (a observação fica). */
const PARCELA_EM_ABERTO_DE_NOVO = {
  status: "a_receber",
  recebidaEm: null,
  valorRecebido: null,
  taxaEfetiva: null,
  valorRepassado: null,
  contaBancariaId: null,
} as const;

/**
 * Desfaz a baixa ou o cancelamento da parcela: volta a `a_receber`. Limpa só a baixa; a observação fica. A de
 * cartão direto no fornecedor volta por `desfazerRepasseNa`.
 */
export function desfazerBaixaParcelaNa(tx: Transacao, usuarioId: string, parcelaId: string): Promise<Feito | Falha> {
  return naParcela(tx, usuarioId, parcelaId, async (_t, p) =>
    p.meio === "cartao_fornecedor" ? USE_REPASSE : p.status === "a_receber" ? falha(MSG_PARCELA_EM_ABERTO) : { ...PARCELA_EM_ABERTO_DE_NOVO },
  );
}

/** Cancela a parcela em aberto, com motivo (acrescentado à observação, como na baixa). `motivo` já validado. */
export function cancelarParcelaNa(tx: Transacao, usuarioId: string, parcelaId: string, motivo: string): Promise<Feito | Falha> {
  return naParcela(tx, usuarioId, parcelaId, async (_t, p) => recusaParcelaFechada(p) ?? { status: "cancelada", observacao: juntarObservacao(p.observacao, motivo) });
}

// ---------------------------------------------------------------------------
// Pagamentos ao fornecedor
// ---------------------------------------------------------------------------

/** A conta fica `paga` com todas as linhas pagas, senão `a_pagar` (a cancelada não muda). */
export async function acertarStatusConta(tx: Transacao, usuarioId: string, conta: ContaLinha, statusDasLinhas: PagamentoLinha["status"][]): Promise<void> {
  const status = statusDasLinhas.every((s) => s === "pago") ? "paga" : "a_pagar";
  if (conta.status !== status && conta.status !== "cancelada") {
    await tx.update(contasPagar).set({ status }).where(eq(contasPagar.id, conta.id));
    await auditarAlteracao(tx, usuarioId, "contas_pagar", conta, { status });
  }
}

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
      await acertarStatusConta(t, usuarioId, conta, linhas.map((l) => (l.id === p.id ? (depois.status ?? l.status) : l.status)));
      return OK;
    },
  );
}

/**
 * Venda de cartão direto no fornecedor da viagem: tem parcela `cartao_fornecedor` não cancelada (a mesma condição do
 * `cartao_direto` da view `lancamentos_financeiros`, drizzle/0022). Devolve o fornecedor do cartão (nulo em venda
 * antiga, sem ele) ou `null` se a venda não é de cartão direto (ou a parcela foi cancelada).
 */
async function vendaCartaoDireto(tx: Transacao, viagemId: string): Promise<{ fornecedorCartaoId: string | null } | null> {
  const [v] = await tx
    .select({ fornecedorCartaoId: vendas.fornecedorCartaoId })
    .from(vendas)
    .innerJoin(
      parcelasReceber,
      and(eq(parcelasReceber.vendaId, vendas.id), eq(parcelasReceber.meio, "cartao_fornecedor"), ne(parcelasReceber.status, "cancelada")),
    )
    .where(eq(vendas.viagemId, viagemId))
    .limit(1);
  return v ?? null;
}

/**
 * A conta é do fornecedor que recebeu no cartão numa venda de cartão direto da viagem (a mesma condição do
 * `no_cartao` da view): o cliente pagou esse fornecedor e a conta em reais é quitada só pelo repasse (que não
 * passa por `baixarPagamentoNa`). A em moeda estrangeira é baixada antes, na viagem, com o câmbio efetivo.
 */
function pagoNoCartao(cartao: { fornecedorCartaoId: string | null } | null, conta: ContaLinha): boolean {
  return cartao !== null && conta.fornecedorId !== null && cartao.fornecedorCartaoId === conta.fornecedorId;
}

/**
 * Baixa do pagamento: data, valor pago na moeda da conta e conta bancária ativa; fora do real, câmbio efetivo
 * obrigatório e o valor em reais é a conversão (meio para cima). A conta fica `paga` quando todas as linhas estão
 * pagas.
 */
export function baixarPagamentoNa(tx: Transacao, usuarioId: string, pagamentoId: string, dados: BaixaPagamentoValidada): Promise<Feito | Falha> {
  const { pagoEm, valorOriginalPago, cambioEfetivo, contaBancariaId } = dados;
  return noPagamento(tx, usuarioId, pagamentoId, async (t, p, conta) => {
    if (p.repasseParcelaId) return PAGO_PELO_REPASSE;
    // Compra no cartão corporativo: sai do banco pela fatura (baixa da fatura do cartão), nunca direto.
    if (p.faturaCartaoId) return COMPRA_NO_CARTAO;
    if (p.status === "pago") return falha(MSG_PAGAMENTO_PAGO);
    const cartao = await vendaCartaoDireto(t, conta.viagemId);
    // Venda antiga de cartão direto sem o fornecedor do cartão: qualquer baixa espera a escolha (senão o pagamento
    // feito pela ECLAK a esse fornecedor reduziria o repasse esperado depois).
    if (cartao && !cartao.fornecedorCartaoId) return falha(MSG_ESCOLHA_FORNECEDOR_ANTES);
    // Em moeda estrangeira a baixa direta continua (com o câmbio): o repasse exige que ela venha antes.
    if (conta.moeda === "BRL" && pagoNoCartao(cartao, conta)) return falha(MSG_PAGO_NO_CARTAO);
    const cambio = conta.moeda === "BRL" ? null : cambioEfetivo;
    if (conta.moeda !== "BRL" && !cambio) return falha(MSG_CAMBIO_EFETIVO, "cambioEfetivo");
    const semConta = await recusaContaBancaria(t, contaBancariaId);
    if (semConta) return semConta;
    const valorBrlPago = cambio ? converter(valorOriginalPago, cambio) : valorOriginalPago;
    return { status: "pago", pagoEm, valorOriginalPago, cambioEfetivo: cambio, valorBrlPago, contaBancariaId };
  });
}

/** Desfaz a baixa do pagamento; a conta volta a `a_pagar`. O pago pela fatura do cartão volta só por ela. */
export function desfazerBaixaPagamentoNa(tx: Transacao, usuarioId: string, pagamentoId: string): Promise<Feito | Falha> {
  return noPagamento(tx, usuarioId, pagamentoId, async (_t, p) =>
    p.repasseParcelaId
      ? PAGO_PELO_REPASSE
      : p.status !== "pago"
        ? falha(MSG_PAGAMENTO_EM_ABERTO)
        : pagoPelaFatura(p)
          ? DESFACA_FATURA_CARTAO
          : { ...PAGAMENTO_EM_ABERTO_DE_NOVO },
  );
}

/** Pagamento quitado pela baixa da fatura do cartão: pago, na fatura e sem conta bancária (o banco viu só a fatura). */
export const pagoPelaFatura = (p: PagamentoLinha): boolean => p.status === "pago" && p.faturaCartaoId !== null && p.contaBancariaId === null && p.repasseParcelaId === null;

/** Pagamento de volta a `a_pagar`: limpa a baixa. */
export const PAGAMENTO_EM_ABERTO_DE_NOVO = {
  status: "a_pagar",
  pagoEm: null,
  valorOriginalPago: null,
  cambioEfetivo: null,
  valorBrlPago: null,
  contaBancariaId: null,
} as const;

// ---------------------------------------------------------------------------
// Cartão direto no fornecedor (regra a): o cliente paga o pacote inteiro na maquininha de um fornecedor, que fica
// com o seu custo e repassa a diferença à ECLAK. A parcela (única) não tem baixa direta: o repasse baixa a parcela
// pelo valor (o cliente pagou tudo), com taxa efetiva = repasse esperado − valor repassado, e quita os pagamentos
// em aberto desse fornecedor na viagem pelo previsto, sem conta bancária (o dinheiro não passou pelo caixa) e
// ligados à parcela (`repasse_parcela_id`). O repasse esperado é o da view `lancamentos_financeiros` (fonte única).
// ---------------------------------------------------------------------------

const VIAGEM_NAO_ENCONTRADA = falha("Viagem não encontrada");

/** Parcela de cartão direto travada, com o fornecedor do cartão da venda (nulo em venda antiga). */
async function parcelaDoCartao(tx: Transacao, parcelaId: string, viagemId: string): Promise<{ p: ParcelaLinha; fornecedorId: string | null } | Falha> {
  const p = await parcelaTravada(tx, parcelaId, viagemId);
  if (!p) return PARCELA_NAO_ENCONTRADA;
  if (p.meio !== "cartao_fornecedor") return NAO_CARTAO_FORNECEDOR;
  const [v] = await tx.select({ fornecedorId: vendas.fornecedorCartaoId }).from(vendas).where(eq(vendas.id, p.vendaId));
  return { p, fornecedorId: v?.fornecedorId ?? null };
}

/** Contas ativas do fornecedor na viagem, `for update` (o mesmo filtro do custo do repasse na view). */
function contasDoFornecedor(tx: Transacao, viagemId: string, fornecedorId: string): Promise<ContaLinha[]> {
  return tx
    .select()
    .from(contasPagar)
    .where(
      and(
        eq(contasPagar.viagemId, viagemId),
        eq(contasPagar.fornecedorId, fornecedorId),
        isNull(contasPagar.excluidoEm),
        ne(contasPagar.status, "cancelada"),
      ),
    )
    .orderBy(asc(contasPagar.id))
    .for("update");
}

/**
 * Repasse do fornecedor do cartão: data, valor repassado (≥ 0) e conta bancária ativa (onde o repasse entrou).
 * Recusa sem fornecedor escolhido, com pagamento em aberto em moeda estrangeira desse fornecedor (dá-se baixa nele
 * na viagem, com o câmbio) e com repasse maior que o esperado.
 */
export function baixarRepasseNa(tx: Transacao, usuarioId: string, parcelaId: string, dados: RepasseValidado): Promise<Feito | Falha> {
  return naViagemVendidaNa(
    tx,
    (t) => viagemDaParcela(t, parcelaId),
    PARCELA_NAO_ENCONTRADA,
    async (t, v) => {
      const c = await parcelaDoCartao(t, parcelaId, v.id);
      if (ehFalha(c)) return c;
      const { p, fornecedorId } = c;
      const fechada = recusaParcelaFechada(p);
      if (fechada) return fechada;
      if (!fornecedorId) return falha(MSG_FORNECEDOR_CARTAO, "fornecedorCartaoId");
      const contas: { conta: ContaLinha; linhas: PagamentoLinha[] }[] = [];
      for (const conta of await contasDoFornecedor(t, v.id, fornecedorId)) contas.push({ conta, linhas: await linhasDaConta(t, conta.id) });
      if (contas.some(({ conta, linhas }) => conta.moeda !== "BRL" && linhas.some((l) => l.status !== "pago"))) return falha(MSG_REPASSE_ESTRANGEIRA);
      // Depois das travas: o esperado da view já vê as linhas como estão (fonte única; nunca recalculado aqui).
      const [linha] = await t
        .select({ esperado: lancamentosFinanceiros.valorPrevisto })
        .from(lancamentosFinanceiros)
        .where(and(eq(lancamentosFinanceiros.origem, "parcela"), eq(lancamentosFinanceiros.id, p.id)));
      if (!linha) return PARCELA_NAO_ENCONTRADA;
      if (dados.valorRepassado > linha.esperado) return falha(MSG_REPASSE_MAIOR, "valorRepassado");
      const semConta = await recusaContaBancaria(t, dados.contaBancariaId);
      if (semConta) return semConta;

      const parcela = {
        status: "recebida" as const,
        recebidaEm: dados.data,
        valorRecebido: p.valor,
        taxaEfetiva: linha.esperado - dados.valorRepassado,
        valorRepassado: dados.valorRepassado,
        contaBancariaId: dados.contaBancariaId,
      };
      await t.update(parcelasReceber).set(parcela).where(eq(parcelasReceber.id, p.id));
      await auditarAlteracao(t, usuarioId, "parcelas_receber", p, parcela);
      for (const { conta, linhas } of contas) {
        const abertas = linhas.filter((x) => x.status !== "pago");
        if (abertas.length === 0) continue;
        for (const l of abertas) {
          const pago = {
            status: "pago" as const,
            pagoEm: dados.data,
            valorOriginalPago: l.valorOriginal,
            cambioEfetivo: null,
            valorBrlPago: l.valorBrlPrevisto,
            contaBancariaId: null,
            repasseParcelaId: p.id,
          };
          await t.update(pagamentosFornecedor).set(pago).where(eq(pagamentosFornecedor.id, l.id));
          await auditarAlteracao(t, usuarioId, "pagamentos_fornecedor", l, pago);
        }
        await acertarStatusConta(t, usuarioId, conta, linhas.map(() => "pago"));
      }
      return OK;
    },
  );
}

/**
 * Desfaz o repasse (ou o cancelamento) da parcela de cartão direto: a parcela volta a `a_receber` e todos os
 * pagamentos quitados por ela voltam a `a_pagar`, sem o vínculo; as contas voltam a `a_pagar`.
 */
export function desfazerRepasseNa(tx: Transacao, usuarioId: string, parcelaId: string): Promise<Feito | Falha> {
  return naViagemVendidaNa(
    tx,
    (t) => viagemDaParcela(t, parcelaId),
    PARCELA_NAO_ENCONTRADA,
    async (t, v) => {
      const c = await parcelaDoCartao(t, parcelaId, v.id);
      if (ehFalha(c)) return c;
      const { p, fornecedorId } = c;
      if (p.status === "a_receber") return falha(MSG_PARCELA_EM_ABERTO);
      // Cancelada: enquanto isso o fornecedor do cartão pode ter sido pago pelo banco (a venda deixou de ser cartão
      // direto). Reabrir o cartão direto tiraria essa saída do caixa: desfaça antes a baixa do pagamento.
      if (p.status === "cancelada" && fornecedorId && (await fornecedorPagoPeloBanco(t, v.id, fornecedorId))) return falha(MSG_FORNECEDOR_JA_PAGO);
      const donos = await t
        .selectDistinct({ contaId: pagamentosFornecedor.contaId })
        .from(pagamentosFornecedor)
        .where(eq(pagamentosFornecedor.repasseParcelaId, p.id));
      const contaIds = donos.map((d) => d.contaId).sort();
      const contas =
        contaIds.length === 0
          ? []
          : await t.select().from(contasPagar).where(and(inArray(contasPagar.id, contaIds), eq(contasPagar.viagemId, v.id))).orderBy(asc(contasPagar.id)).for("update");
      for (const conta of contas) {
        const linhas = await linhasDaConta(t, conta.id);
        const depois = { ...PAGAMENTO_EM_ABERTO_DE_NOVO, repasseParcelaId: null };
        for (const l of linhas.filter((x) => x.repasseParcelaId === p.id)) {
          await t.update(pagamentosFornecedor).set(depois).where(eq(pagamentosFornecedor.id, l.id));
          await auditarAlteracao(t, usuarioId, "pagamentos_fornecedor", l, depois);
        }
        await acertarStatusConta(t, usuarioId, conta, linhas.map((l) => (l.repasseParcelaId === p.id ? "a_pagar" : l.status)));
      }
      const parcela = { ...PARCELA_EM_ABERTO_DE_NOVO };
      await t.update(parcelasReceber).set(parcela).where(eq(parcelasReceber.id, p.id));
      await auditarAlteracao(t, usuarioId, "parcelas_receber", p, parcela);
      return OK;
    },
  );
}

/** Pagamento em reais a esse fornecedor na viagem já feito pela ECLAK (com conta bancária, não pelo repasse). */
async function fornecedorPagoPeloBanco(tx: Transacao, viagemId: string, fornecedorId: string): Promise<boolean> {
  for (const conta of await contasDoFornecedor(tx, viagemId, fornecedorId)) {
    if (conta.moeda !== "BRL") continue;
    if ((await linhasDaConta(tx, conta.id)).some((l) => l.status === "pago" && l.contaBancariaId !== null)) return true;
  }
  return false;
}

/**
 * Fornecedor que recebeu no cartão (venda antiga, sem ele, ou troca antes do repasse): precisa ter conta ativa na
 * viagem. Recusa venda que não é de cartão direto e parcela já recebida pelo repasse.
 */
export function definirFornecedorCartaoNa(tx: Transacao, usuarioId: string, viagemId: string, fornecedorId: string): Promise<Feito | Falha> {
  return naViagemVendidaNa(
    tx,
    async () => viagemId,
    VIAGEM_NAO_ENCONTRADA,
    async (t, v) => {
      const [venda] = await t.select().from(vendas).where(eq(vendas.viagemId, v.id)).for("update");
      if (!venda) return VIAGEM_NAO_ENCONTRADA;
      const parcelas = await t
        .select({ status: parcelasReceber.status })
        .from(parcelasReceber)
        .where(and(eq(parcelasReceber.vendaId, venda.id), eq(parcelasReceber.meio, "cartao_fornecedor")))
        .for("update");
      if (parcelas.length === 0) return NAO_CARTAO_FORNECEDOR;
      if (parcelas.some((p) => p.status === "recebida")) return falha(MSG_DESFACA_REPASSE);
      const contas = await contasDoFornecedor(t, v.id, fornecedorId);
      if (contas.length === 0) return falha(MSG_FORNECEDOR_CARTAO, "fornecedorCartaoId");
      if (venda.fornecedorCartaoId === fornecedorId) return OK;
      // Pagamento em reais já feito pela ECLAK (com conta bancária) a esse fornecedor reduziria o repasse esperado.
      if (await fornecedorPagoPeloBanco(t, v.id, fornecedorId)) return falha(MSG_FORNECEDOR_JA_PAGO, "fornecedorCartaoId");
      const depois = { fornecedorCartaoId: fornecedorId };
      await t.update(vendas).set(depois).where(eq(vendas.id, venda.id));
      await auditarAlteracao(t, usuarioId, "vendas", venda, depois);
      return OK;
    },
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
