import "server-only";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { ClasseErro } from "@/domain/integracoes";
import { CHECKLIST_ROTEIRO, CHECKLIST_VENDA, chaveVenda } from "@/domain/trello";
import { db } from "@/server/db/client";
import { integracaoEnvios } from "@/server/db/schema";
import { configTrello, type ConfigTrello } from "./config";
// Só tipos: `fila.ts` importa o processador daqui (sem ciclo de valores).
import type { DepsProcessador, EnvioTomado, Processador } from "./fila";
import { chamar, ErroIntegracao, type Buscar } from "./http";

// Trello: cliente REST (chave e token só no cabeçalho Authorization, nunca na URL) e o processador da fila.

export const TRELLO_API = "https://api.trello.com/1";

/** Cabeçalho documentado pela Atlassian para a API REST do Trello. */
export function autorizacaoTrello(cfg: ConfigTrello): string {
  return `OAuth oauth_consumer_key="${cfg.apiKey}", oauth_token="${cfg.token}"`;
}

type Json = Record<string, unknown>;

const texto = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function clienteTrello(cfg: ConfigTrello, buscar: Buscar) {
  const autorizacao = autorizacaoTrello(cfg);

  async function postar(caminho: string, corpo: Record<string, string>): Promise<{ json: Json; status: number }> {
    const r = await chamar(buscar, `${TRELLO_API}${caminho}`, {
      method: "POST",
      headers: { Authorization: autorizacao, Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(corpo),
    });
    if (!r.ok) throw new ErroIntegracao(r.classe, r.status);
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
    /** Cartão na lista configurada; `url` é o link curto (ou o longo, se o curto não vier). */
    async criarCartao(c: { nome: string; descricao: string }): Promise<{ id: string; url: string | null }> {
      const r = await postar("/cards", { idList: cfg.listaId, name: c.nome, desc: c.descricao });
      return { id: idDe(r), url: texto(r.json.shortUrl) ?? texto(r.json.url) };
    },

    async criarChecklist(cartaoId: string, nome: string): Promise<{ id: string }> {
      return { id: idDe(await postar("/checklists", { idCard: cartaoId, name: nome })) };
    },

    async adicionarItem(checklistId: string, nome: string): Promise<void> {
      await postar(`/checklists/${encodeURIComponent(checklistId)}/checkItems`, { name: nome });
    },

    /** Testar conexão: lê a lista configurada. Nunca lança. */
    async testar(): Promise<{ ok: true; lista: string } | { ok: false; classe: ClasseErro }> {
      const r = await chamar(buscar, `${TRELLO_API}/lists/${encodeURIComponent(cfg.listaId)}`, {
        method: "GET",
        headers: { Authorization: autorizacao, Accept: "application/json" },
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
    await cliente.adicionarItem(feito.checklistId!, itens[n]);
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

/** Id do cartão criado pelo envio `venda:<viagem>` já enviado; null se ainda não há. */
async function cartaoEnviado(viagemId: string): Promise<string | null> {
  const [l] = await db
    .select({ resultado: integracaoEnvios.resultado })
    .from(integracaoEnvios)
    .where(
      and(
        eq(integracaoEnvios.integracao, "trello"),
        eq(integracaoEnvios.chave, chaveVenda(viagemId)),
        eq(integracaoEnvios.situacao, "enviado"),
      ),
    );
  return feitoDe(l?.resultado).cartaoId ?? null;
}

async function checklistDoRoteiro(cliente: ClienteTrello, envio: EnvioTomado, deps: DepsProcessador): Promise<Feito> {
  const p = lerPayload(payloadRoteiro, envio.payload);
  const antes = feitoDe(envio.resultado);
  const cartaoId = antes.cartaoId ?? (await cartaoEnviado(p.viagemId));
  // O cartão da venda ainda não foi criado: tenta de novo depois (a espera da fila).
  if (!cartaoId) throw new ErroIntegracao("servidor", null);
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
