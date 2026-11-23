import { z } from "zod";

// Faturas (spec §6.4): uma por venda, numeradas na emissão pelo financeiro; reemissão mantém o número com um novo
// retrato fixo. "Desatualizada" é calculada na leitura: o retrato da última versão comparado às parcelas atuais
// não canceladas (número, vencimento e valor).

export const MSG_JA_ATUALIZADA = "A fatura já está atualizada";
export const MSG_NUMERACAO_SO_AVANCA = "Já há faturas emitidas: a numeração só avança";
export const MSG_NUMERO_FATURA = "Informe um número de 1 a 999999";
export const msgJaTemFatura = (numero: number) => `Esta venda já tem a fatura ${numero}`;

/** Parcela no retrato (centavos como texto): `numero` de `total` (n/N). */
export type ParcelaRetrato = { numero: number; total: number; vencimento: string; valor: string };

const chave = (p: Pick<ParcelaRetrato, "numero" | "vencimento" | "valor">) => `${p.numero}|${p.vencimento}|${p.valor}`;

/** O retrato e as parcelas atuais não canceladas diferem em quantidade, número, vencimento ou valor? */
export function parcelasMudaram(retrato: readonly ParcelaRetrato[], atuais: readonly ParcelaRetrato[]): boolean {
  if (retrato.length !== atuais.length) return true;
  const a = retrato.map(chave).sort();
  const b = atuais.map(chave).sort();
  return a.some((x, i) => x !== b[i]);
}

/** Próximo número de fatura (Admin › Parâmetros). */
export const numeroFaturaSchema = z.number({ error: MSG_NUMERO_FATURA }).int(MSG_NUMERO_FATURA).min(1, MSG_NUMERO_FATURA).max(999_999, MSG_NUMERO_FATURA);

export type TotaisFatura = {
  /** Valor da venda (contratado). */
  venda: bigint;
  /** Soma das parcelas canceladas (0 nas versões antigas, sem o campo). */
  canceladas: bigint;
  /** "2/6, 4/6": as canceladas, para explicar a diferença. */
  numerosCancelados: string;
  /** Total a pagar = soma das parcelas listadas no retrato. */
  aPagar: bigint;
};

/** Reconciliação do retrato: valor da venda − canceladas = total a pagar (Σ das parcelas listadas). */
export function totaisDaFatura(d: {
  total: string;
  parcelas: readonly Pick<ParcelaRetrato, "valor">[];
  canceladas?: string;
  parcelasCanceladas?: readonly { numero: number; total: number }[];
}): TotaisFatura {
  return {
    venda: BigInt(d.total),
    canceladas: BigInt(d.canceladas ?? "0"),
    numerosCancelados: (d.parcelasCanceladas ?? []).map((p) => `${p.numero}/${p.total}`).join(", "),
    aPagar: d.parcelas.reduce((s, p) => s + BigInt(p.valor), 0n),
  };
}
