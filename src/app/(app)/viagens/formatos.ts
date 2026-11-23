import type { Moeda } from "@/domain/cambio";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";

/** "2027-08-14" → "14/08/2027". */
export const dataBr = (iso: string | null | undefined) => (iso ? iso.split("-").reverse().join("/") : "");

const PREFIXO: Record<Moeda, string> = { BRL: "R$", USD: "US$", EUR: "EUR", GBP: "GBP", CHF: "CHF" };

/** Centavos na moeda: "R$ 1.234,56", "EUR 1.234,56". */
export function formatarMoeda(centavos: bigint, moeda: Moeda): string {
  if (moeda === "BRL") return formatarReais(centavos);
  return `${PREFIXO[moeda]} ${formatarReais(centavos).replace("R$ ", "")}`;
}

/** Valor para preencher campo: "1.234,56" (sem símbolo). */
export const reaisParaCampo = (centavos: bigint) => formatarReais(centavos).replace("R$ ", "");

/** "4.000" → "4". Para preencher campo de percentual. */
export const pctParaCampo = (p: string) => formatarPercentual(p).replace("%", "");

/** "19.0" → "19,0%". */
export const pct1 = (p: string) => `${p.replace(".", ",")}%`;

/** Data e hora em Cuiabá: "21/11/2026 14:30". */
export function dataHora(d: Date | string): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba", dateStyle: "short", timeStyle: "short" })
    .format(new Date(d))
    .replace(",", "");
}

export const dataCurta = (d: Date | string) =>
  new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba", dateStyle: "short" }).format(new Date(d));

/** Quantidade com dois dígitos: 2 → "02". */
export const doisDigitos = (n: number) => String(n).padStart(2, "0");
