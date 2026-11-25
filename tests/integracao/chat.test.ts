import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import type { Perfil } from "@/domain/perfis";
import { db } from "@/server/db/client";
import { iaUsos, pessoas } from "@/server/db/schema";
import { conversar } from "@/server/actions/chat";
import { criarTarefa } from "@/server/actions/tarefas";
import { ErroIntegracao } from "@/server/integracoes/http";
import { definirProvedorIAParaTestes, MAX_TOKENS_IA, type PedidoIA, type ProvedorIA, type RespostaIA } from "@/server/integracoes/ia";
import { FERRAMENTAS_CHAT } from "@/server/ia/ferramentas";
import { listarOrcamentos } from "@/server/queries/viagens";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

// O ambiente da máquina pode ter uma chave de verdade: todo teste começa com a IA desligada.
beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("IA_MODELO", "");
  vi.stubEnv("TRELLO_API_KEY", "");
  vi.stubEnv("TRELLO_TOKEN", "");
  vi.stubEnv("TRELLO_LISTA_ID", "");
  vi.stubEnv("GOOGLE_SA_EMAIL", "");
  vi.stubEnv("GOOGLE_SA_CHAVE", "");
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "");
});
afterEach(() => {
  definirProvedorIAParaTestes(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type Bloco = RespostaIA["conteudo"][number];
type Volta = Partial<RespostaIA> | Error;

const pensamento = (n: number): Bloco => ({ type: "thinking", thinking: `pensando ${n}`, signature: `assinatura-${n}` }) as Bloco;
const usoDe = (id: string, name: string, input: Record<string, unknown>): Bloco => ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as Bloco;
const textoDe = (text: string): Bloco => ({ type: "text", text, citations: null }) as Bloco;

/** Pedido de ferramenta (com o bloco de pensamento antes, como o modelo devolve). */
function pedeFerramenta(n: number, ...usos: Bloco[]): Partial<RespostaIA> {
  return { parada: "tool_use", texto: "", conteudo: [pensamento(n), ...usos] };
}
function responde(texto: string): Partial<RespostaIA> {
  return { parada: "end_turn", texto, conteudo: [pensamento(99), textoDe(texto)] };
}

/**
 * Provedor falso com um roteiro de voltas (a última se repete). Guarda cópias profundas dos pedidos (o laço reaproveita
 * a lista de mensagens entre voltas).
 */
function provedorFalso(voltas: Volta[]) {
  const pedidos: PedidoIA[] = [];
  const p: ProvedorIA = {
    modelo: "claude-opus-5-5",
    async responder(x) {
      pedidos.push(structuredClone(x));
      const v = voltas[Math.min(pedidos.length - 1, voltas.length - 1)];
      if (v instanceof Error) throw v;
      return { parada: "end_turn", texto: "", conteudo: [], modelo: "claude-opus-5-5", tokensEntrada: 100, tokensSaida: 10, ...v };
    },
  };
  definirProvedorIAParaTestes(p);
  return pedidos;
}

type ResultadoFerramenta = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/** Resultados de ferramenta da última mensagem (do usuário) de um pedido. */
function resultados(p: PedidoIA): ResultadoFerramenta[] {
  const ultima = p.mensagens[p.mensagens.length - 1];
  expect(ultima.role).toBe("user");
  expect(Array.isArray(ultima.content)).toBe(true);
  return ultima.content as unknown as ResultadoFerramenta[];
}

const pergunta = (texto: string) => [{ de: "eu" as const, texto }];

let f: Fixture;
let codigo: string;

beforeEach(async () => {
  await limparBanco();
  f = await vendida();
  codigo = (await comSessao(f.u.id, () => listarOrcamentos()))[0].codigo;
  // Dados pessoais que nunca podem sair pelas ferramentas.
  await db.update(pessoas).set({ nascimento: "1980-03-07", cpf: "12345678909", passaporte: "FZ123456" }).where(eq(pessoas.titular, true));
});

describe("conversar: resumo_da_viagem e o perfil", () => {
  it("consultor: o tool_result não tem custo nem margem; a resposta volta e o uso é gravado sem texto", async () => {
    const pedidos = provedorFalso([pedeFerramenta(1, usoDe("t1", "resumo_da_viagem", { codigo })), responde("A viagem é para a Itália.")]);
    const r = await comSessao(f.u.id, () => conversar(pergunta(`Resumo da ${codigo}`)));
    expect(r).toEqual({ ok: true, texto: "A viagem é para a Itália.", propostas: [] });
    expect(pedidos).toHaveLength(2);

    const [res] = resultados(pedidos[1]);
    expect(res.tool_use_id).toBe("t1");
    expect(res.is_error).toBeFalsy();
    const dados = JSON.parse(res.content);
    expect(dados).toMatchObject({ codigo, destino: "Itália", cliente: expect.any(String) });
    expect(dados.passageiros).toContain("Marcos Souza");
    // Nada estratégico: nem a chave, nem os valores de custo do fornecedor da fixture.
    expect(res.content).not.toMatch(/custo|margem|compensa/i);
    expect(dados.camadaEstrategica).toBeUndefined();
    for (const v of ["3.106", "3106", "R$ 500,00", "50000", "8.000,00", "800000"]) expect(res.content).not.toContain(v);
    // Nada pessoal.
    for (const v of ["1980-03-07", "07/03/1980", "12345678909", "123.456.789-09", "FZ123456", "529.982.247-25", "9123-4567", "99123"])
      expect(res.content).not.toContain(v);

    const usos = await db.select().from(iaUsos);
    expect(usos).toHaveLength(1);
    expect(usos[0]).toMatchObject({ usuarioId: f.u.id, recurso: "chat", modelo: "claude-opus-5-5", tokensEntrada: 200, tokensSaida: 20 });
    expect(Object.keys(usos[0]).sort()).toEqual(["em", "id", "modelo", "recurso", "tokensEntrada", "tokensSaida", "usuarioId"]);
  });

  it.each(["diretor", "fin_operacional", "fin_estrategico"] as Perfil[])("%s: o tool_result tem custo e margem", async (perfil) => {
    const pedidos = provedorFalso([pedeFerramenta(1, usoDe("t1", "resumo_da_viagem", { codigo })), responde("Ok.")]);
    const u = perfil === "diretor" ? f.d : perfil === "fin_operacional" ? f.fin : await criarUsuarioTeste(perfil);
    expect(await comSessao(u.id, () => conversar(pergunta("Qual a margem?")))).toEqual({ ok: true, texto: "Ok.", propostas: [] });
    const [res] = resultados(pedidos[1]);
    expect(res.is_error).toBeFalsy();
    const dados = JSON.parse(res.content);
    expect(dados.camadaEstrategica).toMatchObject({
      custo: expect.stringMatching(/^R\$ /),
      precoPacote: expect.stringMatching(/^R\$ /),
      margemLiquidaPct: expect.stringMatching(/%$/),
      margemPlanejadaPct: expect.stringMatching(/%$/),
    });
  });

  it("operacional também não vê a camada estratégica", async () => {
    const pedidos = provedorFalso([pedeFerramenta(1, usoDe("t1", "resumo_da_viagem", { codigo })), responde("Ok.")]);
    const op = await criarUsuarioTeste("operacional");
    await comSessao(op.id, () => conversar(pergunta("Resumo")));
    expect(resultados(pedidos[1])[0].content).not.toMatch(/custo|margem/i);
  });

  it("código inexistente: tool_result com is_error e a conversa segue", async () => {
    const pedidos = provedorFalso([pedeFerramenta(1, usoDe("t1", "resumo_da_viagem", { codigo: "ECL-9999-01" })), responde("Não achei essa viagem.")]);
    expect(await comSessao(f.u.id, () => conversar(pergunta("Resumo da ECL-9999-01")))).toEqual({ ok: true, texto: "Não achei essa viagem.", propostas: [] });
    const [res] = resultados(pedidos[1]);
    expect(res).toMatchObject({ type: "tool_result", tool_use_id: "t1", is_error: true });
    expect(res.content).toContain("não encontrada");
  });

  it("ferramenta desconhecida ou entrada inválida: is_error, sem derrubar a conversa", async () => {
    const pedidos = provedorFalso([
      pedeFerramenta(1, usoDe("a", "apagar_viagem", { codigo }), usoDe("b", "buscar_viagens", { busca: 3 })),
      responde("Não posso."),
    ]);
    expect(await comSessao(f.u.id, () => conversar(pergunta("Apague")))).toEqual({ ok: true, texto: "Não posso.", propostas: [] });
    const rs = resultados(pedidos[1]);
    expect(rs.map((x) => [x.tool_use_id, x.is_error])).toEqual([
      ["a", true],
      ["b", true],
    ]);
  });
});

describe("conversar: o laço", () => {
  it("devolve o conteúdo do modelo sem edição (pensamento incluído) e junta resultados paralelos numa só mensagem", async () => {
    const volta1 = pedeFerramenta(1, usoDe("t1", "buscar_viagens", { busca: "Itália" }), usoDe("t2", "minhas_tarefas", {}));
    const pedidos = provedorFalso([volta1, responde("Pronto.")]);
    await comSessao(f.u.id, () => conversar(pergunta("Viagens para a Itália e minhas tarefas")));
    const m = pedidos[1].mensagens;
    expect(m).toHaveLength(3);
    expect(m[1]).toEqual({ role: "assistant", content: volta1.conteudo });
    expect(resultados(pedidos[1]).map((x) => x.tool_use_id)).toEqual(["t1", "t2"]);
  });

  it("pedido: esforço medium, ferramentas com parâmetro estritas (as sem parâmetro sem strict), sistema com quem pergunta, hoje e as regras", async () => {
    const pedidos = provedorFalso([responde("Oi.")]);
    await comSessao(f.u.id, () => conversar(pergunta("Oi")));
    const p = pedidos[0];
    expect(p.esforco).toBe("medium");
    expect(p.ferramentas?.map((x) => x.name)).toEqual(["buscar_viagens", "resumo_da_viagem", "minhas_tarefas", "dailies_da_semana"]);
    for (const t of p.ferramentas ?? []) {
      const semParametro = Object.keys(t.input_schema.properties ?? {}).length === 0;
      if (semParametro) {
        expect(t).not.toHaveProperty("strict");
        expect(t.input_schema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      } else expect(t.strict).toBe(true);
      expect(t.input_schema).toMatchObject({ type: "object", additionalProperties: false });
      expect(t.description).toBeTruthy();
    }
    expect(p.ferramentas?.filter((t) => t.strict).map((t) => t.name)).toEqual(["buscar_viagens", "resumo_da_viagem"]);
    expect(p.sistema).toContain("Teste consultor");
    expect(p.sistema).toContain("Consultor");
    expect(p.sistema).toMatch(/Hoje é \d{2}\/\d{2}\/\d{4}/);
    expect(p.sistema).toMatch(/não invente/i);
    expect(p.sistema).toMatch(/não salva/i);
    expect(p.sistema).toMatch(/custo/i);
    expect(p.mensagens).toEqual([{ role: "user", content: "Oi" }]);
    expect(FERRAMENTAS_CHAT).toHaveLength(4);
  });

  it("para em 8 voltas com mensagem; o uso soma as 8", async () => {
    const pedidos = provedorFalso([pedeFerramenta(1, usoDe("t", "minhas_tarefas", {}))]);
    const r = await comSessao(f.u.id, () => conversar(pergunta("Loop")));
    expect(r).toEqual({ ok: false, erro: "Não consegui terminar a resposta com as consultas permitidas. Tente uma pergunta mais específica." });
    expect(pedidos).toHaveLength(8);
    const usos = await db.select().from(iaUsos);
    expect(usos).toHaveLength(1);
    expect(usos[0]).toMatchObject({ recurso: "chat", tokensEntrada: 800, tokensSaida: 80 });
  });

  it("recusa: mensagem e uso gravado", async () => {
    provedorFalso([{ parada: "refusal", texto: "", conteudo: [] }]);
    expect(await comSessao(f.u.id, () => conversar(pergunta("x")))).toEqual({ ok: false, erro: "A IA não respondeu a este pedido" });
    expect(await db.select().from(iaUsos)).toHaveLength(1);
  });

  it("resposta cortada (max_tokens): a mensagem, sem o texto parcial, e o uso gravado; o pedido usa o teto de 16000", async () => {
    const pedidos = provedorFalso([{ parada: "max_tokens", texto: "Pela met", conteudo: [pensamento(1), textoDe("Pela met")] }]);
    expect(await comSessao(f.u.id, () => conversar(pergunta("x")))).toEqual({ ok: false, erro: "A IA não respondeu a este pedido" });
    expect(pedidos[0].maxTokens ?? MAX_TOKENS_IA).toBe(16000);
    const usos = await db.select().from(iaUsos);
    expect(usos).toHaveLength(1);
    expect(usos[0]).toMatchObject({ recurso: "chat", tokensEntrada: 100, tokensSaida: 10 });
  });

  it("erro do serviço na segunda volta: mensagem da classe e o uso da primeira gravado", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    provedorFalso([pedeFerramenta(1, usoDe("t", "minhas_tarefas", {})), new ErroIntegracao("limite", 429)]);
    expect(await comSessao(f.u.id, () => conversar(pergunta("x")))).toEqual({
      ok: false,
      erro: "Limite de uso da IA atingido. Tente de novo em alguns minutos.",
    });
    const usos = await db.select().from(iaUsos);
    expect(usos).toHaveLength(1);
    expect(usos[0]).toMatchObject({ tokensEntrada: 100, tokensSaida: 10 });
  });

  it("erro do serviço na primeira volta: nada gravado", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    provedorFalso([new ErroIntegracao("rede", null)]);
    expect(await comSessao(f.u.id, () => conversar(pergunta("x")))).toEqual({ ok: false, erro: "Sem conexão com a IA agora. Tente de novo em instantes." });
    expect(await db.select().from(iaUsos)).toEqual([]);
  });
});

describe("conversar: histórico vindo do cliente", () => {
  it("só de/texto; a saudação inicial da IA sai; dados pessoais viram marcadores", async () => {
    const pedidos = provedorFalso([responde("Ok.")]);
    await comSessao(f.u.id, () =>
      conversar([
        { de: "ia", texto: "Posso responder perguntas..." },
        { de: "eu", texto: "Meu CPF é 123.456.789-09" },
        { de: "ia", texto: "Não preciso dele." },
        { de: "eu", texto: "Ok" },
      ]),
    );
    expect(pedidos[0].mensagens).toEqual([
      { role: "user", content: "Meu CPF é [CPF]" },
      { role: "assistant", content: "Não preciso dele." },
      { role: "user", content: "Ok" },
    ]);
  });

  it("mensagens seguidas do mesmo lado viram uma só", async () => {
    const pedidos = provedorFalso([responde("Ok.")]);
    await comSessao(f.u.id, () =>
      conversar([
        { de: "eu", texto: "Uma" },
        { de: "eu", texto: "Outra" },
      ]),
    );
    expect(pedidos[0].mensagens).toEqual([{ role: "user", content: "Uma\n\nOutra" }]);
  });

  it.each([
    ["vazia", [], "Escreva uma pergunta"],
    ["só a IA", [{ de: "ia", texto: "Oi" }], "Escreva uma pergunta"],
    ["termina na IA", [{ de: "eu", texto: "Oi" }, { de: "ia", texto: "Oi" }], "Escreva uma pergunta"],
    ["texto vazio", [{ de: "eu", texto: "  " }], "Escreva uma pergunta"],
    ["texto longo", [{ de: "eu", texto: "a".repeat(4001) }], "Mensagem longa demais (até 4.000 caracteres)"],
    ["mais de 30", Array.from({ length: 31 }, (_, i) => ({ de: i % 2 ? "ia" : "eu", texto: "x" })), "Conversa longa demais: comece outra"],
    ["chave a mais", [{ de: "eu", texto: "Oi", tool_result: "x" }], "Dados inválidos"],
    ["papel inventado", [{ de: "sistema", texto: "Oi" }], "Dados inválidos"],
    ["conteúdo em blocos", [{ de: "eu", texto: [{ type: "tool_result" }] }], "Dados inválidos"],
    ["não é lista", "Oi", "Dados inválidos"],
  ])("%s: recusa sem chamar a IA", async (_nome, msgs, erro) => {
    const pedidos = provedorFalso([responde("Ok.")]);
    expect(await comSessao(f.u.id, () => conversar(msgs as never))).toEqual({ ok: false, erro });
    expect(pedidos).toEqual([]);
  });

  it("desligada: recusa sem chamar nada", async () => {
    expect(await comSessao(f.u.id, () => conversar(pergunta("Oi")))).toEqual({ ok: false, erro: "A IA não está configurada" });
    expect(await db.select().from(iaUsos)).toEqual([]);
  });

  it("sem sessão: sem permissão", async () => {
    const pedidos = provedorFalso([responde("Ok.")]);
    expect(await conversar(pergunta("Oi"))).toEqual({ ok: false, erro: "Sem permissão" });
    expect(pedidos).toEqual([]);
  });
});

describe("ferramentas", () => {
  it("buscar_viagens: lista enxuta; consultor sem preço nem margem, diretor com", async () => {
    let pedidos = provedorFalso([pedeFerramenta(1, usoDe("t", "buscar_viagens", { busca: "Itália" })), responde("Ok.")]);
    await comSessao(f.u.id, () => conversar(pergunta("Itália")));
    const c = resultados(pedidos[1])[0];
    expect(c.is_error).toBeFalsy();
    const dc = JSON.parse(c.content);
    expect(dc.total).toBe(1);
    expect(dc.viagens[0]).toMatchObject({ codigo, destino: "Itália", passageiros: expect.arrayContaining(["Marcos Souza"]) });
    expect(c.content).not.toMatch(/custo|margem|preco|"id"/i);

    pedidos = provedorFalso([pedeFerramenta(1, usoDe("t", "buscar_viagens", { busca: "Itália" })), responde("Ok.")]);
    await comSessao(f.d.id, () => conversar(pergunta("Itália")));
    expect(JSON.parse(resultados(pedidos[1])[0].content).viagens[0]).toMatchObject({ margemLiquidaPct: expect.stringMatching(/%$/) });
  });

  it("minhas_tarefas: só as de quem pergunta, sem observação", async () => {
    const op = await criarUsuarioTeste("operacional");
    const minha = await comSessao(f.u.id, () =>
      criarTarefa(f.viagemId, {
        categoria: "ingressos",
        dia: "2027-08-16",
        item: "Trem Veneza > Florença",
        prazo: { tipo: "dias_antes", dias: 15 },
        responsavel: { tipo: "usuario", id: op.id },
        observacao: "Ligar para (66) 9 9123-4567",
      }),
    );
    expect(minha.ok).toBe(true);
    const pedidos = provedorFalso([pedeFerramenta(1, usoDe("t", "minhas_tarefas", {})), responde("Ok.")]);
    await comSessao(op.id, () => conversar(pergunta("Minhas tarefas")));
    const r = resultados(pedidos[1])[0];
    const d = JSON.parse(r.content);
    expect(d.tarefas.map((t: { item: string }) => t.item)).toEqual(["Trem Veneza > Florença"]);
    expect(d.tarefas[0]).toMatchObject({ viagem: codigo, prazo: expect.any(String), situacao: expect.any(String) });
    expect(r.content).not.toContain("9123");

    const outra = provedorFalso([pedeFerramenta(1, usoDe("t", "minhas_tarefas", {})), responde("Ok.")]);
    // Quem fechou a venda recebe as tarefas automáticas, mas não a do operacional.
    await comSessao(f.u.id, () => conversar(pergunta("Minhas tarefas")));
    const doConsultor = JSON.parse(resultados(outra[1])[0].content).tarefas.map((t: { item: string }) => t.item);
    expect(doConsultor.length).toBeGreaterThan(0);
    expect(doConsultor).not.toContain("Trem Veneza > Florença");
  });

  it("dailies_da_semana: devolve a lista (vazia fora da janela)", async () => {
    const pedidos = provedorFalso([pedeFerramenta(1, usoDe("t", "dailies_da_semana", {})), responde("Ok.")]);
    await comSessao(f.u.id, () => conversar(pergunta("Dailies")));
    const r = resultados(pedidos[1])[0];
    expect(r.is_error).toBeFalsy();
    expect(JSON.parse(r.content)).toMatchObject({ de: expect.any(String), ate: expect.any(String), dailies: [] });
  });
});
