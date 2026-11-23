// Aritmética decimal exata sobre bigint, compartilhada por precificação e câmbio.

/** numerador / denominador arredondado ao inteiro, meio para cima (afastando do zero), sinal respeitado. */
export function arredondar(numerador: bigint, denominador: bigint): bigint {
  if (denominador === 0n) throw new Error("Divisão por zero");
  if (denominador < 0n) {
    numerador = -numerador;
    denominador = -denominador;
  }
  const neg = numerador < 0n;
  const abs = neg ? -numerador : numerador;
  const q = (2n * abs + denominador) / (2n * denominador);
  return neg ? -q : q;
}

/** "7.7367" → 77367n com `casas` = 4 (inteiro na escala 10^casas). Aceita até `casas` decimais, sem sinal. */
export function lerDecimal(texto: string, casas: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(texto);
  if (!m || (m[2]?.length ?? 0) > casas) throw new Error("Valor inválido");
  return BigInt(m[1]) * 10n ** BigInt(casas) + BigInt((m[2] ?? "").padEnd(casas, "0"));
}
