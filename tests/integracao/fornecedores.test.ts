import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { db, sql } from "@/server/db/client";
import { auditoria, fornecedores } from "@/server/db/schema";
import { excluirFornecedor, salvarFornecedor } from "@/server/actions/fornecedores";
import { listarFornecedores, obterFornecedor } from "@/server/queries/fornecedores";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const venice = {
  nome: "Venice Private Transfers",
  tipos: ["Transfer" as const],
  cidade: "Veneza",
  modalidade: "net" as const,
  tarifaFixa: "R$ 1.714,00",
};

async function criar(uid: string, extra: Record<string, unknown> = {}) {
  const r = await comSessao(uid, () => salvarFornecedor({ ...venice, ...extra }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

describe("fornecedores", () => {
  beforeEach(limparBanco);

  it("consultor cria: tarifa em centavos e auditoria 'criar'", async () => {
    const c = await criarUsuarioTeste("consultor");
    const id = await criar(c.id);
    const [f] = await db.select().from(fornecedores).where(eq(fornecedores.id, id));
    expect(f.tarifaFixa).toBe(171400n);
    expect(f.comissaoPct).toBe("0.000");
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id));
    expect(aud.map((a) => [a.acao, a.tabela, a.usuarioId])).toEqual([["criar", "fornecedores", c.id]]);
  });

  it("edição audita antes e depois", async () => {
    const c = await criarUsuarioTeste("consultor");
    const id = await criar(c.id);
    const r = await comSessao(c.id, () => salvarFornecedor({ ...venice, cidade: "Florença" }, id));
    expect(r).toEqual({ ok: true, id });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(auditoria.id);
    expect(aud.map((a) => a.acao)).toEqual(["criar", "alterar"]);
    expect((aud[1].antes as { cidade: string }).cidade).toBe("Veneza");
    expect((aud[1].depois as { cidade: string }).cidade).toBe("Florença");
    expect((aud[1].depois as { tarifaFixa: string }).tarifaFixa).toBe("171400");
  });

  it("diretor exclui: some da lista, continua em obter com excluidoEm; consultor não exclui", async () => {
    const d = await criarUsuarioTeste("diretor");
    const c = await criarUsuarioTeste("consultor");
    const id = await criar(c.id);
    expect(await comSessao(c.id, () => excluirFornecedor(id))).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await comSessao(d.id, () => excluirFornecedor(id))).toEqual({ ok: true });
    expect(await comSessao(d.id, () => listarFornecedores())).toEqual([]);
    const f = await comSessao(d.id, () => obterFornecedor(id));
    expect(f?.excluidoEm).toBeInstanceOf(Date);
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(auditoria.id);
    expect(aud.map((a) => a.acao)).toEqual(["criar", "excluir"]);
  });

  it("editar fornecedor excluído ou inexistente: 'Fornecedor não encontrado'", async () => {
    const d = await criarUsuarioTeste("diretor");
    const id = await criar(d.id);
    await comSessao(d.id, () => excluirFornecedor(id));
    const r = await comSessao(d.id, () => salvarFornecedor(venice, id));
    expect(r).toEqual({ ok: false, erro: "Fornecedor não encontrado" });
    const r2 = await comSessao(d.id, () => salvarFornecedor(venice, "00000000-0000-4000-8000-000000000000"));
    expect(r2).toEqual({ ok: false, erro: "Fornecedor não encontrado" });
    expect(await comSessao(d.id, () => excluirFornecedor(id))).toEqual({ ok: false, erro: "Fornecedor não encontrado" });
  });

  it("validações com mensagens por campo", async () => {
    const c = await criarUsuarioTeste("consultor");
    const s = (x: Record<string, unknown>) => comSessao(c.id, () => salvarFornecedor({ ...venice, ...x } as never));
    expect(await s({ nome: "  " })).toMatchObject({ ok: false, erro: "Informe o nome do fornecedor", campos: { nome: "Informe o nome do fornecedor" } });
    expect(await s({ tarifaFixa: "abc" })).toMatchObject({ ok: false, erro: "Valor inválido", campos: { tarifaFixa: "Valor inválido" } });
    expect(await s({ tarifaFixa: "R$ 10.000.000.000,00" })).toMatchObject({ ok: false, campos: { tarifaFixa: "Valor inválido" } });
    expect(await s({ comissaoPct: "100,1" })).toMatchObject({ ok: false, campos: { comissaoPct: "Valor inválido" } });
    expect(await s({ tipos: [] })).toMatchObject({ ok: false, erro: "Escolha ao menos um tipo de serviço" });
    expect(await s({ contatoEmail: "nao-e-email" })).toMatchObject({ ok: false, campos: { contatoEmail: "E-mail inválido" } });
    expect(await s({ contatoEmail: "" })).toMatchObject({ ok: true });
    expect(await s({ comissaoPct: "100" })).toMatchObject({ ok: true });
    expect(await db.select().from(fornecedores)).toHaveLength(2);
  });

  it("mass assignment: campos fora da lista são recusados", async () => {
    const c = await criarUsuarioTeste("consultor");
    const r = await comSessao(c.id, () =>
      salvarFornecedor({ ...venice, id: "00000000-0000-4000-8000-000000000001", excluidoEm: new Date() } as never),
    );
    expect(r.ok).toBe(false);
    expect(await db.select().from(fornecedores)).toHaveLength(0);
  });

  it("sem sessão: salvar e excluir negam, consultas lançam", async () => {
    expect(await salvarFornecedor(venice)).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await excluirFornecedor("00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, erro: "Sem permissão" });
    await expect(listarFornecedores()).rejects.toThrow("Sem permissão");
    await expect(obterFornecedor("00000000-0000-4000-8000-000000000000")).rejects.toThrow("Sem permissão");
  });

  it("listagem: busca sem acento e sem caixa em nome e cidade; filtro por tipo; ordem por nome", async () => {
    const c = await criarUsuarioTeste("consultor");
    await criar(c.id);
    await criar(c.id, { nome: "Hotel São Paulo Palace", tipos: ["Hotelaria"], cidade: "São Paulo" });
    await criar(c.id, { nome: "Alfa Trem", tipos: ["Trem", "Transfer"], cidade: "Florença" });
    const l = (f?: { busca?: string; tipo?: "Transfer" }) => comSessao(c.id, () => listarFornecedores(f));
    expect((await l()).map((x) => x.nome)).toEqual(["Alfa Trem", "Hotel São Paulo Palace", "Venice Private Transfers"]);
    expect((await l({ busca: "sao paulo" })).map((x) => x.nome)).toEqual(["Hotel São Paulo Palace"]);
    expect((await l({ busca: "FLORENCA" })).map((x) => x.nome)).toEqual(["Alfa Trem"]);
    expect((await l({ busca: "venice" })).map((x) => x.nome)).toEqual(["Venice Private Transfers"]);
    expect((await l({ tipo: "Transfer" })).map((x) => x.nome)).toEqual(["Alfa Trem", "Venice Private Transfers"]);
    expect(await l({ busca: "100%_" })).toEqual([]);
  });

  it("RLS ligado em fornecedores", async () => {
    const [r] = await sql<{ relrowsecurity: boolean }[]>`select relrowsecurity from pg_class where relname = 'fornecedores'`;
    expect(r.relrowsecurity).toBe(true);
  });
});
