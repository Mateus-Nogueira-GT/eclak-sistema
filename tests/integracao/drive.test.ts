import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
// `after()` só existe numa requisição: aqui a fila é processada à mão e `processarDepois` só é observada.
vi.mock("@/server/integracoes/fila", async (original) => ({
  ...(await original<typeof import("@/server/integracoes/fila")>()),
  processarDepois: vi.fn(),
}));
import { formatarCodigoCliente } from "@/domain/clientes";
import { db } from "@/server/db/client";
import { auditoria, clientes, integracaoEnvios, viagens } from "@/server/db/schema";
import { processarDepois, processarFila } from "@/server/integracoes/fila";
import { ErroIntegracao } from "@/server/integracoes/http";
import { clienteDrive, LIMITE_UPLOAD_BYTES, processarDrive } from "@/server/integracoes/drive";
import { esquecerTokensGoogle } from "@/server/integracoes/google";
import { criarPastasNoDrive } from "@/server/actions/integracoes";
import { salvarCliente } from "@/server/actions/clientes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { cabecalhoDaViagem } from "@/server/queries/operacao";
import { comSessao, limparBanco } from "../helpers/db";
import { souza, vendida } from "../helpers/venda";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const EMAIL = "eclak@projeto.iam.gserviceaccount.com";
const RAIZ = "raiz-compartilhada";
const CFG = { email: EMAIL, chave: privateKey, pastaRaizId: RAIZ };
const PASTA = "application/vnd.google-apps.folder";
const TOKEN = "ya29.token-falso";

function ligarDrive() {
  vi.stubEnv("GOOGLE_SA_EMAIL", EMAIL);
  // Como costuma vir do painel: a chave numa linha só, com "\n" literais.
  vi.stubEnv("GOOGLE_SA_CHAVE", privateKey.replace(/\n/g, "\\n"));
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", RAIZ);
}
function desligarDrive() {
  vi.stubEnv("GOOGLE_SA_EMAIL", "");
  vi.stubEnv("GOOGLE_SA_CHAVE", "");
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "");
}
function desligarTrello() {
  vi.stubEnv("TRELLO_API_KEY", "");
  vi.stubEnv("TRELLO_TOKEN", "");
  vi.stubEnv("TRELLO_LISTA_ID", "");
}

type Chamada = {
  metodo: string;
  url: URL;
  auth: string | null;
  tipo: string | null;
  corpo: Buffer;
  json: Record<string, unknown> | null;
};

const ehToken = (c: Chamada) => c.url.href === "https://oauth2.googleapis.com/token";
const ehCriarPasta = (c: Chamada) => c.metodo === "POST" && c.url.origin + c.url.pathname === "https://www.googleapis.com/drive/v3/files";

/**
 * Google falso: token `ya29.token-falso`; pastas e arquivos `id<n>` (n = número da chamada) com link
 * `https://drive.google.com/drive/folders/id<n>`. `falhar` decide, por chamada, um status de erro (o corpo ecoa o
 * token) ou "rede".
 */
function googleFalso(falhar: (c: Chamada) => number | "rede" | null = () => null) {
  const chamadas: Chamada[] = [];
  const buscar = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    const b = init?.body;
    const corpo = b === undefined || b === null ? Buffer.alloc(0) : typeof b === "string" ? Buffer.from(b) : Buffer.from(b as Uint8Array);
    const tipo = h.get("content-type");
    const c: Chamada = {
      metodo: init?.method ?? "GET",
      url: new URL(String(url)),
      auth: h.get("authorization"),
      tipo,
      corpo,
      json: tipo?.startsWith("application/json") ? JSON.parse(corpo.toString("utf8")) : null,
    };
    chamadas.push(c);
    const n = chamadas.length;
    const f = falhar(c);
    if (f === "rede") throw new TypeError("fetch failed");
    if (f) return new Response(JSON.stringify({ error: `invalid ${TOKEN}` }), { status: f });
    if (ehToken(c)) return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });
    if (c.url.hostname === "www.googleapis.com") {
      if (c.metodo === "POST") return Response.json({ id: `id${n}`, webViewLink: `https://drive.google.com/drive/folders/id${n}` });
      if (c.url.pathname === "/drive/v3/files") {
        const pagina = c.url.searchParams.get("pageToken");
        if (!pagina)
          return Response.json({
            nextPageToken: "p2",
            files: [{ id: "a1", name: "voucher.pdf", mimeType: "application/pdf", webViewLink: "https://drive.google.com/file/d/a1/view" }],
          });
        return Response.json({ files: [{ id: "a2", name: "mapa.png", mimeType: "image/png", webViewLink: "https://drive.google.com/file/d/a2/view" }] });
      }
      if (c.url.pathname === `/drive/v3/files/${RAIZ}`) return Response.json({ id: RAIZ, name: "Viagens ECLAK" });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { buscar, chamadas, drive: () => chamadas.filter((c) => !ehToken(c)) };
}

const MIN = 60_000;
const agora = new Date("2027-01-10T12:00:00.000Z");
const depois = (min: number) => new Date(agora.getTime() + min * MIN);

const envios = () => db.select().from(integracaoEnvios);
const envioDe = async (chave: string) => (await db.select().from(integracaoEnvios).where(eq(integracaoEnvios.chave, chave)))[0];

async function codigoClienteDa(viagemId: string) {
  const [v] = await db
    .select({ codigo: clientes.codigo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(viagens.id, viagemId));
  return formatarCodigoCliente(v.codigo);
}

beforeEach(async () => {
  await limparBanco();
  esquecerTokensGoogle();
  vi.mocked(processarDepois).mockReset();
  desligarTrello();
  ligarDrive();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("clienteDrive", () => {
  it("criarPasta: POST /drive/v3/files com supportsAllDrives, Bearer e o corpo da pasta", async () => {
    const g = googleFalso();
    const r = await clienteDrive(CFG, g.buscar).criarPasta("ECL-0001_SOUZA", "pai9");
    expect(r).toEqual({ id: "id2", link: "https://drive.google.com/drive/folders/id2" });
    expect(g.chamadas).toHaveLength(2);
    expect(ehToken(g.chamadas[0])).toBe(true);
    const c = g.chamadas[1];
    expect(c.metodo).toBe("POST");
    expect(c.url.origin + c.url.pathname).toBe("https://www.googleapis.com/drive/v3/files");
    expect(Object.fromEntries(c.url.searchParams)).toEqual({ supportsAllDrives: "true", fields: "id,webViewLink" });
    expect(c.auth).toBe(`Bearer ${TOKEN}`);
    expect(c.tipo).toBe("application/json; charset=UTF-8");
    expect(c.json).toEqual({ name: "ECL-0001_SOUZA", mimeType: PASTA, parents: ["pai9"] });
    // O token só no cabeçalho.
    for (const x of g.chamadas) expect(x.url.href).not.toContain(TOKEN);
  });

  it("o token é pedido uma vez e reaproveitado nas chamadas seguintes", async () => {
    const g = googleFalso();
    const cli = clienteDrive(CFG, g.buscar);
    await cli.criarPasta("a", "p");
    await cli.criarPasta("b", "p");
    expect(g.chamadas.filter(ehToken)).toHaveLength(1);
    expect(g.drive()).toHaveLength(2);
  });

  it("enviarArquivo: multipart/related com boundary, metadados JSON e os bytes do arquivo", async () => {
    const g = googleFalso();
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0d, 0x0a, 0x2d, 0x2d]);
    const r = await clienteDrive(CFG, g.buscar).enviarArquivo("pasta7", "voucher.pdf", "application/pdf", bytes);
    expect(r).toEqual({ id: "id2", link: "https://drive.google.com/drive/folders/id2" });
    const c = g.drive()[0];
    expect(c.metodo).toBe("POST");
    expect(c.url.origin + c.url.pathname).toBe("https://www.googleapis.com/upload/drive/v3/files");
    expect(c.url.searchParams.get("uploadType")).toBe("multipart");
    expect(c.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(c.auth).toBe(`Bearer ${TOKEN}`);
    const m = /^multipart\/related; boundary=([^\s;]+)$/.exec(c.tipo ?? "");
    expect(m).not.toBeNull();
    const boundary = m![1];
    const meta = JSON.stringify({ name: "voucher.pdf", parents: ["pasta7"] });
    const esperado = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    expect(c.corpo.equals(esperado)).toBe(true);
  });

  it("enviarArquivo recusa mais de 5 MB e MIME estranho sem nenhuma chamada (nem o token)", async () => {
    const g = googleFalso();
    const cli = clienteDrive(CFG, g.buscar);
    expect(LIMITE_UPLOAD_BYTES).toBe(5 * 1024 * 1024);
    await expect(cli.enviarArquivo("p", "grande.pdf", "application/pdf", new Uint8Array(LIMITE_UPLOAD_BYTES + 1))).rejects.toMatchObject({
      classe: "recusado",
    });
    await expect(cli.enviarArquivo("p", "x.pdf", "application/pdf\r\nX-Injetado: 1", new Uint8Array(3))).rejects.toMatchObject({
      classe: "recusado",
    });
    expect(g.chamadas).toEqual([]);
    // Exatamente 5 MB passa.
    await cli.enviarArquivo("p", "limite.pdf", "application/pdf", new Uint8Array(LIMITE_UPLOAD_BYTES));
    expect(g.drive()).toHaveLength(1);
  });

  it("listarArquivos: q da pasta sem lixeira, drives compartilhados e todas as páginas", async () => {
    const g = googleFalso();
    const r = await clienteDrive(CFG, g.buscar).listarArquivos("pasta'7");
    expect(r).toEqual([
      { id: "a1", nome: "voucher.pdf", mime: "application/pdf", link: "https://drive.google.com/file/d/a1/view" },
      { id: "a2", nome: "mapa.png", mime: "image/png", link: "https://drive.google.com/file/d/a2/view" },
    ]);
    const [p1, p2] = g.drive();
    expect(p1.metodo).toBe("GET");
    expect(p1.url.origin + p1.url.pathname).toBe("https://www.googleapis.com/drive/v3/files");
    expect(p1.url.searchParams.get("q")).toBe("'pasta\\'7' in parents and trashed = false");
    expect(p1.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(p1.url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(p1.url.searchParams.get("fields")).toBe("nextPageToken,files(id,name,mimeType,webViewLink)");
    expect(p1.url.searchParams.get("pageToken")).toBeNull();
    expect(p2.url.searchParams.get("pageToken")).toBe("p2");
    expect(p1.auth).toBe(`Bearer ${TOKEN}`);
  });

  it("testar: token e leitura da pasta raiz; falha devolve a classe sem lançar", async () => {
    const g = googleFalso();
    expect(await clienteDrive(CFG, g.buscar).testar()).toEqual({ ok: true, pasta: "Viagens ECLAK" });
    const c = g.drive()[0];
    expect(c.metodo).toBe("GET");
    expect(c.url.origin + c.url.pathname).toBe(`https://www.googleapis.com/drive/v3/files/${RAIZ}`);
    expect(Object.fromEntries(c.url.searchParams)).toEqual({ supportsAllDrives: "true", fields: "id,name" });

    esquecerTokensGoogle();
    expect(await clienteDrive(CFG, googleFalso((x) => (ehToken(x) ? 401 : null)).buscar).testar()).toEqual({ ok: false, classe: "autenticacao" });
    esquecerTokensGoogle();
    expect(await clienteDrive(CFG, googleFalso((x) => (ehToken(x) ? null : 404)).buscar).testar()).toEqual({ ok: false, classe: "recusado" });
    esquecerTokensGoogle();
    expect(await clienteDrive(CFG, googleFalso(() => "rede").buscar).testar()).toEqual({ ok: false, classe: "rede" });
    esquecerTokensGoogle();
    expect(await clienteDrive({ ...CFG, chave: "nao-e-chave" }, googleFalso().buscar).testar()).toEqual({ ok: false, classe: "autenticacao" });
  });

  it("erro do serviço vira ErroIntegracao com classe e status, sem o corpo nem o token", async () => {
    const g = googleFalso((c) => (ehToken(c) ? null : 500));
    const e = await clienteDrive(CFG, g.buscar).criarPasta("n", "p").catch((x) => x);
    expect(e).toBeInstanceOf(ErroIntegracao);
    expect(e).toMatchObject({ classe: "servidor", status: 500 });
    expect(String(e.message)).not.toContain(TOKEN);
  });
});

describe("fechar venda", () => {
  it("Drive ligado: um envio pasta:<viagem> com o nome da pasta (código do cliente); sem valor nem CPF; agenda", async () => {
    const f = await vendida();
    const linhas = await envios();
    expect(linhas).toHaveLength(1);
    const e = linhas[0];
    expect(e).toMatchObject({ integracao: "drive", tipo: "pasta_viagem", viagemId: f.viagemId, chave: `pasta:${f.viagemId}`, situacao: "pendente" });
    const codigo = await codigoClienteDa(f.viagemId);
    expect(codigo).toMatch(/^ECL-\d{4}$/);
    expect(e.payload).toEqual({ viagemId: f.viagemId, nome: `${codigo}_SOUZA_ITALIA_20270814-20270901` });
    const json = JSON.stringify(e.payload);
    expect(json).not.toContain("R$");
    expect(json).not.toContain("529.982.247-25");
    expect(json).not.toContain("52998224725");
    expect(json).not.toMatch(/\d{11}/);
    expect(json).not.toMatch(/3\.?106|8\.?000|1\.000|500,00/);
    // A raiz vem da configuração na hora de processar, não do payload.
    expect(json).not.toContain(RAIZ);
    expect(processarDepois).toHaveBeenCalledTimes(1);
  });

  it("Drive e Trello ligados: os dois envios na mesma transação, um agendamento", async () => {
    vi.stubEnv("TRELLO_API_KEY", "k");
    vi.stubEnv("TRELLO_TOKEN", "t");
    vi.stubEnv("TRELLO_LISTA_ID", "l");
    const f = await vendida();
    expect((await envios()).map((e) => e.chave).sort()).toEqual([`pasta:${f.viagemId}`, `venda:${f.viagemId}`]);
    expect(processarDepois).toHaveBeenCalledTimes(1);
  });

  it("Drive desligado: nada na fila, nada agendado", async () => {
    desligarDrive();
    await vendida();
    expect(await envios()).toEqual([]);
    expect(processarDepois).not.toHaveBeenCalled();
  });
});

describe("processar a pasta", () => {
  it("cria a pasta-mãe na raiz e as subpastas 'Público' e 'Uso interno' dentro dela", async () => {
    const f = await vendida();
    const g = googleFalso();
    expect(await processarFila({ agora, buscar: g.buscar })).toEqual({ enviados: 1, falhas: 0 });
    const codigo = await codigoClienteDa(f.viagemId);
    expect(g.chamadas.filter(ehToken)).toHaveLength(1);
    expect(g.drive().map((c) => [ehCriarPasta(c), c.json])).toEqual([
      [true, { name: `${codigo}_SOUZA_ITALIA_20270814-20270901`, mimeType: PASTA, parents: [RAIZ] }],
      [true, { name: "Público", mimeType: PASTA, parents: ["id2"] }],
      [true, { name: "Uso interno", mimeType: PASTA, parents: ["id2"] }],
    ]);
    expect(g.drive().every((c) => c.auth === `Bearer ${TOKEN}` && c.url.searchParams.get("supportsAllDrives") === "true")).toBe(true);
    const e = await envioDe(`pasta:${f.viagemId}`);
    expect(e).toMatchObject({
      situacao: "enviado",
      tentativas: 1,
      resultado: { pastaId: "id2", link: "https://drive.google.com/drive/folders/id2", publicaId: "id3", internaId: "id4" },
    });
    // Nem o token nem a chave no banco.
    const aud = JSON.stringify(await db.select().from(auditoria));
    for (const x of [JSON.stringify(e), aud]) {
      expect(x).not.toContain(TOKEN);
      expect(x).not.toContain("PRIVATE KEY");
    }
  });

  it("grava o resultado depois de cada pasta criada (inclusive a última)", async () => {
    const g = googleFalso();
    const gravados: unknown[] = [];
    const r = await processarDrive(
      {
        id: "e1",
        integracao: "drive",
        tipo: "pasta_viagem",
        viagemId: null,
        chave: "pasta:x",
        payload: { viagemId: "x", nome: "ECL-0001_X" },
        tentativas: 1,
        resultado: null,
        tomadoEm: agora,
      },
      { buscar: g.buscar, agora, gravarResultado: async (x) => void gravados.push(x) },
    );
    const final = { pastaId: "id2", link: "https://drive.google.com/drive/folders/id2", publicaId: "id3", internaId: "id4" };
    expect(r).toEqual(final);
    expect(gravados).toEqual([
      { pastaId: "id2", link: "https://drive.google.com/drive/folders/id2" },
      { pastaId: "id2", link: "https://drive.google.com/drive/folders/id2", publicaId: "id3" },
      final,
    ]);
  });

  it("falha depois da pasta-mãe: a retomada não cria outra pasta-mãe", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    let falhou = false;
    const g = googleFalso((c) => {
      if (c.json?.name === "Público" && !falhou) {
        falhou = true;
        return 503;
      }
      return null;
    });
    expect(await processarFila({ agora, buscar: g.buscar })).toEqual({ enviados: 0, falhas: 1 });
    const e = await envioDe(`pasta:${f.viagemId}`);
    expect(e).toMatchObject({
      situacao: "pendente",
      tentativas: 1,
      ultimoErro: { classe: "servidor", status: 503 },
      resultado: { pastaId: "id2", link: "https://drive.google.com/drive/folders/id2" },
    });
    expect(e.proximaEm).toEqual(depois(1));
    expect(await processarFila({ agora: depois(2), buscar: g.buscar })).toEqual({ enviados: 1, falhas: 0 });
    const maes = g.drive().filter((c) => (c.json?.parents as string[] | undefined)?.[0] === RAIZ);
    expect(maes).toHaveLength(1);
    expect(await envioDe(`pasta:${f.viagemId}`)).toMatchObject({
      situacao: "enviado",
      resultado: { pastaId: "id2", link: "https://drive.google.com/drive/folders/id2", publicaId: "id4", internaId: "id5" },
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE KEY");
  });

  it("falha entre as duas subpastas: a retomada só cria 'Uso interno'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    let falhou = false;
    const g = googleFalso((c) => {
      if (c.json?.name === "Uso interno" && !falhou) {
        falhou = true;
        return 429;
      }
      return null;
    });
    expect(await processarFila({ agora, buscar: g.buscar })).toEqual({ enviados: 0, falhas: 1 });
    expect(await envioDe(`pasta:${f.viagemId}`)).toMatchObject({
      situacao: "pendente",
      ultimoErro: { classe: "limite", status: 429 },
      resultado: { pastaId: "id2", publicaId: "id3" },
    });
    await processarFila({ agora: depois(2), buscar: g.buscar });
    expect(g.drive().map((c) => c.json?.name)).toEqual([expect.stringMatching(/^ECL-/), "Público", "Uso interno", "Uso interno"]);
    expect(await envioDe(`pasta:${f.viagemId}`)).toMatchObject({
      situacao: "enviado",
      resultado: { pastaId: "id2", publicaId: "id3", internaId: "id5" },
    });
  });

  it("token recusado (401): falhou com autenticação, sem chamar o Drive; nada do token ou da chave no log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    const g = googleFalso((c) => (ehToken(c) ? 401 : null));
    expect(await processarFila({ agora, buscar: g.buscar })).toEqual({ enviados: 0, falhas: 1 });
    expect(g.drive()).toEqual([]);
    expect(await envioDe(`pasta:${f.viagemId}`)).toMatchObject({ situacao: "falhou", ultimoErro: { classe: "autenticacao", status: 401 } });
    const tudo = JSON.stringify(log.mock.calls);
    expect(tudo).not.toContain(TOKEN);
    expect(tudo).not.toContain("PRIVATE KEY");
  });

  it("rede no token: pendente para tentar de novo, sem resultado", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    await processarFila({ agora, buscar: googleFalso(() => "rede").buscar });
    expect(await envioDe(`pasta:${f.viagemId}`)).toMatchObject({ situacao: "pendente", ultimoErro: { classe: "rede", status: null }, resultado: null });
  });

  it("payload inválido ou tipo desconhecido: falhou recusado sem chamar o Google", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const f = await vendida();
    await db.update(integracaoEnvios).set({ payload: { viagemId: f.viagemId } }).where(eq(integracaoEnvios.chave, `pasta:${f.viagemId}`));
    await db.insert(integracaoEnvios).values({ integracao: "drive", tipo: "outro", viagemId: f.viagemId, chave: "x:1", payload: {} });
    const g = googleFalso();
    await processarFila({ agora, buscar: g.buscar });
    expect(g.chamadas).toEqual([]);
    expect(await envioDe(`pasta:${f.viagemId}`)).toMatchObject({ situacao: "falhou", ultimoErro: { classe: "recusado" } });
    expect(await envioDe("x:1")).toMatchObject({ situacao: "falhou", ultimoErro: { classe: "recusado" } });
  });
});

describe("criarPastasNoDrive", () => {
  it("só o Diretor; desligado recusa; id inválido; viagem não vendida", async () => {
    desligarDrive();
    const f = await vendida();
    expect(await comSessao(f.u.id, () => criarPastasNoDrive(f.viagemId))).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await comSessao(f.d.id, () => criarPastasNoDrive(f.viagemId))).toEqual({ ok: false, erro: "O Google Drive não está configurado" });
    ligarDrive();
    expect(await comSessao(f.d.id, () => criarPastasNoDrive("nada"))).toEqual({ ok: false, erro: "Viagem não encontrada" });
    const c = await comSessao(f.u.id, () => salvarCliente({ ...souza, titular: { nome: "Ana Lima" }, acompanhantes: [] }));
    if (!c.ok) throw new Error(c.erro);
    const pessoas = (await comSessao(f.u.id, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
    const o = await comSessao(f.u.id, () => criarOrcamento({ clienteId: c.id, destino: "Lisboa", inicio: "2027-03-01", fim: "2027-03-08", passageiros: pessoas }));
    if (!o.ok) throw new Error(o.erro);
    expect(await comSessao(f.d.id, () => criarPastasNoDrive(o.id))).toEqual({ ok: false, erro: "A viagem ainda não foi vendida" });
    expect(await envios()).toEqual([]);
  });

  it("vendida com o Drive desligado: o Diretor cria a pasta depois; auditado como drive; uma vez só", async () => {
    desligarDrive();
    const f = await vendida();
    ligarDrive();
    expect(await comSessao(f.d.id, () => criarPastasNoDrive(f.viagemId))).toEqual({ ok: true });
    const e = await envioDe(`pasta:${f.viagemId}`);
    expect(e).toMatchObject({ integracao: "drive", tipo: "pasta_viagem", situacao: "pendente" });
    expect(e.payload).toEqual({ viagemId: f.viagemId, nome: `${await codigoClienteDa(f.viagemId)}_SOUZA_ITALIA_20270814-20270901` });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, e.id));
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({
      usuarioId: f.d.id,
      tabela: "integracao_envios",
      acao: "criar",
      depois: { integracao: "drive", tipo: "pasta_viagem", chave: `pasta:${f.viagemId}`, situacao: "pendente" },
    });
    expect(JSON.stringify(aud[0])).not.toContain("PRIVATE KEY");
    expect(processarDepois).toHaveBeenCalledTimes(1);

    expect(await comSessao(f.d.id, () => criarPastasNoDrive(f.viagemId))).toEqual({
      ok: false,
      erro: "As pastas desta viagem já foram criadas no Drive",
    });
    expect(await envios()).toHaveLength(1);
  });
});

describe("cabeçalho da viagem: Pasta no Drive", () => {
  it("só com o envio enviado e link https; pendente com resultado parcial não mostra", async () => {
    const f = await vendida();
    const chave = `pasta:${f.viagemId}`;
    // Consultor (quem vê a viagem) também vê o link.
    const ler = async () => (await comSessao(f.u.id, () => cabecalhoDaViagem(f.viagemId)))!.pastaDrive;
    expect(await ler()).toBeNull();

    await db.update(integracaoEnvios).set({ resultado: { pastaId: "id2", link: "https://drive.google.com/drive/folders/id2" } }).where(eq(integracaoEnvios.chave, chave));
    expect(await ler()).toBeNull();

    await processarFila({ agora, buscar: googleFalso().buscar });
    expect(await envioDe(chave)).toMatchObject({ situacao: "enviado" });
    expect(await ler()).toBe("https://drive.google.com/drive/folders/id2");

    await db.update(integracaoEnvios).set({ resultado: { pastaId: "id2", link: "javascript:alert(1)" } }).where(eq(integracaoEnvios.chave, chave));
    expect(await ler()).toBeNull();
  });

  it("sem Drive: sem link", async () => {
    desligarDrive();
    const f = await vendida();
    expect((await comSessao(f.u.id, () => cabecalhoDaViagem(f.viagemId)))!.pastaDrive).toBeNull();
  });
});
