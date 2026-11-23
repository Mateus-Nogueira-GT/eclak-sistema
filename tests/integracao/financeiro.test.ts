import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { auditoria, categoriasFinanceiras, contasBancarias, lancamentos } from "@/server/db/schema";
import {
  alternarCategoria,
  baixarLancamento,
  cancelarLancamento,
  criarLancamento,
  desativarContaBancaria,
  desfazerBaixaLancamento,
  editarLancamento,
  salvarCategoria,
  salvarContaBancaria,
} from "@/server/actions/financeiro";
import { listarCategorias, listarContasBancarias } from "@/server/queries/financeiro";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };

type Contexto = { fin: string; consultor: string; categoria: string; receber: string; conta: string };
let c: Contexto;

async function preparar(): Promise<Contexto> {
  await limparBanco();
  const fin = await criarUsuarioTeste("fin_operacional");
  const consultor = await criarUsuarioTeste("consultor");
  const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, "Aluguel"));
  const [rec] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, "vendas_viagem"));
  const [conta] = await db.insert(contasBancarias).values({ nome: "Itaú", saldoInicialEm: "2026-01-01" }).returning();
  return { fin: fin.id, consultor: consultor.id, categoria: cat.id, receber: rec.id, conta: conta.id };
}

const dados = (extra: Record<string, unknown> = {}) => ({
  lado: "pagar",
  descricao: "Aluguel da sala",
  fornecedorId: "",
  clienteId: "",
  pessoaTexto: "",
  categoriaId: c.categoria,
  centro: "MT",
  competencia: "2027-01",
  emissao: "2027-01-05",
  vencimento: "2027-01-31",
  valor: "1.000,00",
  forma: "PIX",
  contaBancariaId: "",
  observacao: "",
  repeticao: { tipo: "unica" },
  ...extra,
});

const criar = async (extra: Record<string, unknown> = {}) => {
  const r = await comSessao(c.fin, () => criarLancamento(dados(extra)));
  if (!r.ok) throw new Error(r.erro);
  return (r as { ids: string[] }).ids;
};

const linhas = (grupoIds: string[]) =>
  db
    .select()
    .from(lancamentos)
    .orderBy(asc(lancamentos.parcelaNumero), asc(lancamentos.vencimento))
    .then((l) => l.filter((x) => grupoIds.includes(x.id)));

const B = () => ({ data: "2026-11-01", valorPago: "500,00", juros: "", desconto: "", observacao: "" , contaBancariaId: c.conta });

describe("financeiro: categorias, contas e lançamentos manuais", () => {
  beforeEach(async () => {
    c = await preparar();
  });

  describe("criarLancamento", () => {
    it("única com selects vazios (\"\") vale null e cria uma linha", async () => {
      const [id] = await criar();
      const [l] = await linhas([id]);
      expect(l).toMatchObject({ valor: 100000n, status: "em_aberto", grupoId: null, parcelaNumero: null, fornecedorId: null, contaBancariaId: null, forma: "pix", criadoPor: c.fin });
      expect(l.descricao).toBe("Aluguel da sala");
    });

    it("parcelado: R$ 1.000,00 em 3 a partir de 31/01/2027", async () => {
      const ids = await criar({ repeticao: { tipo: "parcelado", parcelas: 3 } });
      const ls = await linhas(ids);
      expect(ls.map((l) => l.valor)).toEqual([33333n, 33333n, 33334n]);
      expect(ls.map((l) => l.vencimento)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
      expect(ls.map((l) => [l.parcelaNumero, l.parcelaTotal])).toEqual([[1, 3], [2, 3], [3, 3]]);
      expect(new Set(ls.map((l) => l.grupoId)).size).toBe(1);
      expect(ls[0].grupoId).not.toBeNull();
      expect(new Set(ls.map((l) => l.descricao))).toEqual(new Set(["Aluguel da sala"]));
      expect(ls.map((l) => l.competencia)).toEqual(["2027-01", "2027-02", "2027-03"]);
    });

    it("recorrente mensal R$ 4.200,00 x 12: 12 linhas de 420000", async () => {
      const ids = await criar({ valor: "4.200,00", repeticao: { tipo: "recorrente", frequencia: "mensal", quantidade: 12 } });
      const ls = await linhas(ids);
      expect(ls).toHaveLength(12);
      expect(ls.every((l) => l.valor === 420000n)).toBe(true);
      expect(ls[11].vencimento).toBe("2027-12-31");
      expect(new Set(ls.map((l) => l.grupoId)).size).toBe(1);
    });

    it("recusa categoria de outro lado, inexistente ou desativada", async () => {
      const lado = await comSessao(c.fin, () => criarLancamento(dados({ categoriaId: c.receber })));
      expect(lado).toMatchObject({ ok: false, campos: { categoriaId: expect.any(String) } });
      const nao = await comSessao(c.fin, () => criarLancamento(dados({ categoriaId: crypto.randomUUID() })));
      expect(nao.ok).toBe(false);
      await db.update(categoriasFinanceiras).set({ ativa: false }).where(eq(categoriasFinanceiras.id, c.categoria));
      const off = await comSessao(c.fin, () => criarLancamento(dados()));
      expect(off).toMatchObject({ ok: false, campos: { categoriaId: expect.any(String) } });
      expect(await db.select().from(lancamentos)).toHaveLength(0);
    });

    it("audita a criação de cada linha", async () => {
      const ids = await criar({ repeticao: { tipo: "parcelado", parcelas: 2 } });
      const a = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "lancamentos"), eq(auditoria.acao, "criar")));
      expect(a.map((x) => x.registroId).sort()).toEqual([...ids].sort());
    });
  });

  describe("editarLancamento", () => {
    it("Review Focus 5: 'proximas' só mexe nas em aberto a partir da escolhida", async () => {
      const ids = await criar({ repeticao: { tipo: "recorrente", frequencia: "mensal", quantidade: 6 } });
      const ls = await linhas(ids);
      expect((await comSessao(c.fin, () => baixarLancamento(ls[2].id, B()))).ok).toBe(false); // valor 1000 ≠ 500, sem observação
      expect((await comSessao(c.fin, () => baixarLancamento(ls[2].id, { ...B(), valorPago: "1.000,00" }))).ok).toBe(true);
      expect((await comSessao(c.fin, () => cancelarLancamento(ls[4].id, "Contrato encerrado", "esta"))).ok).toBe(true);

      const r = await comSessao(c.fin, () => editarLancamento(ls[1].id, dados({ valor: "500,00", vencimento: ls[1].vencimento, competencia: ls[1].competencia }), "proximas"));
      expect(r.ok).toBe(true);
      const depois = await linhas(ids);
      expect(depois.map((l) => l.valor)).toEqual([100000n, 50000n, 100000n, 50000n, 100000n, 50000n]);
      expect(depois.map((l) => l.status)).toEqual(["em_aberto", "em_aberto", "baixado", "em_aberto", "cancelado", "em_aberto"]);
      // cada linha mantém o próprio vencimento
      expect(depois.map((l) => l.vencimento)).toEqual(ls.map((l) => l.vencimento));
    });

    it("'esta' altera só a linha; parcelado não redistribui", async () => {
      const ids = await criar({ repeticao: { tipo: "parcelado", parcelas: 3 } });
      const ls = await linhas(ids);
      await comSessao(c.fin, () => editarLancamento(ls[0].id, dados({ valor: "400,00" }), "esta"));
      expect((await linhas(ids)).map((l) => l.valor)).toEqual([40000n, 33333n, 33334n]);
    });

    it("recusa lançamento baixado ou cancelado e audita antes/depois só do alterado", async () => {
      const [a, b] = await criar({ repeticao: { tipo: "parcelado", parcelas: 2 } }).then((i) => linhas(i));
      await comSessao(c.fin, () => baixarLancamento(a.id, { ...B(), valorPago: "500,00" }));
      await comSessao(c.fin, () => cancelarLancamento(b.id, "Erro", "esta"));
      expect(await comSessao(c.fin, () => editarLancamento(a.id, dados(), "esta"))).toEqual({ ok: false, erro: "Desfaça a baixa para editar" });
      expect(await comSessao(c.fin, () => editarLancamento(b.id, dados(), "esta"))).toMatchObject({ ok: false });

      const [novo] = await criar({ descricao: "Outro" }).then((i) => linhas(i));
      await comSessao(c.fin, () => editarLancamento(novo.id, dados({ descricao: "Outro editado" }), "esta"));
      const [aud] = await db.select().from(auditoria).where(and(eq(auditoria.registroId, novo.id), eq(auditoria.acao, "alterar")));
      expect(aud.antes).toEqual({ descricao: "Outro" });
      expect(aud.depois).toEqual({ descricao: "Outro editado" });
    });
  });

  describe("baixa, desfazer e cancelamento", () => {
    it("baixa com data futura: erro de campo", async () => {
      const [id] = await criar();
      const futuro = "2999-01-01";
      const r = await comSessao(c.fin, () => baixarLancamento(id, { ...B(), data: futuro, valorPago: "1.000,00", contaBancariaId: c.conta }));
      expect(r).toMatchObject({ ok: false, campos: { data: expect.any(String) } });
      expect((await linhas([id]))[0].status).toBe("em_aberto");
    });

    it("valor diferente sem observação: pede explicação; com observação baixa", async () => {
      const [id] = await criar();
      const base = { ...B(), contaBancariaId: c.conta, valorPago: "950,00" };
      const r = await comSessao(c.fin, () => baixarLancamento(id, base));
      expect(r).toEqual({ ok: false, erro: "Explique a diferença do valor pago", campos: { observacao: "Explique a diferença do valor pago" } });
      expect((await comSessao(c.fin, () => baixarLancamento(id, { ...base, observacao: "Desconto combinado" }))).ok).toBe(true);
      const [l] = await linhas([id]);
      expect(l).toMatchObject({ status: "baixado", baixadoEm: "2026-11-01", valorPago: 95000n, baixaContaBancariaId: c.conta });
    });

    it("observação da baixa é anexada à do lançamento, sobrevive ao desfazer e vai na auditoria", async () => {
      const [id] = await criar({ observacao: "Original" });
      expect((await comSessao(c.fin, () => baixarLancamento(id, { ...B(), valorPago: "950,00", observacao: "Pago com multa" }))).ok).toBe(true);
      expect((await linhas([id]))[0].observacao).toBe("Original\nPago com multa");
      await comSessao(c.fin, () => desfazerBaixaLancamento(id));
      expect((await linhas([id]))[0].observacao).toBe("Original\nPago com multa");
      const aud = await db.select().from(auditoria).where(and(eq(auditoria.registroId, id), eq(auditoria.acao, "alterar")));
      expect(aud[0].depois).toMatchObject({ observacao: "Original\nPago com multa" });
    });

    it("juros e desconto entram na conta: 1000 + 50 - 20 = 1030 não pede observação", async () => {
      const [id] = await criar();
      const r = await comSessao(c.fin, () => baixarLancamento(id, { ...B(), contaBancariaId: c.conta, valorPago: "1.030,00", juros: "50,00", desconto: "20,00" }));
      expect(r.ok).toBe(true);
      expect(await linhas([id])).toMatchObject([{ juros: 5000n, desconto: 2000n }]);
    });

    it("recusa conta bancária inativa e baixa de lançamento já baixado", async () => {
      const [id] = await criar();
      const ok = { ...B(), contaBancariaId: c.conta, valorPago: "1.000,00" };
      await db.update(contasBancarias).set({ ativa: false }).where(eq(contasBancarias.id, c.conta));
      expect(await comSessao(c.fin, () => baixarLancamento(id, ok))).toMatchObject({ ok: false, campos: { contaBancariaId: expect.any(String) } });
      await db.update(contasBancarias).set({ ativa: true }).where(eq(contasBancarias.id, c.conta));
      expect((await comSessao(c.fin, () => baixarLancamento(id, ok))).ok).toBe(true);
      expect((await comSessao(c.fin, () => baixarLancamento(id, ok))).ok).toBe(false);
    });

    it("desfazer volta a em_aberto, zera a baixa e audita antes/depois", async () => {
      const [id] = await criar();
      await comSessao(c.fin, () => baixarLancamento(id, { ...B(), contaBancariaId: c.conta, valorPago: "1.000,00" }));
      expect((await comSessao(c.fin, () => desfazerBaixaLancamento(id))).ok).toBe(true);
      expect((await linhas([id]))[0]).toMatchObject({ status: "em_aberto", baixadoEm: null, valorPago: null, juros: null, desconto: null, baixaContaBancariaId: null });
      const aud = await db.select().from(auditoria).where(and(eq(auditoria.registroId, id), eq(auditoria.acao, "alterar")));
      const ultima = aud[aud.length - 1];
      expect(ultima.antes).toMatchObject({ status: "baixado", valorPago: "100000" });
      expect(ultima.depois).toMatchObject({ status: "em_aberto", valorPago: null });
      expect((await comSessao(c.fin, () => desfazerBaixaLancamento(id))).ok).toBe(false);
    });

    it("cancelar 'proximas' cancela só as em aberto; baixada recusa", async () => {
      const ids = await criar({ repeticao: { tipo: "parcelado", parcelas: 4 } });
      const ls = await linhas(ids);
      await comSessao(c.fin, () => baixarLancamento(ls[2].id, { ...B(), contaBancariaId: c.conta, valorPago: "250,00", observacao: "x" }));
      expect(await comSessao(c.fin, () => cancelarLancamento(ls[2].id, "x", "esta"))).toMatchObject({ ok: false });
      expect((await comSessao(c.fin, () => cancelarLancamento(ls[1].id, "Cliente saiu", "proximas"))).ok).toBe(true);
      const depois = await linhas(ids);
      expect(depois.map((l) => l.status)).toEqual(["em_aberto", "cancelado", "baixado", "cancelado"]);
      expect(depois[1].motivoCancelamento).toBe("Cliente saiu");
      expect(await comSessao(c.fin, () => cancelarLancamento(ls[0].id, "  ", "esta"))).toMatchObject({ ok: false });
    });
  });

  describe("categorias e contas bancárias", () => {
    it("cria, renomeia e alterna categoria; nome repetido no grupo é recusado", async () => {
      const r = await comSessao(c.fin, () => salvarCategoria({ lado: "pagar", grupo: "Administrativo", nome: "Marketing" }));
      expect(r.ok).toBe(true);
      const id = (r as { id: string }).id;
      expect(await comSessao(c.fin, () => salvarCategoria({ lado: "pagar", grupo: "Administrativo", nome: "Marketing" }))).toMatchObject({ ok: false, campos: { nome: expect.any(String) } });
      expect((await comSessao(c.fin, () => salvarCategoria({ lado: "pagar", grupo: "Administrativo", nome: "Marketing digital" }, id))).ok).toBe(true);
      expect((await comSessao(c.fin, () => alternarCategoria(id, false))).ok).toBe(true);
      const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.id, id));
      expect(cat).toMatchObject({ nome: "Marketing digital", ativa: false });
    });

    it("categoria do sistema: renomeia, mas não desativa nem troca de lado", async () => {
      const msg = "Categoria usada pelas viagens: não pode ser desativada";
      expect(await comSessao(c.fin, () => alternarCategoria(c.receber, false))).toEqual({ ok: false, erro: msg });
      expect(await comSessao(c.fin, () => salvarCategoria({ lado: "pagar", grupo: "Vendas", nome: "Vendas de viagem" }, c.receber))).toMatchObject({ ok: false });
      expect((await comSessao(c.fin, () => salvarCategoria({ lado: "receber", grupo: "Vendas", nome: "Vendas de viagens" }, c.receber))).ok).toBe(true);
      const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.id, c.receber));
      expect(cat).toMatchObject({ nome: "Vendas de viagens", ativa: true, lado: "receber" });
    });

    it("listarCategorias agrupa por lado e grupo", async () => {
      const g = await comSessao(c.fin, () => listarCategorias("receber"));
      expect(g.every((x) => x.lado === "receber")).toBe(true);
      expect(g.find((x) => x.grupo === "Vendas")?.categorias.map((x) => x.nome)).toContain("Vendas de viagem");
      expect((await comSessao(c.fin, () => listarCategorias())).length).toBeGreaterThan(g.length);
    });

    it("conta bancária: cria com saldo negativo, edita, desativa e filtra por ativas", async () => {
      const r = await comSessao(c.fin, () => salvarContaBancaria({ nome: "Sicredi", banco: "748", saldoInicial: "-1.234,56", saldoInicialEm: "2026-01-01" }));
      expect(r.ok).toBe(true);
      const id = (r as { id: string }).id;
      expect((await comSessao(c.fin, () => salvarContaBancaria({ nome: "Sicredi RS", banco: "", saldoInicial: "0", saldoInicialEm: "2026-01-01" }, id))).ok).toBe(true);
      expect(await comSessao(c.fin, () => salvarContaBancaria({ nome: "Itaú", banco: "", saldoInicial: "0", saldoInicialEm: "2026-01-01" }))).toMatchObject({ ok: false, campos: { nome: expect.any(String) } });
      expect((await comSessao(c.fin, () => desativarContaBancaria(id))).ok).toBe(true);
      expect((await comSessao(c.fin, () => listarContasBancarias({ ativas: true }))).map((x) => x.nome)).toEqual(["Itaú"]);
      expect(await comSessao(c.fin, () => listarContasBancarias())).toHaveLength(2);
    });
  });

  describe("permissão", () => {
    it("consultor: ações recusadas, nada gravado; queries lançam ErroAcesso", async () => {
      const [id] = await criar();
      const antes = await db.select().from(lancamentos);
      const rs = await comSessao(c.consultor, async () => [
        await criarLancamento(dados()),
        await baixarLancamento(id, { ...B(), contaBancariaId: c.conta, valorPago: "1.000,00" }),
        await salvarCategoria({ lado: "pagar", grupo: "X", nome: "Y" }),
        await alternarCategoria(c.categoria, false),
        await salvarContaBancaria({ nome: "Z", banco: "", saldoInicial: "0", saldoInicialEm: "2026-01-01" }),
        await desativarContaBancaria(c.conta),
        await editarLancamento(id, dados(), "esta"),
        await desfazerBaixaLancamento(id),
        await cancelarLancamento(id, "x", "esta"),
      ]);
      for (const r of rs) expect(r).toEqual(SEM_PERMISSAO);
      expect(await db.select().from(lancamentos)).toEqual(antes);
      expect(await db.select().from(categoriasFinanceiras)).toHaveLength(27);
      await expect(comSessao(c.consultor, () => listarCategorias())).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(c.consultor, () => listarContasBancarias())).rejects.toBeInstanceOf(ErroAcesso);
    });
  });

  it("hojeEmCuiaba é a referência da data futura", () => {
    expect(hojeEmCuiaba() < "2999-01-01").toBe(true);
  });
});
