import "server-only";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { cambioEfetivoDe } from "@/domain/cambio";
import { MSG_VALOR_BRL_CARTAO, type BaixaFaturaCartaoValidada } from "@/domain/financeiro-entrada";
import { MSG_CONTA_BANCARIA } from "@/domain/venda-entrada";
import type { Transacao } from "@/server/db/client";
import { contasPagar, faturasCartao, lancamentos, pagamentosFornecedor } from "@/server/db/schema";
import {
  CONCILIADA,
  NAO_VENDIDA,
  PAGAMENTO_EM_ABERTO_DE_NOVO,
  acertarStatusConta,
  auditarAlteracao,
  contaBancariaAtiva,
  contaTravada,
  falha,
  linhasDaConta,
  pagoPelaFatura,
  type ContaLinha,
  type Falha,
  type PagamentoLinha,
} from "@/server/financeiro/baixas-viagem";
import { travarFaturasDaBaixaNa, type FaturaCartaoLinha } from "@/server/financeiro/cartoes";
import { travarViagem } from "@/server/trava-viagem";

// Fora dos arquivos "use server" de propósito: nada aqui pode virar endpoint. Baixa (e desfazer) da fatura do cartão
// corporativo, o mesmo código para a lista única (individual e lote) e para a tela de cartões. Padrão do repasse:
// uma saída só no banco (a da fatura, pelo total); as compras ficam quitadas sem passar de novo pelo caixa — as
// manuais `baixado` com a conta da baixa da fatura (a view as deixa fora do caixa, `transita_caixa = false`), os
// pagamentos de viagem `pago` sem conta bancária, com a fatura (`fatura_cartao_id`) como vínculo.
//
// Travas na ordem única de `src/server/financeiro/cartoes.ts`: descobrir as compras e as viagens sem trava → travar as
// viagens (`travarViagem`, ordem crescente de id; recusa viagem conciliada ou não vendida) → as contas e as linhas
// de pagamento (`for update`, contas por id) → os lançamentos manuais (`for update`, por id) → os cartões e as
// faturas (`travarFaturasDaBaixaNa`, ordem `(cartao_id, fechamento)`) → reler as compras: se o conjunto mudou entre
// a descoberta e as travas, recusa (nada gravado) → validar tudo → gravar → auditar. Recusa volta como `Falha` e é
// decidida antes de qualquer escrita.

export const FATURA_NAO_ENCONTRADA = falha("Fatura do cartão não encontrada");
const FATURA_PAGA = falha("Fatura do cartão já paga");
const FATURA_NAO_PAGA = falha("Esta fatura do cartão não foi paga");
const SEM_COMPRAS = falha("Fatura do cartão sem compras");
const COMPRA_JA_BAIXADA = falha("Há compra desta fatura baixada fora dela: desfaça a baixa dessa compra antes");
const MUDOU = falha("A fatura do cartão mudou enquanto a baixa era feita: tente de novo");

type LancamentoLinha = typeof lancamentos.$inferSelect;
type Modo = "baixa" | "desfazer";

/** Sucesso: as viagens mexidas (para revalidar as telas delas). */
export type FeitoFatura = { ok: true; viagens: string[] };

/** As compras de uma fatura, travadas: manuais e pagamentos (com a conta e todas as linhas dela, para o status). */
type FaturaComCompras = {
  fatura: FaturaCartaoLinha;
  manuais: LancamentoLinha[];
  pagamentos: { p: PagamentoLinha; conta: ContaLinha }[];
};

/**
 * Compras das faturas, sem trava. Na baixa, o critério da view (manuais não canceladas; pagamentos de contas ativas);
 * no desfazer, o que a baixa quitou (manuais baixadas; pagamentos pagos pela fatura de contas não excluídas).
 */
async function descobrir(tx: Transacao, faturaIds: string[], modo: Modo) {
  const manuais = await tx
    .select({ id: lancamentos.id, faturaId: lancamentos.faturaCartaoId })
    .from(lancamentos)
    .where(and(inArray(lancamentos.faturaCartaoId, faturaIds), modo === "baixa" ? ne(lancamentos.status, "cancelado") : eq(lancamentos.status, "baixado")));
  const pagamentos = await tx
    .select({ id: pagamentosFornecedor.id, faturaId: pagamentosFornecedor.faturaCartaoId, contaId: pagamentosFornecedor.contaId, viagemId: contasPagar.viagemId })
    .from(pagamentosFornecedor)
    .innerJoin(contasPagar, eq(contasPagar.id, pagamentosFornecedor.contaId))
    .where(
      and(
        inArray(pagamentosFornecedor.faturaCartaoId, faturaIds),
        isNull(contasPagar.excluidoEm),
        modo === "baixa"
          ? ne(contasPagar.status, "cancelada")
          : and(eq(pagamentosFornecedor.status, "pago"), isNull(pagamentosFornecedor.contaBancariaId), isNull(pagamentosFornecedor.repasseParcelaId)),
      ),
    );
  return { manuais, pagamentos };
}
type Descoberta = Awaited<ReturnType<typeof descobrir>>;

const assinatura = (d: Descoberta) =>
  [...d.manuais.map((m) => `m:${m.faturaId}:${m.id}`), ...d.pagamentos.map((p) => `p:${p.faturaId}:${p.id}`)].sort().join(",");

/** As viagens das compras das faturas (sem trava), em ordem crescente: o lote as trava antes de tudo. */
export async function viagensDasFaturas(tx: Transacao, faturaIds: string[]): Promise<string[]> {
  if (faturaIds.length === 0) return [];
  const { pagamentos } = await descobrir(tx, faturaIds, "baixa");
  return [...new Set(pagamentos.map((p) => p.viagemId))].sort();
}

/**
 * Trava tudo na ordem única e relê o conjunto de compras. `viagensTravadas` (lote): as viagens que o chamador já
 * travou; viagem nova no conjunto é recusada como "mudou" (travá-la agora quebraria a ordem crescente).
 */
async function travarFaturas(
  tx: Transacao,
  usuarioId: string,
  faturaIds: string[],
  modo: Modo,
  viagensTravadas?: Set<string>,
): Promise<{ faturas: FaturaComCompras[]; viagens: string[] } | Falha> {
  const ids = [...new Set(faturaIds)];
  const antes = await descobrir(tx, ids, modo);
  const viagens = [...new Set(antes.pagamentos.map((p) => p.viagemId))].sort();
  if (viagensTravadas && viagens.some((v) => !viagensTravadas.has(v))) return MUDOU;
  for (const id of viagens) {
    const v = await travarViagem(tx, id);
    if (!v) return MUDOU;
    if (v.status !== "vendida") return NAO_VENDIDA;
    if (v.conciliadaEm) return CONCILIADA;
  }
  const contas = new Map<string, { conta: ContaLinha; linhas: PagamentoLinha[] }>();
  const viagemDaConta = new Map(antes.pagamentos.map((p) => [p.contaId, p.viagemId]));
  for (const contaId of [...viagemDaConta.keys()].sort()) {
    const conta = await contaTravada(tx, contaId, viagemDaConta.get(contaId)!);
    if (!conta) return MUDOU;
    contas.set(contaId, { conta, linhas: await linhasDaConta(tx, contaId) });
  }
  const idsManuais = antes.manuais.map((m) => m.id);
  const manuais =
    idsManuais.length === 0 ? [] : await tx.select().from(lancamentos).where(inArray(lancamentos.id, idsManuais)).orderBy(asc(lancamentos.id)).for("update");
  const travadas = await travarFaturasDaBaixaNa(tx, usuarioId, ids);
  // Com as faturas travadas ninguém vincula compra nova; as compras travadas não mudam mais.
  const depois = await descobrir(tx, ids, modo);
  if (assinatura(depois) !== assinatura(antes)) return MUDOU;
  const faturas: FaturaComCompras[] = [];
  for (const [i, fatura] of travadas.entries()) {
    if (!fatura) return FATURA_NAO_ENCONTRADA;
    const id = ids[i];
    const pagamentos = antes.pagamentos
      .filter((p) => p.faturaId === id)
      .map((x) => {
        const c = contas.get(x.contaId)!;
        return { p: c.linhas.find((l) => l.id === x.id)!, conta: c.conta };
      });
    if (pagamentos.some((x) => !x.p)) return MUDOU;
    faturas.push({ fatura, manuais: manuais.filter((m) => m.faturaCartaoId === id), pagamentos });
  }
  return { faturas, viagens };
}

/** Acerta o status de cada conta mexida pelas linhas novas (`pagos`: ids que mudam para `status`). */
async function acertarContas(tx: Transacao, usuarioId: string, faturas: FaturaComCompras[], status: PagamentoLinha["status"]): Promise<void> {
  const mudam = new Set(faturas.flatMap((f) => f.pagamentos.map((x) => x.p.id)));
  const contas = new Map(faturas.flatMap((f) => f.pagamentos.map((x) => [x.conta.id, x.conta] as const)));
  for (const conta of [...contas.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const linhas = await tx.select({ id: pagamentosFornecedor.id, status: pagamentosFornecedor.status }).from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, conta.id));
    await acertarStatusConta(tx, usuarioId, conta, linhas.map((l) => (mudam.has(l.id) ? status : l.status)));
  }
}

/**
 * Baixa de uma ou mais faturas do cartão (o lote manda várias, todas em reais), numa passada de travas só. Cada fatura
 * fica `baixado` com a data, a conta bancária (ativa) e o valor pago = compras manuais (valor) + pagamentos em reais
 * (previsto) + pagamentos em moeda estrangeira (o valor em reais informado em `estrangeiras`, um por compra; câmbio
 * efetivo = reais ÷ valor original). Recusa fatura paga, sem compras, com compra já baixada fora dela e viagem
 * conciliada; nada gravado.
 */
export async function baixarFaturasCartaoNa(
  tx: Transacao,
  usuarioId: string,
  faturaIds: string[],
  dados: BaixaFaturaCartaoValidada,
  viagensTravadas?: Set<string>,
): Promise<FeitoFatura | Falha> {
  const t = await travarFaturas(tx, usuarioId, faturaIds, "baixa", viagensTravadas);
  if ("ok" in t) return t;
  const informados = new Map(dados.estrangeiras.map((e) => [e.pagamentoId, e.valorBrl]));
  const estrangeiras = new Set<string>();
  for (const { fatura, manuais, pagamentos } of t.faturas) {
    if (fatura.status === "baixado") return FATURA_PAGA;
    if (manuais.length + pagamentos.length === 0) return SEM_COMPRAS;
    if (manuais.some((m) => m.status !== "em_aberto") || pagamentos.some(({ p }) => p.status === "pago")) return COMPRA_JA_BAIXADA;
    for (const { p, conta } of pagamentos) {
      if (conta.moeda === "BRL") continue;
      estrangeiras.add(p.id);
      const valorBrl = informados.get(p.id);
      if (valorBrl === undefined) return falha(MSG_VALOR_BRL_CARTAO, `estrangeiras.${p.id}`);
      if (p.valorOriginal > 0n && cambioEfetivoDe(valorBrl, p.valorOriginal) === null) return falha("Valor em reais fora do esperado para esta compra", `estrangeiras.${p.id}`);
    }
  }
  const estranha = dados.estrangeiras.find((e) => !estrangeiras.has(e.pagamentoId));
  if (estranha) return falha("Esta compra não é uma compra em moeda estrangeira desta fatura", `estrangeiras.${estranha.pagamentoId}`);
  if (!(await contaBancariaAtiva(tx, dados.contaBancariaId))) return falha(MSG_CONTA_BANCARIA, "contaBancariaId");

  for (const { fatura, manuais, pagamentos } of t.faturas) {
    let total = 0n;
    for (const m of manuais) {
      const depois = {
        status: "baixado" as const,
        baixadoEm: dados.data,
        valorPago: m.valor,
        juros: 0n,
        desconto: 0n,
        baixaContaBancariaId: dados.contaBancariaId,
      };
      await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, m.id));
      await auditarAlteracao(tx, usuarioId, "lancamentos", m, depois);
      total += m.valor;
    }
    for (const { p, conta } of pagamentos) {
      const valorBrlPago = conta.moeda === "BRL" ? p.valorBrlPrevisto : informados.get(p.id)!;
      const depois = {
        status: "pago" as const,
        pagoEm: dados.data,
        valorOriginalPago: p.valorOriginal,
        cambioEfetivo: conta.moeda === "BRL" ? null : cambioEfetivoDe(valorBrlPago, p.valorOriginal),
        valorBrlPago,
        contaBancariaId: null,
      };
      await tx.update(pagamentosFornecedor).set(depois).where(eq(pagamentosFornecedor.id, p.id));
      await auditarAlteracao(tx, usuarioId, "pagamentos_fornecedor", p, depois);
      total += valorBrlPago;
    }
    const depois = { status: "baixado" as const, pagoEm: dados.data, valorPago: total, contaBancariaId: dados.contaBancariaId };
    await tx.update(faturasCartao).set(depois).where(eq(faturasCartao.id, fatura.id));
    await auditarAlteracao(tx, usuarioId, "faturas_cartao", fatura, depois);
  }
  await acertarContas(tx, usuarioId, t.faturas, "pago");
  return { ok: true, viagens: t.viagens };
}

export function baixarFaturaCartaoNa(tx: Transacao, usuarioId: string, faturaId: string, dados: BaixaFaturaCartaoValidada): Promise<FeitoFatura | Falha> {
  return baixarFaturasCartaoNa(tx, usuarioId, [faturaId], dados);
}

/**
 * Desfaz a baixa da fatura: a fatura volta a `em_aberto`, as compras manuais baixadas por ela e os pagamentos pagos
 * por ela voltam a ficar em aberto (com o vínculo à fatura), as contas voltam a `a_pagar`. Recusa viagem conciliada.
 */
export async function desfazerFaturaCartaoNa(tx: Transacao, usuarioId: string, faturaId: string): Promise<FeitoFatura | Falha> {
  const t = await travarFaturas(tx, usuarioId, [faturaId], "desfazer");
  if ("ok" in t) return t;
  const [{ fatura, manuais, pagamentos }] = t.faturas;
  if (fatura.status !== "baixado") return FATURA_NAO_PAGA;
  for (const m of manuais) {
    const depois = { status: "em_aberto" as const, baixadoEm: null, valorPago: null, juros: null, desconto: null, baixaContaBancariaId: null };
    await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, m.id));
    await auditarAlteracao(tx, usuarioId, "lancamentos", m, depois);
  }
  for (const { p } of pagamentos) {
    if (!pagoPelaFatura(p)) continue;
    const depois = { ...PAGAMENTO_EM_ABERTO_DE_NOVO };
    await tx.update(pagamentosFornecedor).set(depois).where(eq(pagamentosFornecedor.id, p.id));
    await auditarAlteracao(tx, usuarioId, "pagamentos_fornecedor", p, depois);
  }
  await acertarContas(tx, usuarioId, t.faturas, "a_pagar");
  const depois = { status: "em_aberto" as const, pagoEm: null, valorPago: null, contaBancariaId: null };
  await tx.update(faturasCartao).set(depois).where(eq(faturasCartao.id, fatura.id));
  await auditarAlteracao(tx, usuarioId, "faturas_cartao", fatura, depois);
  return { ok: true, viagens: t.viagens };
}
