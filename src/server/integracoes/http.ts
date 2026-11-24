import "server-only";
import { TIMEOUT_MS, classificarStatus, type ClasseErro, type MotivoEspera } from "@/domain/integracoes";

// Chamada HTTP das integrações: `fetch` injetável (os testes passam um falso), timeout e erro classificado. O corpo
// de uma resposta de erro é descartado sem leitura (pode ecoar o token). Única exceção: com `limite403`, o corpo de
// um 403 é lido só para extrair o motivo (`reason`/`status`, limite de uso ou não); o resto é descartado na hora e
// nada do corpo é guardado, logado ou posto na mensagem. Só a classe e o status saem daqui.

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

/** Só o motivo de um 403 (o resto do corpo é descartado na hora, nunca logado nem guardado). */
export type Motivo403 = { reason: string | null; status: string | null };

function motivoDe(texto: string): Motivo403 {
  try {
    const erro = (JSON.parse(texto) as { error?: { status?: unknown; errors?: { reason?: unknown }[] } } | null)?.error;
    const reason = Array.isArray(erro?.errors) ? erro.errors[0]?.reason : undefined;
    return {
      reason: typeof reason === "string" ? reason : null,
      status: typeof erro?.status === "string" ? erro.status : null,
    };
  } catch {
    return { reason: null, status: null };
  }
}

/**
 * `limite403`: para serviços que mandam o limite de chamadas como 403 (o Drive): lê só `error.errors[0].reason` e
 * `error.status` do corpo do 403 e, se a função disser que é limite, classifica como `limite` (repete).
 */
export async function chamar(
  buscar: Buscar,
  url: string,
  init: RequestInit & { timeoutMs?: number; limite403?: (m: Motivo403) => boolean },
): Promise<RespostaIntegracao> {
  const { timeoutMs, limite403, ...resto } = init;
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
    if (status === 403 && limite403) {
      let texto = "";
      try {
        texto = await resposta.text();
      } catch {
        // corpo ilegível: fica 403 comum
      }
      const limite = limite403(motivoDe(texto));
      return { ok: false, classe: limite ? "limite" : classificarStatus(status), status };
    }
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
