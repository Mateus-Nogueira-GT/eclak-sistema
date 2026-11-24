// Proteção de dados antes de mandar texto à IA ou ao Trello (puro). Documentos, telefones e datas de nascimento
// conhecidas viram marcadores; datas de viagem, horários, valores e códigos ECL ficam. A ordem importa: CNPJ antes de
// CPF (14 dígitos contêm 11), CPF antes de telefone (11 dígitos sem separador ficam [CPF], o lado seguro) e os padrões
// antes dos valores conhecidos.

export const MARCADORES = {
  cpf: "[CPF]",
  cnpj: "[CNPJ]",
  passaporte: "[PASSAPORTE]",
  rg: "[RG]",
  telefone: "[TELEFONE]",
  nascimento: "[NASCIMENTO]",
  documento: "[DOCUMENTO]",
} as const;

/** Separador opcional entre grupos de dígitos de um documento (ponto, hífen, barra ou espaço). */
const S = "[.\\-/ ]?";
/** Não começa no meio de um número (nem depois de "1." ou "1/", pedaço de um número maior com máscara). */
const INICIO = "(?<!\\d)(?<!\\d[.\\-/])";
/** Não termina no meio de um número (nem antes de ",5" ou ".5", como em valores). */
const FIM = "(?!\\d)(?![.,/\\-]\\d)";

const PADROES: [RegExp, string][] = [
  [new RegExp(`${INICIO}\\d{2}${S}\\d{3}${S}\\d{3}${S}\\d{4}${S}\\d{2}${FIM}`, "g"), MARCADORES.cnpj],
  [new RegExp(`${INICIO}\\d{3}${S}\\d{3}${S}\\d{3}${S}\\d{2}${FIM}`, "g"), MARCADORES.cpf],
  // RG com máscara (ex.: 12.345.678-9, 1.234.567-X). Valores em reais não têm hífen.
  [/(?<![\d.])\d{1,2}\.\d{3}\.\d{3}-[\dXx](?![\dA-Za-z])/g, MARCADORES.rg],
  // Passaporte: 2 letras maiúsculas, espaço ou hífen opcional e 6 ou 7 dígitos, como palavra inteira (voo "AZ675"
  // tem 3 dígitos; "ECL-0147" tem 3 letras).
  [/(?<![A-Za-z0-9])[A-Z]{2}[ -]?\d{6,7}(?![A-Za-z0-9])/g, MARCADORES.passaporte],
  // Telefone com DDD (e +55 opcional): (66) 99999-1234, 66 99999-1234, +55 66 99999-1234, 6634211234. Datas
  // (barra), valores (vírgula) e horários (dois-pontos) não casam: o separador é só espaço, ponto ou hífen.
  [/(?<![\d+])(?:\+?55[ .-]?)?(?:\(\d{2}\) ?|\d{2}[ .-]?)9?\d{4}[ .-]?\d{4}(?!\d)/g, MARCADORES.telefone],
];

/** Documento conhecido com menos caracteres (letras e dígitos) que isto não é trocado (trocaria pedaços de palavras). */
const DOCUMENTO_MINIMO = 5;

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** Um trecho que é data (14/08/2027, 2027-08-14) ou valor: nunca vira [DOCUMENTO] por coincidir com um número. */
const PARECE_DATA = /^(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{1,2}-\d{1,2})$/;

/** Padrão de uma data de nascimento conhecida (ISO aaaa-mm-dd ou dd/mm/aaaa): d/m/aaaa com zero opcional e barra,
 * hífen ou ponto, e a ISO. Null se não é data. */
function padraoDaData(d: string): string | null {
  const t = d.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  const [a, m, dia] = iso ? [iso[1], iso[2], iso[3]] : br ? [br[3], br[2], br[1]] : [];
  if (!a || !m || !dia) return null;
  const semZero = (x: string) => `0?${Number(x)}`;
  return `${semZero(dia)}[/.\\-]${semZero(m)}[/.\\-]${a}|${a}-${m}-${dia}`;
}

/** Padrão de um documento conhecido: o valor como está e a sequência de letras e dígitos com separadores opcionais. */
function padraoDoDocumento(d: string): string | null {
  const alfanum = d.replace(/[^A-Za-z0-9]/g, "");
  if (alfanum.length < DOCUMENTO_MINIMO) return null;
  return `${escapar(d)}|${alfanum.split("").join(S)}`;
}

function trocar(texto: string, padroes: (string | null)[], marcador: string, recusar?: (trecho: string) => boolean): string {
  const validos = [...new Set(padroes.filter((p): p is string => p !== null))].sort((a, b) => b.length - a.length);
  if (validos.length === 0) return texto;
  const re = new RegExp(`(?<![A-Za-z0-9])(?<!\\d[.\\-/])(?:${validos.join("|")})(?![A-Za-z0-9])(?![.,/\\-]\\d)`, "gi");
  return texto.replace(re, (trecho) => (recusar?.(trecho) ? trecho : marcador));
}

/**
 * Troca CPF e CNPJ (com ou sem máscara, separadores ponto, hífen, barra ou espaço), passaporte (2 letras + 6/7
 * dígitos, com espaço ou hífen opcional), RG com máscara, telefone com DDD, as datas de `nascimentos` (ISO ou
 * dd/mm/aaaa; casam no texto como d/m/aaaa, dd-mm-aaaa, dd.mm.aaaa ou ISO) e os `documentos` conhecidos (qualquer
 * formato, ex.: passaporte estrangeiro; casam com ou sem separadores entre os caracteres; viram `[DOCUMENTO]`).
 */
export function protegerTexto(texto: string, conhecidos: { nascimentos?: string[]; documentos?: string[] } = {}): string {
  let t = texto;
  for (const [re, marcador] of PADROES) t = t.replace(re, marcador);
  t = trocar(t, (conhecidos.nascimentos ?? []).map(padraoDaData), MARCADORES.nascimento);
  const documentos = (conhecidos.documentos ?? []).map((d) => d.trim()).map(padraoDoDocumento);
  return trocar(t, documentos, MARCADORES.documento, (trecho) => PARECE_DATA.test(trecho));
}
