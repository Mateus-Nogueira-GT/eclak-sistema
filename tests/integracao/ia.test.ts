import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import type { Perfil } from "@/domain/perfis";
import { db } from "@/server/db/client";
import { auditoria, iaUsos, pessoas, viagemPassageiros } from "@/server/db/schema";
import { reescreverTexto } from "@/server/actions/ia";
import { testarConexao } from "@/server/actions/integracoes";
import { criarRoteiro } from "@/server/actions/roteiros";
import { configIA } from "@/server/integracoes/config";
import { ErroIntegracao } from "@/server/integracoes/http";
import {
  BETA_FALLBACK,
  definirProvedorIAParaTestes,
  provedorClaude,
  provedorIA,
  type PedidoIA,
  type ProvedorIA,
  type RespostaIA,
} from "@/server/integracoes/ia";
import { obterIntegracoes } from "@/server/queries/integracoes";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

const CHAVE = "sk-ant-chave-falsa-secreta";
const CFG = { apiKey: CHAVE, modelo: "claude-opus-5-5" };

// O ambiente da máquina pode ter uma chave de verdade: todo teste começa com a IA desligada.
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("IA_MODELO", "");
});
afterEach(() => {
  definirProvedorIAParaTestes(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Chamada = { url: string; headers: Headers; body: Record<string, unknown> };

function mensagem(o: Partial<{ content: unknown[]; stop_reason: string; model: string }> = {}) {
  return {
    id: "msg_falsa",
    type: "message",
    role: "assistant",
    model: o.model ?? "claude-opus-5-5",
    content: o.content ?? [
      { type: "thinking", thinking: "", signature: "assinatura" },
      { type: "text", text: "Texto " },
      { type: "text", text: "reescrito." },
    ],
    stop_reason: o.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 10 },
  };
}

/** `fetch` falso da API: guarda os pedidos; `resposta` é o corpo JSON, ou um status de erro (corpo ecoa a chave). */
function apiFalsa(resposta: Record<string, unknown> | number | "rede" = mensagem()) {
  const chamadas: Chamada[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    if (resposta === "rede") throw new TypeError("fetch failed");
    if (typeof resposta === "number")
      return Response.json({ type: "error", error: { type: "x", message: `chave inválida ${CHAVE}` } }, { status: resposta });
    return Response.json(resposta);
  }) as typeof fetch;
  return { f, chamadas };
}

const pedido: PedidoIA = {
  sistema: "Sistema de teste",
  mensagens: [{ role: "user", content: "Olá" }],
  esforco: "low",
};

describe("adaptador Claude (SDK com fetch falso)", () => {
  it("pedido: modelo, beta de fallback, fallbacks default, effort, max_tokens; sem thinking, temperatura nem prefill", async () => {
    const { f, chamadas } = apiFalsa();
    const r = await provedorClaude(CFG, { fetch: f }).responder(pedido);
    expect(chamadas).toHaveLength(1);
    const c = chamadas[0];
    expect(new URL(c.url).pathname).toBe("/v1/messages");
    expect(c.headers.get("anthropic-beta")).toBe(BETA_FALLBACK);
    // O SDK 1.x manda a chave como Bearer.
    expect(c.headers.get("authorization")).toBe(`Bearer ${CHAVE}`);
    expect(c.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      fallbacks: "default",
      output_config: { effort: "low" },
      system: "Sistema de teste",
      messages: [{ role: "user", content: "Olá" }],
    });
    for (const k of ["thinking", "temperature", "top_p", "top_k", "betas"]) expect(c.body).not.toHaveProperty(k);
    expect(r).toMatchObject({ parada: "end_turn", texto: "Texto reescrito.", modelo: "claude-opus-5-5", tokensEntrada: 130, tokensSaida: 45 });
    expect(r.conteudo).toHaveLength(3);
  });

  it("esforço médio, max_tokens e ferramentas com tool_choice auto", async () => {
    const { f, chamadas } = apiFalsa();
    const ferramenta = { name: "buscar", description: "Busca", input_schema: { type: "object" as const, properties: {} }, strict: true };
    await provedorClaude(CFG, { fetch: f }).responder({ ...pedido, esforco: "medium", maxTokens: 300, ferramentas: [ferramenta] });
    expect(chamadas[0].body).toMatchObject({ output_config: { effort: "medium" }, max_tokens: 300, tools: [ferramenta], tool_choice: { type: "auto" } });
  });

  it("IA_MODELO troca o modelo; sem ele, claude-opus-5-5", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", CHAVE);
    expect(configIA()).toEqual({ apiKey: CHAVE, modelo: "claude-opus-5-5" });
    vi.stubEnv("IA_MODELO", "claude-sonnet-5-5");
    const { f, chamadas } = apiFalsa();
    await provedorClaude(configIA()!, { fetch: f }).responder(pedido);
    expect(chamadas[0].body.model).toBe("claude-sonnet-5-5");
  });

  it("recusa: parada refusal e nenhum texto", async () => {
    const { f } = apiFalsa(mensagem({ stop_reason: "refusal", content: [{ type: "text", text: "parcial" }] }));
    const r = await provedorClaude(CFG, { fetch: f }).responder(pedido);
    expect(r).toMatchObject({ parada: "refusal", texto: "" });
  });

  it.each([
    [401, "autenticacao"],
    [403, "autenticacao"],
    [429, "limite"],
    [400, "recusado"],
    [500, "servidor"],
    [529, "servidor"],
  ] as const)("HTTP %i vira %s; nem a mensagem nem o log têm o corpo ou a chave", async (status, classe) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { f } = apiFalsa(status);
    const erro = await provedorClaude(CFG, { fetch: f })
      .responder(pedido)
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroIntegracao);
    expect(erro).toMatchObject({ classe, status });
    expect(String((erro as Error).message)).not.toContain(CHAVE);
    expect(JSON.stringify(log.mock.calls)).not.toContain(CHAVE);
    expect(JSON.stringify(log.mock.calls)).not.toContain("inválida");
  });

  it("429 com retry-after longo: sem nova tentativa, volta logo como limite", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const f = (async () => {
      n++;
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "x" } }, { status: 429, headers: { "retry-after": "120" } });
    }) as typeof fetch;
    const inicio = Date.now();
    await expect(provedorClaude(CFG, { fetch: f }).responder(pedido)).rejects.toMatchObject({ classe: "limite", status: 429 });
    expect(n).toBe(1);
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it("prazo total estourado: o pedido é abortado e vira rede", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Fetch que só termina quando o sinal aborta (como um servidor que não responde).
    const f = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_ok, falha) => {
        init?.signal?.addEventListener("abort", () => falha(init.signal?.reason ?? new DOMException("abortado", "AbortError")));
      })) as typeof fetch;
    const inicio = Date.now();
    await expect(provedorClaude(CFG, { fetch: f, prazoMs: 50 }).responder(pedido)).rejects.toMatchObject({ classe: "rede", status: null });
    expect(Date.now() - inicio).toBeLessThan(2000);
  });

  it("falha de rede vira rede, sem status", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { f } = apiFalsa("rede");
    await expect(provedorClaude(CFG, { fetch: f }).responder(pedido)).rejects.toMatchObject({ classe: "rede", status: null });
  });

  it.each(["AbortError", "TimeoutError"])("%s cru durante a leitura do corpo vira rede", async (nome) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // Cabeçalhos chegam (200), o corpo é abortado no meio: o SDK repassa o erro do stream sem embrulhar.
    const f = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"id":"msg'));
            c.error(new DOMException("abortado", nome));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    await expect(provedorClaude(CFG, { fetch: f }).responder(pedido)).rejects.toMatchObject({ classe: "rede", status: null });
  });

  it("prazo do pedido (prazoMs) encurta o prazo total", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_ok, falha) => {
        init?.signal?.addEventListener("abort", () => falha(init.signal?.reason ?? new DOMException("abortado", "AbortError")));
      })) as typeof fetch;
    const inicio = Date.now();
    await expect(provedorClaude(CFG, { fetch: f }).responder({ ...pedido, prazoMs: 50 })).rejects.toMatchObject({ classe: "rede" });
    expect(Date.now() - inicio).toBeLessThan(2000);
  });
});

describe("provedorIA", () => {
  it("desligada (sem ANTHROPIC_API_KEY): null; ligada: o Claude com o modelo configurado", () => {
    expect(provedorIA()).toBeNull();
    vi.stubEnv("ANTHROPIC_API_KEY", CHAVE);
    expect(provedorIA()?.modelo).toBe("claude-opus-5-5");
  });
});

describe("Testar conexão da IA (Admin › Integrações)", () => {
  let diretor: { id: string };
  beforeEach(async () => {
    await limparBanco();
    diretor = await criarUsuarioTeste("diretor");
  });

  it("desligada: sem chamada; ligada: testável, um pedido mínimo e auditoria só com { ok, classe }", async () => {
    const { f, chamadas } = apiFalsa();
    vi.stubGlobal("fetch", f);
    expect(await comSessao(diretor.id, () => testarConexao("ia"))).toEqual({ ok: false, erro: "Integração desligada" });
    expect(chamadas).toHaveLength(0);

    vi.stubEnv("ANTHROPIC_API_KEY", CHAVE);
    const cartao = (await comSessao(diretor.id, () => obterIntegracoes())).cartoes.find((c) => c.integracao === "ia")!;
    expect(cartao.testavel).toBe(true);
    expect(await comSessao(diretor.id, () => testarConexao("ia"))).toEqual({ ok: true, conexao: { ok: true, classe: null } });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0].body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low" }, max_tokens: 256 });
    const [a] = await db.select().from(auditoria).where(eq(auditoria.tabela, "integracoes"));
    expect(a).toMatchObject({ registroId: "ia", acao: "criar", depois: { ok: true, classe: null } });
    expect(await db.select().from(iaUsos)).toEqual([]);
  });

  it("chave recusada (401): o teste falha com autenticacao e nada da chave na auditoria", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("ANTHROPIC_API_KEY", CHAVE);
    const { f } = apiFalsa(401);
    vi.stubGlobal("fetch", f);
    expect(await comSessao(diretor.id, () => testarConexao("ia"))).toEqual({ ok: true, conexao: { ok: false, classe: "autenticacao" } });
    const linhas = await db.select().from(auditoria).where(eq(auditoria.tabela, "integracoes"));
    expect(JSON.stringify(linhas)).not.toContain(CHAVE);
  });
});

/** Provedor falso: guarda os pedidos e devolve a resposta dada (ou lança). */
function provedorFalso(resposta: Partial<RespostaIA> | Error = {}) {
  const pedidos: PedidoIA[] = [];
  const p: ProvedorIA = {
    modelo: "claude-opus-5-5",
    async responder(x) {
      pedidos.push(x);
      if (resposta instanceof Error) throw resposta;
      return { parada: "end_turn", texto: "Sugestão da IA.", conteudo: [], modelo: "claude-opus-5-5", tokensEntrada: 200, tokensSaida: 80, ...resposta };
    },
  };
  definirProvedorIAParaTestes(p);
  return pedidos;
}

describe("reescreverTexto", () => {
  let f: Fixture;
  let op: { id: string };
  let roteiroId: string;

  beforeEach(async () => {
    await limparBanco();
    f = await vendida();
    op = await criarUsuarioTeste("operacional");
    const c = await comSessao(op.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
    if (!c.ok || !("id" in c)) throw new Error(c.ok ? "sem id" : c.erro);
    roteiroId = c.id;
    // Documentos e nascimentos dos passageiros (um com passaporte estrangeiro, fora do padrão).
    const ids = (await db.select({ id: viagemPassageiros.pessoaId }).from(viagemPassageiros).where(eq(viagemPassageiros.viagemId, f.viagemId))).map(
      (l) => l.id,
    );
    const [a, b] = await db.select().from(pessoas).where(inArray(pessoas.id, ids));
    await db.update(pessoas).set({ nascimento: "1980-03-07", cpf: "12345678909", passaporte: "FZ123456" }).where(eq(pessoas.id, a.id));
    await db.update(pessoas).set({ nascimento: "1985-11-02", passaporte: "563829104" }).where(eq(pessoas.id, b.id));
  });

  const TEXTO =
    "Marcos (CPF 123.456.789-09, também 12345678909, passaporte FZ123456) faz aniversário em 07/03/1980 (1980-03-07); " +
    "Júlia nasceu em 1985-11-02, documento 563829104. Embarque em 14/08/2027, total R$ 1.234,56. Buongiorno!";

  it("o texto chega ao provedor com marcadores; a sugestão volta e o uso é gravado sem texto", async () => {
    const pedidos = provedorFalso();
    const r = await comSessao(op.id, () => reescreverTexto({ texto: TEXTO, finalidade: "abertura", idioma: "italiano", roteiroId }));
    expect(r).toEqual({ ok: true, texto: "Sugestão da IA." });
    expect(pedidos).toHaveLength(1);
    const enviado = JSON.stringify(pedidos[0].mensagens);
    for (const sensivel of ["123.456.789-09", "12345678909", "FZ123456", "07/03/1980", "1980-03-07", "1985-11-02", "563829104"])
      expect(enviado).not.toContain(sensivel);
    expect(enviado).toContain("[CPF]");
    expect(enviado).toContain("[PASSAPORTE]");
    expect(enviado).toContain("[NASCIMENTO]");
    expect(enviado).toContain("[DOCUMENTO]");
    // Datas de viagem, valores e a saudação ficam.
    expect(enviado).toContain("14/08/2027");
    expect(enviado).toContain("R$ 1.234,56");
    expect(enviado).toContain("Buongiorno!");
    expect(pedidos[0].esforco).toBe("low");
    expect(pedidos[0].sistema).toContain("Sem emoji");
    expect(pedidos[0].sistema).toContain("italiano");
    expect(pedidos[0].sistema).toContain("Sua viagem");
    expect(pedidos[0].sistema).not.toContain(TEXTO);

    const usos = await db.select().from(iaUsos);
    expect(usos).toHaveLength(1);
    expect(usos[0]).toMatchObject({ usuarioId: op.id, recurso: "reescrever:abertura", modelo: "claude-opus-5-5", tokensEntrada: 200, tokensSaida: 80 });
    expect(Object.keys(usos[0]).sort()).toEqual(["em", "id", "modelo", "recurso", "tokensEntrada", "tokensSaida", "usuarioId"]);
  });

  it("sem roteiro: padrões ainda protegidos; cada finalidade tem a sua instrução e o idioma português não fala de saudação estrangeira", async () => {
    const pedidos = provedorFalso();
    const r = await comSessao(op.id, () => reescreverTexto({ texto: "CPF 123.456.789-09. Dia livre.", finalidade: "daily", idioma: "portugues" }));
    expect(r).toEqual({ ok: true, texto: "Sugestão da IA." });
    expect(JSON.stringify(pedidos[0].mensagens)).toContain("[CPF]");
    expect(pedidos[0].sistema).toContain("*06h20*");
    expect(pedidos[0].sistema).not.toContain("idioma do destino");
    const [u] = await db.select().from(iaUsos);
    expect(u.recurso).toBe("reescrever:daily");
  });

  it("recusa: a mensagem, sem sugestão; o uso (pago) é gravado", async () => {
    provedorFalso({ parada: "refusal", texto: "" });
    expect(await comSessao(op.id, () => reescreverTexto({ texto: "Dica do dia.", finalidade: "dica", idioma: "italiano", roteiroId }))).toEqual({
      ok: false,
      erro: "A IA não respondeu a este pedido",
    });
    expect(await db.select().from(iaUsos)).toHaveLength(1);
  });

  it("resposta cortada (max_tokens) ou vazia: a mensagem", async () => {
    provedorFalso({ parada: "max_tokens", texto: "Pela met" });
    expect(await comSessao(op.id, () => reescreverTexto({ texto: "Dica.", finalidade: "dica", idioma: "italiano" }))).toEqual({
      ok: false,
      erro: "A IA não respondeu a este pedido",
    });
    provedorFalso({ texto: "   " });
    expect(await comSessao(op.id, () => reescreverTexto({ texto: "Dica.", finalidade: "dica", idioma: "italiano" }))).toEqual({
      ok: false,
      erro: "A IA não respondeu a este pedido",
    });
  });

  it("sugestão maior que o campo (dica: 1000) é recusada", async () => {
    provedorFalso({ texto: "a".repeat(1001) });
    expect(await comSessao(op.id, () => reescreverTexto({ texto: "Dica.", finalidade: "dica", idioma: "italiano" }))).toEqual({
      ok: false,
      erro: "A sugestão passou do tamanho do campo. Tente de novo.",
    });
  });

  it("desligada: a mensagem, nenhuma chamada e nada gravado", async () => {
    expect(await comSessao(op.id, () => reescreverTexto({ texto: "Texto.", finalidade: "abertura", idioma: "italiano", roteiroId }))).toEqual({
      ok: false,
      erro: "A IA não está configurada",
    });
    expect(await db.select().from(iaUsos)).toEqual([]);
  });

  it("serviço fora (limite) ou chave recusada: mensagem da classe e nada gravado", async () => {
    provedorFalso(new ErroIntegracao("limite", 429));
    expect(await comSessao(op.id, () => reescreverTexto({ texto: "Texto.", finalidade: "porque", idioma: "italiano" }))).toEqual({
      ok: false,
      erro: "Limite de uso da IA atingido. Tente de novo em alguns minutos.",
    });
    provedorFalso(new ErroIntegracao("autenticacao", 401));
    expect(await comSessao(op.id, () => reescreverTexto({ texto: "Texto.", finalidade: "porque", idioma: "italiano" }))).toEqual({
      ok: false,
      erro: "A chave da IA foi recusada. Avise o Diretor.",
    });
    expect(await db.select().from(iaUsos)).toEqual([]);
  });

  it("validação: vazio, longo demais, finalidade e roteiro desconhecidos; nada chega ao provedor", async () => {
    const pedidos = provedorFalso();
    const chamar = (d: Parameters<typeof reescreverTexto>[0]) => comSessao(op.id, () => reescreverTexto(d));
    expect(await chamar({ texto: "   ", finalidade: "dica", idioma: "italiano" })).toEqual({ ok: false, erro: "Escreva o texto antes de reescrever" });
    expect(await chamar({ texto: "a".repeat(4001), finalidade: "abertura", idioma: "italiano" })).toEqual({
      ok: false,
      erro: "Texto longo demais para reescrever (até 4.000 caracteres)",
    });
    expect(await chamar({ texto: "Texto.", finalidade: "outra" as "dica", idioma: "italiano" })).toMatchObject({ ok: false });
    expect(await chamar({ texto: "Texto.", finalidade: "dica", idioma: "italiano", roteiroId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      ok: false,
      erro: "Roteiro não encontrado",
    });
    expect(pedidos).toEqual([]);
    expect(await db.select().from(iaUsos)).toEqual([]);
  });

  it.each(["diretor", "consultor", "operacional", "fin_operacional", "fin_estrategico"] as Perfil[])("%s pode reescrever", async (perfil) => {
    provedorFalso();
    const u = await criarUsuarioTeste(perfil);
    expect(await comSessao(u.id, () => reescreverTexto({ texto: "Texto.", finalidade: "dica", idioma: "italiano", roteiroId }))).toEqual({
      ok: true,
      texto: "Sugestão da IA.",
    });
  });
});
