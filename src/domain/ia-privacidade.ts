// Proteção de dados antes de mandar texto à IA (puro). Documentos e datas de nascimento conhecidas viram marcadores;
// datas de viagem, horários e valores ficam. A ordem importa: CNPJ antes de CPF (14 dígitos contêm 11) e os padrões
// antes dos valores conhecidos.

export const MARCADORES = {
  cpf: "[CPF]",
  cnpj: "[CNPJ]",
  passaporte: "[PASSAPORTE]",
  rg: "[RG]",
  nascimento: "[NASCIMENTO]",
  documento: "[DOCUMENTO]",
} as const;

const PADROES: [RegExp, string][] = [
  [/(?<!\d)\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}(?!\d)/g, MARCADORES.cnpj],
  [/(?<!\d)\d{14}(?!\d)/g, MARCADORES.cnpj],
  [/(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, MARCADORES.cpf],
  [/(?<!\d)\d{11}(?!\d)/g, MARCADORES.cpf],
  // RG com máscara (ex.: 12.345.678-9, 1.234.567-X). Valores em reais não têm hífen.
  [/(?<![\d.])\d{1,2}\.\d{3}\.\d{3}-[\dXx](?![\dA-Za-z])/g, MARCADORES.rg],
  // Passaporte: 2 letras maiúsculas e 6 ou 7 dígitos, como palavra inteira (voo "AZ675" tem 3 dígitos).
  [/(?<![A-Za-z0-9])[A-Z]{2}\d{6,7}(?![A-Za-z0-9])/g, MARCADORES.passaporte],
];

/** Documento conhecido mais curto que isto não é trocado (trocaria pedaços de palavras). */
const DOCUMENTO_MINIMO = 5;

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** Uma data ISO (aaaa-mm-dd) ou dd/mm/aaaa nas duas formas em que aparece no texto. */
function formasDaData(d: string): string[] {
  const t = d.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return [t, `${iso[3]}/${iso[2]}/${iso[1]}`];
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (br) return [t, `${br[3]}-${br[2]}-${br[1]}`];
  return [];
}

function trocarConhecidos(texto: string, valores: string[], marcador: string): string {
  const unicos = [...new Set(valores)].sort((a, b) => b.length - a.length);
  if (unicos.length === 0) return texto;
  const re = new RegExp(`(?<![A-Za-z0-9])(?:${unicos.map(escapar).join("|")})(?![A-Za-z0-9])`, "gi");
  return texto.replace(re, marcador);
}

/**
 * Troca CPF (com máscara ou 11 dígitos), CNPJ, passaporte (2 letras + 6/7 dígitos), RG com máscara, as datas de
 * `nascimentos` (ISO ou dd/mm/aaaa; aparecem no texto nas duas formas) e os `documentos` conhecidos (qualquer
 * formato, ex.: passaporte estrangeiro, viram `[DOCUMENTO]`) por marcadores.
 */
export function protegerTexto(texto: string, conhecidos: { nascimentos?: string[]; documentos?: string[] } = {}): string {
  let t = texto;
  for (const [re, marcador] of PADROES) t = t.replace(re, marcador);
  t = trocarConhecidos(t, (conhecidos.nascimentos ?? []).flatMap(formasDaData), MARCADORES.nascimento);
  const documentos = (conhecidos.documentos ?? []).map((d) => d.trim()).filter((d) => d.length >= DOCUMENTO_MINIMO);
  return trocarConhecidos(t, documentos, MARCADORES.documento);
}
