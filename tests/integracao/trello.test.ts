import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
// `after()` só existe numa requisição: aqui a fila é processada à mão e `processarDepois` só é observada.
vi.mock("@/server/integracoes/fila", async (original) => ({
  ...(await original<typeof import("@/server/integracoes/fila")>()),
  processarDepois: vi.fn(),
}));
import { formatarCodigoViagem } from "@/domain/viagens";
import { db } from "@/server/db/client";
import { auditoria, clientes, integracaoEnvios, roteiros, tarefas, vendas, viagens } from "@/server/db/schema";
import { processarDepois, processarFila } from "@/server/integracoes/fila";
import { ErroIntegracao } from "@/server/integracoes/http";
import { clienteTrello } from "@/server/integracoes/trello";
import { aprovarRoteiro, criarRoteiro } from "@/server/actions/roteiros";
import { enviarViagemAoTrello } from "@/server/actions/integracoes";
import { salvarCliente } from "@/server/actions/clientes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { comSessao, limparBanco } from "../helpers/db";
import { souza, vendida } from "../helpers/venda";

const SITE = "https://sistema.eclak.test";
const AUTORIZACAO = 'OAuth oauth_consumer_key="chave-falsa", oauth_token="token-falso"';
const CFG = { apiKey: "chave-falsa", token: "token-falso", listaId: "lista-falsa" };
const ITENS_VENDA = [
  "Criar grupo no WhatsApp",
  "Encaminhar informações para emissão da fatura",
  "Fazer comparativo de valores de fornecedores",
  "Realizar reserva da hotelaria e do transfer",
  "Abrir pasta no Google Drive",
];
const ITENS_ROTEIRO = ["Reserva de passeios", "Compra de ingressos", "Compra de trem"];

function ligarTrello() {
  vi.stubEnv("TRELLO_API_KEY", CFG.apiKey);
  vi.stubEnv("TRELLO_TOKEN", CFG.token);
  vi.stubEnv("TRELLO_LISTA_ID", CFG.listaId);
}
function desligarTrello() {
  vi.stubEnv("TRELLO_API_KEY", "");
  vi.stubEnv("TRELLO_TOKEN", "");
  vi.stubEnv("TRELLO_LISTA_ID", "");
}

type Chamada = { metodo: string; url: string; caminho: string; auth: string | null; tipo: string | null; corpo: Record<string, string> | null };

/**
 * Trello falso: cartões `card<n>`, checklists `chk<n>`, itens `item<n>` (n = número da chamada). `falhar` decide,
 * por chamada, um status de erro (o corpo do erro ecoa o token, para provar que não é lido) ou "rede" (rejeita).
 */
function trelloFalso(falhar: (c: Chamada) => number | "rede" | null = () => null) {
  const chamadas: Chamada[] = [];
  const buscar = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const u = new URL(String(url));
    const c: Chamada = {
      metodo: init?.method ?? "GET",
      url: String(url),
      caminho: u.pathname,
      auth: h.get("authorization"),
      tipo: h.get("content-type"),
      corpo: init?.body ? JSON.parse(String(init.body)) : null,
    };
    chamadas.push(c);
    const n = chamadas.length;
    const f = falhar(c);
    if (f === "rede") throw new TypeError("fetch failed");
    if (f) return new Response(JSON.stringify({ message: `invalid token ${CFG.token}` }), { status: f });
    if (c.caminho === "/1/cards") return Response.json({ id: `card${n}`, shortUrl: `https://trello.com/c/card${n}`, url: "https://trello.com/c/longo" });
    if (c.caminho === "/1/checklists") return Response.json({ id: `chk${n}` });
    if (/^\/1\/checklists\/[^/]+\/checkItems$/.test(c.caminho)) return Response.json({ id: `item${n}` });
    if (c.caminho.startsWith("/1/lists/")) return Response.json({ id: "lista-falsa", name: "Operações" });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { buscar, chamadas };
}

const MIN = 60_000;
const agora = new Date("2027-01-10T12:00:00.000Z");
const depois = (min: number) => new Date(agora.getTime() + min * MIN);

const envios = () => db.select().from(integracaoEnvios);
const envioDe = async (chave: string) => (await db.select().from(integracaoEnvios).where(eq(integracaoEnvios.chave, chave)))[0];

async function codigoDa(viagemId: string) {
  const [v] = await db
    .select({ seq: viagens.seq, codigo: clientes.codigo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(viagens.id, viagemId));
  return formatarCodigoViagem(v.codigo, v.seq);
}

beforeEach(async () => {
  await limparBanco();
  vi.mocked(processarDepois).mockReset();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  ligarTrello();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("clienteTrello", () => {
  it("criarCartao: POST /1/cards com JSON e o cabeçalho OAuth; chave e token fora da URL", async () => {
    const t = trelloFalso();
    const r = await clienteTrello(CFG, t.buscar).criarCartao({ nome: "ECL-0001-01 · SOUZA", descricao: "Viagem no sistema: x" });
    expect(r).toEqual({ id: "card1", url: "https://trello.com/c/card1" });
    expect(t.chamadas).toEqual([
      {
        metodo: "POST",
        url: "https://api.trello.com/1/cards",
        caminho: "/1/cards",
        auth: AUTORIZACAO,
        tipo: "application/json",
        corpo: { idList: "lista-falsa", name: "ECL-0001-01 · SOUZA", desc: "Viagem no sistema: x" },
      },
    ]);
    for (const c of t.chamadas) {
      expect(c.url).not.toContain("chave-falsa");
      expect(c.url).not.toContain("token-falso");
      expect(c.url).not.toMatch(/[?&](key|token)=/);
    }
  });

  it("criarChecklist e adicionarItem: caminhos, corpo e id codificado na URL", async () => {
    const t = trelloFalso();
    const cli = clienteTrello(CFG, t.buscar);
    expect(await cli.criarChecklist("card9", "Tarefas da venda")).toEqual({ id: "chk1" });
    await cli.adicionarItem("a/b", "Criar grupo no WhatsApp");
    expect(t.chamadas.map((c) => [c.metodo, c.url, c.auth, c.corpo])).toEqual([
      ["POST", "https://api.trello.com/1/checklists", AUTORIZACAO, { idCard: "card9", name: "Tarefas da venda" }],
      ["POST", "https://api.trello.com/1/checklists/a%2Fb/checkItems", AUTORIZACAO, { name: "Criar grupo no WhatsApp" }],
    ]);
  });

  it("erro do serviço vira ErroIntegracao com classe e status, sem o corpo; 2xx sem id é servidor", async () => {
    const t = trelloFalso(() => 500);
    const e = await clienteTrello(CFG, t.buscar).criarCartao({ nome: "n", descricao: "d" }).catch((x) => x);
    expect(e).toBeInstanceOf(ErroIntegracao);
    expect(e).toMatchObject({ classe: "servidor", status: 500 });
    expect(String(e.message)).not.toContain("token-falso");

    const semId = (async () => Response.json({ name: "x" })) as typeof fetch;
    await expect(clienteTrello(CFG, semId).criarChecklist("c", "n")).rejects.toMatchObject({ classe: "servidor", status: 200 });
  });

  it("testar: GET /1/lists/<id> devolve o nome; 401 e rede devolvem a classe sem lançar", async () => {
    const t = trelloFalso();
    expect(await clienteTrello(CFG, t.buscar).testar()).toEqual({ ok: true, lista: "Operações" });
    expect(t.chamadas[0]).toMatchObject({ metodo: "GET", url: "https://api.trello.com/1/lists/lista-falsa", auth: AUTORIZACAO, corpo: null });
    expect(await clienteTrello(CFG, trelloFalso(() => 401).buscar).testar()).toEqual({ ok: false, classe: "autenticacao" });
    expect(await clienteTrello(CFG, trelloFalso(() => "rede").buscar).testar()).toEqual({ ok: false, classe: "rede" });
  });
});

describe("fechar venda", () => {
  it("Trello ligado: um envio venda:<viagem> com nome, link e as 5 tarefas; sem valor nem CPF; agenda o envio", async () => {
    const f = await vendida();
    const linhas = await envios();
    expect(linhas).toHaveLength(1);
    const e = linhas[0];
    expect(e).toMatchObject({ integracao: "trello", tipo: "cartao_viagem", viagemId: f.viagemId, chave: `venda:${f.viagemId}`, situacao: "pendente" });
    expect(e.payload).toEqual({
      viagemId: f.viagemId,
      nome: `${await codigoDa(f.viagemId)} · SOUZA · Itália · 14/08 a 01/09/2027`,
      descricao: `Viagem no sistema: ${SITE}/viagens/${f.viagemId}`,
      itens: ITENS_VENDA,
    });
    const json = JSON.stringify(e.payload);
    expect(json).not.toContain("R$");
    expect(json).not.toContain("529.982.247-25");
    expect(json).not.toContain("52998224725");
    expect(json).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}/);
    expect(json).not.toMatch(/\d{11}/);
    // Valores do fixture (3.106,00, 500,00, 8.000,00, 1.000,00) e o total em centavos não aparecem.
    expect(json).not.toMatch(/3\.?106|8\.?000|1\.000|500,00/);
    expect(processarDepois).toHaveBeenCalledTimes(1);
  });

  it("Trello desligado: nada na fila, nada agendado, venda fechada como hoje", async () => {
    desligarTrello();
    const f = await vendida();
    expect(await envios()).toEqual([]);
    expect(processarDepois).not.toHaveBeenCalled();
    expect(await db.select().from(vendas).where(eq(vendas.viagemId, f.viagemId))).toHaveLength(1);
  });

  it("processarDepois lança: a venda continua fechada e o envio fica na fila para o cron", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(processarDepois).mockImplementation(() => {
      throw new Error("after quebrou");
    });
    const f = await vendida();
    expect((await db.select().from(viagens).where(eq(viagens.id, f.viagemId)))[0].status).toBe("vendida");
    expect(await db.select().from(vendas).where(eq(vendas.viagemId, f.viagemId))).toHaveLength(1);
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({ situacao: "pendente" });
    log.mockRestore();
  });
});

describe("processar o cartão", () => {
  it("cria o cartão, o checklist 'Tarefas da venda' e os 5 itens; enviado com o resultado", async () => {
    const f = await vendida();
    const t = trelloFalso();
    expect(await processarFila({ agora, buscar: t.buscar })).toEqual({ enviados: 1, falhas: 0 });
    expect(t.chamadas.map((c) => [c.caminho, c.corpo])).toEqual([
      ["/1/cards", expect.objectContaining({ idList: "lista-falsa", desc: `Viagem no sistema: ${SITE}/viagens/${f.viagemId}` })],
      ["/1/checklists", { idCard: "card1", name: "Tarefas da venda" }],
      ...ITENS_VENDA.map((name) => ["/1/checklists/chk2/checkItems", { name }]),
    ]);
    expect(t.chamadas.every((c) => c.auth === AUTORIZACAO)).toBe(true);
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({
      situacao: "enviado",
      tentativas: 1,
      resultado: { cartaoId: "card1", url: "https://trello.com/c/card1", checklistId: "chk2", itens: 5 },
    });
  });

  it("falha depois do cartão e antes do checklist: a próxima tentativa não cria outro cartão", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    let checklistFalhou = false;
    const t = trelloFalso((c) => {
      if (c.caminho === "/1/checklists" && !checklistFalhou) {
        checklistFalhou = true;
        return 500;
      }
      return null;
    });
    expect(await processarFila({ agora, buscar: t.buscar })).toEqual({ enviados: 0, falhas: 1 });
    const e = await envioDe(`venda:${f.viagemId}`);
    expect(e).toMatchObject({
      situacao: "pendente",
      tentativas: 1,
      ultimoErro: { classe: "servidor", status: 500 },
      resultado: { cartaoId: "card1", url: "https://trello.com/c/card1" },
    });
    expect(e.proximaEm).toEqual(depois(1));
    expect(await processarFila({ agora: depois(2), buscar: t.buscar })).toEqual({ enviados: 1, falhas: 0 });
    expect(t.chamadas.filter((c) => c.caminho === "/1/cards")).toHaveLength(1);
    expect(t.chamadas.filter((c) => c.caminho === "/1/checklists")).toHaveLength(2);
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({ situacao: "enviado", resultado: { cartaoId: "card1", checklistId: "chk3", itens: 5 } });
    // Nem o corpo do erro (que ecoa o token) nem o token aparecem no log.
    expect(JSON.stringify(log.mock.calls)).not.toContain("token-falso");
    log.mockRestore();
  });

  it("limite (429) no terceiro item: a retomada não cria outro cartão nem outro checklist nem repete item", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    let itens = 0;
    let falhou = false;
    const t = trelloFalso((c) => {
      if (!c.caminho.endsWith("/checkItems")) return null;
      itens++;
      if (itens === 3 && !falhou) {
        falhou = true;
        return 429;
      }
      return null;
    });
    await processarFila({ agora, buscar: t.buscar });
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({
      situacao: "pendente",
      ultimoErro: { classe: "limite", status: 429 },
      resultado: { cartaoId: "card1", checklistId: "chk2", itens: 2 },
    });
    await processarFila({ agora: depois(2), buscar: t.buscar });
    expect(t.chamadas.filter((c) => c.caminho === "/1/cards")).toHaveLength(1);
    expect(t.chamadas.filter((c) => c.caminho === "/1/checklists")).toHaveLength(1);
    const enviados = t.chamadas.filter((c) => c.caminho.endsWith("/checkItems") && c.corpo);
    // 6 chamadas de item: a do 429 e as 5 que entraram, cada item uma vez.
    expect(enviados.map((c) => c.corpo!.name)).toEqual([...ITENS_VENDA.slice(0, 3), ...ITENS_VENDA.slice(2)]);
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({ situacao: "enviado", resultado: { itens: 5 } });
  });

  it("rede fora no cartão: pendente sem resultado; token inválido (401): falhou direto", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    await processarFila({ agora, buscar: trelloFalso(() => "rede").buscar });
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({ situacao: "pendente", resultado: null, ultimoErro: { classe: "rede", status: null } });
    await processarFila({ agora: depois(2), buscar: trelloFalso(() => 401).buscar });
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({ situacao: "falhou", ultimoErro: { classe: "autenticacao", status: 401 } });
  });

  it("payload inválido ou tipo desconhecido: falhou (recusado), sem chamar o Trello", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await db.insert(integracaoEnvios).values([
      { integracao: "trello", tipo: "cartao_viagem", chave: "venda:x", payload: { viagemId: "x" }, proximaEm: agora },
      { integracao: "trello", tipo: "outro", chave: "outro:x", payload: {}, proximaEm: agora },
    ]);
    const t = trelloFalso();
    expect(await processarFila({ agora, buscar: t.buscar })).toEqual({ enviados: 0, falhas: 2 });
    expect(t.chamadas).toEqual([]);
    expect((await envios()).map((e) => [e.situacao, e.ultimoErro])).toEqual([
      ["falhou", { classe: "recusado", status: null }],
      ["falhou", { classe: "recusado", status: null }],
    ]);
  });
});

describe("aprovar roteiro", () => {
  async function aprovar(f: Awaited<ReturnType<typeof vendida>>) {
    const c = await comSessao(f.u.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
    if (!c.ok || !("id" in c)) throw new Error(c.ok ? "sem id" : c.erro);
    const a = await comSessao(f.u.id, () => aprovarRoteiro(c.id));
    expect(a).toEqual({ ok: true, tarefasCriadas: 3 });
  }

  it("Trello ligado: enfileira roteiro:<viagem> com as 3 tarefas e agenda o envio", async () => {
    const f = await vendida();
    vi.mocked(processarDepois).mockClear();
    await aprovar(f);
    expect(await envioDe(`roteiro:${f.viagemId}`)).toMatchObject({
      integracao: "trello",
      tipo: "checklist_roteiro",
      viagemId: f.viagemId,
      situacao: "pendente",
      payload: { viagemId: f.viagemId, itens: ITENS_ROTEIRO },
    });
    expect(processarDepois).toHaveBeenCalledTimes(1);
  });

  it("o checklist 'Tarefas do roteiro' vai no cartão da venda; cartão na fila: aguarda sem gastar tentativa; cartão com falha: servidor", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    await aprovar(f);
    const t = trelloFalso();
    // O cartão ainda está na fila (pendente, para mais tarde): o roteiro aguarda, sem chamar o Trello e sem contar.
    await db.update(integracaoEnvios).set({ proximaEm: depois(60) }).where(eq(integracaoEnvios.chave, `venda:${f.viagemId}`));
    expect(await processarFila({ agora, buscar: t.buscar })).toEqual({ enviados: 0, falhas: 0 });
    const aguardando = await envioDe(`roteiro:${f.viagemId}`);
    expect(aguardando).toMatchObject({
      situacao: "pendente",
      tentativas: 0,
      ultimoErro: { classe: "aguardando", status: null, motivo: "aguardando_cartao" },
    });
    expect(aguardando.proximaEm).toEqual(depois(5));
    // Várias esperas seguidas não chegam a `falhou`.
    for (let i = 1; i <= 7; i++) await processarFila({ agora: depois(5 * i), buscar: t.buscar });
    expect(await envioDe(`roteiro:${f.viagemId}`)).toMatchObject({ situacao: "pendente", tentativas: 0 });
    expect(t.chamadas).toEqual([]);

    // O cartão falhou: o roteiro gasta tentativa (servidor).
    await db.update(integracaoEnvios).set({ situacao: "falhou" }).where(eq(integracaoEnvios.chave, `venda:${f.viagemId}`));
    expect(await processarFila({ agora: depois(41), buscar: t.buscar })).toEqual({ enviados: 0, falhas: 1 });
    expect(t.chamadas).toEqual([]);
    expect(await envioDe(`roteiro:${f.viagemId}`)).toMatchObject({ situacao: "pendente", tentativas: 1, ultimoErro: { classe: "servidor", status: null } });

    await db
      .update(integracaoEnvios)
      .set({ situacao: "enviado", enviadoEm: agora, resultado: { cartaoId: "card77", url: null, checklistId: "chk78", itens: 5 } })
      .where(eq(integracaoEnvios.chave, `venda:${f.viagemId}`));
    expect(await processarFila({ agora: depois(43), buscar: t.buscar })).toEqual({ enviados: 1, falhas: 0 });
    expect(t.chamadas.map((c) => [c.caminho, c.corpo])).toEqual([
      ["/1/checklists", { idCard: "card77", name: "Tarefas do roteiro" }],
      ...ITENS_ROTEIRO.map((name) => ["/1/checklists/chk1/checkItems", { name }]),
    ]);
    expect(await envioDe(`roteiro:${f.viagemId}`)).toMatchObject({ situacao: "enviado", resultado: { cartaoId: "card77", checklistId: "chk1", itens: 3 } });
  });

  it("Trello desligado na aprovação: não enfileira", async () => {
    desligarTrello();
    const f = await vendida();
    await aprovar(f);
    expect(await envios()).toEqual([]);
    expect(processarDepois).not.toHaveBeenCalled();
  });

  it("vendida com o Trello desligado e aprovada com ele ligado: entra na fila e espera o cartão (Reenviar depois)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    desligarTrello();
    const g = await vendida();
    ligarTrello();
    await aprovar(g);
    const linhas = await envios();
    expect(linhas.map((e) => [e.chave, e.situacao])).toEqual([[`roteiro:${g.viagemId}`, "pendente"]]);
    const t = trelloFalso();
    expect(await processarFila({ agora, buscar: t.buscar })).toEqual({ enviados: 0, falhas: 1 });
    expect(t.chamadas).toEqual([]);
    expect(await envioDe(`roteiro:${g.viagemId}`)).toMatchObject({ situacao: "pendente", ultimoErro: { classe: "servidor", status: null } });
  });
});

describe("enviarViagemAoTrello", () => {
  it("só o Diretor; desligado recusa; id inválido, viagem não vendida", async () => {
    desligarTrello();
    const f = await vendida();
    expect(await comSessao(f.u.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: false, erro: "O Trello não está configurado" });
    ligarTrello();
    expect(await comSessao(f.d.id, () => enviarViagemAoTrello("nada"))).toEqual({ ok: false, erro: "Viagem não encontrada" });
    const c = await comSessao(f.u.id, () => salvarCliente({ ...souza, titular: { nome: "Ana Lima" }, acompanhantes: [] }));
    if (!c.ok) throw new Error(c.erro);
    const pessoas = (await comSessao(f.u.id, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
    const o = await comSessao(f.u.id, () => criarOrcamento({ clienteId: c.id, destino: "Lisboa", inicio: "2027-03-01", fim: "2027-03-08", passageiros: pessoas }));
    if (!o.ok) throw new Error(o.erro);
    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(o.id))).toEqual({ ok: false, erro: "A viagem ainda não foi vendida" });
    expect(await envios()).toEqual([]);
  });

  it("vendida com o Trello desligado: o Diretor envia com as tarefas atuais; auditado; uma vez só", async () => {
    desligarTrello();
    const f = await vendida();
    // Uma tarefa da venda excluída não entra no checklist.
    await db
      .update(tarefas)
      .set({ excluidoEm: new Date() })
      .where(and(eq(tarefas.viagemId, f.viagemId), eq(tarefas.chave, "venda.comparativo")));
    ligarTrello();
    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: true });
    const e = await envioDe(`venda:${f.viagemId}`);
    expect(e).toMatchObject({ tipo: "cartao_viagem", situacao: "pendente" });
    expect(e.payload).toEqual({
      viagemId: f.viagemId,
      nome: `${await codigoDa(f.viagemId)} · SOUZA · Itália · 14/08 a 01/09/2027`,
      descricao: `Viagem no sistema: ${SITE}/viagens/${f.viagemId}`,
      itens: ITENS_VENDA.filter((i) => i !== "Fazer comparativo de valores de fornecedores"),
    });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, e.id));
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuarioId: f.d.id, tabela: "integracao_envios", acao: "criar" });
    expect(JSON.stringify(aud[0])).not.toContain("token-falso");
    expect(processarDepois).toHaveBeenCalledTimes(1);

    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: false, erro: "Esta viagem já foi enviada ao Trello" });
    expect(await envios()).toHaveLength(1);
  });

  async function roteiroAprovado(f: Awaited<ReturnType<typeof vendida>>) {
    const c = await comSessao(f.u.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
    if (!c.ok || !("id" in c)) throw new Error(c.ok ? "sem id" : c.erro);
    const a = await comSessao(f.u.id, () => aprovarRoteiro(c.id));
    if (!a.ok) throw new Error(a.erro);
  }

  it("vendida e roteiro aprovado com o Trello desligado: o botão leva o cartão e o checklist do roteiro", async () => {
    desligarTrello();
    const f = await vendida();
    await roteiroAprovado(f);
    await db
      .update(tarefas)
      .set({ excluidoEm: new Date() })
      .where(and(eq(tarefas.viagemId, f.viagemId), eq(tarefas.chave, "roteiro.trem")));
    ligarTrello();
    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: true });
    const r = await envioDe(`roteiro:${f.viagemId}`);
    expect(r).toMatchObject({
      tipo: "checklist_roteiro",
      situacao: "pendente",
      payload: { viagemId: f.viagemId, itens: ["Reserva de passeios", "Compra de ingressos"] },
    });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, r.id));
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuarioId: f.d.id, tabela: "integracao_envios", acao: "criar" });

    // Os dois saem: o cartão e, nele, o checklist do roteiro (que aguarda o cartão se for tomado antes).
    const t = trelloFalso();
    await processarFila({ agora, buscar: t.buscar });
    await processarFila({ agora: depois(6), buscar: t.buscar });
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({ situacao: "enviado", resultado: { cartaoId: "card1" } });
    expect(await envioDe(`roteiro:${f.viagemId}`)).toMatchObject({ situacao: "enviado", resultado: { cartaoId: "card1", itens: 2 } });
    expect(t.chamadas.filter((c) => c.caminho === "/1/cards")).toHaveLength(1);
    expect(t.chamadas.filter((c) => c.corpo?.name === "Tarefas do roteiro")).toEqual([
      expect.objectContaining({ corpo: { idCard: "card1", name: "Tarefas do roteiro" } }),
    ]);
  });

  it("vendida desligado, roteiro aprovado ligado e já em falhou: o botão cria o cartão e volta o roteiro para pendente", async () => {
    desligarTrello();
    const f = await vendida();
    ligarTrello();
    await roteiroAprovado(f);
    await db
      .update(integracaoEnvios)
      .set({ situacao: "falhou", tentativas: 6, ultimoErro: { classe: "servidor", status: null } })
      .where(eq(integracaoEnvios.chave, `roteiro:${f.viagemId}`));
    const antes = await envioDe(`roteiro:${f.viagemId}`);
    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: true });
    expect(await envioDe(`venda:${f.viagemId}`)).toMatchObject({ situacao: "pendente" });
    const depoisDoBotao = await envioDe(`roteiro:${f.viagemId}`);
    expect(depoisDoBotao).toMatchObject({ id: antes.id, situacao: "pendente", tentativas: 0, payload: antes.payload });
    expect(depoisDoBotao.proximaEm.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await envios()).toHaveLength(2);
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, antes.id));
    expect(aud.map((a) => [a.usuarioId, a.acao, (a.depois as { situacao: string }).situacao])).toEqual([[f.d.id, "alterar", "pendente"]]);
  });

  it("roteiro não aprovado: só o cartão", async () => {
    desligarTrello();
    const f = await vendida();
    const c = await comSessao(f.u.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
    if (!c.ok) throw new Error(c.erro);
    expect((await db.select().from(roteiros).where(eq(roteiros.viagemId, f.viagemId)))[0].status).toBe("rascunho");
    ligarTrello();
    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: true });
    expect((await envios()).map((e) => e.chave)).toEqual([`venda:${f.viagemId}`]);
  });
});
