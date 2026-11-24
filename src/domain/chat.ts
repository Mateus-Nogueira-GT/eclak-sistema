// Chat com IA: limites da conversa (os mesmos na tela e na action) e o histórico que a tela manda ao servidor.

export const MAX_MENSAGENS_CHAT = 30;
export const MAX_CARACTERES_CHAT = 4000;

export type MensagemChat = { de: "eu" | "ia"; texto: string };

/**
 * O que vai ao servidor: as últimas mensagens (até 30) começando numa pergunta, sem os balões de erro, cada uma cortada
 * em 4.000 caracteres (a resposta da IA não tem esse limite e, inteira, travaria as perguntas seguintes).
 */
export function historicoParaEnviar(msgs: (MensagemChat & { erro?: boolean })[]): MensagemChat[] {
  let corte = msgs
    .filter((m) => !m.erro)
    .map(({ de, texto }) => ({ de, texto: texto.slice(0, MAX_CARACTERES_CHAT) }))
    .slice(-MAX_MENSAGENS_CHAT);
  while (corte.length && corte[0].de !== "eu") corte = corte.slice(1);
  return corte;
}
