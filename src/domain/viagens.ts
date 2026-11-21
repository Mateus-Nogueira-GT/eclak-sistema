// Regras puras de viagens (sem I/O).

export const STATUS_ORCAMENTO = ["em_edicao", "aguardando_aprovacao", "aprovado", "devolvido"] as const;
export type StatusOrcamento = (typeof STATUS_ORCAMENTO)[number];

export const ROTULOS_STATUS_ORCAMENTO: Record<StatusOrcamento, string> = {
  em_edicao: "Em edição",
  aguardando_aprovacao: "Aguardando aprovação",
  aprovado: "Aprovado",
  devolvido: "Devolvido",
};

export const STATUS_VERSAO = ["aguardando", "aprovada", "aprovada_com_ajuste", "devolvida"] as const;
export type StatusVersao = (typeof STATUS_VERSAO)[number];

/** "ECL-0147-01": código do cliente (4 dígitos) e sequencial da viagem (2 dígitos). */
export function formatarCodigoViagem(codigoCliente: number, seq: number): string {
  return `ECL-${String(codigoCliente).padStart(4, "0")}-${String(seq).padStart(2, "0")}`;
}

function diasEntre(inicio: string, fim: string): number {
  return Math.round((Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000);
}

/** Dias da viagem, inclusivo (14/08 a 01/09 = 19). Datas "YYYY-MM-DD". */
export function diasDaViagem(inicio: string, fim: string): number {
  return diasEntre(inicio, fim) + 1;
}

/** Noites da viagem (14/08 a 01/09 = 18). */
export function noites(inicio: string, fim: string): number {
  return diasEntre(inicio, fim);
}
