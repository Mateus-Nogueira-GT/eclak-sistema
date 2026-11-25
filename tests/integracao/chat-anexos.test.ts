import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { TAMANHO_MAXIMO_ANEXO_CHAT } from "@/domain/chat-acoes";
import { formatarCodigoViagem } from "@/domain/viagens";
import { db } from "@/server/db/client";
import { chatAcoes, chatAnexos, clientes, integracaoEnvios, viagens } from "@/server/db/schema";
import { POST as cronIntegracoes } from "@/app/api/cron/integracoes/route";
import { conversar } from "@/server/actions/chat";
import { confirmarAcaoChat } from "@/server/actions/chat-acoes";
import { anexarNoChat, removerAnexoDoChat } from "@/server/actions/chat-anexos";
import { definirBuscarDoChatParaTestes } from "@/server/ia/ferramentas";
import { limparChat } from "@/server/ia/limpeza";
import { esquecerTokensGoogle, GOOGLE_TOKEN_URL } from "@/server/integracoes/google";
import { definirProvedorIAParaTestes, type PedidoIA, type ProvedorIA, type RespostaIA } from "@/server/integracoes/ia";
import { BUCKET_ANEXOS } from "@/server/storage";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const subidos: string[] = [];
afterAll(async () => {
  const caminhos = (await db.select({ c: chatAnexos.caminho }).from(chatAnexos)).map((x) => x.c);
  const todos = [...new Set([...subidos, ...caminhos])];
  if (todos.length > 0) await admin().storage.from(BUCKET_ANEXOS).remove(todos);
});

const PDF = new TextEncoder().encode("%PDF-1.4\nCONTEUDO-SECRETO-BINARIO-999\n%%EOF\n");

function formArquivo(bytes: Uint8Array, nome: string, tipo = "application/pdf"): FormData {
  const fd = new FormData();
  const copia = new Uint8Array(bytes.byteLength);
  copia.set(bytes);
  fd.set("arquivo", new File([copia], nome, { type: tipo }));
  return fd;
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

let f: Fixture;
let codigo: string;

beforeEach(async () => {
  await limparBanco();
  esquecerTokensGoogle();
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("TRELLO_API_KEY", "");
  vi.stubEnv("TRELLO_TOKEN", "");
  vi.stubEnv("TRELLO_LISTA_ID", "");
  vi.stubEnv("GOOGLE_SA_EMAIL", "");
  vi.stubEnv("GOOGLE_SA_CHAVE", "");
  vi.stubEnv("GOOGLE_DRIVE_PASTA_RAIZ_ID", "");
  f = await vendida();
  ligarDrive();
  const [v] = await db
    .select({ seq: viagens.seq, codigo: clientes.codigo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(viagens.id, f.viagemId));
  codigo = formatarCodigoViagem(v.codigo, v.seq);
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

afterEach(() => {
  definirProvedorIAParaTestes(null);
  definirBuscarDoChatParaTestes(null);
  esquecerTokensGoogle();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("anexarNoChat e removerAnexoDoChat", () => {
  it("PDF renomeado para .png entra como PDF; recusa .exe, > 5 MB e quarto anexo esperando", async () => {
    const rPdf = await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "disfarcado.png", "image/png")));
    expect(rPdf).toMatchObject({ ok: true, nome: "disfarcado.png", tamanho: PDF.length });
    if (!rPdf.ok) throw new Error(rPdf.erro);
    const [linha] = await db.select().from(chatAnexos).where(eq(chatAnexos.id, rPdf.id));
    subidos.push(linha.caminho);
    expect(linha.mime).toBe("application/pdf");

    expect(
      await comSessao(f.u.id, () => anexarNoChat(formArquivo(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "virus.exe", "application/octet-stream"))),
    ).toEqual({ ok: false, erro: "Envie um PDF, PNG ou JPEG" });

    const grande = new Uint8Array(TAMANHO_MAXIMO_ANEXO_CHAT + 1);
    grande.set(PDF);
    expect(await comSessao(f.u.id, () => anexarNoChat(formArquivo(grande, "grande.pdf")))).toEqual({
      ok: false,
      erro: "O arquivo passa de 5 MB",
    });

    const r2 = await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "dois.pdf")));
    const r3 = await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "tres.pdf")));
    expect(r2.ok && r3.ok).toBe(true);
    if (r2.ok) subidos.push((await db.select().from(chatAnexos).where(eq(chatAnexos.id, r2.id)))[0].caminho);
    if (r3.ok) subidos.push((await db.select().from(chatAnexos).where(eq(chatAnexos.id, r3.id)))[0].caminho);

    expect(await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "quatro.pdf")))).toEqual({
      ok: false,
      erro: "Você já tem 3 arquivos anexados esperando. Use ou remova um.",
    });

    // Remover um libera vaga.
    expect(await comSessao(f.u.id, () => removerAnexoDoChat(rPdf.id))).toEqual({ ok: true });
    const r4 = await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "quatro.pdf")));
    expect(r4.ok).toBe(true);
    if (r4.ok) subidos.push((await db.select().from(chatAnexos).where(eq(chatAnexos.id, r4.id)))[0].caminho);
  });
});

describe("conversar com anexos e drive_enviar_arquivo", () => {
  it("anexo aparece só como metadados para o modelo (sem bytes); vencido/outro usuário gera aviso", async () => {
    const rAnexo = await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "voucher.pdf")));
    if (!rAnexo.ok) throw new Error(rAnexo.erro);
    subidos.push((await db.select().from(chatAnexos).where(eq(chatAnexos.id, rAnexo.id)))[0].caminho);

    const outro = await criarUsuarioTeste("consultor");
    const rOutro = await comSessao(outro.id, () => anexarNoChat(formArquivo(PDF, "outro.pdf")));
    if (!rOutro.ok) throw new Error(rOutro.erro);
    subidos.push((await db.select().from(chatAnexos).where(eq(chatAnexos.id, rOutro.id)))[0].caminho);

    const pedidos = provedorFalso([{ parada: "end_turn", texto: "Recebi.", conteudo: [textoDe("Recebi.")] }]);
    const r = await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Guarda esse voucher" }], [rAnexo.id, rOutro.id]));
    expect(r.ok).toBe(true);

    const msgEnviada = String(pedidos[0].mensagens[0].content);
    expect(msgEnviada).toContain(`Arquivo anexado: voucher.pdf (PDF, ${PDF.length} bytes), referência ${rAnexo.id}`);
    expect(msgEnviada).toContain("um arquivo anexado venceu");
    expect(msgEnviada).not.toContain("CONTEUDO-SECRETO-BINARIO-999");
    expect(msgEnviada).not.toContain("outro.pdf");
  });

  it("drive_enviar_arquivo proposto e confirmado faz upload multipart, grava usado_em e remove do bucket; se falhar, mantém anexo", async () => {
    const rAnexo = await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "voucher.png", "image/png")));
    if (!rAnexo.ok) throw new Error(rAnexo.erro);
    const [anexoRow] = await db.select().from(chatAnexos).where(eq(chatAnexos.id, rAnexo.id));
    subidos.push(anexoRow.caminho);

    let falharUpload = true;
    const uploads: Buffer[] = [];
    const arvore: Record<string, Record<string, unknown>> = {
      raiz: { id: "raiz", name: "Raiz", mimeType: "application/vnd.google-apps.folder", parents: [] },
      "pasta-v1": { id: "pasta-v1", name: "ECL-0001_SOUZA", mimeType: "application/vnd.google-apps.folder", parents: ["raiz"] },
      "pub-1": { id: "pub-1", name: "Público", mimeType: "application/vnd.google-apps.folder", parents: ["pasta-v1"] },
    };
    const buscarDrive = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.href === GOOGLE_TOKEN_URL) return Response.json({ access_token: "tok", expires_in: 3600 });
      if (init?.method === "POST" && u.pathname === "/upload/drive/v3/files") {
        if (falharUpload) return new Response("err", { status: 500 });
        uploads.push(Buffer.from(init.body as Uint8Array));
        return Response.json({ id: "drive-file-1", webViewLink: "https://drive.google.com/file/d/drive-file-1/view" });
      }
      const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
      if (m && arvore[m[1]]) return Response.json(arvore[m[1]]);
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    definirBuscarDoChatParaTestes(buscarDrive);

    // 1) Proposta + falha de upload: anexo continua disponível no bucket e sem usado_em.
    provedorFalso([
      {
        parada: "tool_use",
        conteudo: [usoDe("u1", "drive_enviar_arquivo", { viagem: codigo, anexo: rAnexo.id, destino: "publico", nome: "" })],
      },
      { parada: "end_turn", texto: "Confirme o envio.", conteudo: [textoDe("Confirme o envio.")] },
    ]);
    const p1 = await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Guarda em Público" }], [rAnexo.id]));
    expect(p1.ok).toBe(true);
    if (!p1.ok) throw new Error(p1.erro);
    expect(p1.propostas).toHaveLength(1);
    // Extensão ajustada para .pdf (tipo pelos bytes).
    expect(p1.propostas[0].linhas).toContainEqual(["Arquivo", "voucher.pdf"]);

    const f1 = await comSessao(f.u.id, () => confirmarAcaoChat(p1.propostas[0].id));
    expect(f1.ok).toBe(false);
    expect((await db.select().from(chatAnexos).where(eq(chatAnexos.id, rAnexo.id)))[0].usadoEm).toBeNull();

    // 2) Nova proposta + sucesso no upload: multipart com os bytes certos, usado_em gravado, objeto removido do bucket.
    falharUpload = false;
    provedorFalso([
      {
        parada: "tool_use",
        conteudo: [usoDe("u2", "drive_enviar_arquivo", { viagem: codigo, anexo: rAnexo.id, destino: "publico", nome: "" })],
      },
      { parada: "end_turn", texto: "Confirme de novo.", conteudo: [textoDe("Confirme de novo.")] },
    ]);
    const p2 = await comSessao(f.u.id, () => conversar([{ de: "eu", texto: "Tenta de novo" }], [rAnexo.id]));
    if (!p2.ok) throw new Error(p2.erro);
    const ok2 = await comSessao(f.u.id, () => confirmarAcaoChat(p2.propostas[0].id));
    expect(ok2).toMatchObject({ ok: true, link: "https://drive.google.com/file/d/drive-file-1/view" });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].toString("utf8")).toContain("CONTEUDO-SECRETO-BINARIO-999");
    expect((await db.select().from(chatAnexos).where(eq(chatAnexos.id, rAnexo.id)))[0].usadoEm).not.toBeNull();
    const { data: depoisBucket } = await admin().storage.from(BUCKET_ANEXOS).download(anexoRow.caminho);
    expect(depoisBucket).toBeNull();
  });
});

describe("limparChat e cron /api/cron/integracoes", () => {
  it("marca propostas vencidas como expirada, remove anexos vencidos (bucket + banco) e sai no cron", async () => {
    const rAnexo = await comSessao(f.u.id, () => anexarNoChat(formArquivo(PDF, "velho.pdf")));
    if (!rAnexo.ok) throw new Error(rAnexo.erro);
    const [anexoRow] = await db.select().from(chatAnexos).where(eq(chatAnexos.id, rAnexo.id));
    subidos.push(anexoRow.caminho);
    await db.update(chatAnexos).set({ expiraEm: new Date(Date.now() - 60_000) }).where(eq(chatAnexos.id, rAnexo.id));

    const [acaoVencida] = await db
      .insert(chatAcoes)
      .values({
        usuarioId: f.u.id,
        tipo: "trello_criar_cartao",
        viagemId: null,
        alvo: { listaId: "l1", lista: "Op" },
        dados: { nome: "X", descricao: "" },
        expiraEm: new Date(Date.now() - 60_000),
      })
      .returning();

    expect(await limparChat()).toEqual({ expiradas: 1, anexosRemovidos: 1 });
    expect((await db.select().from(chatAcoes).where(eq(chatAcoes.id, acaoVencida.id)))[0].situacao).toBe("expirada");
    expect(await db.select().from(chatAnexos).where(eq(chatAnexos.id, rAnexo.id))).toEqual([]);
    const { data } = await admin().storage.from(BUCKET_ANEXOS).download(anexoRow.caminho);
    expect(data).toBeNull();

    // Rota do cron inclui expiradas e anexosRemovidos.
    vi.stubEnv("CRON_SECRET", "segredo");
    const req = new Request("http://localhost/api/cron/integracoes", {
      method: "POST",
      headers: { authorization: "Bearer segredo" },
    });
    const res = await cronIntegracoes(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enviados: 0, falhas: 0, expiradas: 0, anexosRemovidos: 0 });
  });
});
