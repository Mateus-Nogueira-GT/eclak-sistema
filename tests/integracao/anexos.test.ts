import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { TAMANHO_MAXIMO_ANEXO } from "@/domain/anexos";
import { ErroAcesso } from "@/server/auth";
import { db, sql } from "@/server/db/client";
import { anexos, auditoria, cartoesCorporativos, categoriasFinanceiras, contasBancarias, faturasCartao, lancamentos } from "@/server/db/schema";
import { enviarAnexo, linkDoAnexo, removerAnexo } from "@/server/actions/anexos";
import { listarAnexos } from "@/server/queries/anexos";
import { listarLancamentos } from "@/server/queries/financeiro";
import { BUCKET_ANEXOS } from "@/server/storage";
import { filtroDaUrl } from "@/domain/financeiro-entrada";
import { hojeEmCuiaba } from "@/domain/clientes";
import { anonClient, comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida } from "../helpers/venda";
import { createClient } from "@supabase/supabase-js";

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

// Objetos que os testes subiram: removidos do bucket local no fim (limparBanco só trunca o `public`).
const subidos: string[] = [];
afterAll(async () => {
  const caminhos = (await db.select({ c: anexos.caminho }).from(anexos)).map((x) => x.c);
  const todos = [...new Set([...subidos, ...caminhos])];
  if (todos.length > 0) await admin().storage.from(BUCKET_ANEXOS).remove(todos);
});

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

function form(donoTipo: string, donoId: string, arquivo: File | string): FormData {
  const f = new FormData();
  f.set("donoTipo", donoTipo);
  f.set("donoId", donoId);
  f.set("arquivo", arquivo);
  return f;
}

const arquivo = (bytes: Uint8Array<ArrayBuffer>, nome = "comprovante.pdf", tipo = "application/pdf") => new File([bytes], nome, { type: tipo });

type Ctx = { fin: string; consultor: string; operacional: string; manual: string };
let c: Ctx;

async function preparar(): Promise<Ctx> {
  await limparBanco();
  const fin = await criarUsuarioTeste("fin_estrategico");
  const consultor = await criarUsuarioTeste("consultor");
  const operacional = await criarUsuarioTeste("operacional");
  const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, "Aluguel"));
  const [l] = await db
    .insert(lancamentos)
    .values({
      lado: "pagar",
      descricao: "Aluguel da sala",
      categoriaId: cat.id,
      centro: "MT",
      competencia: "2027-01",
      emissao: "2027-01-05",
      vencimento: "2027-01-31",
      valor: 100000n,
      forma: "pix",
      criadoPor: fin.id,
    })
    .returning();
  return { fin: fin.id, consultor: consultor.id, operacional: operacional.id, manual: l.id };
}

async function enviar(donoTipo: string, donoId: string, a: File = arquivo(PDF)) {
  return comSessao(c.fin, () => enviarAnexo(form(donoTipo, donoId, a)));
}

describe("anexos: envio, link assinado e remoção", () => {
  beforeEach(async () => {
    c = await preparar();
  });

  it("PDF pequeno num lançamento manual: linha em anexos, objeto no bucket e auditoria", async () => {
    const r = await enviar("manual", c.manual);
    expect(r).toMatchObject({ ok: true });
    const id = (r as { id: string }).id;
    const [a] = await db.select().from(anexos).where(eq(anexos.id, id));
    subidos.push(a.caminho);
    expect(a).toMatchObject({ donoTipo: "manual", donoId: c.manual, nome: "comprovante.pdf", mime: "application/pdf", tamanho: PDF.length, enviadoPor: c.fin, excluidoEm: null });
    // Caminho sem o nome original: tipo/dono/uuid.
    expect(a.caminho).toMatch(new RegExp(`^manual/${c.manual}/[0-9a-f-]{36}$`));
    const { data, error } = await admin().storage.from(BUCKET_ANEXOS).download(a.caminho);
    expect(error).toBeNull();
    expect(new Uint8Array(await data!.arrayBuffer())).toEqual(PDF);
    const [aud] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "anexos"), eq(auditoria.registroId, id)));
    expect(aud).toMatchObject({ acao: "criar", usuarioId: c.fin });
    expect(aud.depois).toMatchObject({ donoTipo: "manual", donoId: c.manual, nome: "comprovante.pdf" });

    const lista = await comSessao(c.fin, () => listarAnexos("manual", c.manual));
    expect(lista.map((x) => x.id)).toEqual([id]);
    expect(lista[0]).toMatchObject({ nome: "comprovante.pdf", mime: "application/pdf", tamanho: PDF.length, enviadoPorNome: "Teste fin_estrategico" });
  });

  it("PNG e JPEG pelos bytes valem; o tipo gravado é o dos bytes, não o declarado", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const r1 = await enviar("manual", c.manual, arquivo(png, "foto.png", "application/octet-stream"));
    const r2 = await enviar("manual", c.manual, arquivo(jpg, "recibo.jpg", "image/jpeg"));
    expect(r1.ok && r2.ok).toBe(true);
    const linhas = await db.select().from(anexos).where(eq(anexos.donoId, c.manual));
    subidos.push(...linhas.map((x) => x.caminho));
    expect(linhas.map((x) => x.mime).sort()).toEqual(["image/jpeg", "image/png"]);
  });

  it(".txt renomeado para .pdf é recusado, nada gravado", async () => {
    const txt = new TextEncoder().encode("isto é só um texto, renomeado para parecer PDF");
    expect(await enviar("manual", c.manual, arquivo(txt, "boleto.pdf", "application/pdf"))).toEqual({ ok: false, erro: "Envie um PDF, PNG ou JPEG" });
    expect(await db.select().from(anexos)).toEqual([]);
  });

  it("arquivo vazio ou campo que não é arquivo: recusado como tipo", async () => {
    expect(await enviar("manual", c.manual, arquivo(new Uint8Array(), "vazio.pdf"))).toEqual({ ok: false, erro: "Envie um PDF, PNG ou JPEG" });
    expect(await comSessao(c.fin, () => enviarAnexo(form("manual", c.manual, "texto")))).toEqual({ ok: false, erro: "Envie um PDF, PNG ou JPEG" });
  });

  it("10 MB + 1 byte (com cabeçalho de PDF válido) é recusado", async () => {
    const grande = new Uint8Array(TAMANHO_MAXIMO_ANEXO + 1);
    grande.set(PDF);
    expect(await enviar("manual", c.manual, arquivo(grande))).toEqual({ ok: false, erro: "O arquivo passa de 10 MB" });
    expect(await db.select().from(anexos)).toEqual([]);
  });

  it("exatamente 10 MB passa", async () => {
    const limite = new Uint8Array(TAMANHO_MAXIMO_ANEXO);
    limite.set(PDF);
    const r = await enviar("manual", c.manual, arquivo(limite));
    expect(r.ok).toBe(true);
    const [a] = await db.select().from(anexos);
    subidos.push(a.caminho);
    expect(a.tamanho).toBe(TAMANHO_MAXIMO_ANEXO);
  });

  it("dono inexistente, id inválido ou tipo de dono desconhecido: Lançamento não encontrado (fatura do cartão: a mensagem dela)", async () => {
    const NAO = { ok: false, erro: "Lançamento não encontrado" };
    expect(await enviar("manual", "00000000-0000-4000-8000-000000000000")).toEqual(NAO);
    expect(await enviar("manual", "nao-e-uuid")).toEqual(NAO);
    expect(await enviar("parcela", c.manual)).toEqual(NAO);
    expect(await enviar("fatura_cartao", c.manual)).toEqual({ ok: false, erro: "Fatura do cartão não encontrada" });
    expect(await enviar("qualquer", c.manual)).toEqual(NAO);
    expect(await db.select().from(anexos)).toEqual([]);
  });

  it("anexo na fatura do cartão (linha da lista)", async () => {
    const [cb] = await db.insert(contasBancarias).values({ nome: "Itaú", saldoInicialEm: "2026-01-01" }).returning();
    const [k] = await db.insert(cartoesCorporativos).values({ nome: "Visa", final: "1234", diaFechamento: 15, diaVencimento: 25, contaBancariaId: cb.id, centro: "MT" }).returning();
    const [f] = await db.insert(faturasCartao).values({ cartaoId: k.id, fechamento: "2027-01-15", vencimento: "2027-01-25" }).returning();
    const r = await enviar("fatura_cartao", f.id);
    expect(r.ok).toBe(true);
    const [a] = await db.select().from(anexos);
    subidos.push(a.caminho);
    expect(a).toMatchObject({ donoTipo: "fatura_cartao", donoId: f.id });
  });

  it("linkDoAnexo devolve URL assinada que baixa o mesmo conteúdo", async () => {
    const r = await enviar("manual", c.manual);
    const id = (r as { id: string }).id;
    subidos.push((await db.select().from(anexos))[0].caminho);
    const l = await comSessao(c.fin, () => linkDoAnexo(id));
    expect(l.ok).toBe(true);
    const url = (l as { url: string }).url;
    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(new Uint8Array(await resp.arrayBuffer())).toEqual(PDF);
  });

  it("removido: excluido_em, auditoria, linkDoAnexo recusa e listarAnexos não mostra; o objeto fica", async () => {
    const id = ((await enviar("manual", c.manual)) as { id: string }).id;
    const [a] = await db.select().from(anexos);
    subidos.push(a.caminho);
    expect(await comSessao(c.fin, () => removerAnexo(id))).toEqual({ ok: true });
    const [depois] = await db.select().from(anexos).where(eq(anexos.id, id));
    expect(depois.excluidoEm).not.toBeNull();
    const [aud] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "anexos"), eq(auditoria.acao, "excluir")));
    expect(aud).toMatchObject({ registroId: id, usuarioId: c.fin });
    expect(await comSessao(c.fin, () => linkDoAnexo(id))).toEqual({ ok: false, erro: "Anexo não encontrado" });
    expect(await comSessao(c.fin, () => removerAnexo(id))).toEqual({ ok: false, erro: "Anexo não encontrado" });
    expect(await comSessao(c.fin, () => listarAnexos("manual", c.manual))).toEqual([]);
    const { error } = await admin().storage.from(BUCKET_ANEXOS).download(a.caminho);
    expect(error).toBeNull();
  });

  it("gravação falha depois de subir: o objeto é removido do bucket e nada fica na tabela", async () => {
    const espiao = vi.spyOn(db, "transaction").mockRejectedValueOnce(Object.assign(new Error("falha simulada"), { code: "XX000" }));
    const erroLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(enviar("manual", c.manual)).rejects.toThrow("Falha ao gravar o anexo");
    } finally {
      espiao.mockRestore();
      erroLog.mockRestore();
    }
    expect(await db.select().from(anexos)).toEqual([]);
    const { data } = await admin().storage.from(BUCKET_ANEXOS).list(`manual/${c.manual}`);
    expect(data).toEqual([]);
  });

  it("anexo inexistente ou id inválido: Anexo não encontrado", async () => {
    const NAO = { ok: false, erro: "Anexo não encontrado" };
    expect(await comSessao(c.fin, () => linkDoAnexo("00000000-0000-4000-8000-000000000000"))).toEqual(NAO);
    expect(await comSessao(c.fin, () => linkDoAnexo("x"))).toEqual(NAO);
    expect(await comSessao(c.fin, () => removerAnexo("x"))).toEqual(NAO);
  });

  it("consultor e operacional: Sem permissão em tudo, nada gravado; a query lança ErroAcesso", async () => {
    const id = ((await enviar("manual", c.manual)) as { id: string }).id;
    subidos.push((await db.select().from(anexos))[0].caminho);
    for (const u of [c.consultor, c.operacional]) {
      expect(await comSessao(u, () => enviarAnexo(form("manual", c.manual, arquivo(PDF))))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => linkDoAnexo(id))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => removerAnexo(id))).toEqual(SEM_PERMISSAO);
      await expect(comSessao(u, () => listarAnexos("manual", c.manual))).rejects.toBeInstanceOf(ErroAcesso);
    }
    const linhas = await db.select().from(anexos);
    expect(linhas).toHaveLength(1);
    expect(linhas[0].excluidoEm).toBeNull();
  });

  it("o bucket é privado e sem políticas: anon não baixa nem sobe", async () => {
    await enviar("manual", c.manual);
    const [a] = await db.select().from(anexos);
    subidos.push(a.caminho);
    const anon = anonClient();
    const baixar = await anon.storage.from(BUCKET_ANEXOS).download(a.caminho);
    expect(baixar.data).toBeNull();
    const subir = await anon.storage.from(BUCKET_ANEXOS).upload(`manual/${c.manual}/anon`, PDF, { contentType: "application/pdf" });
    expect(subir.error).not.toBeNull();
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_policies where schemaname = 'storage' and tablename = 'objects'`;
    expect(n).toBe(0);
  });
});

describe("anexos: linhas de viagem e contagem na lista", () => {
  it("parcela, pagamento e comissão aceitam anexo; a lista mostra a quantidade por linha", async () => {
    await limparBanco();
    const fx = await vendida();
    const parcela = fx.parcelas[0];
    const pagamento = fx.pagHotel;
    for (const [tipo, id] of [["parcela", parcela.id], ["parcela", parcela.id], ["pagamento", pagamento.id], ["comissao", fx.comissao.id]] as const) {
      const r = await comSessao(fx.fin.id, () => enviarAnexo(form(tipo, id, arquivo(PDF))));
      expect(r).toMatchObject({ ok: true });
    }
    subidos.push(...(await db.select({ c: anexos.caminho }).from(anexos)).map((x) => x.c));
    // Um removido não conta.
    const [p2] = await db.select().from(anexos).where(eq(anexos.donoTipo, "pagamento"));
    expect(await comSessao(fx.fin.id, () => removerAnexo(p2.id))).toEqual({ ok: true });

    const filtro = { ...filtroDaUrl({ lado: "todos" }, hojeEmCuiaba()), de: "2000-01-01", ate: "2099-12-31" };
    const lista = await comSessao(fx.fin.id, () => listarLancamentos(filtro));
    const qtd = (origem: string, id: string) => lista.linhas.find((l) => l.origem === origem && l.id === id)?.anexos;
    expect(qtd("parcela", parcela.id)).toBe(2);
    expect(qtd("pagamento", pagamento.id)).toBe(0);
    expect(qtd("comissao", fx.comissao.id)).toBe(1);
    expect(qtd("parcela", fx.parcelas[1].id)).toBe(0);
  });
});
