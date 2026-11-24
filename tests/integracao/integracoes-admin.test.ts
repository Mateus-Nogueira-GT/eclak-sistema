import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
// `after()` só existe numa requisição: aqui só se observa que o reenvio agenda a fila.
vi.mock("@/server/integracoes/fila", async (original) => ({
  ...(await original<typeof import("@/server/integracoes/fila")>()),
  processarDepois: vi.fn(),
}));
import { INTEGRACOES } from "@/domain/integracoes";
import type { Perfil } from "@/domain/perfis";
import { chaveRoteiro, chaveVenda } from "@/domain/trello";
import { chavePasta } from "@/domain/drive";
import { db } from "@/server/db/client";
import { auditoria, integracaoEnvios, viagens } from "@/server/db/schema";
import { processarDepois } from "@/server/integracoes/fila";
import { esquecerTokensGoogle } from "@/server/integracoes/google";
import { criarPastasNoDrive, enviarViagemAoTrello, reenviarEnvio, testarConexao } from "@/server/actions/integracoes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterIntegracoes } from "@/server/queries/integracoes";
import { cabecalhoDaViagem } from "@/server/queries/operacao";
import { obterCliente } from "@/server/queries/clientes";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida } from "../helpers/venda";

const TOKEN = "token-falso-secreto";
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const TODAS = [
  "TRELLO_API_KEY",
  "TRELLO_TOKEN",
  "TRELLO_LISTA_ID",
  "GOOGLE_SA_EMAIL",
  "GOOGLE_SA_CHAVE",
  "GOOGLE_DRIVE_PASTA_RAIZ_ID",
  "ANTHROPIC_API_KEY",
  "IA_MODELO",
  "CRON_SECRET",
];

function ligarTrello() {
  vi.stubEnv("TRELLO_API_KEY", "chave-falsa");
  vi.stubEnv("TRELLO_TOKEN", TOKEN);
  vi.stubEnv("TRELLO_LISTA_ID", "lista-falsa");
}
function ligarDrive() {
  vi.stubEnv("GOOGLE_SA_EMAIL", "eclak@projeto.iam.gserviceaccount.com");
  vi.stubEnv("GOOGLE_SA_CHAVE", privateKey.replace(/\n/g, "\\n"));
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "raiz");
}

/** `fetch` falso: responde por caminho; `status` força um erro (o corpo ecoa o token, para provar que não é lido). */
function fetchFalso(status: number | "rede" | null = null) {
  const chamadas: string[] = [];
  const f = (async (url: string | URL | Request) => {
    const u = new URL(String(url));
    chamadas.push(u.origin + u.pathname);
    if (status === "rede") throw new TypeError("fetch failed");
    if (status) return new Response(JSON.stringify({ message: `invalid ${TOKEN}` }), { status });
    if (u.pathname.startsWith("/1/lists/")) return Response.json({ id: "lista-falsa", name: "Operações" });
    if (u.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "ya29.falso", expires_in: 3600 });
    if (u.pathname.startsWith("/drive/v3/files/")) return Response.json({ id: "raiz", name: "Viagens ECLAK" });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  vi.stubGlobal("fetch", f);
  return chamadas;
}

const ler = async (id: string) => (await db.select().from(integracaoEnvios).where(eq(integracaoEnvios.id, id)))[0];
type Linha = Partial<typeof integracaoEnvios.$inferInsert>;
async function inserir(l: Linha = {}) {
  const [r] = await db
    .insert(integracaoEnvios)
    .values({ integracao: "trello", tipo: "cartao_viagem", chave: `venda:${Math.random()}`, payload: { nome: "x" }, ...l })
    .returning();
  return r;
}

let diretor: { id: string };

beforeEach(async () => {
  await limparBanco();
  vi.mocked(processarDepois).mockReset();
  for (const v of TODAS) vi.stubEnv(v, "");
  esquecerTokensGoogle();
  diretor = await criarUsuarioTeste("diretor");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("perfil", () => {
  const outros: Perfil[] = ["consultor", "operacional", "fin_operacional", "fin_estrategico"];
  it.each(outros)("%s não abre, não testa e não reenvia", async (perfil) => {
    const u = await criarUsuarioTeste(perfil);
    ligarTrello();
    const chamadas = fetchFalso();
    const e = await inserir({ situacao: "falhou", tentativas: 6 });
    await expect(comSessao(u.id, () => obterIntegracoes())).rejects.toThrow("Sem permissão");
    expect(await comSessao(u.id, () => testarConexao("trello"))).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await comSessao(u.id, () => reenviarEnvio(e.id))).toEqual({ ok: false, erro: "Sem permissão" });
    expect(chamadas).toEqual([]);
    expect(await ler(e.id)).toMatchObject({ situacao: "falhou", tentativas: 6 });
    expect(await db.select().from(auditoria).where(eq(auditoria.tabela, "integracoes"))).toEqual([]);
  });
});

describe("obterIntegracoes", () => {
  it("tudo desligado: os cinco cartões, com os nomes das variáveis que faltam e sem teste; fila vazia", async () => {
    const r = await comSessao(diretor.id, () => obterIntegracoes());
    expect(r.cartoes.map((c) => c.integracao)).toEqual([...INTEGRACOES]);
    const por = Object.fromEntries(r.cartoes.map((c) => [c.integracao, c]));
    expect(por.trello.estado).toEqual({ configurada: false, faltam: ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_LISTA_ID"] });
    expect(por.drive.estado.faltam).toEqual(["GOOGLE_SA_EMAIL", "GOOGLE_SA_CHAVE", "GOOGLE_DRIVE_PASTA_RAIZ_ID"]);
    expect(por.ia.estado.faltam).toEqual(["ANTHROPIC_API_KEY"]);
    expect(por.hotelaria.estado).toEqual({ configurada: false, faltam: [] });
    expect(por.agendador.estado.faltam).toEqual(["CRON_SECRET"]);
    for (const c of r.cartoes) {
      expect(c.ultimoTeste).toBeNull();
      expect(c.nome).not.toBe("");
      expect(c.descricao).not.toBe("");
    }
    expect(por.trello.testavel).toBe(true);
    expect(por.drive.testavel).toBe(true);
    expect(por.ia.testavel).toBe(true);
    expect(por.hotelaria.testavel).toBe(false);
    expect(por.agendador.testavel).toBe(false);
    expect(r.fila).toEqual({ pendentes: [], falhas: [], enviadosRecentes: [] });
  });

  it("ligada não mostra valores, só o estado", async () => {
    ligarTrello();
    const r = await comSessao(diretor.id, () => obterIntegracoes());
    expect(r.cartoes.find((c) => c.integracao === "trello")!.estado).toEqual({ configurada: true, faltam: [] });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("chave-falsa");
  });

  it("fila: pendentes (com enviando), falhas e enviados recentes; rótulo do erro; link só https; sem payload", async () => {
    const f = await vendida();
    const espera = await inserir({
      chave: chaveRoteiro(f.viagemId),
      tipo: "checklist_roteiro",
      viagemId: f.viagemId,
      payload: { itens: ["Reserva de passeios"] },
      ultimoErro: { classe: "aguardando", status: null, motivo: "aguardando_cartao" },
    });
    const enviando = await inserir({ situacao: "enviando", tomadoEm: new Date(), tentativas: 1 });
    const falhou = await inserir({ situacao: "falhou", tentativas: 1, ultimoErro: { classe: "autenticacao", status: 401 } });
    const cartao = await inserir({
      chave: chaveVenda(f.viagemId),
      viagemId: f.viagemId,
      situacao: "enviado",
      enviadoEm: new Date(),
      resultado: { cartaoId: "c1", url: "https://trello.com/c/c1" },
    });
    const pasta = await inserir({
      integracao: "drive",
      tipo: "pasta_viagem",
      chave: chavePasta(f.viagemId),
      viagemId: f.viagemId,
      situacao: "enviado",
      enviadoEm: new Date(),
      resultado: { pastaId: "p1", link: "javascript:alert(1)" },
    });
    const { fila } = await comSessao(diretor.id, () => obterIntegracoes());
    expect(fila.pendentes.map((e) => e.id).sort()).toEqual([espera.id, enviando.id].sort());
    const e1 = fila.pendentes.find((e) => e.id === espera.id)!;
    expect(e1).toMatchObject({ integracao: "trello", situacao: "pendente", erro: "Aguardando o cartão da venda" });
    expect(e1.viagem).toMatchObject({ id: f.viagemId });
    expect(e1.viagem!.codigo).toMatch(/^ECL-\d{4}-\d{2}$/);
    expect(fila.falhas).toEqual([expect.objectContaining({ id: falhou.id, erro: "Credencial recusada", status: 401, viagem: null })]);
    const enviados = Object.fromEntries(fila.enviadosRecentes.map((e) => [e.id, e]));
    expect(enviados[cartao.id].link).toBe("https://trello.com/c/c1");
    expect(enviados[pasta.id].link).toBeNull();
    expect(JSON.stringify(fila)).not.toContain("Reserva de passeios");
  });
});

describe("testarConexao", () => {
  it("desligada: 'Integração desligada', sem chamada nem auditoria; nome desconhecido recusado", async () => {
    const chamadas = fetchFalso();
    for (const i of ["trello", "drive", "ia", "hotelaria", "agendador"]) {
      expect(await comSessao(diretor.id, () => testarConexao(i))).toEqual({ ok: false, erro: "Integração desligada" });
    }
    expect(await comSessao(diretor.id, () => testarConexao("xpto"))).toEqual({ ok: false, erro: "Integração desconhecida" });
    expect(chamadas).toEqual([]);
    expect(await db.select().from(auditoria).where(eq(auditoria.tabela, "integracoes"))).toEqual([]);
  });

  it("agendador ligado não tem teste de conexão", async () => {
    vi.stubEnv("CRON_SECRET", "segredo");
    expect(await comSessao(diretor.id, () => testarConexao("agendador"))).toEqual({
      ok: false,
      erro: "Esta integração não tem teste de conexão",
    });
  });

  it("Trello ok: chama a lista, audita { ok, classe } com o Diretor e aparece em ultimoTeste", async () => {
    ligarTrello();
    const chamadas = fetchFalso();
    expect(await comSessao(diretor.id, () => testarConexao("trello"))).toEqual({ ok: true, conexao: { ok: true, classe: null } });
    expect(chamadas).toEqual(["https://api.trello.com/1/lists/lista-falsa"]);
    const aud = await db.select().from(auditoria).where(eq(auditoria.tabela, "integracoes"));
    expect(aud).toEqual([
      expect.objectContaining({ usuarioId: diretor.id, registroId: "trello", acao: "criar", antes: null, depois: { ok: true, classe: null } }),
    ]);
    const r = await comSessao(diretor.id, () => obterIntegracoes());
    const t = r.cartoes.find((c) => c.integracao === "trello")!.ultimoTeste;
    expect(t).toEqual({ ok: true, classe: null, em: aud[0].em });
    expect(r.cartoes.find((c) => c.integracao === "drive")!.ultimoTeste).toBeNull();
  });

  it("Trello recusa a credencial: o último teste é a falha, com a classe e sem segredo na auditoria", async () => {
    ligarTrello();
    fetchFalso();
    await comSessao(diretor.id, () => testarConexao("trello"));
    fetchFalso(401);
    expect(await comSessao(diretor.id, () => testarConexao("trello"))).toEqual({
      ok: true,
      conexao: { ok: false, classe: "autenticacao" },
    });
    const aud = await db.select().from(auditoria).where(eq(auditoria.tabela, "integracoes"));
    expect(aud).toHaveLength(2);
    expect(JSON.stringify(aud)).not.toContain(TOKEN);
    expect(JSON.stringify(aud)).not.toContain("chave-falsa");
    const r = await comSessao(diretor.id, () => obterIntegracoes());
    expect(r.cartoes.find((c) => c.integracao === "trello")!.ultimoTeste).toMatchObject({ ok: false, classe: "autenticacao" });
  });

  it("Drive: pede o token e lê a raiz; rede vira classe rede", async () => {
    ligarDrive();
    const chamadas = fetchFalso();
    expect(await comSessao(diretor.id, () => testarConexao("drive"))).toEqual({ ok: true, conexao: { ok: true, classe: null } });
    expect(chamadas).toEqual(["https://oauth2.googleapis.com/token", "https://www.googleapis.com/drive/v3/files/raiz"]);
    esquecerTokensGoogle();
    fetchFalso("rede");
    expect(await comSessao(diretor.id, () => testarConexao("drive"))).toEqual({ ok: true, conexao: { ok: false, classe: "rede" } });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "integracoes"), eq(auditoria.registroId, "drive")));
    expect(aud).toHaveLength(2);
    expect(JSON.stringify(aud)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(aud)).not.toContain("ya29");
  });
});

describe("reenviarEnvio", () => {
  it("falhou volta a pendente para agora com o Diretor na auditoria e agenda a fila", async () => {
    const e = await inserir({ situacao: "falhou", tentativas: 6, ultimoErro: { classe: "servidor", status: 500 }, resultado: { cartaoId: "c1" } });
    expect(await comSessao(diretor.id, () => reenviarEnvio(e.id))).toEqual({ ok: true });
    expect(await ler(e.id)).toMatchObject({ situacao: "pendente", tentativas: 0, resultado: { cartaoId: "c1" } });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, e.id));
    expect(aud).toEqual([expect.objectContaining({ usuarioId: diretor.id, acao: "alterar" })]);
    expect(processarDepois).toHaveBeenCalledTimes(1);
  });

  it("enviado, enviando, inexistente e id inválido são recusados sem mudar nada", async () => {
    const enviado = await inserir({ situacao: "enviado", enviadoEm: new Date() });
    const enviando = await inserir({ situacao: "enviando", tomadoEm: new Date(), tentativas: 1 });
    const NAO = { ok: false, erro: "Este envio não pode ser reenviado agora" };
    expect(await comSessao(diretor.id, () => reenviarEnvio(enviado.id))).toEqual(NAO);
    expect(await comSessao(diretor.id, () => reenviarEnvio(enviando.id))).toEqual(NAO);
    const NAO_ACHOU = { ok: false, erro: "Envio não encontrado" };
    expect(await comSessao(diretor.id, () => reenviarEnvio("00000000-0000-4000-8000-000000000000"))).toEqual(NAO_ACHOU);
    expect(await comSessao(diretor.id, () => reenviarEnvio("x"))).toEqual(NAO_ACHOU);
    expect(await ler(enviado.id)).toMatchObject({ situacao: "enviado" });
    expect(await ler(enviando.id)).toMatchObject({ situacao: "enviando", tentativas: 1 });
    expect(processarDepois).not.toHaveBeenCalled();
  });

  it("reenviar o cartão reabre o checklist do roteiro que falhou na mesma viagem (mesma transação, auditado); os outros ficam", async () => {
    const f = await vendida();
    const [v] = await db.select({ clienteId: viagens.clienteId }).from(viagens).where(eq(viagens.id, f.viagemId));
    const pessoas = (await comSessao(f.u.id, () => obterCliente(v.clienteId)))!.pessoas.map((p) => p.id);
    const outra = await comSessao(f.u.id, () =>
      criarOrcamento({ clienteId: v.clienteId, destino: "Lisboa", inicio: "2027-10-01", fim: "2027-10-08", passageiros: pessoas }),
    );
    if (!outra.ok) throw new Error(outra.erro);
    const venda = await inserir({ chave: chaveVenda(f.viagemId), viagemId: f.viagemId, situacao: "falhou", tentativas: 6 });
    const roteiro = await inserir({
      chave: chaveRoteiro(f.viagemId),
      tipo: "checklist_roteiro",
      viagemId: f.viagemId,
      situacao: "falhou",
      tentativas: 6,
      ultimoErro: { classe: "servidor", status: null },
    });
    const roteiroOutra = await inserir({ chave: chaveRoteiro(outra.id), tipo: "checklist_roteiro", viagemId: outra.id, situacao: "falhou", tentativas: 6 });
    expect(await comSessao(diretor.id, () => reenviarEnvio(venda.id))).toEqual({ ok: true });
    expect(await ler(venda.id)).toMatchObject({ situacao: "pendente", tentativas: 0 });
    expect(await ler(roteiro.id)).toMatchObject({ situacao: "pendente", tentativas: 0 });
    expect(await ler(roteiroOutra.id)).toMatchObject({ situacao: "falhou", tentativas: 6 });
    const audRoteiro = await db.select().from(auditoria).where(eq(auditoria.registroId, roteiro.id));
    expect(audRoteiro).toEqual([expect.objectContaining({ usuarioId: diretor.id, acao: "alterar" })]);
    expect(processarDepois).toHaveBeenCalledTimes(1);
  });

  it("o checklist do roteiro já enviado ou ainda pendente não é mexido; reenviar o roteiro não mexe no cartão", async () => {
    const f = await vendida();
    const venda = await inserir({ chave: chaveVenda(f.viagemId), viagemId: f.viagemId, situacao: "falhou", tentativas: 6 });
    const roteiro = await inserir({
      chave: chaveRoteiro(f.viagemId),
      tipo: "checklist_roteiro",
      viagemId: f.viagemId,
      situacao: "enviado",
      enviadoEm: new Date(),
    });
    expect(await comSessao(diretor.id, () => reenviarEnvio(venda.id))).toEqual({ ok: true });
    expect(await ler(roteiro.id)).toMatchObject({ situacao: "enviado" });
    expect(await db.select().from(auditoria).where(eq(auditoria.registroId, roteiro.id))).toEqual([]);

    // Pendente (ex.: esperando a próxima tentativa) também não é mexido: segue a própria espera.
    await db.update(integracaoEnvios).set({ situacao: "falhou", tentativas: 6 }).where(eq(integracaoEnvios.id, venda.id));
    await db.update(integracaoEnvios).set({ situacao: "pendente", tentativas: 3, enviadoEm: null }).where(eq(integracaoEnvios.id, roteiro.id));
    expect(await comSessao(diretor.id, () => reenviarEnvio(venda.id))).toEqual({ ok: true });
    expect(await ler(roteiro.id)).toMatchObject({ situacao: "pendente", tentativas: 3 });
    expect(await db.select().from(auditoria).where(eq(auditoria.registroId, roteiro.id))).toEqual([]);

    await db.update(integracaoEnvios).set({ situacao: "falhou", tentativas: 6, enviadoEm: null }).where(eq(integracaoEnvios.id, roteiro.id));
    await db.update(integracaoEnvios).set({ situacao: "falhou", tentativas: 6 }).where(eq(integracaoEnvios.id, venda.id));
    expect(await comSessao(diretor.id, () => reenviarEnvio(roteiro.id))).toEqual({ ok: true });
    expect(await ler(venda.id)).toMatchObject({ situacao: "falhou", tentativas: 6 });
  });
});

describe("botões na viagem (cabeçalho)", () => {
  it("tudo desligado: nenhum botão, nenhum link", async () => {
    const f = await vendida();
    const c = (await comSessao(f.d.id, () => cabecalhoDaViagem(f.viagemId)))!;
    expect(c.integracoesNaViagem).toEqual({ trello: "desligada", drive: "desligada" });
    expect(c.cartaoTrello).toBeNull();
    expect(c.pastaDrive).toBeNull();
  });

  it("ligada e não enviada: só o Diretor vê o botão; depois de pedir, fica na fila; enviado mostra o link a todos", async () => {
    const f = await vendida();
    ligarTrello();
    ligarDrive();
    expect((await comSessao(f.d.id, () => cabecalhoDaViagem(f.viagemId)))!.integracoesNaViagem).toEqual({ trello: "enviar", drive: "enviar" });
    expect((await comSessao(f.u.id, () => cabecalhoDaViagem(f.viagemId)))!.integracoesNaViagem).toBeNull();
    expect((await comSessao(f.fin.id, () => cabecalhoDaViagem(f.viagemId)))!.integracoesNaViagem).toBeNull();

    expect(await comSessao(f.d.id, () => enviarViagemAoTrello(f.viagemId))).toEqual({ ok: true });
    expect(await comSessao(f.d.id, () => criarPastasNoDrive(f.viagemId))).toEqual({ ok: true });
    expect((await comSessao(f.d.id, () => cabecalhoDaViagem(f.viagemId)))!.integracoesNaViagem).toEqual({ trello: "pendente", drive: "pendente" });

    await db
      .update(integracaoEnvios)
      .set({ situacao: "falhou", ultimoErro: { classe: "autenticacao", status: 401 } })
      .where(eq(integracaoEnvios.chave, chavePasta(f.viagemId)));
    await db
      .update(integracaoEnvios)
      .set({ situacao: "enviado", enviadoEm: new Date(), resultado: { cartaoId: "c1", url: "https://trello.com/c/c1" } })
      .where(eq(integracaoEnvios.chave, chaveVenda(f.viagemId)));
    const d = (await comSessao(f.d.id, () => cabecalhoDaViagem(f.viagemId)))!;
    expect(d.integracoesNaViagem).toEqual({ trello: "enviado", drive: "falhou" });
    expect(d.cartaoTrello).toBe("https://trello.com/c/c1");
    expect((await comSessao(f.u.id, () => cabecalhoDaViagem(f.viagemId)))!.cartaoTrello).toBe("https://trello.com/c/c1");
  });

  it("cartão com link que não é https não vira link", async () => {
    const f = await vendida();
    await inserir({ chave: chaveVenda(f.viagemId), viagemId: f.viagemId, situacao: "enviado", enviadoEm: new Date(), resultado: { url: "javascript:x" } });
    expect((await comSessao(f.d.id, () => cabecalhoDaViagem(f.viagemId)))!.cartaoTrello).toBeNull();
  });
});
