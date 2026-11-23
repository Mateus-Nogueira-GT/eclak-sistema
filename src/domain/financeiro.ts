import type { Filial } from "./perfis";
import { cronogramaRecebimento, somarMeses } from "./venda";

// Domínio do financeiro (fatia 4a): listas, parcelamento e recorrência de lançamentos. Datas "AAAA-MM-DD".

/** Texto exato, nesta ordem (o banco guarda um slug; o rótulo mora aqui). */
export const FORMAS_FINANCEIRO = [
  "A prazo",
  "Boleto bancário",
  "Cartão de crédito",
  "Cartão de débito",
  "Débito em conta",
  "Depósito bancário",
  "Dinheiro",
  "PIX",
  "Transferência",
] as const;
export type FormaFinanceiro = (typeof FORMAS_FINANCEIRO)[number];

/** Valores do enum `forma_financeiro` no banco, 1:1 e na mesma ordem de `FORMAS_FINANCEIRO`. */
export const FORMAS_FINANCEIRO_SLUG = [
  "a_prazo",
  "boleto",
  "cartao_credito",
  "cartao_debito",
  "debito_conta",
  "deposito",
  "dinheiro",
  "pix",
  "transferencia",
] as const;
export type FormaFinanceiroSlug = (typeof FORMAS_FINANCEIRO_SLUG)[number];
export const ROTULO_FORMA_FINANCEIRO: Record<FormaFinanceiroSlug, FormaFinanceiro> = {
  a_prazo: "A prazo",
  boleto: "Boleto bancário",
  cartao_credito: "Cartão de crédito",
  cartao_debito: "Cartão de débito",
  debito_conta: "Débito em conta",
  deposito: "Depósito bancário",
  dinheiro: "Dinheiro",
  pix: "PIX",
  transferencia: "Transferência",
};

export const STATUS_LANCAMENTO = ["em_aberto", "baixado", "cancelado"] as const;
export type StatusLancamento = (typeof STATUS_LANCAMENTO)[number];

/** Categorias fixas usadas pelas linhas de viagem (`categorias_financeiras.sistema`). */
export const CATEGORIAS_SISTEMA = ["vendas_viagem", "fornecedores_viagem", "comissoes_hotel", "comissoes_operadora"] as const;
export type CategoriaSistema = (typeof CATEGORIAS_SISTEMA)[number];

export const LADOS = ["pagar", "receber"] as const;
export type Lado = (typeof LADOS)[number];

export const CENTROS = ["MT", "RS"] as const;
export type Centro = (typeof CENTROS)[number];

/** Centro de custo = filial da viagem. */
export function centroDaFilial(filial: Filial): Centro {
  return filial === "RS" ? "RS" : "MT";
}

/** De onde vem a linha da view `lancamentos_financeiros`. */
export const ORIGENS = ["manual", "parcela", "pagamento", "comissao"] as const;
export type Origem = (typeof ORIGENS)[number];

export const SITUACOES = ["vencida", "vence_hoje", "a_vencer", "baixada", "cancelada"] as const;
export type Situacao = (typeof SITUACOES)[number];

/** O cálculo da situação mora na view/query; aqui só o rótulo. */
export function rotuloSituacao(situacao: Situacao, lado: Lado): string {
  switch (situacao) {
    case "vencida":
      return "Vencida";
    case "vence_hoje":
      return "Vence hoje";
    case "a_vencer":
      return "A vencer";
    case "baixada":
      return lado === "pagar" ? "Paga" : "Recebida";
    case "cancelada":
      return "Cancelada";
  }
}

export type ParcelaDividida = { numero: number; total: number; vencimento: string; valor: bigint };

/** Parcelas mensais (mesma regra do recebimento da venda): truncado ao centavo, a última absorve a diferença. */
export function dividirEmParcelas(total: bigint, n: number, primeiro: string): ParcelaDividida[] {
  return cronogramaRecebimento(total, n, primeiro).map((p) => ({ ...p, total: n }));
}

export const FREQUENCIAS = ["semanal", "mensal", "anual"] as const;
export type Frequencia = (typeof FREQUENCIAS)[number];

function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/**
 * Datas de uma série recorrente. Mensal e anual voltam sempre ao dia original (dia inexistente → último do mês,
 * sem "deslizar": 31/01 → 28/02 → 31/03); semanal soma 7 dias.
 */
export function datasRecorrentes(primeiro: string, frequencia: Frequencia, quantidade: number): string[] {
  if (!Number.isInteger(quantidade) || quantidade < 1) throw new Error("Quantidade inválida");
  somarMeses(primeiro, 0); // valida a data
  return Array.from({ length: quantidade }, (_, i) => {
    switch (frequencia) {
      case "semanal":
        return somarDias(primeiro, 7 * i);
      case "mensal":
        return somarMeses(primeiro, i);
      case "anual":
        return somarMeses(primeiro, 12 * i);
    }
  });
}

/** `AAAA-MM` de uma data. */
export function competenciaDe(data: string): string {
  return data.slice(0, 7);
}
