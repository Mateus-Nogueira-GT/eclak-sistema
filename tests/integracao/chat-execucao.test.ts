import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { formatarCodigoViagem } from "@/domain/viagens";
import { db } from "@/server/db/client";
import { auditoria, chatAcoes, clientes, integracaoEnvios, viagens } from "@/server/db/schema";
import { cancelarAcaoChat, confirmarAcaoChat } from "@/server/actions/chat-acoes";
import { proporAcao } from "@/server/ia/acoes";
import { ERRO_DO_SERVICO } from "@/server/ia/erros-servico";
import { definirBuscarDoChatParaTestes } from "@/server/ia/ferramentas";
import { esquecerTokensGoogle, GOOGLE_TOKEN_URL } from "@/server/integracoes/google";
import { esquecerQuadrosTrello } from "@/server/integracoes/trello";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function ligarTudo() {
  vi.stubEnv("TRELLO_API_KEY", "chave");
  vi.stubEnv("TRELLO_TOKEN", "token");
  vi.stubEnv("TRELLO_LISTA_ID", "lista-op");
  vi.stubEnv("GOOGLE_SA_EMAIL", "sa@eclak.test");
  vi.stubEnv("GOOGLE_SA_CHAVE", privateKey);
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "raiz");
}

type ChamadaEscrita = { metodo: string; caminho: string; params: Record<string, string>; corpo: Record<string, unknown> | null };

let f: Fixture;
let codigo: string;
let escritas: ChamadaEscrita[];
let estadoFalso: {
  cartaoOutroQuadro?: boolean;
  listaAtualCartao?: string;
  paiAtualArquivo?: string;
  arquivoSumiu?: boolean;
  statusEscrita?: number;
  atrasoEscritaMs?: number;
  esperarEscrita?: () => Promise<void>;
};

function servicosFalsos(): typeof fetch {
  const arvore: Record<string, Record<string, unknown>> = {
    raiz: { id: "raiz", name: "Raiz", mimeType: "application/vnd.google-apps.folder", parents: [] },
    "pasta-v1": { id: "pasta-v1", name: "ECL-0001_SOUZA", mimeType: "application/vnd.google-apps.folder", parents: ["raiz"] },
    "pub-1": { id: "pub-1", name: "Público", mimeType: "application/vnd.google-apps.folder", parents: ["pasta-v1"] },
    "int-1": { id: "int-1", name: "Uso interno", mimeType: "application/vnd.google-apps.folder", parents: ["pasta-v1"] },
    "sub-outra": { id: "sub-outra", name: "Outra pasta", mimeType: "application/vnd.google-apps.folder", parents: ["pasta-v1"] },
    "arq-1": {
      id: "arq-1",
      name: "voucher.pdf",
      mimeType: "application/pdf",
      parents: ["int-1"],
      webViewLink: "https://drive.google.com/file/d/arq-1/view",
    },
  };

  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const metodo = init?.method ?? "GET";
    if (u.href === GOOGLE_TOKEN_URL) return Response.json({ access_token: "tok", expires_in: 3600 });

    if (metodo !== "GET") {
      if (estadoFalso.esperarEscrita) await estadoFalso.esperarEscrita();
      if (estadoFalso.atrasoEscritaMs) await new Promise((r) => setTimeout(r, estadoFalso.atrasoEscritaMs));
      const corpo = typeof init?.body === "string" && init.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      escritas.push({ metodo, caminho: u.pathname, params: Object.fromEntries(u.searchParams), corpo });
      if (estadoFalso.statusEscrita) return new Response("err", { status: estadoFalso.statusEscrita });
      if (metodo === "POST" && u.pathname === "/1/cards") return Response.json({ id: "c-novo", shortUrl: "https://trello.com/c/c-novo" });
      if (metodo === "POST" && u.pathname === "/drive/v3/files") {
        return Response.json({ id: "pasta-nova", webViewLink: "https://drive.google.com/drive/folders/pasta-nova" });
      }
      return Response.json({ id: "ok" });
    }

    if (u.pathname === "/1/lists/lista-op") return Response.json({ id: "lista-op", idBoard: "b1", name: "Operações" });
    if (u.pathname === "/1/boards/b1/lists") {
      return Response.json([
        { id: "lista-op", name: "Operações" },
        { id: "lista-em", name: "Emissão" },
        { id: "lista-c", name: "Revisão" },
      ]);
    }
    if (u.pathname === "/1/cards/card-v1") {
      return Response.json({
        id: "card-v1",
        idBoard: estadoFalso.cartaoOutroQuadro ? "b-outro" : "b1",
        name: `${codigo} · SOUZA`,
        desc: "Viagem",
        idList: estadoFalso.listaAtualCartao ?? "lista-op",
        due: null,
        dueComplete: false,
        shortUrl: "https://trello.com/c/card-v1",
        checklists: [{ id: "chk-1", name: "Tarefas", checkItems: [{ id: "item-1", name: "Seguro", state: "incomplete" }] }],
        actions: [],
      });
    }
    const mFile = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (mFile) {
      const id = decodeURIComponent(mFile[1]);
      if (id === "arq-1" && estadoFalso.arquivoSumiu) return new Response(null, { status: 404 });
      if (id === "arq-1" && estadoFalso.paiAtualArquivo) {
        return Response.json({ ...arvore[id], parents: [estadoFalso.paiAtualArquivo] });
      }
      return arvore[id] ? Response.json(arvore[id]) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

function ctxDo(usuario: Fixture["u"]) {
  return {
    usuario: { id: usuario.id, nome: "Teste consultor", email: usuario.email, perfil: "consultor" as const, filial: "Rondonópolis" as const },
    conhecidos: { nascimentos: [], documentos: [] },
    buscar: servicosFalsos(),
    prazoAte: Date.now() + 60_000,
  };
}

beforeEach(async () => {
  await limparBanco();
  esquecerQuadrosTrello();
  esquecerTokensGoogle();
  escritas = [];
  estadoFalso = {};
  vi.stubEnv("TRELLO_API_KEY", "");
  vi.stubEnv("TRELLO_TOKEN", "");
  vi.stubEnv("TRELLO_LISTA_ID", "");
  vi.stubEnv("GOOGLE_SA_EMAIL", "");
  vi.stubEnv("GOOGLE_SA_CHAVE", "");
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "");
  f = await vendida();
  ligarTudo();
  const [v] = await db
    .select({ seq: viagens.seq, codigo: clientes.codigo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(viagens.id, f.viagemId));
  codigo = formatarCodigoViagem(v.codigo, v.seq);
  await db.insert(integracaoEnvios).values([
    {
      integracao: "trello",
      tipo: "cartao_viagem",
      viagemId: f.viagemId,
      chave: `venda:${f.viagemId}`,
      payload: {},
      situacao: "enviado",
      enviadoEm: new Date(),
      resultado: { cartaoId: "card-v1", url: "https://trello.com/c/card-v1" },
    },
    {
      integracao: "drive",
      tipo: "pasta_viagem",
      viagemId: f.viagemId,
      chave: `pasta:${f.viagemId}`,
      payload: {},
      situacao: "enviado",
      enviadoEm: new Date(),
      resultado: { pastaId: "pasta-v1", publicaId: "pub-1", internaId: "int-1" },
    },
  ]);
  definirBuscarDoChatParaTestes(servicosFalsos());
});

afterEach(() => {
  definirBuscarDoChatParaTestes(null);
  esquecerQuadrosTrello();
  esquecerTokensGoogle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("confirmarAcaoChat: as 9 ações sem anexo", () => {
  it("executa todas as 9 ações, grava feita com link e audita sem o texto do comentário/descrição", async () => {
    const propor = async (tipo: Parameters<typeof proporAcao>[1], entrada: unknown) => {
      const r = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), tipo, entrada));
      if (!("proposta" in r)) throw new Error(`Falhou propor ${tipo}: ${r.erro}`);
      return r.proposta.id;
    };

    const id1 = await propor("trello_comentar", { cartao: codigo, texto: "SEGREDO-DO-COMENTARIO" });
    const r1 = await comSessao(f.u.id, () => confirmarAcaoChat(id1));
    expect(r1).toEqual({
      ok: true,
      texto: `Comentário publicado no cartão ${codigo} · SOUZA`,
      link: "https://trello.com/c/card-v1",
    });
    expect(escritas[0]).toMatchObject({
      metodo: "POST",
      caminho: "/1/cards/card-v1/actions/comments",
      corpo: { text: "[Teste consultor, pelo sistema] SEGREDO-DO-COMENTARIO" },
    });
    const [aud1] = await db.select().from(auditoria).where(eq(auditoria.registroId, id1));
    expect(aud1).toMatchObject({ tabela: "chat_acoes", acao: "criar", usuarioId: f.u.id });
    expect(JSON.stringify(aud1)).not.toContain("SEGREDO-DO-COMENTARIO");

    const id2 = await propor("trello_marcar_item", { cartao: codigo, item: "item-1", feito: true });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id2))).toMatchObject({ ok: true, link: "https://trello.com/c/card-v1" });
    expect(escritas[1]).toMatchObject({ metodo: "PUT", caminho: "/1/cards/card-v1/checkItem/item-1", corpo: { state: "complete" } });

    const id3 = await propor("trello_adicionar_item", { cartao: codigo, checklist: "chk-1", nome: "Transfer" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id3))).toMatchObject({ ok: true });
    expect(escritas[2]).toMatchObject({ metodo: "POST", caminho: "/1/checklists/chk-1/checkItems", corpo: { name: "Transfer" } });

    const id4 = await propor("trello_mover_cartao", { cartao: codigo, lista: "lista-em" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id4))).toMatchObject({ ok: true });
    expect(escritas[3]).toMatchObject({ metodo: "PUT", caminho: "/1/cards/card-v1", corpo: { idList: "lista-em" } });

    const id5 = await propor("trello_definir_prazo", { cartao: codigo, prazo: "2026-12-01" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id5))).toMatchObject({ ok: true });
    expect(escritas[4]).toMatchObject({ metodo: "PUT", caminho: "/1/cards/card-v1", corpo: { due: "2026-12-01T16:00:00.000Z" } });

    const id6 = await propor("trello_criar_cartao", { lista: "lista-em", nome: "Ligar", descricao: "DESCRICAO-SECRETA" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id6))).toMatchObject({ ok: true, link: "https://trello.com/c/c-novo" });
    expect(escritas[5]).toMatchObject({
      metodo: "POST",
      caminho: "/1/cards",
      corpo: { idList: "lista-em", name: "Ligar", desc: "DESCRICAO-SECRETA" },
    });
    const [aud6] = await db.select().from(auditoria).where(eq(auditoria.registroId, id6));
    expect(JSON.stringify(aud6)).not.toContain("DESCRICAO-SECRETA");

    const id7 = await propor("drive_criar_pasta", { viagem: codigo, dentroDe: "publico", nome: "Hotéis" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id7))).toMatchObject({
      ok: true,
      link: "https://drive.google.com/drive/folders/pasta-nova",
    });
    expect(escritas[6]).toMatchObject({ metodo: "POST", caminho: "/drive/v3/files" });

    const id8 = await propor("drive_renomear", { arquivo: "arq-1", nome: "voucher-novo.pdf" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id8))).toMatchObject({
      ok: true,
      link: "https://drive.google.com/file/d/arq-1/view",
    });
    expect(escritas[7]).toMatchObject({ metodo: "PATCH", caminho: "/drive/v3/files/arq-1", corpo: { name: "voucher-novo.pdf" } });

    const id9 = await propor("drive_mover", { arquivo: "arq-1", destino: "pub-1" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(id9))).toMatchObject({ ok: true });
    expect(escritas[8]).toMatchObject({
      metodo: "PATCH",
      caminho: "/drive/v3/files/arq-1",
      params: expect.objectContaining({ addParents: "pub-1", removeParents: "int-1" }),
    });
  });
});

describe("ciclo de vida, concorrência e reconferência na execução", () => {
  it("cancelar marca cancelada sem chamar serviço; confirmar depois recusa", async () => {
    const p = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in p)) throw new Error(p.erro);
    expect(await comSessao(f.u.id, () => cancelarAcaoChat(p.proposta.id))).toEqual({ ok: true });
    expect(escritas).toEqual([]);
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(p.proposta.id))).toEqual({ ok: false, erro: "Esta ação foi cancelada." });
  });

  it("expirada responde e marca expirada", async () => {
    const p = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in p)) throw new Error(p.erro);
    await db.update(chatAcoes).set({ expiraEm: new Date(Date.now() - 60_000) }).where(eq(chatAcoes.id, p.proposta.id));
    expect(await comSessao(f.u.id, () => confirmarAcaoChat(p.proposta.id))).toEqual({
      ok: false,
      erro: "Esta ação expirou. Peça de novo.",
    });
    const [linha] = await db.select().from(chatAcoes).where(eq(chatAcoes.id, p.proposta.id));
    expect(linha.situacao).toBe("expirada");
    expect(escritas).toEqual([]);
  });

  it("outra pessoa, id inválido e sem sessão são recusados", async () => {
    const p = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in p)) throw new Error(p.erro);
    const outro = await criarUsuarioTeste("consultor");
    expect(await comSessao(outro.id, () => confirmarAcaoChat(p.proposta.id))).toEqual({ ok: false, erro: "Ação não encontrada" });
    expect(await comSessao(f.u.id, () => confirmarAcaoChat("nao-uuid"))).toEqual({ ok: false, erro: "Ação não encontrada" });
    expect(await confirmarAcaoChat(p.proposta.id)).toEqual({ ok: false, erro: "Sem permissão" });
    expect(escritas).toEqual([]);
  });

  it("Review Focus 3: duas confirmações ao mesmo tempo executam só uma escrita", async () => {
    const p = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Duplo clique" }));
    if (!("proposta" in p)) throw new Error(p.erro);
    estadoFalso.atrasoEscritaMs = 60;
    const [a, b] = await comSessao(f.u.id, () => Promise.all([confirmarAcaoChat(p.proposta.id), confirmarAcaoChat(p.proposta.id)]));
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const falha = a.ok ? b : a;
    expect(!falha.ok && falha.erro).toMatch(/em execução|já foi executada/);
    expect(escritas).toHaveLength(1);
  });

  it("Review Focus 4: alvo mudou entre propor e confirmar (outro quadro, arquivo sumiu, viagem excluída, integração desligada)", async () => {
    // (a) cartão movido para outro quadro
    const pA = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in pA)) throw new Error(pA.erro);
    estadoFalso.cartaoOutroQuadro = true;
    expect((await comSessao(f.u.id, () => confirmarAcaoChat(pA.proposta.id))).ok).toBe(false);
    expect((await db.select().from(chatAcoes).where(eq(chatAcoes.id, pA.proposta.id)))[0].situacao).toBe("falhou");
    estadoFalso.cartaoOutroQuadro = false;

    // (b) arquivo sumiu no Drive
    const pB = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "drive_renomear", { arquivo: "arq-1", nome: "novo.pdf" }));
    if (!("proposta" in pB)) throw new Error(pB.erro);
    estadoFalso.arquivoSumiu = true;
    expect((await comSessao(f.u.id, () => confirmarAcaoChat(pB.proposta.id))).ok).toBe(false);
    expect((await db.select().from(chatAcoes).where(eq(chatAcoes.id, pB.proposta.id)))[0].situacao).toBe("falhou");
    estadoFalso.arquivoSumiu = false;

    // (c) integração desligada
    const pC = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in pC)) throw new Error(pC.erro);
    vi.stubEnv("TRELLO_TOKEN", "");
    expect((await comSessao(f.u.id, () => confirmarAcaoChat(pC.proposta.id))).ok).toBe(false);
    vi.stubEnv("TRELLO_TOKEN", "token");

    // (d) viagem excluída
    const pD = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in pD)) throw new Error(pD.erro);
    await db.update(viagens).set({ excluidoEm: new Date() }).where(eq(viagens.id, f.viagemId));
    expect((await comSessao(f.u.id, () => confirmarAcaoChat(pD.proposta.id))).ok).toBe(false);

    expect(escritas).toEqual([]);
  });

  it("serviço devolve 500 -> falhou com classe servidor e status 500", async () => {
    const p = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in p)) throw new Error(p.erro);
    estadoFalso.statusEscrita = 500;
    const r = await comSessao(f.u.id, () => confirmarAcaoChat(p.proposta.id));
    expect(r).toEqual({ ok: false, erro: ERRO_DO_SERVICO.trello.servidor });
    const [linha] = await db.select().from(chatAcoes).where(eq(chatAcoes.id, p.proposta.id));
    expect(linha.situacao).toBe("falhou");
    expect(linha.resultado).toEqual({ classe: "servidor", status: 500 });
  });

  it("executando preso há mais de 2 min responde desconhecido e marca falhou", async () => {
    const p = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Oi" }));
    if (!("proposta" in p)) throw new Error(p.erro);
    await db
      .update(chatAcoes)
      .set({ situacao: "executando", tomadoEm: new Date(Date.now() - 3 * 60_000) })
      .where(eq(chatAcoes.id, p.proposta.id));
    const r = await comSessao(f.u.id, () => confirmarAcaoChat(p.proposta.id));
    expect(r).toEqual({
      ok: false,
      erro: "Não sei se esta ação foi concluída. Confira no Trello antes de pedir de novo.",
    });
    const [linha] = await db.select().from(chatAcoes).where(eq(chatAcoes.id, p.proposta.id));
    expect(linha.situacao).toBe("falhou");
    expect(linha.resultado).toEqual({ classe: "desconhecido" });
    expect(escritas).toEqual([]);
  });

  it("recusa movimentação no Trello e no Drive se a origem mudou antes da confirmação (A -> B virou C -> B)", async () => {
    const pTrello = await comSessao(f.u.id, () =>
      proporAcao(ctxDo(f.u), "trello_mover_cartao", { cartao: codigo, lista: "lista-em" }),
    );
    if (!("proposta" in pTrello)) throw new Error(pTrello.erro);
    estadoFalso.listaAtualCartao = "lista-c";
    const rTrello = await comSessao(f.u.id, () => confirmarAcaoChat(pTrello.proposta.id));
    expect(rTrello).toEqual({
      ok: false,
      erro: "O cartão mudou de lista desde a proposta. Peça de novo para confirmar a nova movimentação.",
    });
    expect((await db.select().from(chatAcoes).where(eq(chatAcoes.id, pTrello.proposta.id)))[0].situacao).toBe("falhou");
    estadoFalso.listaAtualCartao = undefined;

    const pDrive = await comSessao(f.u.id, () =>
      proporAcao(ctxDo(f.u), "drive_mover", { arquivo: "arq-1", destino: "pub-1" }),
    );
    if (!("proposta" in pDrive)) throw new Error(pDrive.erro);
    estadoFalso.paiAtualArquivo = "sub-outra";
    const rDrive = await comSessao(f.u.id, () => confirmarAcaoChat(pDrive.proposta.id));
    expect(rDrive).toEqual({
      ok: false,
      erro: "O item mudou de pasta desde a proposta. Peça de novo para confirmar a nova movimentação.",
    });
    expect((await db.select().from(chatAcoes).where(eq(chatAcoes.id, pDrive.proposta.id)))[0].situacao).toBe("falhou");
    expect(escritas).toEqual([]);
  });

  it("execução lenta que perde fencing para desconhecido nunca devolve ok: true sem gravar resultado e auditoria", async () => {
    const p = await comSessao(f.u.id, () => proporAcao(ctxDo(f.u), "trello_comentar", { cartao: codigo, texto: "Lento" }));
    if (!("proposta" in p)) throw new Error(p.erro);

    let chegouNaEscrita!: () => void;
    let liberarEscrita!: () => void;
    const escritaIniciada = new Promise<void>((resolve) => {
      chegouNaEscrita = resolve;
    });
    const podeConcluir = new Promise<void>((resolve) => {
      liberarEscrita = resolve;
    });
    estadoFalso.esperarEscrita = async () => {
      chegouNaEscrita();
      await podeConcluir;
    };

    const primeiraPromessa = comSessao(f.u.id, () => confirmarAcaoChat(p.proposta.id));
    await escritaIniciada;

    // Simula que a primeira execução ficou presa por > 2 min e uma segunda confirmação a encerra como desconhecido.
    await db
      .update(chatAcoes)
      .set({ tomadoEm: new Date(Date.now() - 3 * 60_000) })
      .where(eq(chatAcoes.id, p.proposta.id));
    const segunda = await comSessao(f.u.id, () => confirmarAcaoChat(p.proposta.id));
    expect(segunda).toEqual({
      ok: false,
      erro: "Não sei se esta ação foi concluída. Confira no Trello antes de pedir de novo.",
    });

    // Agora a primeira execução termina o HTTP 200: como perdeu o fencing, NÃO pode responder ok: true.
    liberarEscrita();
    const primeira = await primeiraPromessa;
    expect(primeira).toEqual({
      ok: false,
      erro: "Não sei se esta ação foi concluída. Confira no Trello antes de pedir de novo.",
    });

    const [linha] = await db.select().from(chatAcoes).where(eq(chatAcoes.id, p.proposta.id));
    expect(linha.situacao).toBe("falhou");
    expect(linha.resultado).toEqual({ classe: "desconhecido" });
    const auds = await db.select().from(auditoria).where(eq(auditoria.registroId, p.proposta.id));
    expect(auds).toHaveLength(1);
    expect((auds[0].depois as { resultado?: unknown }).resultado).toEqual({ classe: "desconhecido" });
  });
});
