// Anexos (comprovantes, boletos, notas): qualquer linha da lista e notas fiscais. Só PDF, PNG ou JPEG até 10 MB,
// conferidos no servidor pelos bytes iniciais (a extensão e o tipo declarado pelo navegador não valem).

export const DONOS_ANEXO = ["manual", "parcela", "pagamento", "comissao", "fatura_cartao", "nota_fiscal"] as const;
export type DonoAnexo = (typeof DONOS_ANEXO)[number];

export const TAMANHO_MAXIMO_ANEXO = 10 * 1024 * 1024;

export const TIPOS_ANEXO = ["application/pdf", "image/png", "image/jpeg"] as const;
export type TipoAnexo = (typeof TIPOS_ANEXO)[number];

export const MSG_TIPO_ANEXO = "Envie um PDF, PNG ou JPEG";
export const MSG_TAMANHO_ANEXO = "O arquivo passa de 10 MB";

/** O `accept` do campo de arquivo (só ajuda a escolher; quem decide é `tipoPelosBytes`). */
export const ACEITA_ANEXO = ".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg";

const ASSINATURAS: { tipo: TipoAnexo; bytes: number[] }[] = [
  { tipo: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { tipo: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { tipo: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
];

/** Bytes iniciais que bastam para reconhecer qualquer tipo aceito. */
export const BYTES_ASSINATURA = 8;

/** Tipo do arquivo pela assinatura no começo; `null` se não for PDF, PNG ou JPEG. */
export function tipoPelosBytes(bytes: Uint8Array): TipoAnexo | null {
  for (const a of ASSINATURAS) {
    if (bytes.length >= a.bytes.length && a.bytes.every((b, i) => bytes[i] === b)) return a.tipo;
  }
  return null;
}

/** "512 bytes", "2 KB", "1,5 MB". */
export function tamanhoLegivel(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const fmt = (v: number) => v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  if (n < 1024 * 1024) return `${fmt(n / 1024)} KB`;
  return `${fmt(n / (1024 * 1024))} MB`;
}
