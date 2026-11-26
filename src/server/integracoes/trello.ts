import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ClasseErro } from "@/domain/integracoes";
import { protegerTexto } from "@/domain/ia-privacidade";
import { CHECKLIST_ROTEIRO, CHECKLIST_VENDA, chaveVenda } from "@/domain/trello";
import { db } from "@/server/db/client";
import { integracaoEnvios } from "@/server/db/schema";
import { configTrello, type ConfigTrello } from "./config";
// Só tipos: `fila.ts` importa o processador daqui (sem ciclo de valores).
import type { DepsProcessador, EnvioTomado, Processador } from "./fila";
import { chamar, ErroIntegracao, EsperaIntegracao, urlDeTeste, type Buscar } from "./http";

// Trello: cliente REST (chave e token só no cabeçalho Authorization, nunca na URL) e o processador da fila.

export const TRELLO_API = "https://api.trello.com/1";
const MAX_COMENTARIOS = 20;

export function baseTrello(env: Record<string, string | undefined> = process.env): string {
  return urlDeTeste(env.TRELLO_API_URL, TRELLO_API);
}

const quadros = new Map<string, string>();

/** Só testes: esquece os ids de quadro guardados em memória. */
export function esquecerQuadrosTrello(): void {
  if (process.env.NODE_ENV === "production") throw new Error("Só em testes");
  quadros.clear();
}

export type CartaoTrello = {
  id: string;
  nome: string;
  listaId: string;
  prazo: string | null;
  concluido: boolean;
  link: string | null;
};

export type CartaoDetalhe = CartaoTrello & {
  descricao: string;
  checklists: {
    id: string;
    nome: string;
    itens: { id: string; nome: string; feito: boolean }[];
  }[];
  comentarios: { autor: string; data: string; texto: string }[];
};

/** Cabeçalho documentado pela Atlassian para a API REST do Trello. */
export function autorizacaoTrello(cfg: ConfigTrello): string {
  return `OAuth oauth_consumer_key="${cfg.apiKey}", oauth_token="${cfg.token}"`;
}

type Json = Record<string, unknown>;

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function clienteTrello(cfg: ConfigTrello, buscar: Buscar, opcoes: { timeoutMs?: number; prazoAte?: number } = {}) {
  const autorizacao = autorizacaoTrello(cfg);
  const api = baseTrello();

  async function ler(caminho: string): Promise<{ json: unknown; status: number }> {
    const r = await chamar(buscar, `${api}${caminho}`, {
      method: "GET",
      headers: { Authorization: autorizacao, Accept: "application/json" },
      timeoutMs: opcoes.timeoutMs,
      prazoAte: opcoes.prazoAte,
    });
    if (!r.ok) throw new ErroIntegracao(r.classe, r.status);
    return { json: r.json, status: r.status };
  }

  async function postar(caminho: string, corpo: Record<string, unknown>): Promise<{ json: Json; status: number }> {
    const r = await chamar(buscar, `${api}${caminho}`, {
      method: "POST",
      headers: { Authorization: autorizacao, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      timeoutMs: opcoes.timeoutMs,
      prazoAte: opcoes.prazoAte,
    });
    if (!r.ok) throw new ErroIntegracao(r.classe, r.status);
    if (typeof r.json !== "object" || r.json === null) throw new ErroIntegracao("servidor", r.status);
    return { json: r.json as Json, status: r.status };
  }

  async function alterar(caminho: string, corpo: Record<string, unknown>): Promise<void> {
    const r = await chamar(buscar, `${api}${caminho}`, {
      method: "PUT",
      headers: { Authorization: autorizacao, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
      timeoutMs: opcoes.timeoutMs,
      prazoAte: opcoes.prazoAte,
    });
    if (!r.ok) throw new ErroIntegracao(r.classe, r.status);
  }

  /** Resposta 2xx sem o `id` do que foi criado: conta como erro do serviço (tenta de novo). */
  function idDe(r: { json: Json; status: number }): string {
    const id = texto(r.json.id);
    if (!id) throw new ErroIntegracao("servidor", r.status);
    return id;
  }

  async function quadroId(): Promise<string> {
    const chave = `${api}|${cfg.listaId}`;
    const guardado = quadros.get(chave);
    if (guardado) return guardado;
    const r = await ler(`/lists/${encodeURIComponent(cfg.listaId)}?fields=idBoard`);
    const idBoard = typeof r.json === "object" && r.json !== null ? texto((r.json as Json).idBoard) : null;
    if (!idBoard) throw new ErroIntegracao("servidor", r.status);
    quadros.set(chave, idBoard);
    return idBoard;
  }

  async function criarCartaoEm(listaId: string, c: { nome: string; descricao: string }): Promise<{ id: string; url: string | null }> {
    const r = await postar("/cards", { idList: listaId, name: c.nome, desc: c.descricao });
    return { id: idDe(r), url: texto(r.json.shortUrl) ?? texto(r.json.url) };
  }

  return {
    quadroId,

    async listas(): Promise<{ id: string; nome: string }[]> {
      const board = await quadroId();
      const r = await ler(`/boards/${encodeURIComponent(board)}/lists?filter=open&fields=name`);
      if (!Array.isArray(r.json)) throw new ErroIntegracao("servidor", r.status);
      const saida: { id: string; nome: string }[] = [];
      for (const item of r.json) {
        if (typeof item !== "object" || item === null) continue;
        const j = item as Json;
        const id = texto(j.id);
        if (!id) continue;
        saida.push({ id, nome: texto(j.name) ?? "" });
      }
      return saida;
    },

    async cartoes(): Promise<CartaoTrello[]> {
      const board = await quadroId();
      const r = await ler(`/boards/${encodeURIComponent(board)}/cards/open?fields=name,idList,due,dueComplete,shortUrl`);
      if (!Array.isArray(r.json)) throw new ErroIntegracao("servidor", r.status);
      const saida: CartaoTrello[] = [];
      for (const item of r.json) {
        if (typeof item !== "object" || item === null) continue;
        const j = item as Json;
        const id = texto(j.id);
        if (!id) continue;
        saida.push({
          id,
          nome: texto(j.name) ?? "",
          listaId: texto(j.idList) ?? "",
          prazo: texto(j.due),
          concluido: j.dueComplete === true,
          link: texto(j.shortUrl) ?? texto(j.url),
        });
      }
      return saida;
    },

    async cartao(id: string): Promise<CartaoDetalhe | null> {
      const board = await quadroId();
      const r = await chamar(
        buscar,
        `${api}/cards/${encodeURIComponent(id)}?fields=name,desc,idList,idBoard,due,dueComplete,shortUrl&checklists=all&checklist_fields=name&actions=commentCard&actions_limit=${MAX_COMENTARIOS}&action_fields=data,date,memberCreator`,
        {
          method: "GET",
          headers: { Authorization: autorizacao, Accept: "application/json" },
          timeoutMs: opcoes.timeoutMs,
          prazoAte: opcoes.prazoAte,
        },
      );
      if (!r.ok) {
        if (r.status === 404) return null;
        throw new ErroIntegracao(r.classe, r.status);
      }
      if (typeof r.json !== "object" || r.json === null) throw new ErroIntegracao("servidor", r.status);
      const j = r.json as Json;
      if (texto(j.idBoard) !== board) return null;
      const cid = texto(j.id);
      if (!cid) throw new ErroIntegracao("servidor", r.status);

      const checklists: CartaoDetalhe["checklists"] = [];
      if (Array.isArray(j.checklists)) {
        for (const chk of j.checklists) {
          if (typeof chk !== "object" || chk === null) continue;
          const k = chk as Json;
          const kid = texto(k.id);
          if (!kid) continue;
          const itens: { id: string; nome: string; feito: boolean }[] = [];
          if (Array.isArray(k.checkItems)) {
            for (const it of k.checkItems) {
              if (typeof it !== "object" || it === null) continue;
              const x = it as Json;
              const xid = texto(x.id);
              if (!xid) continue;
              itens.push({ id: xid, nome: texto(x.name) ?? "", feito: x.state === "complete" });
            }
          }
          checklists.push({ id: kid, nome: texto(k.name) ?? "", itens });
        }
      }

      const comentarios: CartaoDetalhe["comentarios"] = [];
      if (Array.isArray(j.actions)) {
        for (const acao of j.actions) {
          if (comentarios.length >= MAX_COMENTARIOS) break;
          if (typeof acao !== "object" || acao === null) continue;
          const a = acao as Json;
          if (a.type !== undefined && a.type !== "commentCard") continue;
          const data = typeof a.data === "object" && a.data !== null ? (a.data as Json) : null;
          const criador = typeof a.memberCreator === "object" && a.memberCreator !== null ? (a.memberCreator as Json) : null;
          const msg = texto(data?.text);
          if (msg === null) continue;
          comentarios.push({
            autor: texto(criador?.fullName) ?? texto(criador?.username) ?? "",
            data: texto(a.date) ?? "",
            texto: msg,
          });
        }
      }

      return {
        id: cid,
        nome: texto(j.name) ?? "",
        listaId: texto(j.idList) ?? "",
        prazo: texto(j.due),
        concluido: j.dueComplete === true,
        link: texto(j.shortUrl) ?? texto(j.url),
        descricao: typeof j.desc === "string" ? j.desc : "",
        checklists,
        comentarios,
      };
    },

    async comentar(cartaoId: string, comentario: string): Promise<void> {
      await postar(`/cards/${encodeURIComponent(cartaoId)}/actions/comments`, { text: comentario });
    },

    async marcarItem(cartaoId: string, itemId: string, feito: boolean): Promise<void> {
      await alterar(`/cards/${encodeURIComponent(cartaoId)}/checkItem/${encodeURIComponent(itemId)}`, {
        state: feito ? "complete" : "incomplete",
      });
    },

    async atualizarCartao(cartaoId: string, m: { idList?: string; due?: string | null }): Promise<void> {
      const corpo: Record<string, unknown> = {};
      if (m.idList !== undefined) corpo.idList = m.idList;
      if (m.due !== undefined) corpo.due = m.due;
      await alterar(`/cards/${encodeURIComponent(cartaoId)}`, corpo);
    },

    criarCartaoEm,

    /** Cartão na lista configurada; `url` é o link curto (ou o longo, se o curto não vier). */
    async criarCartao(c: { nome: string; descricao: string }): Promise<{ id: string; url: string | null }> {
      return criarCartaoEm(cfg.listaId, c);
    },

    async criarChecklist(cartaoId: string, nome: string): Promise<{ id: string }> {
      return { id: idDe(await postar("/checklists", { idCard: cartaoId, name: nome })) };
    },

    async adicionarItem(checklistId: string, nome: string): Promise<void> {
      await postar(`/checklists/${encodeURIComponent(checklistId)}/checkItems`, { name: nome });
    },

    /** Testar conexão: lê a lista configurada. Nunca lança. */
    async testar(): Promise<{ ok: true; lista: string } | { ok: false; classe: ClasseErro }> {
      const r = await chamar(buscar, `${api}/lists/${encodeURIComponent(cfg.listaId)}`, {
        method: "GET",
        headers: { Authorization: autorizacao, Accept: "application/json" },
        timeoutMs: opcoes.timeoutMs,
        prazoAte: opcoes.prazoAte,
      });
      if (!r.ok) return { ok: false, classe: r.classe };
      const nome = texto((r.json as Json | null)?.name);
      return nome ? { ok: true, lista: nome } : { ok: false, classe: "servidor" };
    },
  };
}

export type ClienteTrello = ReturnType<typeof clienteTrello>;

// ---------------------------------------------------------------------------
// Processador da fila
// ---------------------------------------------------------------------------

const itensSchema = z.array(z.string().trim().min(1).max(16384));
const payloadCartao = z.object({
  viagemId: z.string().min(1),
  nome: z.string().trim().min(1).max(16384),
  descricao: z.string().max(16384),
  itens: itensSchema,
});
const payloadRoteiro = z.object({ viagemId: z.string().min(1), itens: itensSchema });

export type PayloadCartao = z.infer<typeof payloadCartao>;
export type PayloadRoteiro = z.infer<typeof payloadRoteiro>;

/** O que já foi criado no Trello por tentativas anteriores (o `resultado` do envio). */
type Feito = { cartaoId?: string; url?: string | null; checklistId?: string; itens?: number };

function feitoDe(resultado: unknown): Feito {
  const r = (typeof resultado === "object" && resultado !== null ? resultado : {}) as Json;
  const f: Feito = {};
  if (texto(r.cartaoId)) f.cartaoId = r.cartaoId as string;
  if (texto(r.url) || r.url === null) f.url = r.url as string | null;
  if (texto(r.checklistId)) f.checklistId = r.checklistId as string;
  if (typeof r.itens === "number" && Number.isInteger(r.itens) && r.itens >= 0) f.itens = r.itens;
  return f;
}

/**
 * Checklist com os itens, retomando de onde a tentativa anterior parou: grava o id do checklist logo depois de
 * criá-lo e a contagem depois de cada item (o `resultado` é substituído inteiro, então vai sempre o objeto todo).
 */
async function checklistComItens(
  cliente: ClienteTrello,
  deps: DepsProcessador,
  base: Feito & { cartaoId: string },
  nome: string,
  itens: string[],
): Promise<Feito> {
  if (itens.length === 0) return base;
  let feito: Feito = { ...base };
  if (!feito.checklistId) {
    const { id } = await cliente.criarChecklist(base.cartaoId, nome);
    feito = { ...feito, checklistId: id, itens: 0 };
    await deps.gravarResultado(feito);
  }
  for (let n = feito.itens ?? 0; n < itens.length; n++) {
    // O payload já vem protegido (eventos.ts); de novo aqui para envios gravados antes disso (marcador não muda).
    await cliente.adicionarItem(feito.checklistId!, protegerTexto(itens[n]));
    feito = { ...feito, itens: n + 1 };
    await deps.gravarResultado(feito);
  }
  return feito;
}

function lerPayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const p = schema.safeParse(payload);
  // Payload que não fecha não melhora repetindo.
  if (!p.success) throw new ErroIntegracao("recusado", null);
  return p.data;
}

async function cartaoDaViagem(cliente: ClienteTrello, envio: EnvioTomado, deps: DepsProcessador): Promise<Feito> {
  const p = lerPayload(payloadCartao, envio.payload);
  const antes = feitoDe(envio.resultado);
  let base: Feito & { cartaoId: string };
  if (antes.cartaoId) {
    base = { ...antes, cartaoId: antes.cartaoId };
  } else {
    // Cartão novo: o id vai para o banco antes do checklist (falha no checklist não cria um segundo cartão).
    const c = await cliente.criarCartao({ nome: p.nome, descricao: p.descricao });
    base = { cartaoId: c.id, url: c.url };
    await deps.gravarResultado(base);
  }
  return checklistComItens(cliente, deps, base, CHECKLIST_VENDA, p.itens);
}

/**
 * Id do cartão criado pelo envio `venda:<viagem>`. Ainda `pendente` ou `enviando`: espera sem gastar tentativa
 * (`aguardando_cartao`). Sem envio do cartão, com falha ou enviado sem id: erro `servidor` (gasta tentativas e, no
 * fim, `falhou`, para Reenviar depois do cartão).
 */
async function cartaoDaVenda(viagemId: string): Promise<string> {
  const [l] = await db
    .select({ situacao: integracaoEnvios.situacao, resultado: integracaoEnvios.resultado })
    .from(integracaoEnvios)
    .where(and(eq(integracaoEnvios.integracao, "trello"), eq(integracaoEnvios.chave, chaveVenda(viagemId))));
  if (l && (l.situacao === "pendente" || l.situacao === "enviando")) throw new EsperaIntegracao("aguardando_cartao");
  const cartaoId = l?.situacao === "enviado" ? feitoDe(l.resultado).cartaoId : undefined;
  if (!cartaoId) throw new ErroIntegracao("servidor", null);
  return cartaoId;
}

async function checklistDoRoteiro(cliente: ClienteTrello, envio: EnvioTomado, deps: DepsProcessador): Promise<Feito> {
  const p = lerPayload(payloadRoteiro, envio.payload);
  const antes = feitoDe(envio.resultado);
  const cartaoId = antes.cartaoId ?? (await cartaoDaVenda(p.viagemId));
  return checklistComItens(cliente, deps, { ...antes, cartaoId }, CHECKLIST_ROTEIRO, p.itens);
}

/**
 * `cartao_viagem` (venda fechada): cartão + checklist "Tarefas da venda"; `checklist_roteiro` (roteiro aprovado):
 * checklist "Tarefas do roteiro" no cartão da venda. Resultado: `{ cartaoId, url?, checklistId, itens }`.
 */
export const processarTrello: Processador = async (envio, deps) => {
  const cfg = configTrello();
  // Desligada entre a tomada e a chamada: tenta de novo depois.
  if (!cfg) throw new ErroIntegracao("servidor", null);
  const cliente = clienteTrello(cfg, deps.buscar);
  if (envio.tipo === "cartao_viagem") return cartaoDaViagem(cliente, envio, deps);
  if (envio.tipo === "checklist_roteiro") return checklistDoRoteiro(cliente, envio, deps);
  throw new ErroIntegracao("recusado", null);
};
