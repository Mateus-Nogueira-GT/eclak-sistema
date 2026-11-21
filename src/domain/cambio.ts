import { arredondar, lerDecimal } from "./decimal";

export const MOEDAS = ["BRL", "USD", "EUR", "GBP", "CHF"] as const;
export type Moeda = (typeof MOEDAS)[number];

const ESCALA_CAMBIO = 10_000n; // câmbio com 4 casas
const E = 1_000_000n; // percentual: 1 unidade = 0,0001%

function formatarCambio(u: bigint): string {
  return `${u / ESCALA_CAMBIO}.${(u % ESCALA_CAMBIO).toString().padStart(4, "0")}`;
}

/** Câmbio aplicado = comercial × (1 + acréscimo), com 4 casas, meio para cima. Ex.: ("5.8930", "4.500") → "6.1582". */
export function cambioAplicado(comercial: string, acrescimoPct: string): string {
  const c = lerDecimal(comercial, 4);
  const a = lerDecimal(acrescimoPct, 4);
  return formatarCambio(arredondar(c * (E + a), E));
}

/** Centavos da moeda original × câmbio (string com até 4 casas) → centavos de real, meio para cima. */
export function converter(valorOriginal: bigint, cambio: string): bigint {
  return arredondar(valorOriginal * lerDecimal(cambio, 4), ESCALA_CAMBIO);
}
