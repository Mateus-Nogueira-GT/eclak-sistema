import { arredondar, lerDecimal } from "./decimal";

export const MOEDAS = ["BRL", "USD", "EUR", "GBP", "CHF"] as const;
export type Moeda = (typeof MOEDAS)[number];

const ESCALA_CAMBIO = 10_000n; // câmbio com 4 casas
const E = 1_000_000n; // percentual: 1 unidade = 0,0001%

function textoCambio(u: bigint): string {
  return `${u / ESCALA_CAMBIO}.${(u % ESCALA_CAMBIO).toString().padStart(4, "0")}`;
}

/** Câmbio aplicado = comercial × (1 + acréscimo), com 4 casas, meio para cima. Ex.: ("5.8930", "4.500") → "6.1582". */
export function cambioAplicado(comercial: string, acrescimoPct: string): string {
  const c = lerDecimal(comercial, 4);
  const a = lerDecimal(acrescimoPct, 4);
  return textoCambio(arredondar(c * (E + a), E));
}

/** Centavos da moeda original × câmbio (string com até 4 casas) → centavos de real, meio para cima. */
export function converter(valorOriginal: bigint, cambio: string): bigint {
  return arredondar(valorOriginal * lerDecimal(cambio, 4), ESCALA_CAMBIO);
}

/**
 * Câmbio efetivo de uma compra no cartão em moeda estrangeira: reais cobrados ÷ valor original, com 4 casas, meio
 * para cima (centavos sobre centavos). `null` sem valor original ou acima do que a coluna guarda (999.999,9999).
 */
export function cambioEfetivoDe(valorBrl: bigint, valorOriginal: bigint): string | null {
  if (valorOriginal <= 0n) return null;
  const u = arredondar(valorBrl * ESCALA_CAMBIO, valorOriginal);
  return u > 9_999_999_999n ? null : textoCambio(u);
}

/** Texto digitado ("5,4210", "5.4210", "5,42") → forma canônica com 4 casas ("5.4210"); de 0,0001 a 9999,9999. */
export function lerCambio(texto: string): string {
  const m = /^(\d{1,4})(?:[.,](\d{1,4}))?$/.exec(texto.trim());
  if (!m) throw new Error("Câmbio inválido");
  const t = `${BigInt(m[1])}.${(m[2] ?? "").padEnd(4, "0")}`;
  if (lerDecimal(t, 4) === 0n) throw new Error("Câmbio inválido");
  return t;
}

/** "5.4210" → "5,4210". */
export function formatarCambio(canonico: string): string {
  return canonico.replace(".", ",");
}
