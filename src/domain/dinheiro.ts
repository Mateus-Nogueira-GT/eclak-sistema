export type Centavos = bigint;

const ERRO = "Valor inválido";

/** Recebe o texto já sem símbolo; devolve [inteiro, decimais] como texto. */
function partes(texto: string, maxDecimais: number): [string, string] {
  const m = /^(\d+|\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/.exec(texto);
  if (!m) throw new Error(ERRO);
  const dec = m[2] ?? "";
  if (dec.length > maxDecimais) throw new Error(ERRO);
  return [m[1].replace(/\./g, ""), dec];
}

export function lerReais(texto: string): Centavos {
  const [inteiro, dec] = partes(texto.trim().replace(/^R\$\s*/, ""), 2);
  return BigInt(inteiro) * 100n + BigInt(dec.padEnd(2, "0"));
}

export function formatarReais(c: Centavos): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const inteiro = (abs / 100n).toString().replace(/\B(?=(\d{3})+$)/g, ".");
  const cents = (abs % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}R$ ${inteiro},${cents}`;
}

export function lerPercentual(texto: string): string {
  const [inteiro, dec] = partes(texto.trim().replace(/\s*%$/, ""), 3);
  return `${BigInt(inteiro)}.${dec.padEnd(3, "0")}`;
}

export function formatarPercentual(p: string): string {
  const [inteiro, dec = ""] = p.split(".");
  const d = dec.replace(/0+$/, "");
  return `${inteiro}${d ? "," + d : ""}%`;
}
