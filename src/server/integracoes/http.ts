import "server-only";
import { TIMEOUT_MS, classificarStatus, type ClasseErro, type MotivoEspera } from "@/domain/integracoes";

// Chamada HTTP das integrações: `fetch` injetável (os testes passam um falso), timeout e erro classificado. O corpo
// de uma resposta de erro nunca é lido nem guardado (pode ecoar o token); só a classe e o status saem daqui.

export type Buscar = typeof fetch;

export type RespostaIntegracao =
  | { ok: true; status: number; json: unknown }
  | { ok: false; classe: ClasseErro; status: number | null };

export class ErroIntegracao extends Error {
  readonly classe: ClasseErro;
  readonly status: number | null;
  constructor(classe: ClasseErro, status: number | null) {
    super(`Falha na integração: ${classe}${status === null ? "" : ` (HTTP ${status})`}`);
    this.name = "ErroIntegracao";
    this.classe = classe;
    this.status = status;
  }
}

/** O processador ainda não pode mandar (depende de outro envio): a fila espera sem gastar tentativa. */
export class EsperaIntegracao extends Error {
  readonly motivo: MotivoEspera;
  constructor(motivo: MotivoEspera) {
    super(`Envio aguardando: ${motivo}`);
    this.name = "EsperaIntegracao";
    this.motivo = motivo;
  }
}

export async function chamar(
  buscar: Buscar,
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<RespostaIntegracao> {
  const { timeoutMs, ...resto } = init;
  const tempo = AbortSignal.timeout(timeoutMs ?? TIMEOUT_MS);
  const signal = resto.signal ? AbortSignal.any([resto.signal, tempo]) : tempo;
  let resposta: Response;
  try {
    resposta = await buscar(url, { ...resto, signal });
  } catch {
    return { ok: false, classe: "rede", status: null };
  }
  const status = resposta.status;
  if (!resposta.ok) {
    try {
      await resposta.body?.cancel();
    } catch {
      // nada: o corpo de erro é descartado de qualquer jeito
    }
    return { ok: false, classe: classificarStatus(status), status };
  }
  // O sinal continua valendo durante a leitura do corpo (timeout no meio do download = rede).
  let texto: string;
  try {
    texto = await resposta.text();
  } catch {
    return { ok: false, classe: "rede", status: null };
  }
  if (texto.trim() === "") return { ok: true, status, json: null };
  try {
    return { ok: true, status, json: JSON.parse(texto) };
  } catch {
    return { ok: false, classe: "servidor", status };
  }
}
