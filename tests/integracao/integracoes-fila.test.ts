import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { auditoria, integracaoEnvios } from "@/server/db/schema";
import { ErroIntegracao } from "@/server/integracoes/http";
import {
  definirProcessadorParaTestes,
  enfileirar,
  processarDepois,
  processarFila,
  reenviar,
  type Processador,
} from "@/server/integracoes/fila";
import { GET, POST } from "@/app/api/cron/integracoes/route";
import { criarUsuarioTeste, limparBanco } from "../helpers/db";

const MIN = 60_000;
const agora = new Date("2027-01-10T12:00:00.000Z");
const antes = (min: number) => new Date(agora.getTime() - min * MIN);
const depois = (min: number) => new Date(agora.getTime() + min * MIN);

function ligarTrello() {
  vi.stubEnv("TRELLO_API_KEY", "chave-falsa");
  vi.stubEnv("TRELLO_TOKEN", "token-falso");
  vi.stubEnv("TRELLO_LISTA_ID", "lista-falsa");
}
function desligarTrello() {
  vi.stubEnv("TRELLO_API_KEY", "");
  vi.stubEnv("TRELLO_TOKEN", "");
  vi.stubEnv("TRELLO_LISTA_ID", "");
}

let chamadas: { chave: string; resultado: unknown; payload: unknown }[];
const sucesso: Processador = async (envio) => {
  chamadas.push({ chave: envio.chave, resultado: envio.resultado, payload: envio.payload });
  return { cartaoId: `c-${envio.chave}`, url: "https://trello.test/c" };
};
const falhaCom = (classe: ErroIntegracao["classe"], status: number | null): Processador => async (envio) => {
  chamadas.push({ chave: envio.chave, resultado: envio.resultado, payload: envio.payload });
  throw new ErroIntegracao(classe, status);
};

type Linha = Partial<typeof integracaoEnvios.$inferInsert>;
async function inserir(l: Linha = {}) {
  const [r] = await db
    .insert(integracaoEnvios)
    .values({
      integracao: "trello",
      tipo: "cartao_viagem",
      chave: `venda:${Math.random()}`,
      payload: { nome: "ECL-0001-01" },
      proximaEm: antes(1),
      ...l,
    })
    .returning();
  return r;
}
const ler = async (id: string) => (await db.select().from(integracaoEnvios).where(eq(integracaoEnvios.id, id)))[0];

beforeEach(async () => {
  await limparBanco();
  chamadas = [];
  ligarTrello();
  definirProcessadorParaTestes("trello", sucesso);
  definirProcessadorParaTestes("drive", null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  definirProcessadorParaTestes("trello", undefined);
  definirProcessadorParaTestes("drive", undefined);
});

describe("enfileirar", () => {
  const evento = { integracao: "trello" as const, tipo: "cartao_viagem", viagemId: null, chave: "venda:v1", payload: { a: 1 } };

  it("desligada: não grava nada", async () => {
    desligarTrello();
    await db.transaction((tx) => enfileirar(tx, evento));
    expect(await db.select().from(integracaoEnvios)).toEqual([]);
  });

  it("ligada: grava uma vez só com a mesma chave", async () => {
    await db.transaction((tx) => enfileirar(tx, evento));
    await db.transaction((tx) => enfileirar(tx, { ...evento, payload: { a: 2 } }));
    const linhas = await db.select().from(integracaoEnvios);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      integracao: "trello",
      tipo: "cartao_viagem",
      chave: "venda:v1",
      payload: { a: 1 },
      situacao: "pendente",
      tentativas: 0,
      resultado: null,
      ultimoErro: null,
    });
  });

  it("mesma chave em outra integração é outro envio", async () => {
    vi.stubEnv("GOOGLE_SA_EMAIL", "sa@x.test");
    vi.stubEnv("GOOGLE_SA_CHAVE", "chave");
    vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "raiz");
    await db.transaction(async (tx) => {
      await enfileirar(tx, evento);
      await enfileirar(tx, { ...evento, integracao: "drive" });
    });
    expect(await db.select().from(integracaoEnvios)).toHaveLength(2);
  });

  it("roda na transação de quem chama: desfeita junto", async () => {
    await expect(
      db.transaction(async (tx) => {
        await enfileirar(tx, evento);
        throw new Error("evento falhou");
      }),
    ).rejects.toThrow("evento falhou");
    expect(await db.select().from(integracaoEnvios)).toEqual([]);
  });
});

describe("processarFila", () => {
  it("sucesso: enviado com resultado, auditado pelo sistema", async () => {
    const e = await inserir({ chave: "venda:v1" });
    expect(await processarFila({ agora })).toEqual({ enviados: 1, falhas: 0 });
    const r = await ler(e.id);
    expect(r).toMatchObject({
      situacao: "enviado",
      tentativas: 1,
      resultado: { cartaoId: "c-venda:v1", url: "https://trello.test/c" },
      ultimoErro: null,
    });
    expect(r.enviadoEm).toEqual(agora);
    expect(chamadas).toEqual([{ chave: "venda:v1", resultado: null, payload: { nome: "ECL-0001-01" } }]);
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, e.id));
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuarioId: null, tabela: "integracao_envios", acao: "alterar" });
    expect(aud[0].depois).toMatchObject({ situacao: "enviado", tentativas: 1 });
  });

  it("erro servidor: volta a pendente, tentativas 1, próxima em +1 min, resultado mantido", async () => {
    definirProcessadorParaTestes("trello", falhaCom("servidor", 503));
    const e = await inserir({ resultado: { cartaoId: "c1" } });
    expect(await processarFila({ agora })).toEqual({ enviados: 0, falhas: 1 });
    const r = await ler(e.id);
    expect(r).toMatchObject({
      situacao: "pendente",
      tentativas: 1,
      ultimoErro: { classe: "servidor", status: 503 },
      resultado: { cartaoId: "c1" },
      enviadoEm: null,
    });
    expect(r.proximaEm).toEqual(depois(1));
  });

  it("espera cresce: a terceira falha espera 15 min", async () => {
    definirProcessadorParaTestes("trello", falhaCom("limite", 429));
    const e = await inserir({ tentativas: 2 });
    await processarFila({ agora });
    const r = await ler(e.id);
    expect(r).toMatchObject({ situacao: "pendente", tentativas: 3, ultimoErro: { classe: "limite", status: 429 } });
    expect(r.proximaEm).toEqual(depois(15));
  });

  it("erro autenticação: falhou direto (repetir não resolve)", async () => {
    definirProcessadorParaTestes("trello", falhaCom("autenticacao", 401));
    const e = await inserir();
    await processarFila({ agora });
    expect(await ler(e.id)).toMatchObject({ situacao: "falhou", tentativas: 1, ultimoErro: { classe: "autenticacao", status: 401 } });
  });

  it("erro recusado: falhou direto", async () => {
    definirProcessadorParaTestes("trello", falhaCom("recusado", 404));
    const e = await inserir();
    await processarFila({ agora });
    expect((await ler(e.id)).situacao).toBe("falhou");
  });

  it("sexta falha: falhou", async () => {
    definirProcessadorParaTestes("trello", falhaCom("rede", null));
    const e = await inserir({ tentativas: 5 });
    expect(await processarFila({ agora })).toEqual({ enviados: 0, falhas: 1 });
    expect(await ler(e.id)).toMatchObject({ situacao: "falhou", tentativas: 6, ultimoErro: { classe: "rede", status: null } });
  });

  it("erro desconhecido do processador: repete como servidor, sem a mensagem", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    definirProcessadorParaTestes("trello", async () => {
      throw new Error("token segredo-xyz recusado");
    });
    const e = await inserir();
    await processarFila({ agora });
    const r = await ler(e.id);
    expect(r).toMatchObject({ situacao: "pendente", ultimoErro: { classe: "servidor", status: null } });
    expect(JSON.stringify(r)).not.toContain("segredo-xyz");
    expect(JSON.stringify(log.mock.calls)).not.toContain("segredo-xyz");
    log.mockRestore();
  });

  it("resultado parcial gravado no meio é mantido na falha e chega na próxima tentativa", async () => {
    let vez = 0;
    definirProcessadorParaTestes("trello", async (envio, deps) => {
      chamadas.push({ chave: envio.chave, resultado: envio.resultado, payload: envio.payload });
      vez++;
      if (vez === 1) {
        await deps.gravarResultado({ cartaoId: "c1" });
        throw new ErroIntegracao("servidor", 500);
      }
      return { ...(envio.resultado as object), checklistId: "k1" };
    });
    const e = await inserir();
    await processarFila({ agora });
    expect(await ler(e.id)).toMatchObject({ situacao: "pendente", resultado: { cartaoId: "c1" } });
    await processarFila({ agora: depois(2) });
    expect(chamadas.map((c) => c.resultado)).toEqual([null, { cartaoId: "c1" }]);
    expect(await ler(e.id)).toMatchObject({ situacao: "enviado", tentativas: 2, resultado: { cartaoId: "c1", checklistId: "k1" } });
  });

  it("processador que não devolve nada mantém o resultado", async () => {
    definirProcessadorParaTestes("trello", async () => undefined);
    const e = await inserir({ resultado: { cartaoId: "c1" } });
    await processarFila({ agora });
    expect(await ler(e.id)).toMatchObject({ situacao: "enviado", resultado: { cartaoId: "c1" } });
  });

  it("enviando há mais de 10 min volta e é enviado; recente fica; preso na sexta vira falhou", async () => {
    const velho = await inserir({ situacao: "enviando", tentativas: 1, tomadoEm: antes(11) });
    const recente = await inserir({ situacao: "enviando", tentativas: 1, tomadoEm: antes(5) });
    const esgotado = await inserir({ situacao: "enviando", tentativas: 6, tomadoEm: antes(30) });
    expect(await processarFila({ agora })).toEqual({ enviados: 1, falhas: 0 });
    expect(await ler(velho.id)).toMatchObject({ situacao: "enviado", tentativas: 2 });
    expect(await ler(recente.id)).toMatchObject({ situacao: "enviando", tentativas: 1 });
    expect(await ler(esgotado.id)).toMatchObject({ situacao: "falhou", tentativas: 6 });
  });

  it("não toma: próxima no futuro, enviado, falhou, integração sem processador ou desligada", async () => {
    const futuro = await inserir({ proximaEm: depois(1) });
    await inserir({ situacao: "enviado", enviadoEm: antes(1) });
    await inserir({ situacao: "falhou", tentativas: 6 });
    const drive = await inserir({ integracao: "drive", tipo: "pasta_viagem" });
    expect(await processarFila({ agora })).toEqual({ enviados: 0, falhas: 0 });
    expect(chamadas).toEqual([]);
    expect(await ler(futuro.id)).toMatchObject({ situacao: "pendente", tentativas: 0 });
    expect(await ler(drive.id)).toMatchObject({ situacao: "pendente", tentativas: 0 });

    desligarTrello();
    const desligada = await inserir();
    expect(await processarFila({ agora })).toEqual({ enviados: 0, falhas: 0 });
    expect(await ler(desligada.id)).toMatchObject({ situacao: "pendente", tentativas: 0 });
  });

  it("lote: no máximo 20 por vez (ou o limite pedido), mais antigos primeiro", async () => {
    for (let i = 0; i < 25; i++) await inserir({ chave: `k${String(i).padStart(2, "0")}`, proximaEm: antes(30 - i) });
    expect(await processarFila({ agora })).toEqual({ enviados: 20, falhas: 0 });
    expect(chamadas.map((c) => c.chave)).toEqual(Array.from({ length: 20 }, (_, i) => `k${String(i).padStart(2, "0")}`));
    expect(await processarFila({ agora, limite: 2 })).toEqual({ enviados: 2, falhas: 0 });
  });

  it("duas execuções ao mesmo tempo não mandam o mesmo envio duas vezes", async () => {
    definirProcessadorParaTestes("trello", async (envio) => {
      chamadas.push({ chave: envio.chave, resultado: null, payload: null });
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true };
    });
    for (let i = 0; i < 6; i++) await inserir({ chave: `k${i}` });
    const [a, b] = await Promise.all([processarFila({ agora }), processarFila({ agora })]);
    expect(a.enviados + b.enviados).toBe(6);
    expect(chamadas.map((c) => c.chave).sort()).toEqual(["k0", "k1", "k2", "k3", "k4", "k5"]);
  });

  it("passa o fetch injetado ao processador", async () => {
    const buscar = (async () => new Response("{}")) as typeof fetch;
    let recebido: unknown;
    definirProcessadorParaTestes("trello", async (_e, deps) => {
      recebido = deps.buscar;
      return {};
    });
    await inserir();
    await processarFila({ agora, buscar });
    expect(recebido).toBe(buscar);
  });
});

describe("reenviar", () => {
  it("falhou volta a pendente, zera tentativas, próxima agora, resultado mantido, auditado", async () => {
    const u = await criarUsuarioTeste("diretor");
    const e = await inserir({
      situacao: "falhou",
      tentativas: 6,
      proximaEm: antes(500),
      resultado: { cartaoId: "c1" },
      ultimoErro: { classe: "servidor", status: 500 },
    });
    const t0 = Date.now();
    expect(await reenviar(e.id, u.id)).toBe(true);
    const r = await ler(e.id);
    expect(r).toMatchObject({ situacao: "pendente", tentativas: 0, resultado: { cartaoId: "c1" } });
    expect(Math.abs(r.proximaEm.getTime() - t0)).toBeLessThan(10_000);
    const aud = await db
      .select()
      .from(auditoria)
      .where(and(eq(auditoria.registroId, e.id), eq(auditoria.tabela, "integracao_envios")));
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ usuarioId: u.id, acao: "alterar" });
    expect(aud[0].antes).toMatchObject({ situacao: "falhou", tentativas: 6 });
    expect(aud[0].depois).toMatchObject({ situacao: "pendente", tentativas: 0 });
  });

  it("pendente com espera longa também volta para agora", async () => {
    const e = await inserir({ tentativas: 4, proximaEm: depois(60) });
    expect(await reenviar(e.id)).toBe(true);
    expect(await ler(e.id)).toMatchObject({ situacao: "pendente", tentativas: 0 });
  });

  it("enviado e enviando não são reenviados; id inexistente também não", async () => {
    const enviado = await inserir({ situacao: "enviado", enviadoEm: antes(1), tentativas: 1 });
    const enviando = await inserir({ situacao: "enviando", tomadoEm: antes(1), tentativas: 1 });
    expect(await reenviar(enviado.id)).toBe(false);
    expect(await reenviar(enviando.id)).toBe(false);
    expect(await reenviar("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(await ler(enviado.id)).toMatchObject({ situacao: "enviado", tentativas: 1 });
    expect(await ler(enviando.id)).toMatchObject({ situacao: "enviando", tentativas: 1 });
  });
});

describe("processarDepois", () => {
  it("fora de uma requisição não lança", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => processarDepois()).not.toThrow();
    log.mockRestore();
  });
});

describe("rota POST /api/cron/integracoes", () => {
  const pedir = (auth?: string) =>
    new Request("http://localhost/api/cron/integracoes", {
      method: "POST",
      headers: auth === undefined ? {} : { authorization: auth },
    });

  it.each([
    ["vazio", ""],
    ["só espaços", "   "],
  ])("CRON_SECRET %s: 503 e nada roda", async (_n, valor) => {
    vi.stubEnv("CRON_SECRET", valor);
    const e = await inserir();
    for (const auth of [undefined, "Bearer ", `Bearer ${valor}`]) {
      const r = await POST(pedir(auth));
      expect(r.status).toBe(503);
    }
    expect(chamadas).toEqual([]);
    expect((await ler(e.id)).situacao).toBe("pendente");
  });

  it.each([
    ["sem cabeçalho", undefined],
    ["errado", "Bearer outro-segredo"],
    ["sem Bearer", "segredo-do-cron"],
    ["prefixo", "Bearer segredo-do-cro"],
    ["outro esquema", "Basic segredo-do-cron"],
  ])("segredo %s: 401 e nada roda", async (_n, auth) => {
    vi.stubEnv("CRON_SECRET", "segredo-do-cron");
    const e = await inserir({ proximaEm: new Date(Date.now() - MIN) });
    const r = await POST(pedir(auth));
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("segredo-do-cron");
    expect(chamadas).toEqual([]);
    expect((await ler(e.id)).situacao).toBe("pendente");
  });

  it("segredo certo: 200 com enviados e falhas", async () => {
    vi.stubEnv("CRON_SECRET", "segredo-do-cron");
    const e = await inserir({ proximaEm: new Date(Date.now() - MIN) });
    const r = await POST(pedir("Bearer segredo-do-cron"));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ enviados: 1, falhas: 0 });
    expect((await ler(e.id)).situacao).toBe("enviado");
  });

  it("GET: 405", async () => {
    const r = GET();
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("POST");
  });
});
