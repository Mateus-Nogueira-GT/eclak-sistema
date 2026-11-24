import { describe, expect, it } from "vitest";
import {
  ESPERAS_MIN,
  INTEGRACOES,
  INTEGRACOES_FILA,
  MAX_TENTATIVAS,
  SITUACOES_ENVIO,
  classificarStatus,
  proximaTentativa,
  repete,
  linkHttps,
  rotuloDoErro,
} from "@/domain/integracoes";
import { VARIAVEIS, configDrive, configIA, configTrello, estadoIntegracao } from "@/server/integracoes/config";
import { ErroIntegracao, chamar, type Buscar } from "@/server/integracoes/http";

const MIN = 60_000;
const t = new Date("2027-01-10T12:00:00.000Z");

describe("constantes", () => {
  it("valores exatos", () => {
    expect(INTEGRACOES).toEqual(["trello", "drive", "ia", "hotelaria", "agendador"]);
    expect(INTEGRACOES_FILA).toEqual(["trello", "drive"]);
    expect(SITUACOES_ENVIO).toEqual(["pendente", "enviando", "enviado", "falhou"]);
    expect(MAX_TENTATIVAS).toBe(6);
    expect(ESPERAS_MIN).toEqual([1, 5, 15, 60, 180]);
  });
});

describe("proximaTentativa", () => {
  it.each([
    [1, 1],
    [2, 5],
    [3, 15],
    [4, 60],
    [5, 180],
  ])("depois da tentativa %i espera %i min", (n, min) => {
    expect(proximaTentativa(n, t)).toEqual(new Date(t.getTime() + min * MIN));
  });
  it("a sexta falha não tem próxima", () => {
    expect(proximaTentativa(6, t)).toBeNull();
    expect(proximaTentativa(7, t)).toBeNull();
  });
  it("não muta a data recebida", () => {
    proximaTentativa(1, t);
    expect(t.toISOString()).toBe("2027-01-10T12:00:00.000Z");
  });
});

describe("classificarStatus e repete", () => {
  it.each([
    [401, "autenticacao"],
    [403, "autenticacao"],
    [429, "limite"],
    [400, "recusado"],
    [404, "recusado"],
    [422, "recusado"],
    [500, "servidor"],
    [503, "servidor"],
  ] as const)("%i é %s", (s, c) => expect(classificarStatus(s)).toBe(c));
  it("repete rede, limite e servidor; não repete autenticação nem recusado", () => {
    expect(repete("rede")).toBe(true);
    expect(repete("limite")).toBe(true);
    expect(repete("servidor")).toBe(true);
    expect(repete("autenticacao")).toBe(false);
    expect(repete("recusado")).toBe(false);
  });
});

describe("estadoIntegracao", () => {
  const trello = { TRELLO_API_KEY: "k", TRELLO_TOKEN: "t", TRELLO_LISTA_ID: "l" };
  it("trello sem nada: faltam as três, na ordem", () => {
    expect(estadoIntegracao("trello", {})).toEqual({
      configurada: false,
      faltam: ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_LISTA_ID"],
    });
  });
  it("trello com as três: configurada", () => {
    expect(estadoIntegracao("trello", trello)).toEqual({ configurada: true, faltam: [] });
  });
  it("variável só com espaços conta como faltando", () => {
    expect(estadoIntegracao("trello", { ...trello, TRELLO_TOKEN: "   " })).toEqual({
      configurada: false,
      faltam: ["TRELLO_TOKEN"],
    });
  });
  it("hotelaria: sempre desligada, sem variável", () => {
    expect(VARIAVEIS.hotelaria).toEqual([]);
    expect(estadoIntegracao("hotelaria", {})).toEqual({ configurada: false, faltam: [] });
  });
  it("drive, ia e agendador", () => {
    expect(estadoIntegracao("drive", {}).faltam).toEqual(["GOOGLE_SA_EMAIL", "GOOGLE_SA_CHAVE", "GOOGLE_DRIVE_PASTA_RAIZ_ID"]);
    expect(estadoIntegracao("ia", {}).faltam).toEqual(["ANTHROPIC_API_KEY"]);
    expect(estadoIntegracao("ia", { ANTHROPIC_API_KEY: "x" })).toEqual({ configurada: true, faltam: [] });
    expect(estadoIntegracao("agendador", {}).faltam).toEqual(["CRON_SECRET"]);
  });
  it("faltam só tem nomes, nunca valores", () => {
    const r = estadoIntegracao("trello", { TRELLO_API_KEY: "segredo-123" });
    expect(JSON.stringify(r)).not.toContain("segredo-123");
  });
  it("lê o ambiente na chamada (process.env por padrão)", () => {
    const antes = process.env.TRELLO_API_KEY;
    process.env.TRELLO_API_KEY = "agora";
    try {
      expect(estadoIntegracao("trello").faltam).not.toContain("TRELLO_API_KEY");
    } finally {
      if (antes === undefined) delete process.env.TRELLO_API_KEY;
      else process.env.TRELLO_API_KEY = antes;
    }
  });
});

describe("leitores de configuração", () => {
  it("trello: null quando desligada, valores aparados quando ligada", () => {
    expect(configTrello({})).toBeNull();
    expect(configTrello({ TRELLO_API_KEY: " k ", TRELLO_TOKEN: "t", TRELLO_LISTA_ID: "l" })).toEqual({
      apiKey: "k",
      token: "t",
      listaId: "l",
    });
  });
  it("drive: troca \\n literal por quebra de linha na chave", () => {
    expect(configDrive({ GOOGLE_SA_EMAIL: "e" })).toBeNull();
    const c = configDrive({
      GOOGLE_SA_EMAIL: "sa@x.iam.gserviceaccount.com",
      GOOGLE_SA_CHAVE: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n",
      GOOGLE_DRIVE_PASTA_RAIZ_ID: "raiz",
    });
    expect(c).toEqual({
      email: "sa@x.iam.gserviceaccount.com",
      chave: "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n",
      pastaRaizId: "raiz",
    });
  });
  it("ia: modelo padrão claude-opus-5-5, IA_MODELO troca", () => {
    expect(configIA({})).toBeNull();
    expect(configIA({ ANTHROPIC_API_KEY: "a" })).toEqual({ apiKey: "a", modelo: "claude-opus-5-5" });
    expect(configIA({ ANTHROPIC_API_KEY: "a", IA_MODELO: " outro " })).toEqual({ apiKey: "a", modelo: "outro" });
    expect(configIA({ ANTHROPIC_API_KEY: "a", IA_MODELO: "  " })).toEqual({ apiKey: "a", modelo: "claude-opus-5-5" });
  });
});

describe("chamar", () => {
  const corpoSecreto = JSON.stringify({ error: "token segredo-xyz inválido" });
  const resposta = (status: number, corpo: string | null) => (async () => new Response(corpo, { status })) as Buscar;

  it("200 com JSON", async () => {
    const r = await chamar(resposta(200, JSON.stringify({ id: "c1" })), "https://x.test/a", { method: "GET" });
    expect(r).toEqual({ ok: true, status: 200, json: { id: "c1" } });
  });
  it("2xx sem corpo: json null", async () => {
    const r = await chamar(resposta(204, null), "https://x.test/a", {});
    expect(r).toEqual({ ok: true, status: 204, json: null });
  });
  it("2xx com corpo que não é JSON: servidor, sem corpo", async () => {
    const r = await chamar(resposta(200, "<html>segredo-xyz</html>"), "https://x.test/a", {});
    expect(r).toEqual({ ok: false, classe: "servidor", status: 200 });
  });
  it.each([
    [500, "servidor"],
    [503, "servidor"],
    [401, "autenticacao"],
    [429, "limite"],
    [404, "recusado"],
  ] as const)("%i vira %s e o corpo não aparece", async (status, classe) => {
    const r = await chamar(resposta(status, corpoSecreto), "https://x.test/a", {});
    expect(r).toEqual({ ok: false, classe, status });
    expect(JSON.stringify(r)).not.toContain("segredo-xyz");
  });
  it("rejeição do fetch: rede, status null, sem mensagem", async () => {
    const buscar = (async () => {
      throw new TypeError("fetch failed: segredo-xyz");
    }) as Buscar;
    const r = await chamar(buscar, "https://x.test/a", {});
    expect(r).toEqual({ ok: false, classe: "rede", status: null });
  });
  it("timeout pelo AbortSignal: rede", async () => {
    let recebeuSinal = false;
    const buscar = ((_url: string, init?: RequestInit) =>
      new Promise((_ok, falha) => {
        const s = init?.signal;
        recebeuSinal = s instanceof AbortSignal;
        s?.addEventListener("abort", () => falha(s.reason));
      })) as Buscar;
    const r = await chamar(buscar, "https://x.test/a", { timeoutMs: 20 });
    expect(recebeuSinal).toBe(true);
    expect(r).toEqual({ ok: false, classe: "rede", status: null });
  });
  it("timeout durante a leitura do corpo: rede", async () => {
    const buscar = ((_url: string, init?: RequestInit) => {
      const corpo = new ReadableStream({
        start(c) {
          init?.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
        },
      });
      return Promise.resolve(new Response(corpo, { status: 200 }));
    }) as Buscar;
    const r = await chamar(buscar, "https://x.test/a", { timeoutMs: 20 });
    expect(r).toEqual({ ok: false, classe: "rede", status: null });
  });
  it("repassa método, cabeçalhos e corpo; não repassa timeoutMs", async () => {
    let visto: RequestInit | undefined;
    const buscar = (async (_u: string, init?: RequestInit) => {
      visto = init;
      return new Response("{}", { status: 200 });
    }) as Buscar;
    await chamar(buscar, "https://x.test/a", { method: "POST", headers: { A: "1" }, body: "{}", timeoutMs: 1000 });
    expect(visto?.method).toBe("POST");
    expect(visto?.headers).toEqual({ A: "1" });
    expect(visto?.body).toBe("{}");
    expect(visto && "timeoutMs" in visto).toBe(false);
  });
});

describe("ErroIntegracao", () => {
  it("guarda classe e status; mensagem sem corpo", () => {
    const e = new ErroIntegracao("servidor", 503);
    expect(e).toBeInstanceOf(Error);
    expect(e.classe).toBe("servidor");
    expect(e.status).toBe(503);
    expect(e.message).toBe("Falha na integração: servidor (HTTP 503)");
    expect(new ErroIntegracao("rede", null).message).toBe("Falha na integração: rede");
  });
});

describe("rotuloDoErro", () => {
  it("o motivo de espera vem antes da classe", () => {
    expect(rotuloDoErro({ classe: "aguardando", status: null, motivo: "aguardando_cartao" })).toBe("Aguardando o cartão da venda");
  });
  it("cada classe tem rótulo em pt-BR", () => {
    expect(rotuloDoErro({ classe: "rede", status: null })).toBe("Sem conexão");
    expect(rotuloDoErro({ classe: "autenticacao", status: 401 })).toBe("Credencial recusada");
    expect(rotuloDoErro({ classe: "limite", status: 429 })).toBe("Limite de uso atingido");
    expect(rotuloDoErro({ classe: "recusado", status: 400 })).toBe("Pedido recusado");
    expect(rotuloDoErro({ classe: "servidor", status: 503 })).toBe("Erro no serviço");
  });
  it("sem erro, ou com forma desconhecida, não inventa rótulo", () => {
    expect(rotuloDoErro(null)).toBeNull();
    expect(rotuloDoErro({ classe: "outra", status: null })).toBe("Erro no serviço");
    expect(rotuloDoErro({ classe: "toString", status: null, motivo: "constructor" })).toBe("Erro no serviço");
  });
});

describe("linkHttps", () => {
  it("só https passa", () => {
    expect(linkHttps("https://trello.com/c/x")).toBe("https://trello.com/c/x");
    expect(linkHttps("http://trello.com/c/x")).toBeNull();
    expect(linkHttps("javascript:alert(1)")).toBeNull();
    expect(linkHttps("não é url")).toBeNull();
    expect(linkHttps(42)).toBeNull();
    expect(linkHttps(undefined)).toBeNull();
  });
});

describe("ambiente dos testes (tests/setup-env.ts)", () => {
  it("toda variável de integração começa vazia, sem stub neste arquivo (a shell pode ter chave de verdade)", async () => {
    // O ambiente é lido antes de importar a lista (o import roda o setup de novo).
    const ambiente = { ...process.env };
    expect(configIA()).toBeNull();
    for (const i of INTEGRACOES) expect(estadoIntegracao(i).configurada).toBe(false);
    const { VARIAVEIS_DE_INTEGRACAO } = await import("../setup-env");
    for (const nome of Object.values(VARIAVEIS).flat()) expect(VARIAVEIS_DE_INTEGRACAO).toContain(nome);
    for (const nome of VARIAVEIS_DE_INTEGRACAO) expect(ambiente[nome]).toBe("");
  });
});
