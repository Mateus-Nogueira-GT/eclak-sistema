import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { ErroAcesso } from "@/server/auth";
import { db, sql } from "@/server/db/client";
import {
  auditoria,
  categoriasFinanceiras,
  contasBancarias,
  contasPagar,
  fornecedores,
  lancamentos,
  lancamentosFinanceiros,
  pagamentosFornecedor,
  parcelasReceber,
  vendas,
} from "@/server/db/schema";
import {
  alternarCategoria,
  baixarLancamento,
  baixarRepasse,
  definirFornecedorCartao,
  desfazerRepasse,
  cancelarLancamento,
  criarLancamento,
  desativarContaBancaria,
  desfazerBaixaLancamento,
  editarLancamento,
  salvarCategoria,
  salvarContaBancaria,
} from "@/server/actions/financeiro";
import { baixarPagamento, baixarParcela, cancelarParcela, desfazerBaixaPagamento, desfazerBaixaParcela } from "@/server/actions/financeiro-viagem";
import { listarCategorias, listarContasBancarias, listarLancamentos } from "@/server/queries/financeiro";
import { obterViagemVendida } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { contaBancaria, vendida, type Fixture } from "../helpers/venda";

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

    it("achado 2: 'proximas' mudando só a categoria não reescreve o valor das seguintes (1.000,00 em 3)", async () => {
      const ids = await criar({ repeticao: { tipo: "parcelado", parcelas: 3 } });
      const ls = await linhas(ids);
      expect(ls.map((l) => l.valor)).toEqual([33333n, 33333n, 33334n]);
      const [outra] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, "Telefone"));
      const r = await comSessao(c.fin, () =>
        editarLancamento(ls[0].id, dados({ valor: "333,33", categoriaId: outra.id, vencimento: ls[0].vencimento, competencia: ls[0].competencia }), "proximas"),
      );
      expect(r.ok).toBe(true);
      const depois = await linhas(ids);
      expect(depois.map((l) => l.valor)).toEqual([33333n, 33333n, 33334n]);
      expect(depois.every((l) => l.categoriaId === outra.id)).toBe(true);
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

    it("achado 9: conta bancária desativada por outra transação ao mesmo tempo → a baixa espera e é recusada", async () => {
      const [id] = await criar();
      const outra = await sql.reserve();
      let aberta = true;
      try {
        await outra`begin`;
        await outra`update contas_bancarias set ativa = false where id = ${c.conta}`;
        let pronto = false;
        const baixa = comSessao(c.fin, () => baixarLancamento(id, { ...B(), valorPago: "1.000,00" })).finally(() => {
          pronto = true;
        });
        await new Promise((r) => setTimeout(r, 400));
        // Com `for share` na conta, a baixa espera a desativação terminar.
        expect(pronto).toBe(false);
        await outra`commit`;
        aberta = false;
        expect(await baixa).toMatchObject({ ok: false, erro: "Conta bancária não encontrada ou desativada" });
      } finally {
        if (aberta) await outra`rollback`;
        outra.release();
      }
      expect((await db.select().from(lancamentos).where(eq(lancamentos.id, id)))[0].status).toBe("em_aberto");
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

// ---------------------------------------------------------------------------
// Cartão direto no fornecedor (regra a): repasse
// ---------------------------------------------------------------------------

describe("repasse do cartão direto no fornecedor", () => {
  let cb = "";
  const MAIOR = "O repasse é maior que o esperado: atualize o previsto das contas do fornecedor na viagem";
  const ESTRANGEIRA = "Dê baixa no pagamento em moeda estrangeira na viagem antes do repasse";
  const USE_REPASSE = { ok: false, erro: "Use o repasse do fornecedor para esta parcela" };
  const PELO_REPASSE = { ok: false, erro: "Pagamento quitado pelo repasse: desfaça o repasse" };
  const ESCOLHA = "Escolha o fornecedor que recebeu no cartão";
  const HOJE = "2026-11-21";

  /** Centavos → "1234,56". */
  const reais = (v: bigint) => `${v / 100n},${(v % 100n).toString().padStart(2, "0")}`;

  async function cartao(fornecedor: "hotel" | "transfer" = "hotel"): Promise<Fixture> {
    const x = await vendida({ cartao: fornecedor });
    cb = await contaBancaria(x.fin.id);
    return x;
  }

  const linhaDaView = async (parcelaId: string) =>
    (await db.select().from(lancamentosFinanceiros).where(and(eq(lancamentosFinanceiros.origem, "parcela"), eq(lancamentosFinanceiros.id, parcelaId))))[0];
  const parcela = async (id: string) => (await db.select().from(parcelasReceber).where(eq(parcelasReceber.id, id)))[0];
  const pagamento = async (id: string) => (await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, id)))[0];
  const conta = async (id: string) => (await db.select().from(contasPagar).where(eq(contasPagar.id, id)))[0];
  const repasse = (x: Fixture, valor: string, extra: Record<string, unknown> = {}) =>
    comSessao(x.fin.id, () => baixarRepasse(x.parcelas[0].id, { data: HOJE, valorRepassado: valor, contaBancariaId: cb, ...extra }));
  async function margem(x: Fixture) {
    const e = (await comSessao(x.fin.id, () => obterViagemVendida(x.viagemId)))!.estrategico!;
    if ("erro" in e.real) throw new Error(e.real.erro);
    if ("erro" in e.ponte) throw new Error(e.ponte.erro);
    return { real: e.real, ponte: e.ponte };
  }
  /** Estado das linhas de dinheiro da viagem (para "nada gravado"). */
  const estado = async (x: Fixture) =>
    JSON.stringify(
      {
        p: await db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, x.viagemId)),
        c: await db.select().from(contasPagar).where(eq(contasPagar.viagemId, x.viagemId)).orderBy(asc(contasPagar.id)),
        g: await db.select().from(pagamentosFornecedor).orderBy(asc(pagamentosFornecedor.id)),
        v: await db.select().from(vendas).where(eq(vendas.viagemId, x.viagemId)),
        a: (await db.select().from(auditoria)).length,
      },
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );

  beforeEach(limparBanco);

  it("esperado da view = parcela − Σ linhas das contas ativas do fornecedor; a ficha mostra o mesmo valor", async () => {
    const x = await cartao();
    expect(x.parcelas).toHaveLength(1);
    expect(x.parcelas[0].meio).toBe("cartao_fornecedor");
    const linhasHotel = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.hotel.id));
    const esperado = x.parcelas[0].valor - linhasHotel.reduce((a, l) => a + l.valorBrlPrevisto, 0n);
    const v = await linhaDaView(x.parcelas[0].id);
    expect(v).toMatchObject({ repasse: true, valorPrevisto: esperado, descricao: "Repasse de Palazzo Hotels", exigeIndividual: false });
    const f = await comSessao(x.fin.id, () => obterViagemVendida(x.viagemId));
    expect(f!.cartaoFornecedor).toMatchObject({
      parcelaId: x.parcelas[0].id,
      fornecedorId: x.fornecedores.palazzo,
      fornecedor: "Palazzo Hotels",
      repasseEsperado: esperado,
    });
    expect(f!.cartaoFornecedor!.opcoes.map((o) => o.nome)).toEqual(["Euro Transfer", "Palazzo Hotels", "Roma Tours"]);
  });

  it("repassado = esperado: parcela recebida pelo valor, taxa efetiva 0, pagamentos do hotel pagos pelo previsto sem conta", async () => {
    const x = await cartao();
    const esperado = (await linhaDaView(x.parcelas[0].id)).valorPrevisto;
    expect(await repasse(x, reais(esperado))).toEqual({ ok: true });
    expect(await parcela(x.parcelas[0].id)).toMatchObject({
      status: "recebida",
      recebidaEm: HOJE,
      valorRecebido: x.parcelas[0].valor,
      taxaEfetiva: 0n,
      contaBancariaId: cb,
    });
    expect(await pagamento(x.pagHotel.id)).toMatchObject({
      status: "pago",
      pagoEm: HOJE,
      valorOriginalPago: x.pagHotel.valorOriginal,
      cambioEfetivo: null,
      valorBrlPago: x.pagHotel.valorBrlPrevisto,
      contaBancariaId: null,
      repasseParcelaId: x.parcelas[0].id,
    });
    expect((await conta(x.hotel.id)).status).toBe("paga");
    // os outros fornecedores não mudam
    expect((await pagamento(x.pagPasseio.id)).status).toBe("a_pagar");
    expect((await pagamento(x.pagTransfer.id)).status).toBe("a_pagar");
    // auditado na mesma transação
    const aud = await db.select().from(auditoria).where(inArray(auditoria.registroId, [x.parcelas[0].id, x.pagHotel.id, x.hotel.id]));
    expect(aud.filter((a) => a.acao === "alterar").map((a) => a.tabela).sort()).toEqual(["contas_pagar", "pagamentos_fornecedor", "parcelas_receber"]);
    // a view continua mostrando o mesmo esperado (o pago é o previsto)
    expect((await linhaDaView(x.parcelas[0].id)).valorPrevisto).toBe(esperado);
  });

  it("repassado = esperado − 100,00: taxa efetiva 10000n; a margem real cai a taxa; desfazer volta à margem de antes", async () => {
    const x = await cartao();
    const r0 = await margem(x);
    const esperado = (await linhaDaView(x.parcelas[0].id)).valorPrevisto;
    expect(await repasse(x, reais(esperado))).toEqual({ ok: true });
    const r1 = await margem(x);
    expect(await comSessao(x.fin.id, () => desfazerRepasse(x.parcelas[0].id))).toEqual({ ok: true });
    expect(await margem(x)).toEqual(r0);

    expect(await repasse(x, reais(esperado - 10000n))).toEqual({ ok: true });
    expect((await parcela(x.parcelas[0].id)).taxaEfetiva).toBe(10000n);
    const r2 = await margem(x);
    // Mesmo custo e receita do repasse cheio (o cliente pagou tudo; o fornecedor recebeu o previsto): só a taxa muda.
    // `margemReal` soma a taxa efetiva sem proporção (a proporção preço ÷ total vale para o recebido a menos).
    const pTaxa = x.parcelas[0].taxaPrevista;
    expect(r2.real.receita).toBe(r1.real.receita);
    expect(r2.real.custo).toBe(r1.real.custo);
    expect(r2.real.imposto).toBe(r1.real.imposto);
    expect(r1.real.taxas).toBe(r0.real.taxas - pTaxa);
    expect(r2.real.taxas).toBe(r1.real.taxas + 10000n);
    expect(r2.real.final).toBe(r1.real.final - 10000n);
    const taxa = (r: typeof r1) => r.ponte.find((l) => l.rotulo === "Taxas financeiras")?.valor ?? 0n;
    expect(taxa(r2)).toBe(taxa(r1) - 10000n);

    expect(await comSessao(x.fin.id, () => desfazerRepasse(x.parcelas[0].id))).toEqual({ ok: true });
    expect(await margem(x)).toEqual(r0);
    expect(await parcela(x.parcelas[0].id)).toMatchObject({ status: "a_receber", recebidaEm: null, valorRecebido: null, taxaEfetiva: null, contaBancariaId: null });
    expect(await pagamento(x.pagHotel.id)).toMatchObject({
      status: "a_pagar",
      pagoEm: null,
      valorOriginalPago: null,
      valorBrlPago: null,
      contaBancariaId: null,
      repasseParcelaId: null,
    });
    expect((await conta(x.hotel.id)).status).toBe("a_pagar");
    expect(await comSessao(x.fin.id, () => desfazerRepasse(x.parcelas[0].id))).toEqual({ ok: false, erro: "Esta parcela não foi baixada" });
  });

  it("repassado maior que o esperado e conta bancária ausente: recusados, nada gravado", async () => {
    const x = await cartao();
    const esperado = (await linhaDaView(x.parcelas[0].id)).valorPrevisto;
    const ativa = cb;
    cb = await contaBancaria(x.fin.id, "Desativada");
    expect(await comSessao(x.fin.id, () => desativarContaBancaria(cb))).toMatchObject({ ok: true });
    const antes = await estado(x);
    expect(await repasse(x, reais(esperado + 1n))).toEqual({ ok: false, erro: MAIOR, campos: { valorRepassado: MAIOR } });
    expect(await repasse(x, reais(esperado), { contaBancariaId: "" })).toMatchObject({ ok: false, erro: "Escolha a conta bancária" });
    expect(await repasse(x, reais(esperado))).toEqual({ ok: false, erro: "Escolha a conta bancária", campos: { contaBancariaId: "Escolha a conta bancária" } });
    expect(await estado(x)).toBe(antes);
    cb = ativa;
    expect(await repasse(x, reais(esperado))).toEqual({ ok: true });
  });

  it("pagamento em EUR do fornecedor do cartão em aberto: recusado; baixado na viagem, o repasse quita o resto", async () => {
    const x = await cartao("transfer");
    const antes = await estado(x);
    expect(await repasse(x, "0,00")).toEqual({ ok: false, erro: ESTRANGEIRA });
    expect(await estado(x)).toBe(antes);
    expect(
      await comSessao(x.fin.id, () =>
        baixarPagamento(x.pagTransfer.id, { pagoEm: HOJE, valorOriginalPago: reais(x.pagTransfer.valorOriginal), cambioEfetivo: "6,5000", contaBancariaId: cb }),
      ),
    ).toEqual({ ok: true });
    const pago = await pagamento(x.pagTransfer.id);
    const v = await linhaDaView(x.parcelas[0].id);
    expect(v.valorPrevisto).toBe(x.parcelas[0].valor - pago.valorBrlPago!);
    expect(await repasse(x, reais(v.valorPrevisto))).toEqual({ ok: true });
    // o pagamento em EUR fica com a própria baixa (não é do repasse)
    expect(await pagamento(x.pagTransfer.id)).toMatchObject({ status: "pago", contaBancariaId: cb, repasseParcelaId: null });
    expect(await comSessao(x.fin.id, () => desfazerRepasse(x.parcelas[0].id))).toEqual({ ok: true });
    expect((await pagamento(x.pagTransfer.id)).status).toBe("pago");
  });

  it("caminho direto bloqueado: parcela de cartão direto e pagamento quitado pelo repasse", async () => {
    const x = await cartao();
    const p = x.parcelas[0];
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, { recebidaEm: HOJE, valorRecebido: reais(p.valor), contaBancariaId: cb }))).toEqual(USE_REPASSE);
    expect(await comSessao(x.fin.id, () => desfazerBaixaParcela(p.id))).toEqual(USE_REPASSE);
    const esperado = (await linhaDaView(p.id)).valorPrevisto;
    expect(await repasse(x, reais(esperado))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => desfazerBaixaParcela(p.id))).toEqual(USE_REPASSE);
    expect(await comSessao(x.fin.id, () => desfazerBaixaPagamento(x.pagHotel.id))).toEqual(PELO_REPASSE);
    expect(
      await comSessao(x.fin.id, () => baixarPagamento(x.pagHotel.id, { pagoEm: HOJE, valorOriginalPago: "1,00", contaBancariaId: cb })),
    ).toEqual(PELO_REPASSE);
    expect(await repasse(x, reais(esperado))).toEqual({ ok: false, erro: "Parcela já recebida" });
    // repasse em parcela que não é de cartão direto
    const y = await vendida();
    expect(await comSessao(y.fin.id, () => baixarRepasse(y.parcelas[0].id, { data: HOJE, valorRepassado: "1,00", contaBancariaId: cb }))).toEqual({
      ok: false,
      erro: "Esta parcela não é de cartão direto no fornecedor",
    });
  });

  it("definirFornecedorCartao: venda antiga sem fornecedor; exige conta ativa na viagem; recusado depois do repasse", async () => {
    const x = await cartao();
    await db.update(vendas).set({ fornecedorCartaoId: null }).where(eq(vendas.viagemId, x.viagemId));
    expect(await linhaDaView(x.parcelas[0].id)).toMatchObject({ exigeIndividual: true, descricao: "Repasse: escolha o fornecedor na viagem" });
    expect((await comSessao(x.fin.id, () => obterViagemVendida(x.viagemId)))!.cartaoFornecedor).toMatchObject({ fornecedorId: null, repasseEsperado: null });
    expect(await repasse(x, "1,00")).toEqual({ ok: false, erro: ESCOLHA, campos: { fornecedorCartaoId: ESCOLHA } });

    const outro = (await db.insert(fornecedores).values({ nome: "Sem conta", tipos: ["Hotelaria"], modalidade: "net" }).returning())[0].id;
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, outro))).toEqual({ ok: false, erro: ESCOLHA, campos: { fornecedorCartaoId: ESCOLHA } });
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, "x"))).toEqual({ ok: false, erro: ESCOLHA, campos: { fornecedorCartaoId: ESCOLHA } });
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, x.fornecedores.roma))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, x.fornecedores.palazzo))).toEqual({ ok: true });
    const [venda] = await db.select().from(vendas).where(eq(vendas.viagemId, x.viagemId));
    expect(venda.fornecedorCartaoId).toBe(x.fornecedores.palazzo);
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "vendas"), eq(auditoria.registroId, venda.id), eq(auditoria.acao, "alterar")));
    expect(aud).toHaveLength(2);
    expect(aud.map((a) => (a.depois as Record<string, unknown>).fornecedorCartaoId).sort()).toEqual([x.fornecedores.palazzo, x.fornecedores.roma].sort());

    const esperado = (await linhaDaView(x.parcelas[0].id)).valorPrevisto;
    expect(await repasse(x, reais(esperado))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, x.fornecedores.roma))).toEqual({ ok: false, erro: "Desfaça o repasse para trocar o fornecedor" });

    // venda em boleto: não há fornecedor do cartão
    const y = await vendida();
    expect(await comSessao(y.fin.id, () => definirFornecedorCartao(y.viagemId, y.fornecedores.palazzo))).toEqual({
      ok: false,
      erro: "Esta parcela não é de cartão direto no fornecedor",
    });
  });

  it("achado 1: repasse a menos → a linha e o card Recebidos mostram o valor repassado (o que entrou no banco)", async () => {
    const x = await cartao();
    const esperado = (await linhaDaView(x.parcelas[0].id)).valorPrevisto;
    expect(await repasse(x, reais(esperado - 10000n))).toEqual({ ok: true });
    expect(await linhaDaView(x.parcelas[0].id)).toMatchObject({ statusBase: "baixado", valorPrevisto: esperado, valorBaixado: esperado - 10000n, taxa: 10000n });
    const lista = await comSessao(x.fin.id, () => listarLancamentos({ lado: "todos", de: "2000-01-01", ate: "2099-12-31", base: "vencimento", pagina: 1 }));
    expect(lista.linhas.find((l) => l.origem === "parcela")).toMatchObject({ valorBaixado: esperado - 10000n, situacao: "baixada" });
    expect(lista.totais.receber.baixados).toBe(esperado - 10000n);
    // parcela comum recebida continua pelo valor recebido
    const y = await vendida();
    const q = y.parcelas[0];
    expect(await comSessao(y.fin.id, () => baixarParcela(q.id, { recebidaEm: HOJE, valorRecebido: reais(q.valor), contaBancariaId: cb }))).toEqual({ ok: true });
    expect((await linhaDaView(q.id)).valorBaixado).toBe(q.valor);
  });

  it("achado 4: parcela de cartão direto cancelada → a view e a baixa (pagoNoCartao) concordam: o fornecedor volta ao caixa", async () => {
    const x = await cartao();
    const pagamentoNaView = async () =>
      (await db.select().from(lancamentosFinanceiros).where(and(eq(lancamentosFinanceiros.origem, "pagamento"), eq(lancamentosFinanceiros.id, x.pagHotel.id))))[0];
    const baixa = () => comSessao(x.fin.id, () => baixarPagamento(x.pagHotel.id, { pagoEm: HOJE, valorOriginalPago: reais(x.pagHotel.valorOriginal), contaBancariaId: cb }));
    // Ativa: fora do caixa na view e baixa direta recusada (as duas regras dizem "pago no cartão").
    expect((await pagamentoNaView()).transitaCaixa).toBe(false);
    expect(await baixa()).toEqual({ ok: false, erro: "Pago pelo cliente no cartão do fornecedor: use o repasse" });
    // Cancelada: as duas regras dizem "não foi pago no cartão".
    expect(await comSessao(x.fin.id, () => cancelarParcela(x.parcelas[0].id, "Cliente pagou à parte"))).toEqual({ ok: true });
    expect((await pagamentoNaView()).transitaCaixa).toBe(true);
    expect(await linhaDaView(x.parcelas[0].id)).toMatchObject({ repasse: false, statusBase: "cancelado", valorPrevisto: x.parcelas[0].valor });
    expect(await baixa()).toEqual({ ok: true });
  });

  it("achado 8: venda antiga sem fornecedor do cartão → baixa de pagamento recusada até escolher", async () => {
    const x = await cartao();
    await db.update(vendas).set({ fornecedorCartaoId: null }).where(eq(vendas.viagemId, x.viagemId));
    const ANTES = "Escolha o fornecedor que recebeu no cartão antes de dar baixa";
    const antes = await estado(x);
    for (const pg of [x.pagPasseio, x.pagHotel, x.pagAereo]) {
      expect(await comSessao(x.fin.id, () => baixarPagamento(pg.id, { pagoEm: HOJE, valorOriginalPago: reais(pg.valorOriginal), contaBancariaId: cb }))).toEqual({ ok: false, erro: ANTES });
    }
    // em moeda estrangeira também (a regra vale para qualquer pagamento da viagem)
    expect(
      await comSessao(x.fin.id, () => baixarPagamento(x.pagTransfer.id, { pagoEm: HOJE, valorOriginalPago: reais(x.pagTransfer.valorOriginal), cambioEfetivo: "6,5000", contaBancariaId: cb })),
    ).toEqual({ ok: false, erro: ANTES });
    expect(await estado(x)).toBe(antes);
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, x.fornecedores.palazzo))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagPasseio.id, { pagoEm: HOJE, valorOriginalPago: reais(x.pagPasseio.valorOriginal), contaBancariaId: cb }))).toEqual({ ok: true });
    // parcela cancelada: a venda deixa de ser cartão direto e a baixa segue sem fornecedor
    const y = await vendida({ cartao: "hotel" });
    await db.update(vendas).set({ fornecedorCartaoId: null }).where(eq(vendas.viagemId, y.viagemId));
    expect(await comSessao(y.fin.id, () => cancelarParcela(y.parcelas[0].id, "Cliente desistiu do cartão"))).toEqual({ ok: true });
    expect(await comSessao(y.fin.id, () => baixarPagamento(y.pagPasseio.id, { pagoEm: HOJE, valorOriginalPago: reais(y.pagPasseio.valorOriginal), contaBancariaId: cb }))).toEqual({ ok: true });
  });

  it("achado 8: definirFornecedorCartao recusa fornecedor com pagamento em reais já pago com conta bancária", async () => {
    const x = await cartao();
    const JA_PAGO = "Este fornecedor já tem pagamento feito pela ECLAK: desfaça a baixa antes";
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagPasseio.id, { pagoEm: HOJE, valorOriginalPago: reais(x.pagPasseio.valorOriginal), contaBancariaId: cb }))).toEqual({ ok: true });
    const antes = await estado(x);
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, x.fornecedores.roma))).toEqual({ ok: false, erro: JA_PAGO, campos: { fornecedorCartaoId: JA_PAGO } });
    expect(await estado(x)).toBe(antes);
    expect(await comSessao(x.fin.id, () => desfazerBaixaPagamento(x.pagPasseio.id))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => definirFornecedorCartao(x.viagemId, x.fornecedores.roma))).toEqual({ ok: true });
  });

  it("perfis: consultor e operacional não fazem repasse nem escolhem o fornecedor", async () => {
    const x = await cartao();
    const op = await criarUsuarioTeste("operacional");
    const antes = await estado(x);
    for (const uid of [x.u.id, op.id]) {
      expect(await comSessao(uid, () => baixarRepasse(x.parcelas[0].id, { data: HOJE, valorRepassado: "1,00", contaBancariaId: cb }))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(uid, () => desfazerRepasse(x.parcelas[0].id))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(uid, () => definirFornecedorCartao(x.viagemId, x.fornecedores.roma))).toEqual(SEM_PERMISSAO);
    }
    expect(await estado(x)).toBe(antes);
  });
});
