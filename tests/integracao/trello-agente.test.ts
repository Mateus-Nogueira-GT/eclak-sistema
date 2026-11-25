import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baixar, ErroIntegracao, urlDeTeste } from "@/server/integracoes/http";
import { baseTrello, clienteTrello, esquecerQuadrosTrello, TRELLO_API } from "@/server/integracoes/trello";

const CFG = { apiKey: "chave-falsa", token: "token-falso", listaId: "lista-1" };
const AUTORIZACAO = 'OAuth oauth_consumer_key="chave-falsa", oauth_token="token-falso"';

type Chamada = {
  metodo: string;
  url: string;
  caminho: string;
  params: Record<string, string>;
  auth: string | null;
  corpo: Record<string, unknown> | null;
};

function trelloFalso(handler: (c: Chamada) => Response | null = () => null) {
  const chamadas: Chamada[] = [];
  const buscar = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const h = new Headers(init?.headers);
    const c: Chamada = {
      metodo: init?.method ?? "GET",
      url: String(url),
      caminho: u.pathname,
      params: Object.fromEntries(u.searchParams),
      auth: h.get("authorization"),
      corpo: init?.body ? JSON.parse(String(init.body)) : null,
    };
    chamadas.push(c);
    const custom = handler(c);
    if (custom) return custom;
    if (c.metodo === "GET" && c.caminho === "/1/lists/lista-1") return Response.json({ id: "lista-1", idBoard: "board-1", name: "Operações" });
    if (c.metodo === "GET" && c.caminho === "/1/boards/board-1/lists") {
      return Response.json([
        { id: "lista-1", name: "Operações" },
        { id: "lista-2", name: "Emissão" },
      ]);
    }
    if (c.metodo === "GET" && c.caminho === "/1/boards/board-1/cards/open") {
      return Response.json([
        {
          id: "c1",
          name: "ECL-0001-01 · SOUZA",
          idList: "lista-1",
          due: "2027-08-14T16:00:00.000Z",
          dueComplete: false,
          shortUrl: "https://trello.com/c/c1",
        },
      ]);
    }
    if (c.metodo === "GET" && c.caminho === "/1/cards/c1") {
      const comentarios = Array.from({ length: 25 }, (_, i) => ({
        type: "commentCard",
        date: `2026-11-${String(25 - Math.floor(i / 2)).padStart(2, "0")}T12:00:00.000Z`,
        memberCreator: { fullName: `Autor ${i}` },
        data: { text: `Comentário ${i}` },
      }));
      return Response.json({
        id: "c1",
        idBoard: "board-1",
        name: "ECL-0001-01 · SOUZA",
        desc: "Descrição",
        idList: "lista-1",
        due: null,
        dueComplete: false,
        shortUrl: "https://trello.com/c/c1",
        checklists: [
          {
            id: "chk1",
            name: "Tarefas da venda",
            checkItems: [
              { id: "i1", name: "Emitir seguro", state: "complete" },
              { id: "i2", name: "Reservar hotel", state: "incomplete" },
            ],
          },
        ],
        actions: comentarios,
      });
    }
    if (c.metodo === "GET" && c.caminho === "/1/cards/outro-quadro") {
      return Response.json({
        id: "outro-quadro",
        idBoard: "board-2",
        name: "Outro",
        desc: "",
        idList: "lista-x",
        due: null,
        dueComplete: false,
        shortUrl: "https://trello.com/c/outro",
        checklists: [],
        actions: [],
      });
    }
    if (c.metodo === "POST" && c.caminho === "/1/cards") return Response.json({ id: "c-novo", shortUrl: "https://trello.com/c/novo" });
    if (c.metodo === "POST" && c.caminho === "/1/cards/c1/actions/comments") return Response.json({ id: "act1" });
    if (c.metodo === "PUT" && c.caminho === "/1/cards/c1/checkItem/i2") return Response.json({ id: "i2", state: "complete" });
    if (c.metodo === "PUT" && c.caminho === "/1/cards/c1") return Response.json({ id: "c1" });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { buscar, chamadas };
}

beforeEach(() => {
  esquecerQuadrosTrello();
});
afterEach(() => {
  vi.unstubAllEnvs();
  esquecerQuadrosTrello();
});

describe("http: urlDeTeste e baixar", () => {
  it("urlDeTeste só aceita loopback http", () => {
    const oficial = "https://api.trello.com/1";
    expect(urlDeTeste(undefined, oficial)).toBe(oficial);
    expect(urlDeTeste("", oficial)).toBe(oficial);
    expect(urlDeTeste("https://evil.io", oficial)).toBe(oficial);
    expect(urlDeTeste("https://127.0.0.1:4010", oficial)).toBe(oficial);
    expect(urlDeTeste("http://127.0.0.1.evil.io:4010", oficial)).toBe(oficial);
    expect(urlDeTeste("http://user:pass@127.0.0.1:4010", oficial)).toBe(oficial);
    expect(urlDeTeste("http://127.0.0.1:4010", oficial)).toBe("http://127.0.0.1:4010");
    expect(urlDeTeste("http://127.0.0.1:4010/1/", oficial)).toBe("http://127.0.0.1:4010/1");
    expect(urlDeTeste("http://localhost:4010", oficial)).toBe("http://localhost:4010");
    expect(urlDeTeste("http://[::1]:4010", oficial)).toBe("http://[::1]:4010");
  });

  it("baixar devolve bytes dentro do limite e recusa acima de maxBytes em streaming", async () => {
    const okBuscar = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "Content-Type": "application/pdf; charset=utf-8" } })) as typeof fetch;
    const rOk = await baixar(okBuscar, "https://exemplo.test/a.pdf", { maxBytes: 4 });
    expect(rOk).toEqual({ ok: true, bytes: new Uint8Array([1, 2, 3, 4]), mime: "application/pdf", status: 200 });

    const streamGrande = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(new Uint8Array(6));
        ctrl.enqueue(new Uint8Array(6));
        ctrl.close();
      },
    });
    const grandeBuscar = (async () => new Response(streamGrande, { status: 200 })) as typeof fetch;
    const rGrande = await baixar(grandeBuscar, "https://exemplo.test/grande.pdf", { maxBytes: 10 });
    expect(rGrande).toEqual({ ok: false, classe: "recusado", status: 200 });
  });
});

describe("clienteTrello: leitura e escrita do agente", () => {
  it("baseTrello usa TRELLO_API_URL só se loopback", () => {
    expect(baseTrello({})).toBe(TRELLO_API);
    expect(baseTrello({ TRELLO_API_URL: "https://evil.io/1" })).toBe(TRELLO_API);
    expect(baseTrello({ TRELLO_API_URL: "http://127.0.0.1:4010/1" })).toBe("http://127.0.0.1:4010/1");
  });

  it("quadroId chama a rede uma vez em duas chamadas", async () => {
    const t = trelloFalso();
    const cli = clienteTrello(CFG, t.buscar);
    expect(await cli.quadroId()).toBe("board-1");
    expect(await cli.quadroId()).toBe("board-1");
    expect(t.chamadas).toHaveLength(1);
    expect(t.chamadas[0]).toMatchObject({
      metodo: "GET",
      caminho: "/1/lists/lista-1",
      params: { fields: "idBoard" },
      auth: AUTORIZACAO,
    });
  });

  it("listas e cartoes consultam o quadro configurado sem segredo na URL", async () => {
    const t = trelloFalso();
    const cli = clienteTrello(CFG, t.buscar);
    expect(await cli.listas()).toEqual([
      { id: "lista-1", nome: "Operações" },
      { id: "lista-2", nome: "Emissão" },
    ]);
    expect(await cli.cartoes()).toEqual([
      {
        id: "c1",
        nome: "ECL-0001-01 · SOUZA",
        listaId: "lista-1",
        prazo: "2027-08-14T16:00:00.000Z",
        concluido: false,
        link: "https://trello.com/c/c1",
      },
    ]);
    for (const c of t.chamadas) {
      expect(c.auth).toBe(AUTORIZACAO);
      expect(c.url).not.toContain(CFG.apiKey);
      expect(c.url).not.toContain(CFG.token);
    }
  });

  it("cartao devolve detalhes, checklists e até 20 comentários; outro quadro ou 404 vira null", async () => {
    const t = trelloFalso();
    const cli = clienteTrello(CFG, t.buscar);
    const c = await cli.cartao("c1");
    expect(c).toMatchObject({
      id: "c1",
      nome: "ECL-0001-01 · SOUZA",
      descricao: "Descrição",
      checklists: [
        {
          id: "chk1",
          nome: "Tarefas da venda",
          itens: [
            { id: "i1", nome: "Emitir seguro", feito: true },
            { id: "i2", nome: "Reservar hotel", feito: false },
          ],
        },
      ],
    });
    expect(c!.comentarios).toHaveLength(20);
    expect(c!.comentarios[0]).toMatchObject({ autor: "Autor 0", texto: "Comentário 0" });

    expect(await cli.cartao("outro-quadro")).toBeNull();
    expect(await cli.cartao("nao-existe")).toBeNull();
  });

  it("comentar, marcarItem, atualizarCartao e criarCartaoEm mandam verbo, URL e corpo certos", async () => {
    const t = trelloFalso();
    const cli = clienteTrello(CFG, t.buscar);
    await cli.comentar("c1", "[Diretor, pelo sistema] Voucher ok");
    await cli.marcarItem("c1", "i2", true);
    await cli.atualizarCartao("c1", { idList: "lista-2", due: "2026-12-01T16:00:00.000Z" });
    const novo = await cli.criarCartaoEm("lista-2", { nome: "Avulso", descricao: "Detalhe" });
    expect(novo).toEqual({ id: "c-novo", url: "https://trello.com/c/novo" });

    expect(t.chamadas.map((c) => [c.metodo, c.caminho, c.corpo])).toEqual([
      ["POST", "/1/cards/c1/actions/comments", { text: "[Diretor, pelo sistema] Voucher ok" }],
      ["PUT", "/1/cards/c1/checkItem/i2", { state: "complete" }],
      ["PUT", "/1/cards/c1", { idList: "lista-2", due: "2026-12-01T16:00:00.000Z" }],
      ["POST", "/1/cards", { idList: "lista-2", name: "Avulso", desc: "Detalhe" }],
    ]);
    expect(t.chamadas.every((c) => c.auth === AUTORIZACAO)).toBe(true);
  });

  it("401 lança ErroIntegracao('autenticacao')", async () => {
    const t = trelloFalso(() => new Response("unauthorized", { status: 401 }));
    await expect(clienteTrello(CFG, t.buscar).quadroId()).rejects.toSatisfy(
      (e: unknown) => e instanceof ErroIntegracao && e.classe === "autenticacao" && e.status === 401,
    );
  });
});
