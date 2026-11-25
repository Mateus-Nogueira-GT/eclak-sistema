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

export const DOMINIOS_LINK_CHAT = ["trello.com", "drive.google.com", "docs.google.com"] as const;

export type ParteTextoChat = { tipo: "texto"; valor: string } | { tipo: "link"; url: string };

function dominioPermitido(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return DOMINIOS_LINK_CHAT.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

const URL_RE = /https?:\/\/[^\s<>()]+/g;

function apararPontuacao(bruta: string): [string, string] {
  let fim = bruta.length;
  while (fim > 0 && /[.,;:!?\]}'"]/.test(bruta[fim - 1])) fim--;
  return [bruta.slice(0, fim), bruta.slice(fim)];
}

/**
 * Divide o texto em trechos comuns e links clicáveis só para `https:` dos três domínios permitidos
 * (`trello.com`, `drive.google.com`, `docs.google.com`). Qualquer outro endereço fica como texto.
 */
export function partesComLink(texto: string): ParteTextoChat[] {
  const partes: ParteTextoChat[] = [];
  const empurrarTexto = (valor: string) => {
    if (!valor) return;
    const ultima = partes[partes.length - 1];
    if (ultima?.tipo === "texto") ultima.valor += valor;
    else partes.push({ tipo: "texto", valor });
  };
  let pos = 0;
  for (const m of texto.matchAll(URL_RE)) {
    const idx = m.index ?? 0;
    if (idx > pos) empurrarTexto(texto.slice(pos, idx));
    const [url, resto] = apararPontuacao(m[0]);
    if (url && dominioPermitido(url)) {
      partes.push({ tipo: "link", url });
      if (resto) empurrarTexto(resto);
    } else {
      empurrarTexto(m[0]);
    }
    pos = idx + m[0].length;
  }
  if (pos < texto.length) empurrarTexto(texto.slice(pos));
  return partes;
}
