// Regras puras das integrações externas (fatia 6c): nomes, situações da fila, espera entre tentativas e classe do erro.

export const INTEGRACOES = ["trello", "drive", "ia", "hotelaria", "agendador"] as const;
export type Integracao = (typeof INTEGRACOES)[number];

/** Integrações que mandam pela fila `integracao_envios` (as outras chamam na hora ou não chamam). */
export const INTEGRACOES_FILA = ["trello", "drive"] as const;
export type IntegracaoFila = (typeof INTEGRACOES_FILA)[number];

export const SITUACOES_ENVIO = ["pendente", "enviando", "enviado", "falhou"] as const;
export type SituacaoEnvio = (typeof SITUACOES_ENVIO)[number];

export const MAX_TENTATIVAS = 6;
/** Espera (minutos) depois da tentativa n (1-based) que falhou; a sexta falha vira `falhou`. */
export const ESPERAS_MIN = [1, 5, 15, 60, 180] as const;
/** `enviando` há mais que isso: o processo caiu no meio; volta a `pendente`. */
export const ENVIANDO_PRESO_MIN = 10;
/** Envios tomados por execução da fila (cron ou `after`). */
export const LOTE_FILA = 20;
export const TIMEOUT_MS = 15_000;

export const CLASSES_ERRO = ["rede", "autenticacao", "limite", "recusado", "servidor"] as const;
export type ClasseErro = (typeof CLASSES_ERRO)[number];

/** Quando tentar de novo depois de `tentativas` falhas; null quando acabaram as tentativas. */
export function proximaTentativa(tentativas: number, agora: Date): Date | null {
  if (tentativas >= MAX_TENTATIVAS) return null;
  const min = ESPERAS_MIN[Math.max(1, Math.trunc(tentativas)) - 1];
  return new Date(agora.getTime() + min * 60_000);
}

/** Classe do erro de uma resposta HTTP que não deu certo. */
export function classificarStatus(status: number): ClasseErro {
  if (status === 401 || status === 403) return "autenticacao";
  if (status === 429) return "limite";
  if (status >= 500) return "servidor";
  return "recusado";
}

/** Repetir resolve? Autenticação e recusa vão direto a `falhou`. */
export function repete(classe: ClasseErro): boolean {
  return classe === "rede" || classe === "limite" || classe === "servidor";
}

export const ROTULO_CLASSE_ERRO: Record<ClasseErro, string> = {
  rede: "rede",
  autenticacao: "autenticação",
  limite: "limite de chamadas",
  recusado: "recusado",
  servidor: "servidor",
};
