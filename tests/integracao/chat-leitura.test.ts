import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { formatarCodigoViagem } from "@/domain/viagens";
import { db } from "@/server/db/client";
import { clientes, integracaoEnvios, pessoas, viagens } from "@/server/db/schema";
import { conversar } from "@/server/actions/chat";
import { ERRO_DO_SERVICO } from "@/server/ia/erros-servico";
import { definirBuscarDoChatParaTestes, ferramentasDoChat } from "@/server/ia/ferramentas";
import { esquecerTokensGoogle, GOOGLE_TOKEN_URL } from "@/server/integracoes/google";
import { definirProvedorIAParaTestes, type PedidoIA, type ProvedorIA, type RespostaIA } from "@/server/integracoes/ia";
import { esquecerQuadrosTrello } from "@/server/integracoes/trello";
import { comSessao, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function pdfMinimo(texto: string): Uint8Array {
  const escapado = texto.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escapado}) Tj ET`;
  const objetos = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objetos) {
    offsets.push(out.length);
    out += obj;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objetos.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function ligarTrello() {
  vi.stubEnv("TRELLO_API_KEY", "chave");
  vi.stubEnv("TRELLO_TOKEN", "token");
  vi.stubEnv("TRELLO_LISTA_ID", "lista-op");
}
function ligarDrive() {
  vi.stubEnv("GOOGLE_SA_EMAIL", "sa@eclak.test");
  vi.stubEnv("GOOGLE_SA_CHAVE", privateKey);
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "raiz");
}

type Bloco = RespostaIA["conteudo"][number];
const usoDe = (id: string, name: string, input: Record<string, unknown>): Bloco =>
  ({ type: "tool_use", id, name, input, caller: { type: "direct" } }) as Bloco;
const textoDe = (text: string): Bloco => ({ type: "text", text, citations: null }) as Bloco;

function provedorFalso(voltas: Partial<RespostaIA>[]) {
  const pedidos: PedidoIA[] = [];
  const p: ProvedorIA = {
    modelo: "claude-opus-5-5",
    async responder(x) {
      pedidos.push(structuredClone(x));
      const v = voltas[Math.min(pedidos.length - 1, voltas.length - 1)];
      return { parada: "end_turn", texto: "", conteudo: [], modelo: "claude-opus-5-5", tokensEntrada: 100, tokensSaida: 10, ...v };
    },
  };
  definirProvedorIAParaTestes(p);
  return pedidos;
}

type ToolRes = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
function resultado(p: PedidoIA, idx = 0): ToolRes {
  const u = p.mensagens[p.mensagens.length - 1];
  return (u.content as unknown as ToolRes[])[idx];
}

let f: Fixture;
let codigo: string;

beforeEach(async () => {
  await limparBanco();
  esquecerQuadrosTrello();
  esquecerTokensGoogle();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("TRELLO_API_KEY", "");
  vi.stubEnv("TRELLO_TOKEN", "");
  vi.stubEnv("TRELLO_LISTA_ID", "");
  vi.stubEnv("GOOGLE_SA_EMAIL", "");
  vi.stubEnv("GOOGLE_SA_CHAVE", "");
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "");
  f = await vendida();
  const [v] = await db
    .select({ seq: viagens.seq, codigo: clientes.codigo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(viagens.id, f.viagemId));
  codigo = formatarCodigoViagem(v.codigo, v.seq);
  await db
    .update(pessoas)
    .set({ nascimento: "1982-06-15", cpf: "52998224725", passaporte: "BR987654" })
    .where(eq(pessoas.titular, true));
});
afterEach(() => {
  definirProvedorIAParaTestes(null);
  definirBuscarDoChatParaTestes(null);
  esquecerQuadrosTrello();
  esquecerTokensGoogle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("R-A1: ferramentas disponíveis conforme integrações", () => {
  it("sem Trello e Drive, só as 4 ferramentas base; ligando Trello/Drive, entram as de leitura", () => {
    expect(ferramentasDoChat().map((t) => t.name)).toEqual([
      "buscar_viagens",
      "resumo_da_viagem",
      "minhas_tarefas",
      "dailies_da_semana",
    ]);
    ligarTrello();
    expect(ferramentasDoChat().map((t) => t.name)).toContain("trello_listas");
    expect(ferramentasDoChat().map((t) => t.name)).toContain("trello_buscar_cartoes");
    expect(ferramentasDoChat().map((t) => t.name)).toContain("trello_cartao");
    expect(ferramentasDoChat().map((t) => t.name)).not.toContain("drive_listar");
    ligarDrive();
    expect(ferramentasDoChat().map((t) => t.name)).toContain("drive_listar");
    expect(ferramentasDoChat().map((t) => t.name)).toContain("drive_buscar");
    expect(ferramentasDoChat().map((t) => t.name)).toContain("drive_ler_arquivo");
  });
});

describe("ferramentas de leitura do Trello", () => {
  const ID_11_DIGITOS = "5f1a11122233344455566677";

  beforeEach(async () => {
    ligarTrello();
    await db.insert(integracaoEnvios).values({
      integracao: "trello",
      tipo: "cartao_viagem",
      viagemId: f.viagemId,
      chave: `venda:${f.viagemId}`,
      payload: {},
      situacao: "enviado",
      enviadoEm: new Date(),
      resultado: { cartaoId: ID_11_DIGITOS, url: `https://trello.com/c/${ID_11_DIGITOS}` },
    });
  });

  function trelloBuscar(opcoes: { status?: number } = {}): typeof fetch {
    return (async (url: string | URL | Request) => {
      if (opcoes.status) return new Response("err", { status: opcoes.status });
      const u = new URL(String(url));
      if (u.pathname === "/1/lists/lista-op") return Response.json({ id: "lista-op", idBoard: "b1", name: "Operações" });
      if (u.pathname === "/1/boards/b1/lists") {
        return Response.json([
          { id: "lista-op", name: "Operações" },
          { id: "lista-em", name: "Emissão" },
        ]);
      }
      if (u.pathname === "/1/boards/b1/cards/open") {
        const cards = [
          {
            id: ID_11_DIGITOS,
            name: `${codigo} · Emissão Itália`,
            idList: "lista-em",
            due: "2027-08-14T16:00:00.000Z",
            dueComplete: false,
            shortUrl: `https://trello.com/c/${ID_11_DIGITOS}`,
          },
          ...Array.from({ length: 34 }, (_, i) => ({
            id: `card-${i}`,
            name: `Cartão ${i}`,
            idList: "lista-op",
            due: null,
            dueComplete: false,
            shortUrl: `https://trello.com/c/card-${i}`,
          })),
        ];
        return Response.json(cards);
      }
      if (u.pathname === `/1/cards/${ID_11_DIGITOS}`) {
        return Response.json({
          id: ID_11_DIGITOS,
          idBoard: "b1",
          name: `${codigo} · SOUZA`,
          desc: `Viagem no sistema: https://sistema.eclak.test/viagens/${f.viagemId}\nHotel Roma confirmado.`,
          idList: "lista-em",
          due: null,
          dueComplete: false,
          shortUrl: `https://trello.com/c/${ID_11_DIGITOS}`,
          checklists: [{ id: "chk1", name: "Tarefas", checkItems: [{ id: "i1", name: "Emitir voucher", state: "incomplete" }] }],
          actions: [
            {
              type: "commentCard",
              date: "2026-11-25T10:00:00.000Z",
              memberCreator: { fullName: "Maria" },
              data: { text: "CPF 529.982.247-25 e nascimento 15/06/1982 conferidos." },
            },
          ],
        });
      }
      if (u.pathname === "/1/cards/outro-quadro") {
        return Response.json({ id: "outro-quadro", idBoard: "b-outro", name: "Segredo", idList: "x", desc: "" });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  }

  it("trello_buscar_cartoes limita em 30 com total 35, busca sem acento, marca viagem e preserva id com 11 dígitos", async () => {
    definirBuscarDoChatParaTestes(trelloBuscar());
    const pedidos = provedorFalso([
      {
        parada: "tool_use",
        conteudo: [
          usoDe("t1", "trello_buscar_cartoes", { busca: "", lista: "" }),
          usoDe("t2", "trello_buscar_cartoes", { busca: "emissao", lista: "" }),
        ],
      },
      { parada: "end_turn", texto: "Encontrei.", conteudo: [textoDe("Encontrei.")] },
    ]);
    const r = await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Cartões" }]));
    expect(r).toMatchObject({ ok: true, texto: "Encontrei." });

    const r1 = JSON.parse(resultado(pedidos[1], 0).content);
    expect(r1.total).toBe(35);
    expect(r1.cartoes).toHaveLength(30);
    expect(r1.cartoes[0]).toMatchObject({ id: ID_11_DIGITOS, viagem: codigo, lista: "Emissão" });

    const r2 = JSON.parse(resultado(pedidos[1], 1).content);
    expect(r2.total).toBe(1);
    expect(r2.cartoes[0].id).toBe(ID_11_DIGITOS);
  });

  it("trello_cartao por código e por id: remove /viagens/<uuid>, mascara CPF e nascimento, recusa outro quadro", async () => {
    definirBuscarDoChatParaTestes(trelloBuscar());
    const pedidos = provedorFalso([
      {
        parada: "tool_use",
        conteudo: [
          usoDe("t1", "trello_cartao", { cartao: codigo }),
          usoDe("t2", "trello_cartao", { cartao: "outro-quadro" }),
        ],
      },
      { parada: "end_turn", texto: "Ok.", conteudo: [textoDe("Ok.")] },
    ]);
    await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Ver cartão" }]));

    const okRes = resultado(pedidos[1], 0);
    expect(okRes.is_error).toBeFalsy();
    const dados = JSON.parse(okRes.content);
    expect(dados.descricao).toContain("Hotel Roma confirmado.");
    expect(dados.descricao).not.toContain(f.viagemId);
    expect(dados.descricao).not.toContain("/viagens/");
    expect(dados.comentarios[0].texto).toBe("CPF [CPF] e nascimento [NASCIMENTO] conferidos.");

    const foraRes = resultado(pedidos[1], 1);
    expect(foraRes.is_error).toBe(true);
    expect(foraRes.content).toContain("Cartão não encontrado");
  });

  it("serviço fora do ar (503) vira tool_result com ERRO_DO_SERVICO.trello.servidor e conversa segue", async () => {
    definirBuscarDoChatParaTestes(trelloBuscar({ status: 503 }));
    const pedidos = provedorFalso([
      { parada: "tool_use", conteudo: [usoDe("t1", "trello_listas", {})] },
      { parada: "end_turn", texto: "Trello fora do ar.", conteudo: [textoDe("Trello fora do ar.")] },
    ]);
    const r = await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Listas" }]));
    expect(r).toMatchObject({ ok: true, texto: "Trello fora do ar." });
    expect(resultado(pedidos[1], 0)).toMatchObject({ is_error: true, content: ERRO_DO_SERVICO.trello.servidor });
  });
});

describe("ferramentas de leitura do Drive", () => {
  beforeEach(async () => {
    ligarDrive();
    await db.insert(integracaoEnvios).values({
      integracao: "drive",
      tipo: "pasta_viagem",
      viagemId: f.viagemId,
      chave: `pasta:${f.viagemId}`,
      payload: {},
      situacao: "enviado",
      enviadoEm: new Date(),
      resultado: { pastaId: "pasta-v1", publicaId: "pub-1", internaId: "int-1" },
    });
  });

  function driveBuscar(): typeof fetch {
    const arvore: Record<string, Record<string, unknown>> = {
      raiz: { id: "raiz", name: "Raiz", mimeType: "application/vnd.google-apps.folder", parents: [] },
      "pasta-v1": { id: "pasta-v1", name: "ECL-0001_SOUZA", mimeType: "application/vnd.google-apps.folder", parents: ["raiz"] },
      "pub-1": { id: "pub-1", name: "Público", mimeType: "application/vnd.google-apps.folder", parents: ["pasta-v1"] },
      "fora-pasta": { id: "fora-pasta", name: "Externo", mimeType: "application/vnd.google-apps.folder", parents: ["outra-raiz"] },
      "doc-1": {
        id: "doc-1",
        name: "roteiro.gdoc",
        mimeType: "application/vnd.google-apps.document",
        parents: ["pub-1"],
        webViewLink: "https://docs.google.com/document/d/doc-1",
      },
      "pdf-1": {
        id: "pdf-1",
        name: "voucher.pdf",
        mimeType: "application/pdf",
        parents: ["pub-1"],
        size: "1200",
        webViewLink: "https://drive.google.com/file/d/pdf-1/view",
      },
      "txt-grande": {
        id: "txt-grande",
        name: "longo.txt",
        mimeType: "text/plain",
        parents: ["pub-1"],
        size: "25000",
        webViewLink: "https://drive.google.com/file/d/txt-grande/view",
      },
      "img-1": {
        id: "img-1",
        name: "foto.png",
        mimeType: "image/png",
        parents: ["pub-1"],
        size: "500",
        webViewLink: "https://drive.google.com/file/d/img-1/view",
      },
      "arq-fora": {
        id: "arq-fora",
        name: "secreto.txt",
        mimeType: "text/plain",
        parents: ["fora-pasta"],
        size: "100",
        webViewLink: "https://drive.google.com/file/d/arq-fora/view",
      },
    };
    const pdfBytes = pdfMinimo("Voucher Hotel Roma passaporte BR987654");

    return (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      if (u.href === GOOGLE_TOKEN_URL) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (u.pathname === "/drive/v3/files") {
        const q = u.searchParams.get("q") ?? "";
        if (q.includes("'raiz' in parents")) return Response.json({ files: [arvore["pasta-v1"]] });
        if (q.includes("'pasta-v1' in parents")) return Response.json({ files: [arvore["pub-1"]] });
        if (q.includes("fullText contains")) return Response.json({ files: [arvore["pdf-1"], arvore["arq-fora"]] });
        return Response.json({ files: [] });
      }
      const mExport = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(u.pathname);
      if (mExport) {
        if (mExport[1] === "doc-1") return new Response("Texto do Docs com BR987654", { status: 200, headers: { "Content-Type": "text/plain" } });
        return new Response(null, { status: 404 });
      }
      const mFile = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
      if (mFile) {
        const id = decodeURIComponent(mFile[1]);
        if (u.searchParams.get("alt") === "media") {
          if (id === "pdf-1") return new Response(Buffer.from(pdfBytes), { status: 200, headers: { "Content-Type": "application/pdf" } });
          if (id === "txt-grande") return new Response("x".repeat(25_000), { status: 200, headers: { "Content-Type": "text/plain" } });
          return new Response(null, { status: 404 });
        }
        return arvore[id] ? Response.json(arvore[id]) : new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  }

  it("drive_listar lista raiz e viagem e recusa pasta fora da raiz", async () => {
    definirBuscarDoChatParaTestes(driveBuscar());
    const pedidos = provedorFalso([
      {
        parada: "tool_use",
        conteudo: [
          usoDe("d1", "drive_listar", { pasta: "" }),
          usoDe("d2", "drive_listar", { pasta: codigo }),
          usoDe("d3", "drive_listar", { pasta: "fora-pasta" }),
        ],
      },
      { parada: "end_turn", texto: "Listei.", conteudo: [textoDe("Listei.")] },
    ]);
    await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Listar" }]));
    expect(JSON.parse(resultado(pedidos[1], 0).content).itens[0]).toMatchObject({ id: "pasta-v1", tipo: "pasta" });
    expect(JSON.parse(resultado(pedidos[1], 1).content).itens[0]).toMatchObject({ id: "pub-1", tipo: "pasta" });
    expect(resultado(pedidos[1], 2)).toMatchObject({ is_error: true, content: expect.stringContaining("Pasta não encontrada") });
  });

  it("drive_buscar descarta fora da raiz e traz caminho", async () => {
    definirBuscarDoChatParaTestes(driveBuscar());
    const pedidos = provedorFalso([
      { parada: "tool_use", conteudo: [usoDe("b1", "drive_buscar", { texto: "voucher" })] },
      { parada: "end_turn", texto: "Achei.", conteudo: [textoDe("Achei.")] },
    ]);
    await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Buscar voucher" }]));
    const d = JSON.parse(resultado(pedidos[1], 0).content);
    expect(d.arquivos).toHaveLength(1);
    expect(d.arquivos[0]).toMatchObject({ id: "pdf-1", nome: "voucher.pdf", caminho: ["ECL-0001_SOUZA", "Público"] });
  });

  it("drive_ler_arquivo lê Docs, PDF (com máscara de passaporte), texto longo cortado em 20.000, recusa imagem com link e arquivo fora da raiz", async () => {
    definirBuscarDoChatParaTestes(driveBuscar());
    const pedidos = provedorFalso([
      {
        parada: "tool_use",
        conteudo: [
          usoDe("l1", "drive_ler_arquivo", { arquivo: "doc-1" }),
          usoDe("l2", "drive_ler_arquivo", { arquivo: "pdf-1" }),
          usoDe("l3", "drive_ler_arquivo", { arquivo: "txt-grande" }),
          usoDe("l4", "drive_ler_arquivo", { arquivo: "img-1" }),
          usoDe("l5", "drive_ler_arquivo", { arquivo: "arq-fora" }),
        ],
      },
      { parada: "end_turn", texto: "Lido.", conteudo: [textoDe("Lido.")] },
    ]);
    await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Ler arquivos" }]));

    const rDoc = JSON.parse(resultado(pedidos[1], 0).content);
    expect(rDoc.texto).toBe("Texto do Docs com [PASSAPORTE]");
    expect(rDoc.cortado).toBe(false);

    const rPdf = JSON.parse(resultado(pedidos[1], 1).content);
    expect(rPdf.texto).toContain("Voucher Hotel Roma");
    expect(rPdf.texto).toContain("[PASSAPORTE]");
    expect(rPdf.texto).not.toContain("BR987654");

    const rTxt = JSON.parse(resultado(pedidos[1], 2).content);
    expect(rTxt.texto).toHaveLength(20_000);
    expect(rTxt.cortado).toBe(true);

    const rImg = resultado(pedidos[1], 3);
    expect(rImg.is_error).toBe(true);
    expect(rImg.content).toContain("https://drive.google.com/file/d/img-1/view");

    const rFora = resultado(pedidos[1], 4);
    expect(rFora.is_error).toBe(true);
    expect(rFora.content).toContain("Arquivo não encontrado");
  });
});

describe("conversar: 8 voltas", () => {
  it("aceita 8 voltas e falha na 9ª com DEMAIS", async () => {
    // 7 tool_use + 1 end_turn = 8 voltas -> sucesso
    const okVoltas: Partial<RespostaIA>[] = [
      ...Array.from({ length: 7 }, (_, i) => ({ parada: "tool_use" as const, conteudo: [usoDe(`t${i}`, "minhas_tarefas", {})] })),
      { parada: "end_turn" as const, texto: "Na 8ª volta.", conteudo: [textoDe("Na 8ª volta.")] },
    ];
    const pOk = provedorFalso(okVoltas);
    const rOk = await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "8 voltas" }]));
    expect(rOk).toMatchObject({ ok: true, texto: "Na 8ª volta." });
    expect(pOk).toHaveLength(8);

    // 8 tool_use -> 9ª necessária -> falha DEMAIS
    const pLoop = provedorFalso([{ parada: "tool_use", conteudo: [usoDe("t", "minhas_tarefas", {})] }]);
    const rLoop = await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Loop 9" }]));
    expect(rLoop).toEqual({
      ok: false,
      erro: "Não consegui terminar a resposta com as consultas permitidas. Tente uma pergunta mais específica.",
    });
    expect(pLoop).toHaveLength(8);
  });
});
