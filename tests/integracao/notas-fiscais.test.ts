import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { anexos, auditoria, fornecedores, notasFiscais } from "@/server/db/schema";
import { cancelarNotaFiscal, criarNotaFiscal, editarNotaFiscal } from "@/server/actions/notas-fiscais";
import { enviarAnexo } from "@/server/actions/anexos";
import { listarAnexos } from "@/server/queries/anexos";
import { listarNotasFiscais, obterNotaFiscal } from "@/server/queries/notas-fiscais";
import { BUCKET_ANEXOS } from "@/server/storage";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { createClient } from "@supabase/supabase-js";

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };
const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");

afterAll(async () => {
  const caminhos = (await db.select({ c: anexos.caminho }).from(anexos)).map((x) => x.c);
  if (caminhos.length > 0) {
    await createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
      .storage.from(BUCKET_ANEXOS)
      .remove(caminhos);
  }
});

const nota = (extra: Record<string, unknown> = {}) => ({
  numero: "0412",
  emitidaEm: "2026-11-03",
  competencia: "2026-11",
  valor: "12.723,38",
  destinatario: "Marina Souza",
  documento: "529.982.247-25",
  fornecedorId: "",
  clienteId: "",
  viagemId: "",
  observacao: "",
  ...extra,
});

const periodoTodo = { de: "2026-01-01", ate: "2026-12-31", pagina: 1 };

let fin: string;
let diretor: string;
let consultor: string;
let operacional: string;

async function criar(extra: Record<string, unknown> = {}, como = fin) {
  return comSessao(como, () => criarNotaFiscal(nota(extra)));
}

describe("notas fiscais", () => {
  beforeEach(async () => {
    await limparBanco();
    fin = (await criarUsuarioTeste("fin_estrategico")).id;
    diretor = (await criarUsuarioTeste("diretor")).id;
    consultor = (await criarUsuarioTeste("consultor")).id;
    operacional = (await criarUsuarioTeste("operacional")).id;
  });

  it("cria, grava em centavos e audita; aparece na lista e em obterNotaFiscal", async () => {
    const r = await criar();
    expect(r).toMatchObject({ ok: true });
    const id = (r as { id: string }).id;
    const [n] = await db.select().from(notasFiscais).where(eq(notasFiscais.id, id));
    expect(n).toMatchObject({
      numero: "0412",
      emitidaEm: "2026-11-03",
      competencia: "2026-11",
      valor: 1272338n,
      destinatario: "Marina Souza",
      documento: "52998224725",
      status: "emitida",
      motivoCancelamento: null,
      criadoPor: fin,
    });
    const [aud] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "notas_fiscais"), eq(auditoria.registroId, id)));
    expect(aud).toMatchObject({ acao: "criar", usuarioId: fin });
    expect(aud.depois).toMatchObject({ numero: "0412", valor: "1272338" });
    const o = await comSessao(diretor, () => obterNotaFiscal(id));
    expect(o).toMatchObject({ id, numero: "0412", valor: 1272338n, status: "emitida" });
    expect(await comSessao(fin, () => obterNotaFiscal("00000000-0000-4000-8000-000000000000"))).toBeNull();
  });

  it("valida pelos campos (CPF inválido, valor zero) sem gravar", async () => {
    const r = await criar({ documento: "111.111.111-11", valor: "0" });
    expect(r).toMatchObject({ ok: false, campos: { documento: "CPF ou CNPJ inválido", valor: "Informe um valor maior que zero" } });
    expect(await db.select().from(notasFiscais)).toEqual([]);
  });

  it("número repetido: 'Já existe uma nota com este número' no campo número", async () => {
    expect(await criar()).toMatchObject({ ok: true });
    expect(await criar({ destinatario: "Outra" })).toEqual({ ok: false, erro: "Já existe uma nota com este número", campos: { numero: "Já existe uma nota com este número" } });
    expect(await db.select().from(notasFiscais)).toHaveLength(1);
  });

  it("lista por período (pela data de emissão) e por destinatário sem acento e parcial", async () => {
    await criar({ numero: "1", emitidaEm: "2026-11-03", destinatario: "José Antônio Pereira" });
    await criar({ numero: "2", emitidaEm: "2026-10-28", destinatario: "Empresa Exemplo Ltda." });
    await criar({ numero: "3", emitidaEm: "2026-11-30", competencia: "2026-11", destinatario: "Família Andrade", valor: "100,00" });
    const lista = (f: object) => comSessao(fin, () => listarNotasFiscais({ pagina: 1, de: "2026-01-01", ate: "2026-12-31", ...f }));

    const novembro = await lista({ de: "2026-11-01", ate: "2026-11-30" });
    expect(novembro.linhas.map((l) => l.numero)).toEqual(["3", "1"]); // mais recente primeiro
    expect(novembro.totalLinhas).toBe(2);
    expect(novembro.total).toBe(1272338n + 10000n);

    expect((await lista({ destinatario: "jose antonio" })).linhas.map((l) => l.numero)).toEqual(["1"]);
    expect((await lista({ destinatario: "FAMILIA" })).linhas.map((l) => l.numero)).toEqual(["3"]);
    expect((await lista({ destinatario: "exemplo" })).linhas.map((l) => l.numero)).toEqual(["2"]);
    expect((await lista({ destinatario: "inexistente" })).linhas).toEqual([]);
    // O período inclui as duas pontas.
    expect((await lista({ de: "2026-11-03", ate: "2026-11-03" })).linhas.map((l) => l.numero)).toEqual(["1"]);
    // % e _ na busca são literais.
    expect((await lista({ destinatario: "%" })).linhas).toEqual([]);
  });

  it("pagina de 50 em 50", async () => {
    for (let i = 1; i <= 52; i++) await criar({ numero: String(1000 + i), valor: "1,00" });
    const p1 = await comSessao(fin, () => listarNotasFiscais({ ...periodoTodo, pagina: 1 }));
    const p2 = await comSessao(fin, () => listarNotasFiscais({ ...periodoTodo, pagina: 2 }));
    expect([p1.linhas.length, p2.linhas.length, p1.totalLinhas]).toEqual([50, 2, 52]);
    expect(p1.total).toBe(5200n);
  });

  it("cancelar exige motivo; a nota fica na lista marcada, fora do total, e libera o número", async () => {
    const id = ((await criar()) as { id: string }).id;
    const sem = await comSessao(fin, () => cancelarNotaFiscal(id, "  "));
    expect(sem).toMatchObject({ ok: false, erro: "Escreva o motivo do cancelamento" });
    expect((await db.select().from(notasFiscais))[0].status).toBe("emitida");

    expect(await comSessao(fin, () => cancelarNotaFiscal(id, "Emitida em duplicidade"))).toEqual({ ok: true });
    const [n] = await db.select().from(notasFiscais).where(eq(notasFiscais.id, id));
    expect(n).toMatchObject({ status: "cancelada", motivoCancelamento: "Emitida em duplicidade" });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "notas_fiscais"), eq(auditoria.registroId, id), eq(auditoria.acao, "alterar")));
    expect(aud).toHaveLength(1);
    expect(aud[0].antes).toMatchObject({ status: "emitida" });
    expect(aud[0].depois).toMatchObject({ status: "cancelada", motivoCancelamento: "Emitida em duplicidade" });

    const l = await comSessao(fin, () => listarNotasFiscais(periodoTodo));
    expect(l.linhas).toHaveLength(1);
    expect(l.linhas[0]).toMatchObject({ id, status: "cancelada", motivoCancelamento: "Emitida em duplicidade" });
    expect(l.total).toBe(0n);

    // O número volta a poder ser usado; duas canceladas com o mesmo número convivem.
    const novo = await criar({ destinatario: "Reemissão" });
    expect(novo).toMatchObject({ ok: true });
    expect(await comSessao(fin, () => cancelarNotaFiscal((novo as { id: string }).id, "Erro de valor"))).toEqual({ ok: true });
    expect(await criar({ destinatario: "Terceira" })).toMatchObject({ ok: true });
    // Cancelar de novo e nota inexistente.
    expect(await comSessao(fin, () => cancelarNotaFiscal(id, "Outra vez"))).toEqual({ ok: false, erro: "Nota já cancelada" });
    expect(await comSessao(fin, () => cancelarNotaFiscal("00000000-0000-4000-8000-000000000000", "x"))).toEqual({ ok: false, erro: "Nota fiscal não encontrada" });
  });

  it("edita uma nota emitida (auditoria só com o que mudou); número repetido na edição é recusado; cancelada não edita", async () => {
    const a = ((await criar()) as { id: string }).id;
    const b = ((await criar({ numero: "0413" })) as { id: string }).id;
    expect(await comSessao(fin, () => editarNotaFiscal(a, nota({ valor: "100,00", destinatario: "Marina S." })))).toEqual({ ok: true, id: a });
    const [n] = await db.select().from(notasFiscais).where(eq(notasFiscais.id, a));
    expect(n).toMatchObject({ valor: 10000n, destinatario: "Marina S.", numero: "0412" });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.registroId, a), eq(auditoria.acao, "alterar")));
    expect(aud).toHaveLength(1);
    expect(aud[0].antes).toEqual({ valor: "1272338", destinatario: "Marina Souza" });
    expect(aud[0].depois).toEqual({ valor: "10000", destinatario: "Marina S." });

    expect(await comSessao(fin, () => editarNotaFiscal(b, nota({ numero: "0412" })))).toMatchObject({ ok: false, erro: "Já existe uma nota com este número" });
    // Salvar sem mudar o número da própria nota não conflita consigo.
    expect(await comSessao(fin, () => editarNotaFiscal(b, nota({ numero: "0413", observacao: "ok" })))).toEqual({ ok: true, id: b });

    await comSessao(fin, () => cancelarNotaFiscal(b, "Erro"));
    expect(await comSessao(fin, () => editarNotaFiscal(b, nota({ numero: "0413" })))).toEqual({ ok: false, erro: "Nota cancelada não pode ser editada" });
    expect(await comSessao(fin, () => editarNotaFiscal("00000000-0000-4000-8000-000000000000", nota()))).toEqual({ ok: false, erro: "Nota fiscal não encontrada" });
  });

  it("fornecedor inexistente ou viagem inexistente: recusado no campo", async () => {
    const x = "00000000-0000-4000-8000-000000000000";
    expect(await criar({ fornecedorId: x })).toMatchObject({ ok: false, campos: { fornecedorId: "Fornecedor não encontrado" } });
    expect(await criar({ clienteId: x })).toMatchObject({ ok: false, campos: { clienteId: "Cliente não encontrado" } });
    expect(await criar({ viagemId: x })).toMatchObject({ ok: false, campos: { viagemId: "Viagem não encontrada" } });
    expect(await db.select().from(notasFiscais)).toEqual([]);
  });

  it("liga a um fornecedor existente", async () => {
    const [f] = await db.insert(fornecedores).values({ nome: "Hotel Exemplo", tipos: ["Hotelaria"], modalidade: "net" }).returning();
    const r = await criar({ fornecedorId: f.id, destinatario: "Hotel Exemplo (comissão)" });
    expect(r).toMatchObject({ ok: true });
    const o = await comSessao(fin, () => obterNotaFiscal((r as { id: string }).id));
    expect(o?.fornecedorId).toBe(f.id);
  });

  it("anexa o PDF da nota; nota inexistente: 'Nota fiscal não encontrada'", async () => {
    const id = ((await criar()) as { id: string }).id;
    const f = new FormData();
    f.set("donoTipo", "nota_fiscal");
    f.set("donoId", id);
    f.set("arquivo", new File([PDF], "NF_0412.pdf", { type: "application/pdf" }));
    const r = await comSessao(fin, () => enviarAnexo(f));
    expect(r).toMatchObject({ ok: true });
    const lista = await comSessao(fin, () => listarAnexos("nota_fiscal", id));
    expect(lista.map((a) => a.nome)).toEqual(["NF_0412.pdf"]);
    const l = await comSessao(fin, () => listarNotasFiscais(periodoTodo));
    expect(l.linhas[0].anexos).toBe(1);

    const g = new FormData();
    g.set("donoTipo", "nota_fiscal");
    g.set("donoId", "00000000-0000-4000-8000-000000000000");
    g.set("arquivo", new File([PDF], "x.pdf", { type: "application/pdf" }));
    expect(await comSessao(fin, () => enviarAnexo(g))).toEqual({ ok: false, erro: "Nota fiscal não encontrada" });
  });

  it("Consultor e Operacional: sem permissão em tudo; Diretor e financeiro passam", async () => {
    const id = ((await criar()) as { id: string }).id;
    for (const u of [consultor, operacional]) {
      expect(await criar({ numero: "9" }, u)).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => editarNotaFiscal(id, nota()))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => cancelarNotaFiscal(id, "x"))).toEqual(SEM_PERMISSAO);
      await expect(comSessao(u, () => listarNotasFiscais(periodoTodo))).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(u, () => obterNotaFiscal(id))).rejects.toBeInstanceOf(ErroAcesso);
    }
    expect(await criar({ numero: "10" }, diretor)).toMatchObject({ ok: true });
    expect((await comSessao(diretor, () => listarNotasFiscais(periodoTodo))).totalLinhas).toBe(2);
  });

  it("o banco recusa o que a action não deixaria passar (CHECKs)", async () => {
    const base = { numero: "x", emitidaEm: "2026-01-01", competencia: "2026-01", valor: 100n, destinatario: "A", criadoPor: fin };
    await expect(db.insert(notasFiscais).values({ ...base, valor: 0n })).rejects.toThrow();
    await expect(db.insert(notasFiscais).values({ ...base, documento: "123" })).rejects.toThrow();
    await expect(db.insert(notasFiscais).values({ ...base, status: "cancelada" })).rejects.toThrow();
  });
});
