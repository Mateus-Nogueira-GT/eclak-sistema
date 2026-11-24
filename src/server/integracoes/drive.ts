import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ClasseErro } from "@/domain/integracoes";
import { SUBPASTA_INTERNA, SUBPASTA_PUBLICA } from "@/domain/drive";
import { configDrive, type ConfigDrive } from "./config";
// Só tipos: `fila.ts` importa o processador daqui (sem ciclo de valores).
import type { DepsProcessador, EnvioTomado, Processador } from "./fila";
import { descartarTokenGoogle, tokenGoogle } from "./google";
import { chamar, ErroIntegracao, type Buscar, type Motivo403 } from "./http";

// Google Drive: cliente REST v3 (token Bearer da conta de serviço, só no cabeçalho) e o processador da fila. Conta de
// serviço não tem cota própria: tudo é criado dentro da pasta raiz, que fica num drive compartilhado
// (`supportsAllDrives=true` em toda chamada).

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const MIME_PASTA = "application/vnd.google-apps.folder";
/** Upload multipart (uma chamada) só até 5 MB; acima disso o Google pede upload retomável. */
export const LIMITE_UPLOAD_BYTES = 5 * 1024 * 1024;

type Json = Record<string, unknown>;

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Link para abrir a pasta: o `webViewLink` devolvido ou, se não vier, o endereço de pasta do Drive. */
const linkDe = (json: Json, id: string, pasta: boolean) =>
  texto(json.webViewLink) ?? (pasta ? `https://drive.google.com/drive/folders/${encodeURIComponent(id)}` : null);

/** Literal entre aspas simples na consulta `q` do Drive (escapa `\` e `'`). */
const literalQ = (s: string) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Tipo MIME simples (`tipo/subtipo`): nada de quebra de linha nem parâmetro no cabeçalho da parte. */
const MIME_VALIDO = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

/** O Drive manda o limite de chamadas como 403 com estes motivos (doc do Google: "Resolve errors"). */
const MOTIVOS_LIMITE = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);
const ehLimiteDoDrive = (m: Motivo403) => (m.reason !== null && MOTIVOS_LIMITE.has(m.reason)) || m.status === "RESOURCE_EXHAUSTED";

export type ArquivoDrive = { id: string; nome: string; mime: string; link: string | null };

export function clienteDrive(cfg: ConfigDrive, buscar: Buscar) {
  async function autorizacao(): Promise<string> {
    return `Bearer ${await tokenGoogle(cfg, buscar)}`;
  }

  async function pedir(url: string, init: RequestInit): Promise<{ json: Json; status: number }> {
    const r = await chamar(buscar, url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: await autorizacao(), Accept: "application/json" },
      limite403: ehLimiteDoDrive,
    });
    if (!r.ok) {
      if (r.status === 401) descartarTokenGoogle(cfg.email);
      throw new ErroIntegracao(r.classe, r.status);
    }
    if (typeof r.json !== "object" || r.json === null) throw new ErroIntegracao("servidor", r.status);
    return { json: r.json as Json, status: r.status };
  }

  /** Resposta 2xx sem o `id` do que foi criado: conta como erro do serviço (tenta de novo). */
  function idDe(r: { json: Json; status: number }): string {
    const id = texto(r.json.id);
    if (!id) throw new ErroIntegracao("servidor", r.status);
    return id;
  }

  return {
    async criarPasta(nome: string, paiId: string): Promise<{ id: string; link: string }> {
      const q = new URLSearchParams({ supportsAllDrives: "true", fields: "id,webViewLink" });
      const r = await pedir(`${DRIVE_API}/files?${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ name: nome, mimeType: MIME_PASTA, parents: [paiId] }),
      });
      const id = idDe(r);
      return { id, link: linkDe(r.json, id, true)! };
    },

    /** Upload multipart (metadados + bytes numa chamada). Recusa acima de 5 MB antes de qualquer chamada. */
    async enviarArquivo(pastaId: string, nome: string, mime: string, bytes: Uint8Array): Promise<{ id: string; link: string | null }> {
      if (bytes.byteLength > LIMITE_UPLOAD_BYTES || !MIME_VALIDO.test(mime)) throw new ErroIntegracao("recusado", null);
      const boundary = `eclak-${randomBytes(16).toString("hex")}`;
      const meta = JSON.stringify({ name: nome, parents: [pastaId] });
      const corpo = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`, "utf8"),
        Buffer.from(`--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, "utf8"),
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
      ]);
      const q = new URLSearchParams({ uploadType: "multipart", supportsAllDrives: "true", fields: "id,webViewLink" });
      const r = await pedir(`${DRIVE_UPLOAD}/files?${q}`, {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body: corpo,
      });
      const id = idDe(r);
      return { id, link: linkDe(r.json, id, false) };
    },

    /** Arquivos da pasta (fora da lixeira), todas as páginas. */
    async listarArquivos(pastaId: string): Promise<ArquivoDrive[]> {
      const todos: ArquivoDrive[] = [];
      let pagina: string | null = null;
      do {
        const q = new URLSearchParams({
          q: `${literalQ(pastaId)} in parents and trashed = false`,
          supportsAllDrives: "true",
          includeItemsFromAllDrives: "true",
          fields: "nextPageToken,files(id,name,mimeType,webViewLink)",
        });
        if (pagina) q.set("pageToken", pagina);
        const r = await pedir(`${DRIVE_API}/files?${q}`, { method: "GET" });
        const files = Array.isArray(r.json.files) ? (r.json.files as Json[]) : [];
        for (const f of files) {
          const id = texto(f.id);
          if (!id) continue;
          todos.push({ id, nome: texto(f.name) ?? "", mime: texto(f.mimeType) ?? "", link: texto(f.webViewLink) });
        }
        pagina = texto(r.json.nextPageToken);
      } while (pagina);
      return todos;
    },

    /** Testar conexão: obtém o token e lê a pasta raiz. Nunca lança. */
    async testar(): Promise<{ ok: true; pasta: string } | { ok: false; classe: ClasseErro }> {
      try {
        const q = new URLSearchParams({ supportsAllDrives: "true", fields: "id,name" });
        const r = await pedir(`${DRIVE_API}/files/${encodeURIComponent(cfg.pastaRaizId)}?${q}`, { method: "GET" });
        const nome = texto(r.json.name);
        return nome ? { ok: true, pasta: nome } : { ok: false, classe: "servidor" };
      } catch (e) {
        return { ok: false, classe: e instanceof ErroIntegracao ? e.classe : "servidor" };
      }
    },
  };
}

export type ClienteDrive = ReturnType<typeof clienteDrive>;

// ---------------------------------------------------------------------------
// Processador da fila
// ---------------------------------------------------------------------------

const payloadPasta = z.object({ viagemId: z.string().min(1), nome: z.string().trim().min(1).max(1024) });
export type PayloadPasta = z.infer<typeof payloadPasta>;

/** O que já foi criado no Drive por tentativas anteriores (o `resultado` do envio). */
type Feito = { pastaId?: string; link?: string; publicaId?: string; internaId?: string };

function feitoDe(resultado: unknown): Feito {
  const r = (typeof resultado === "object" && resultado !== null ? resultado : {}) as Json;
  const f: Feito = {};
  for (const k of ["pastaId", "link", "publicaId", "internaId"] as const) {
    const v = texto(r[k]);
    if (v) f[k] = v;
  }
  return f;
}

/**
 * Pasta-mãe na raiz e, dentro dela, "Público" e "Uso interno", retomando de onde a tentativa anterior parou: cada id
 * vai para o banco logo depois de criado (o `resultado` é substituído inteiro, então vai sempre o objeto todo).
 */
async function pastaDaViagem(cliente: ClienteDrive, cfg: ConfigDrive, envio: EnvioTomado, deps: DepsProcessador) {
  const p = payloadPasta.safeParse(envio.payload);
  // Payload que não fecha não melhora repetindo.
  if (!p.success) throw new ErroIntegracao("recusado", null);
  let feito = feitoDe(envio.resultado);
  if (!feito.pastaId) {
    const mae = await cliente.criarPasta(p.data.nome, cfg.pastaRaizId);
    feito = { pastaId: mae.id, link: mae.link };
    await deps.gravarResultado(feito);
  }
  const pastaId = feito.pastaId!;
  if (!feito.publicaId) {
    feito = { ...feito, publicaId: (await cliente.criarPasta(SUBPASTA_PUBLICA, pastaId)).id };
    await deps.gravarResultado(feito);
  }
  if (!feito.internaId) {
    feito = { ...feito, internaId: (await cliente.criarPasta(SUBPASTA_INTERNA, pastaId)).id };
    // Também a última: se a gravação do sucesso falhar, a retomada não cria outra "Uso interno".
    await deps.gravarResultado(feito);
  }
  return {
    pastaId,
    link: feito.link ?? `https://drive.google.com/drive/folders/${encodeURIComponent(pastaId)}`,
    publicaId: feito.publicaId!,
    internaId: feito.internaId!,
  };
}

/** `pasta_viagem` (venda fechada): resultado `{ pastaId, link, publicaId, internaId }`. */
export const processarDrive: Processador = async (envio, deps) => {
  const cfg = configDrive();
  // Desligada entre a tomada e a chamada: tenta de novo depois.
  if (!cfg) throw new ErroIntegracao("servidor", null);
  if (envio.tipo !== "pasta_viagem") throw new ErroIntegracao("recusado", null);
  return pastaDaViagem(clienteDrive(cfg, deps.buscar), cfg, envio, deps);
};
