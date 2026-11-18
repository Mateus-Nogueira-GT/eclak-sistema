import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { db } from "@/server/db/client";
import { auditoria, clientes, pessoas } from "@/server/db/schema";
import { hojeEmCuiaba } from "@/domain/clientes";
import { excluirCliente, salvarCliente, type ClienteEntrada } from "@/server/actions/clientes";
import { listarClientes, obterCliente } from "@/server/queries/clientes";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const ribeiro: ClienteEntrada = {
  tipo: "familia",
  filial: "Rondonópolis",
  telefone: "(66) 9 9123-4567",
  titular: { nome: "Carlos Ribeiro", cpf: "529.982.247-25" },
  acompanhantes: [{ nome: "Lúcia Ribeiro", parentesco: "Esposa" }, { nome: "Pedro Ribeiro", parentesco: "Filho" }],
};

async function criar(uid: string, dados: ClienteEntrada = ribeiro) {
  const r = await comSessao(uid, () => salvarCliente(dados));
  if (!r.ok) throw new Error(r.erro);
  return r;
}

describe("clientes", () => {
  beforeEach(limparBanco);

  it("consultor cria família: código, grupo, telefone em dígitos, 3 pessoas, auditoria 'criar'", async () => {
    const c = await criarUsuarioTeste("consultor");
    const r = await criar(c.id);
    expect(r.codigo).toBe("ECL-0001");
    const [cli] = await db.select().from(clientes).where(eq(clientes.id, r.id));
    expect(cli.grupo).toBe("Família Ribeiro");
    expect(cli.telefone).toBe("66991234567");
    const ps = await db.select().from(pessoas).where(eq(pessoas.clienteId, r.id)).orderBy(pessoas.ordem);
    expect(ps.map((p) => [p.nome, p.titular, p.ordem, p.cpf])).toEqual([
      ["Carlos Ribeiro", true, 0, "52998224725"],
      ["Lúcia Ribeiro", false, 1, null],
      ["Pedro Ribeiro", false, 2, null],
    ]);
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, r.id));
    expect(aud.map((a) => [a.acao, a.tabela, a.usuarioId])).toEqual([["criar", "clientes", c.id]]);
    const r2 = await criar(c.id, { ...ribeiro, titular: { nome: "Ana Souza" }, acompanhantes: [] });
    expect(r2.codigo).toBe("ECL-0002");
  });

  it("CPF: duplicado em outro cliente, dentro do mesmo, excluído liberado, inválido", async () => {
    const d = await criarUsuarioTeste("diretor");
    const a = await criar(d.id);
    const s = (x: Partial<ClienteEntrada>) =>
      comSessao(d.id, () => salvarCliente({ ...ribeiro, titular: { nome: "Outro Nome" }, acompanhantes: [], ...x }));
    expect(await s({ acompanhantes: [{ nome: "Fulano", cpf: "52998224725" }] })).toEqual({
      ok: false,
      erro: "CPF já cadastrado em Família Ribeiro (Fulano)",
      campos: { acompanhantes: "CPF já cadastrado em Família Ribeiro (Fulano)", "acompanhantes.0.cpf": "CPF já cadastrado em Família Ribeiro" },
    });
    expect(await s({ titular: { nome: "Outro", cpf: "52998224725" } })).toMatchObject({
      ok: false,
      erro: "CPF já cadastrado em Família Ribeiro",
      campos: { "titular.cpf": "CPF já cadastrado em Família Ribeiro" },
    });
    expect(
      await s({
        titular: { nome: "Outro", cpf: "111.444.777-35" },
        acompanhantes: [{ nome: "X", cpf: "11144477735" }],
      }),
    ).toMatchObject({ ok: false, campos: { acompanhantes: expect.any(String) } });
    expect(await s({ titular: { nome: "Outro", cpf: "52998224724" } })).toMatchObject({
      ok: false,
      erro: "CPF inválido",
      campos: { "titular.cpf": "CPF inválido" },
    });
    expect(await s({ acompanhantes: [{ nome: "F", cpf: "52998224724" }] })).toMatchObject({
      campos: { acompanhantes: "CPF inválido (F)" },
    });
    // o próprio cliente pode manter seu CPF ao editar
    const f = (await obterCliente2(d.id, a.id))!;
    expect(await comSessao(d.id, () => salvarCliente(ribeiro, a.id, f.atualizadoEm))).toMatchObject({ ok: true });
    // excluído libera o CPF
    expect(await comSessao(d.id, () => excluirCliente(a.id))).toEqual({ ok: true });
    expect(await s({ titular: { nome: "Outro", cpf: "52998224725" } })).toMatchObject({ ok: true });
  });

  const obterCliente2 = (uid: string, id: string) => comSessao(uid, () => obterCliente(id));

  it("concorrência: atualizadoEmEsperado antigo é recusado e nada muda; sem ele também", async () => {
    const c = await criarUsuarioTeste("consultor");
    const { id } = await criar(c.id);
    const a = (await obterCliente2(c.id, id))!;
    const r = await comSessao(c.id, () => salvarCliente({ ...ribeiro, telefone: "6633334444" }, id, a.atualizadoEm));
    expect(r).toMatchObject({ ok: true, id });
    const msg = "Este cliente foi alterado por outra pessoa. Recarregue a página.";
    expect(await comSessao(c.id, () => salvarCliente({ ...ribeiro, telefone: "6655556666" }, id, a.atualizadoEm))).toEqual({
      ok: false,
      erro: msg,
      conflito: true,
    });
    expect(await comSessao(c.id, () => salvarCliente(ribeiro, id))).toEqual({ ok: false, erro: msg, conflito: true });
    expect(await comSessao(c.id, () => salvarCliente(ribeiro, id, "não é data"))).toEqual({ ok: false, erro: msg, conflito: true });
    const b = (await obterCliente2(c.id, id))!;
    expect(b.telefone).toBe("(66) 3333-4444");
    expect(b.atualizadoEm).not.toBe(a.atualizadoEm);
    expect(await comSessao(c.id, () => salvarCliente(ribeiro, id, b.atualizadoEm))).toMatchObject({ ok: true });
  });

  it("editar removendo acompanhante: 2 pessoas e auditoria com antes/depois", async () => {
    const c = await criarUsuarioTeste("consultor");
    const { id } = await criar(c.id);
    const f = (await obterCliente2(c.id, id))!;
    const r = await comSessao(c.id, () =>
      salvarCliente({ ...ribeiro, acompanhantes: [ribeiro.acompanhantes[0]] }, id, f.atualizadoEm),
    );
    expect(r).toMatchObject({ ok: true, codigo: "ECL-0001" });
    const g = (await obterCliente2(c.id, id))!;
    expect(g.pessoas.map((p) => p.nome)).toEqual(["Carlos Ribeiro", "Lúcia Ribeiro"]);
    expect(g.pessoas[0].cpf).toBe("529.982.247-25");
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(auditoria.id);
    expect(aud.map((a) => a.acao)).toEqual(["criar", "alterar"]);
    expect((aud[1].antes as { pessoas: unknown[] }).pessoas).toHaveLength(3);
    expect((aud[1].depois as { pessoas: unknown[] }).pessoas).toHaveLength(2);
  });

  it("busca: CPF, telefone, nome com acento, curingas escapados, tipo e ordem por grupo", async () => {
    const c = await criarUsuarioTeste("consultor");
    await criar(c.id);
    await criar(c.id, { ...ribeiro, tipo: "individual", titular: { nome: "Ana Souza" }, acompanhantes: [], telefone: "6633334444", email: "ana@exemplo.com" });
    const l = (f: Parameters<typeof listarClientes>[0]) => comSessao(c.id, () => listarClientes(f));
    expect((await l({ busca: "529.982" })).map((x) => x.grupo)).toEqual(["Família Ribeiro"]);
    expect((await l({ busca: "(66) 9 9123" })).map((x) => x.grupo)).toEqual(["Família Ribeiro"]);
    expect((await l({ busca: "ribeiro" })).map((x) => x.grupo)).toEqual(["Família Ribeiro"]);
    expect((await l({ busca: "LUCIA" })).map((x) => x.grupo)).toEqual(["Família Ribeiro"]);
    expect((await l({ busca: "ANA@" })).map((x) => x.grupo)).toEqual(["Ana Souza"]);
    expect(await l({ busca: "100%_" })).toEqual([]);
    expect(await l({ busca: "%" })).toEqual([]);
    expect((await l({ tipo: "individual" })).map((x) => x.grupo)).toEqual(["Ana Souza"]);
    const todos = await l({});
    expect(todos.map((x) => x.grupo)).toEqual(["Ana Souza", "Família Ribeiro"]);
    expect(todos[1]).toMatchObject({ codigo: "ECL-0001", titular: "Carlos Ribeiro", acompanhantes: 2, telefone: "(66) 9 9123-4567" });
  });

  it("aviso: aniversário (nascimento = hoje) e documentos", async () => {
    const c = await criarUsuarioTeste("consultor");
    const hoje = hojeEmCuiaba();
    const nasc = `1980-${hoje.slice(5)}`;
    await criar(c.id, {
      ...ribeiro,
      titular: { nome: "Bia Lima", nascimento: nasc, passaporte: "AB123", validadePassaporte: "2099-01-01" },
      acompanhantes: [],
    });
    await criar(c.id, { ...ribeiro, titular: { nome: "Zé Sem", cpf: "11144477735", passaporte: "X", validadePassaporte: "2099-01-01" }, acompanhantes: [] });
    const l = (aviso: "documentos" | "aniversario") => comSessao(c.id, () => listarClientes({ aviso }));
    expect((await l("aniversario")).map((x) => x.grupo)).toEqual(["Família Lima"]);
    expect(await l("documentos")).toEqual([]);
    await criar(c.id, { ...ribeiro, titular: { nome: "Sem Passaporte", cpf: "39053344705" }, acompanhantes: [] });
    expect((await l("documentos")).map((x) => x.grupo)).toEqual(["Família Passaporte"]);
  });

  it("permissões: sem sessão, consultor não exclui, diretor exclui; excluído some e não edita", async () => {
    const d = await criarUsuarioTeste("diretor");
    const c = await criarUsuarioTeste("consultor");
    expect(await salvarCliente(ribeiro)).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await excluirCliente("00000000-0000-4000-8000-000000000000")).toEqual({ ok: false, erro: "Sem permissão" });
    const { id } = await criar(c.id);
    const f = (await obterCliente2(c.id, id))!;
    expect(await comSessao(c.id, () => excluirCliente(id))).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await comSessao(d.id, () => excluirCliente(id))).toEqual({ ok: true });
    expect(await comSessao(d.id, () => listarClientes())).toEqual([]);
    expect((await obterCliente2(d.id, id))?.excluidoEm).toEqual(expect.any(String));
    expect(await comSessao(d.id, () => salvarCliente(ribeiro, id, f.atualizadoEm))).toEqual({ ok: false, erro: "Cliente não encontrado" });
    expect(await comSessao(d.id, () => excluirCliente(id))).toEqual({ ok: false, erro: "Cliente não encontrado" });
    expect(await obterCliente2(d.id, "nao-e-uuid")).toBeNull();
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(auditoria.id);
    expect(aud.map((a) => a.acao)).toEqual(["criar", "excluir"]);
  });

  it("validações com mensagens por campo", async () => {
    const c = await criarUsuarioTeste("consultor");
    const s = (x: Record<string, unknown>) => comSessao(c.id, () => salvarCliente({ ...ribeiro, ...x } as never));
    expect(await s({ titular: { nome: " " } })).toMatchObject({ ok: false, erro: "Informe o nome do titular", campos: { "titular.nome": "Informe o nome do titular" } });
    expect(await s({ telefone: "" })).toMatchObject({ erro: "Informe o telefone", campos: { telefone: "Informe o telefone" } });
    expect(await s({ telefone: "123" })).toMatchObject({ campos: { telefone: "Telefone inválido" } });
    expect(await s({ email: "abc" })).toMatchObject({ campos: { email: "E-mail inválido" } });
    expect(await s({ titular: { nome: "A", nascimento: "2026-02-30" } })).toMatchObject({ campos: { "titular.nascimento": "Data inválida" } });
    expect(await s({ titular: { nome: "A", nascimento: "2999-01-01" } })).toMatchObject({ campos: { "titular.nascimento": "Data inválida" } });
    expect(await s({ titular: { nome: "A", validadePassaporte: "31/12/2030" } })).toMatchObject({ campos: { "titular.validadePassaporte": "Data inválida" } });
    expect(await s({ id: "x" })).toMatchObject({ ok: false });
    expect(await s({ codigo: 9 })).toMatchObject({ ok: false });
    expect(await s({ acompanhantes: Array.from({ length: 61 }, (_, i) => ({ nome: `P${i}` })) })).toMatchObject({ ok: false });
    expect(await db.select().from(clientes)).toEqual([]);
  });

  it("criações simultâneas com o mesmo CPF: só uma passa", async () => {
    const c = await criarUsuarioTeste("consultor");
    const um = (n: string) => comSessao(c.id, () => salvarCliente({ ...ribeiro, titular: { nome: n, cpf: "52998224725" }, acompanhantes: [] }));
    const rs = await Promise.all([um("Ana A"), um("Bia B"), um("Cris C")]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.select().from(pessoas)).toHaveLength(1);
  });

  describe("pessoas com id estável", () => {
    const ficha = (uid: string, id: string) => comSessao(uid, () => obterCliente(id)).then((f) => f!);
    const entradaDe = (f: Awaited<ReturnType<typeof obterCliente>> & object): ClienteEntrada => {
      const pe = (p: (typeof f.pessoas)[number]) => ({
        id: p.id,
        nome: p.nome,
        parentesco: p.parentesco ?? undefined,
        nascimento: p.nascimento ?? undefined,
        cpf: p.cpf ?? undefined,
        passaporte: p.passaporte ?? undefined,
        validadePassaporte: p.validadePassaporte ?? undefined,
      });
      const tit = f.pessoas.find((p) => p.titular)!;
      return {
        tipo: f.tipo,
        filial: f.filial,
        telefone: f.telefone,
        titular: pe(tit),
        acompanhantes: f.pessoas.filter((p) => !p.titular).map(pe),
      };
    };

    it("editar só o telefone mantém os ids das pessoas", async () => {
      const c = await criarUsuarioTeste("consultor");
      const { id } = await criar(c.id);
      const f = await ficha(c.id, id);
      const r = await comSessao(c.id, () => salvarCliente({ ...entradaDe(f), telefone: "6633334444" }, id, f.atualizadoEm));
      expect(r).toMatchObject({ ok: true });
      const g = await ficha(c.id, id);
      expect(g.pessoas.map((p) => p.id)).toEqual(f.pessoas.map((p) => p.id));
      expect(g.telefone).toBe("(66) 3333-4444");
      expect(await db.select().from(pessoas)).toHaveLength(3);
      const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(auditoria.id);
      const idsDepois = (aud[1].depois as { pessoas: { id: string }[] }).pessoas.map((p) => p.id);
      expect(idsDepois).toEqual(f.pessoas.map((p) => p.id));
    });

    it("remover acompanhante é lógico: a linha fica com removido_em", async () => {
      const c = await criarUsuarioTeste("consultor");
      const { id } = await criar(c.id);
      const f = await ficha(c.id, id);
      const e = entradaDe(f);
      const pedro = e.acompanhantes[1].id!;
      const r = await comSessao(c.id, () => salvarCliente({ ...e, acompanhantes: [e.acompanhantes[0]] }, id, f.atualizadoEm));
      expect(r).toMatchObject({ ok: true });
      const [linha] = await db.select().from(pessoas).where(eq(pessoas.id, pedro));
      expect(linha.removidoEm).toBeInstanceOf(Date);
      const g = await ficha(c.id, id);
      expect(g.pessoas.map((p) => p.nome)).toEqual(["Carlos Ribeiro", "Lúcia Ribeiro"]);
      const [item] = await comSessao(c.id, () => listarClientes({ busca: "Pedro" }));
      expect(item).toBeUndefined();
      expect((await comSessao(c.id, () => listarClientes()))[0].acompanhantes).toBe(1);
      const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(auditoria.id);
      const ids = (x: unknown) => (x as { pessoas: { id: string }[] }).pessoas.map((p) => p.id);
      expect(ids(aud[1].antes)).toContain(pedro);
      expect(ids(aud[1].depois)).not.toContain(pedro);
    });

    it("acompanhante vira titular mantendo o id", async () => {
      const c = await criarUsuarioTeste("consultor");
      const { id } = await criar(c.id);
      const f = await ficha(c.id, id);
      const e = entradaDe(f);
      const [lucia, pedro] = e.acompanhantes;
      const r = await comSessao(c.id, () =>
        salvarCliente({ ...e, titular: { ...lucia, parentesco: undefined }, acompanhantes: [e.titular, pedro] }, id, f.atualizadoEm),
      );
      expect(r).toMatchObject({ ok: true });
      const g = await ficha(c.id, id);
      expect(g.pessoas.map((p) => [p.id, p.nome, p.titular])).toEqual([
        [lucia.id, "Lúcia Ribeiro", true],
        [e.titular.id, "Carlos Ribeiro", false],
        [pedro.id, "Pedro Ribeiro", false],
      ]);
    });

    it("id de pessoa de outro cliente (ou inexistente) é recusado", async () => {
      const c = await criarUsuarioTeste("consultor");
      const a = await criar(c.id);
      const b = await criar(c.id, { ...ribeiro, titular: { nome: "Ana Souza" }, acompanhantes: [] });
      const fa = await ficha(c.id, a.id);
      const fb = await ficha(c.id, b.id);
      const msg = { ok: false, erro: "Pessoa não encontrada neste cliente" };
      const alheio = { ...entradaDe(fb), acompanhantes: [{ id: fa.pessoas[1].id, nome: "Lúcia Ribeiro" }] };
      expect(await comSessao(c.id, () => salvarCliente(alheio, b.id, fb.atualizadoEm))).toEqual(msg);
      expect(await comSessao(c.id, () => salvarCliente(alheio))).toEqual(msg);
      const repetido = { ...entradaDe(fa), acompanhantes: [entradaDe(fa).acompanhantes[0], entradaDe(fa).acompanhantes[0]] };
      expect(await comSessao(c.id, () => salvarCliente(repetido, a.id, fa.atualizadoEm))).toEqual(msg);
      expect((await ficha(c.id, a.id)).pessoas).toHaveLength(3);
      expect((await ficha(c.id, b.id)).pessoas).toHaveLength(1);
    });

    it("CPF de pessoa removida pode ser usado de novo", async () => {
      const c = await criarUsuarioTeste("consultor");
      const { id } = await criar(c.id, { ...ribeiro, acompanhantes: [{ nome: "Lúcia Ribeiro", cpf: "111.444.777-35" }] });
      const f = await ficha(c.id, id);
      const e = entradaDe(f);
      expect(await comSessao(c.id, () => salvarCliente({ ...e, acompanhantes: [] }, id, f.atualizadoEm))).toMatchObject({ ok: true });
      expect(
        await comSessao(c.id, () => salvarCliente({ ...ribeiro, titular: { nome: "Lúcia Souza", cpf: "11144477735" }, acompanhantes: [] })),
      ).toMatchObject({ ok: true });
      expect((await comSessao(c.id, () => listarClientes({ busca: "111.444" }))).map((x) => x.grupo)).toEqual(["Família Souza"]);
    });
  });

  it("erros de acompanhante dizem de quem é", async () => {
    const c = await criarUsuarioTeste("consultor");
    await criar(c.id);
    const s = (acompanhantes: ClienteEntrada["acompanhantes"]) =>
      comSessao(c.id, () => salvarCliente({ ...ribeiro, titular: { nome: "Ana Souza" }, acompanhantes }));
    expect(await s([{ nome: "Lúcia Ribeiro", cpf: "52998224724" }])).toEqual({
      ok: false,
      erro: "CPF inválido (Lúcia Ribeiro)",
      campos: { acompanhantes: "CPF inválido (Lúcia Ribeiro)", "acompanhantes.0.cpf": "CPF inválido" },
    });
    expect(await s([{ nome: "Bia" }, { nome: " " }])).toMatchObject({
      erro: "Informe o nome do acompanhante (linha 2)",
      campos: { acompanhantes: "Informe o nome do acompanhante (linha 2)", "acompanhantes.1.nome": "Informe o nome do acompanhante" },
    });
    expect(await s([{ nome: "Lúcia Ribeiro", cpf: "52998224725" }])).toEqual({
      ok: false,
      erro: "CPF já cadastrado em Família Ribeiro (Lúcia Ribeiro)",
      campos: {
        acompanhantes: "CPF já cadastrado em Família Ribeiro (Lúcia Ribeiro)",
        "acompanhantes.0.cpf": "CPF já cadastrado em Família Ribeiro",
      },
    });
  });

  it("grupo informado prevalece", async () => {
    const c = await criarUsuarioTeste("consultor");
    const { id } = await criar(c.id, { ...ribeiro, grupo: "Excursão Roma" });
    expect((await obterCliente2(c.id, id))?.grupo).toBe("Excursão Roma");
  });
});
