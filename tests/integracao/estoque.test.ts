import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { criarCartao } from "@/server/actions/cartoes";
import {
  ajustarEstoque,
  desativarProduto,
  desfazerEntradaDeEstoque,
  registrarEntrada,
  registrarSaida,
  salvarProduto,
} from "@/server/actions/estoque";
import { baixarLinha } from "@/server/actions/financeiro";
import { ErroAcesso } from "@/server/auth";
import { db, sql } from "@/server/db/client";
import {
  auditoria,
  categoriasFinanceiras,
  contasBancarias,
  estoqueMovimentos,
  estoqueSaldos,
  faturasCartao,
  fornecedores,
  lancamentos,
  produtosEstoque,
} from "@/server/db/schema";
import { historicoDoProduto, listarEstoque } from "@/server/queries/estoque";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const HOJE = hojeEmCuiaba();
const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };
const MSG_AJUSTE = "Faça um ajuste de estoque.";
const MSG_DESFACA_FATURA = "Desfaça a baixa da fatura do cartão antes";

type Contexto = { fin: string; consultor: string; operacional: string; conta: string; fornecedor: string };
let c: Contexto;

const id = (r: { ok: boolean; id?: string; erro?: string }) => {
  if (!r.ok || !r.id) throw new Error(r.ok ? "sem id" : r.erro);
  return r.id;
};

const novoProduto = async (nome = "Caderno", uso = "caixa_experiencia", minimos: { minimoMt?: number; minimoRs?: number } = {}) =>
  id(await comSessao(c.fin, () => salvarProduto({ nome, uso, minimoMt: 0, minimoRs: 0, ...minimos })));

const dadosEntrada = (produtoId: string, extra: Record<string, unknown> = {}) => ({
  produtoId,
  filial: "MT",
  quantidade: 10,
  valorUnitario: "38,00",
  fornecedorId: "",
  fornecedorTexto: "Papelaria do Zé",
  vencimento: "2027-01-31",
  forma: "PIX",
  cartaoId: "",
  ...extra,
});
const entrada = async (produtoId: string, extra: Record<string, unknown> = {}) => id(await comSessao(c.fin, () => registrarEntrada(dadosEntrada(produtoId, extra))));
const saida = (produtoId: string, quantidade: number, filial = "MT") =>
  comSessao(c.fin, () => registrarSaida({ produtoId, filial, quantidade, motivo: "Brinde avulso" }));
const ajuste = (produtoId: string, quantidadeNova: number, filial = "MT") =>
  comSessao(c.fin, () => ajustarEstoque({ produtoId, filial, quantidadeNova, motivo: "Contagem do mês" }));
const desfazer = (movimentoId: string) => comSessao(c.fin, () => desfazerEntradaDeEstoque(movimentoId));

const saldo = async (produtoId: string, filial: "MT" | "RS" = "MT") =>
  (await db.select().from(estoqueSaldos).where(and(eq(estoqueSaldos.produtoId, produtoId), eq(estoqueSaldos.filial, filial))))[0];
const movimento = async (movId: string) => (await db.select().from(estoqueMovimentos).where(eq(estoqueMovimentos.id, movId)))[0];
const movimentos = (produtoId: string) => db.select().from(estoqueMovimentos).where(eq(estoqueMovimentos.produtoId, produtoId)).orderBy(asc(estoqueMovimentos.seq));
const lancamento = async (lid: string) => (await db.select().from(lancamentos).where(eq(lancamentos.id, lid)))[0];
const auditoriaDe = (tabela: string, registroId: string) =>
  db.select().from(auditoria).where(and(eq(auditoria.tabela, tabela), eq(auditoria.registroId, registroId))).orderBy(asc(auditoria.id));
const categoriaSistema = async (sistema: "caixa_experiencia" | "papelaria") =>
  (await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, sistema)))[0].id;

/** Tudo do estoque e das contas de um produto, para conferir que uma recusa não gravou nada. */
const foto = async (produtoId: string) => ({
  saldos: await db.select().from(estoqueSaldos).where(eq(estoqueSaldos.produtoId, produtoId)),
  movimentos: await movimentos(produtoId),
  lancamentos: await db.select().from(lancamentos).orderBy(asc(lancamentos.criadoEm)),
  auditoria: (await db.select().from(auditoria)).length,
});

async function novoCartao(): Promise<string> {
  return id(
    await comSessao(c.fin, () =>
      criarCartao({ nome: "Visa empresarial", final: "1234", diaFechamento: "15", diaVencimento: "25", contaBancariaId: c.conta, centro: "MT" }),
    ),
  );
}

describe("estoque: actions e queries", () => {
  beforeEach(async () => {
    await limparBanco();
    const fin = await criarUsuarioTeste("fin_operacional");
    const consultor = await criarUsuarioTeste("consultor");
    const operacional = await criarUsuarioTeste("operacional");
    const [conta] = await db.insert(contasBancarias).values({ nome: "Itaú", saldoInicialEm: "2026-01-01" }).returning();
    const [f] = await db.insert(fornecedores).values({ nome: "Papelaria Central", tipos: ["Outro"], modalidade: "net" }).returning();
    c = { fin: fin.id, consultor: consultor.id, operacional: operacional.id, conta: conta.id, fornecedor: f.id };
  });

  describe("produto", () => {
    it("cria, edita e audita; nome repetido entre os ativos é recusado no campo", async () => {
      const p = await novoProduto("Caderno", "caixa_experiencia", { minimoMt: 5 });
      expect((await db.select().from(produtosEstoque).where(eq(produtosEstoque.id, p)))[0]).toMatchObject({ nome: "Caderno", minimoMt: 5, ativo: true });
      expect(await comSessao(c.fin, () => salvarProduto({ nome: "Caderno A5", uso: "papelaria", minimoMt: 2, minimoRs: 3 }, p))).toEqual({ ok: true, id: p });
      expect((await db.select().from(produtosEstoque).where(eq(produtosEstoque.id, p)))[0]).toMatchObject({ nome: "Caderno A5", uso: "papelaria", minimoRs: 3 });
      expect((await auditoriaDe("produtos_estoque", p)).map((a) => a.acao)).toEqual(["criar", "alterar"]);
      expect(await comSessao(c.fin, () => salvarProduto({ nome: "caderno a5", uso: "papelaria", minimoMt: 0, minimoRs: 0 }))).toEqual({
        ok: false,
        erro: "Já existe um produto ativo com este nome",
        campos: { nome: "Já existe um produto ativo com este nome" },
      });
    });

    it("desativarProduto: recusado com saldo em qualquer filial; com saldo 0 desativa e audita; depois não aceita entrada", async () => {
      const p = await novoProduto();
      await entrada(p, { filial: "RS", quantidade: 2 });
      const antes = await foto(p);
      expect(await comSessao(c.fin, () => desativarProduto(p))).toEqual({ ok: false, erro: "Zere o saldo nas duas filiais antes de desativar" });
      expect(await foto(p)).toEqual(antes);
      await saida(p, 2, "RS");
      expect(await comSessao(c.fin, () => desativarProduto(p))).toEqual({ ok: true, id: p });
      expect((await db.select().from(produtosEstoque).where(eq(produtosEstoque.id, p)))[0].ativo).toBe(false);
      expect((await auditoriaDe("produtos_estoque", p)).at(-1)?.acao).toBe("desativar");
      expect(await comSessao(c.fin, () => desativarProduto(p))).toEqual({ ok: false, erro: "Produto já desativado" });
      expect(await comSessao(c.fin, () => registrarEntrada(dadosEntrada(p)))).toEqual({ ok: false, erro: "Produto desativado" });
    });
  });

  describe("entrada", () => {
    it("grava movimento, saldo com custo médio e uma conta a pagar ligada, com a categoria do uso; audita tudo", async () => {
      const p = await novoProduto();
      const m1 = await entrada(p);
      const m2 = await entrada(p, { quantidade: 5, valorUnitario: "44,00", fornecedorTexto: "", fornecedorId: c.fornecedor });
      expect(await saldo(p)).toMatchObject({ quantidade: 15, custoMedio: 4000n });

      const mov = await movimento(m2);
      expect(mov).toMatchObject({
        tipo: "entrada",
        filial: "MT",
        quantidade: 5,
        custoUnitario: 4400n,
        custoMedioAntes: 3800n,
        fornecedorId: c.fornecedor,
        fornecedorTexto: null,
        usuarioId: c.fin,
      });
      expect((await movimento(m1)).custoMedioAntes).toBe(0n);
      expect(await db.select().from(lancamentos)).toHaveLength(2);
      const conta = await lancamento(mov.lancamentoId!);
      expect(conta).toMatchObject({
        lado: "pagar",
        descricao: "Estoque: 5 × Caderno",
        categoriaId: await categoriaSistema("caixa_experiencia"),
        centro: "MT",
        valor: 22000n,
        fornecedorId: c.fornecedor,
        pessoaTexto: null,
        emissao: HOJE,
        competencia: HOJE.slice(0, 7),
        vencimento: "2027-01-31",
        forma: "pix",
        status: "em_aberto",
        estoqueMovimentoId: m2,
        faturaCartaoId: null,
      });
      expect((await lancamento((await movimento(m1)).lancamentoId!)).pessoaTexto).toBe("Papelaria do Zé");

      expect((await auditoriaDe("estoque_movimentos", m2)).map((a) => a.acao)).toEqual(["criar"]);
      expect((await auditoriaDe("estoque_saldos", `${p}:MT`)).map((a) => a.acao)).toEqual(["criar", "alterar", "alterar"]);
      const [criar, ligar] = await auditoriaDe("lancamentos", conta.id);
      expect(criar.acao).toBe("criar");
      expect(ligar).toMatchObject({ acao: "alterar", depois: { estoqueMovimentoId: m2 } });
    });

    it("papelaria vai para a categoria Papelaria e o centro é a filial", async () => {
      const p = await novoProduto("Caneta", "papelaria");
      const m = await entrada(p, { filial: "RS", quantidade: 3, valorUnitario: "2,50" });
      const conta = await lancamento((await movimento(m)).lancamentoId!);
      expect(conta).toMatchObject({ categoriaId: await categoriaSistema("papelaria"), centro: "RS", valor: 750n });
      expect(await saldo(p, "RS")).toMatchObject({ quantidade: 3, custoMedio: 250n });
    });

    it("valor 0 (doação) entra no saldo e não cria conta", async () => {
      const p = await novoProduto();
      await entrada(p, { quantidade: 2, valorUnitario: "30,00" });
      const m = await entrada(p, { quantidade: 2, valorUnitario: "0,00" });
      expect(await movimento(m)).toMatchObject({ lancamentoId: null, custoUnitario: 0n });
      expect(await saldo(p)).toMatchObject({ quantidade: 4, custoMedio: 1500n });
      expect(await db.select().from(lancamentos)).toHaveLength(1);
    });

    it("no cartão corporativo, a conta cai na fatura do ciclo", async () => {
      const k = await novoCartao();
      const p = await novoProduto();
      const m = await entrada(p, { forma: "Cartão de crédito", cartaoId: k, vencimento: "2027-01-10" });
      const conta = await lancamento((await movimento(m)).lancamentoId!);
      const fs = await db.select().from(faturasCartao).where(eq(faturasCartao.cartaoId, k));
      expect(fs).toHaveLength(1);
      expect(conta).toMatchObject({ cartaoId: k, faturaCartaoId: fs[0].id, forma: "cartao_credito", vencimento: "2027-01-10" });
    });

    it("validação e referências: dois fornecedores, produto inexistente e fornecedor excluído recusados", async () => {
      const p = await novoProduto();
      const r = await comSessao(c.fin, () => registrarEntrada(dadosEntrada(p, { fornecedorId: c.fornecedor })));
      expect(r).toMatchObject({ ok: false, campos: { fornecedor: "Escolha só um: fornecedor do cadastro ou nome" } });
      expect(await comSessao(c.fin, () => registrarEntrada(dadosEntrada(crypto.randomUUID())))).toEqual({ ok: false, erro: "Produto não encontrado" });
      await db.update(fornecedores).set({ excluidoEm: new Date() }).where(eq(fornecedores.id, c.fornecedor));
      for (const valorUnitario of ["10,00", "0,00"]) {
        expect(await comSessao(c.fin, () => registrarEntrada(dadosEntrada(p, { fornecedorTexto: "", fornecedorId: c.fornecedor, valorUnitario })))).toMatchObject({
          ok: false,
          erro: "Fornecedor não encontrado",
        });
      }
      expect(await movimentos(p)).toHaveLength(0);
      expect(await db.select().from(lancamentos)).toHaveLength(0);
    });
  });

  describe("desfazer entrada", () => {
    it("só a última do par produto/filial; cancela a conta, volta saldo e custo médio e grava o ajuste negativo", async () => {
      const p = await novoProduto();
      const m1 = await entrada(p);
      const m2 = await entrada(p, { quantidade: 5, valorUnitario: "44,00" });
      await entrada(p, { filial: "RS", quantidade: 1 });
      expect(await desfazer(m1)).toEqual({ ok: false, erro: MSG_AJUSTE });

      expect(await desfazer(m2)).toEqual({ ok: true, id: m2 });
      expect(await saldo(p)).toMatchObject({ quantidade: 10, custoMedio: 3800n });
      const conta = await lancamento((await movimento(m2)).lancamentoId!);
      expect(conta).toMatchObject({ status: "cancelado", motivoCancelamento: "Entrada de estoque desfeita" });
      const ultimo = (await movimentos(p)).at(-1)!;
      expect(ultimo).toMatchObject({ tipo: "ajuste", filial: "MT", quantidade: -5, custoUnitario: 4400n, custoMedioAntes: 4000n, motivo: "Entrada desfeita" });
      expect((await auditoriaDe("estoque_movimentos", ultimo.id)).map((a) => a.acao)).toEqual(["criar"]);
      expect((await auditoriaDe("estoque_saldos", `${p}:MT`)).at(-1)?.acao).toBe("alterar");

      // Desfeita: o último movimento é o ajuste; nem ela nem a anterior se desfazem mais.
      expect(await desfazer(m2)).toEqual({ ok: false, erro: MSG_AJUSTE });
      expect(await desfazer(m1)).toEqual({ ok: false, erro: MSG_AJUSTE });
    });

    it("o último movimento é decidido por `seq`, não pelo relógio: `criado_em` fora de ordem não muda o que se desfaz", async () => {
      const p = await novoProduto();
      const m1 = await entrada(p);
      const m2 = await entrada(p, { quantidade: 5, valorUnitario: "44,00" });
      expect((await movimento(m2)).seq).toBeGreaterThan((await movimento(m1)).seq);
      // O relógio do banco voltou entre as duas: a segunda ficou com `criado_em` uma hora antes da primeira.
      await sql`update estoque_movimentos set criado_em = criado_em - interval '2 hours' where id = ${m2}`;
      const h = await comSessao(c.fin, () => historicoDoProduto(p));
      expect(h.map((x) => [x.id, x.desfazivel])).toEqual([
        [m2, true],
        [m1, false],
      ]);
      expect(await desfazer(m1)).toEqual({ ok: false, erro: MSG_AJUSTE });
      expect(await desfazer(m2)).toEqual({ ok: true, id: m2 });
    });

    it("única entrada desfeita zera saldo e custo médio; depois de uma saída é recusada", async () => {
      const p = await novoProduto();
      const m = await entrada(p, { quantidade: 3 });
      expect(await desfazer(m)).toEqual({ ok: true, id: m });
      expect(await saldo(p)).toMatchObject({ quantidade: 0, custoMedio: 0n });

      const m2 = await entrada(p, { quantidade: 3 });
      await saida(p, 1);
      const antes = await foto(p);
      expect(await desfazer(m2)).toEqual({ ok: false, erro: MSG_AJUSTE });
      expect(await foto(p)).toEqual(antes);
    });

    it("entrada sem conta (valor 0) se desfaz; movimento que não é entrada é recusado", async () => {
      const p = await novoProduto();
      const m = await entrada(p, { valorUnitario: "0,00" });
      expect(await desfazer(m)).toEqual({ ok: true, id: m });
      expect(await saldo(p)).toMatchObject({ quantidade: 0, custoMedio: 0n });
      await entrada(p, { quantidade: 2 });
      const s = id(await saida(p, 1));
      expect(await desfazer(s)).toEqual({ ok: false, erro: "Só uma entrada pode ser desfeita" });
      expect(await desfazer(crypto.randomUUID())).toEqual({ ok: false, erro: "Movimento não encontrado" });
    });

    it("recusada com a conta baixada; nada muda", async () => {
      const p = await novoProduto();
      const m = await entrada(p, { quantidade: 2 });
      const contaId = (await movimento(m)).lancamentoId!;
      expect(await comSessao(c.fin, () => baixarLinha("manual", contaId, { data: HOJE, valorPago: "76,00", juros: "", desconto: "", contaBancariaId: c.conta, observacao: "" }))).toEqual({ ok: true });
      const antes = await foto(p);
      expect(await desfazer(m)).toEqual({ ok: false, erro: "Desfaça a baixa para cancelar" });
      expect(await foto(p)).toEqual(antes);
    });

    it("no cartão: sai da fatura; com a fatura paga é recusada e nada muda", async () => {
      const k = await novoCartao();
      const p = await novoProduto();
      const m = await entrada(p, { forma: "Cartão de crédito", cartaoId: k, vencimento: "2027-01-10" });
      expect(await desfazer(m)).toEqual({ ok: true, id: m });
      expect(await lancamento((await movimento(m)).lancamentoId!)).toMatchObject({ status: "cancelado", faturaCartaoId: null });

      const m2 = await entrada(p, { forma: "Cartão de crédito", cartaoId: k, vencimento: "2027-01-11" });
      const [f] = await db.select().from(faturasCartao).where(eq(faturasCartao.cartaoId, k));
      await db.update(faturasCartao).set({ status: "baixado", pagoEm: "2027-01-25", valorPago: 38000n, contaBancariaId: c.conta }).where(eq(faturasCartao.id, f.id));
      const antes = await foto(p);
      expect(await desfazer(m2)).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await foto(p)).toEqual(antes);
    });

    it("no cartão com a fatura paga pela lista: recusada pedindo para desfazer a baixa da fatura; nada muda", async () => {
      const k = await novoCartao();
      const p = await novoProduto();
      const m = await entrada(p, { forma: "Cartão de crédito", cartaoId: k, vencimento: "2026-09-10", quantidade: 2 });
      const conta = await lancamento((await movimento(m)).lancamentoId!);
      expect(await comSessao(c.fin, () => baixarLinha("fatura_cartao", conta.faturaCartaoId!, { data: HOJE, contaBancariaId: c.conta }))).toEqual({ ok: true });
      expect((await lancamento(conta.id)).status).toBe("baixado");
      const antes = await foto(p);
      expect(await desfazer(m)).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await foto(p)).toEqual(antes);
    });

    it("lê a conta com trava: fatura paga enquanto o desfazer espera é vista com o cartão e recusada pedindo a fatura", async () => {
      const k = await novoCartao();
      const p = await novoProduto();
      const m = await entrada(p, { forma: "Cartão de crédito", cartaoId: k, vencimento: "2026-09-10", quantidade: 2 });
      const conta = await lancamento((await movimento(m)).lancamentoId!);
      // Outra transação trava a conta e paga a fatura (como a baixa da fatura); o desfazer começa no meio.
      let soltar!: () => void;
      const segurando = new Promise<void>((r) => (soltar = r));
      let travou!: () => void;
      const travada = new Promise<void>((r) => (travou = r));
      const pagamento = sql.begin(async (t) => {
        await t`select id from lancamentos where id = ${conta.id} for update`;
        travou();
        await segurando;
        await t`update lancamentos set status = 'baixado', baixado_em = ${HOJE}, valor_pago = ${conta.valor.toString()}, juros = 0, desconto = 0, baixa_conta_bancaria_id = ${c.conta} where id = ${conta.id}`;
        await t`update faturas_cartao set status = 'baixado', pago_em = ${HOJE}, valor_pago = ${conta.valor.toString()}, conta_bancaria_id = ${c.conta} where id = ${conta.faturaCartaoId!}`;
      });
      await travada;
      const desfeito = desfazer(m);
      for (let i = 0; i < 100; i++) {
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
        if (n >= 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      soltar();
      await pagamento;
      expect(await desfeito).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await saldo(p)).toMatchObject({ quantidade: 2 });
    });
  });

  describe("saída e ajuste", () => {
    it("saída ao custo médio; acima do saldo recusada; não gera conta", async () => {
      const p = await novoProduto();
      await entrada(p, { quantidade: 3, valorUnitario: "10,00" });
      const antes = await foto(p);
      expect(await saida(p, 4)).toEqual({ ok: false, erro: "Só há 3 na filial", campos: { quantidade: "Só há 3 na filial" } });
      expect(await saida(p, 1, "RS")).toMatchObject({ ok: false, erro: "Só há 0 na filial" });
      expect(await foto(p)).toEqual(antes);

      const s = id(await saida(p, 2));
      expect(await movimento(s)).toMatchObject({ tipo: "saida", quantidade: -2, custoUnitario: 1000n, custoMedioAntes: 1000n, motivo: "Brinde avulso", lancamentoId: null });
      expect(await saldo(p)).toMatchObject({ quantidade: 1, custoMedio: 1000n });
      expect(await db.select().from(lancamentos)).toHaveLength(1);
      expect((await auditoriaDe("estoque_movimentos", s)).map((a) => a.acao)).toEqual(["criar"]);
    });

    it("ajuste grava a diferença ao custo médio; mesma quantidade recusada; zerar leva o custo a 0", async () => {
      const p = await novoProduto();
      await entrada(p, { quantidade: 10, valorUnitario: "40,00" });
      const a1 = id(await ajuste(p, 7));
      expect(await movimento(a1)).toMatchObject({ tipo: "ajuste", quantidade: -3, custoUnitario: 4000n, custoMedioAntes: 4000n, motivo: "Contagem do mês" });
      expect(await saldo(p)).toMatchObject({ quantidade: 7, custoMedio: 4000n });
      const a2 = id(await ajuste(p, 9));
      expect((await movimento(a2)).quantidade).toBe(2);
      expect(await saldo(p)).toMatchObject({ quantidade: 9, custoMedio: 4000n });
      expect(await ajuste(p, 9)).toEqual({ ok: false, erro: "A quantidade da filial já é essa", campos: { quantidadeNova: "A quantidade da filial já é essa" } });
      await ajuste(p, 0);
      expect(await saldo(p)).toMatchObject({ quantidade: 0, custoMedio: 0n });
      // Filial sem saldo ainda: a linha nasce e o ajuste soma ao custo 0.
      const a3 = id(await ajuste(p, 3, "RS"));
      expect(await movimento(a3)).toMatchObject({ quantidade: 3, custoUnitario: 0n });
      expect(await saldo(p, "RS")).toMatchObject({ quantidade: 3, custoMedio: 0n });
      expect(await db.select().from(lancamentos)).toHaveLength(1);
    });

    it("ajuste positivo em filial com saldo 0 entra ao custo médio da outra filial (passar itens de uma para a outra)", async () => {
      const p = await novoProduto();
      await entrada(p, { quantidade: 5, valorUnitario: "40,00" });
      const a = id(await ajuste(p, 2, "RS"));
      expect(await movimento(a)).toMatchObject({ filial: "RS", quantidade: 2, custoUnitario: 4000n, custoMedioAntes: 0n });
      expect(await saldo(p, "RS")).toMatchObject({ quantidade: 2, custoMedio: 4000n });
      // A outra metade da passagem: MT baixa ao seu custo médio, que não muda.
      await ajuste(p, 3, "MT");
      expect(await saldo(p, "MT")).toMatchObject({ quantidade: 3, custoMedio: 4000n });
      // Com saldo na filial, o ajuste positivo fica no custo médio dela, não no da outra.
      await entrada(p, { filial: "RS", quantidade: 2, valorUnitario: "50,00" });
      await ajuste(p, 5, "RS");
      expect(await saldo(p, "RS")).toMatchObject({ quantidade: 5, custoMedio: 4500n });
    });

    it("duas saídas simultâneas do último item: uma passa, a outra é recusada; saldo nunca negativo", async () => {
      const p = await novoProduto();
      await entrada(p, { quantidade: 1 });
      const rs = await Promise.all([saida(p, 1), saida(p, 1)]);
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
      expect(rs.find((r) => !r.ok)).toMatchObject({ ok: false, erro: "Só há 0 na filial" });
      expect(await saldo(p)).toMatchObject({ quantidade: 0, custoMedio: 0n });
      expect((await movimentos(p)).filter((m) => m.tipo === "saida")).toHaveLength(1);
    });

    it("duas primeiras entradas simultâneas no par criam uma só linha de saldo", async () => {
      const p = await novoProduto();
      const rs = await Promise.all([
        comSessao(c.fin, () => registrarEntrada(dadosEntrada(p, { quantidade: 2 }))),
        comSessao(c.fin, () => registrarEntrada(dadosEntrada(p, { quantidade: 3 }))),
      ]);
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(await saldo(p)).toMatchObject({ quantidade: 5, custoMedio: 3800n });
    });
  });

  describe("queries", () => {
    it("listarEstoque: quantidades, mínimos, custo médio, valor e abaixo do mínimo; filtros", async () => {
      const caderno = await novoProduto("Caderno", "caixa_experiencia", { minimoMt: 5, minimoRs: 1 });
      const caneta = await novoProduto("Caneta", "papelaria", { minimoRs: 10 });
      await entrada(caderno, { quantidade: 4, valorUnitario: "10,00" });
      await entrada(caderno, { filial: "RS", quantidade: 2, valorUnitario: "12,00" });
      await entrada(caneta, { filial: "RS", quantidade: 20, valorUnitario: "1,00" });

      const tudo = await comSessao(c.fin, () => listarEstoque({}));
      expect(tudo.valorTotal).toBe(4000n + 2400n + 2000n);
      expect(tudo.abaixoDoMinimo).toBe(1);
      expect(tudo.produtos.map((x) => x.nome)).toEqual(["Caderno", "Caneta"]);
      expect(tudo.produtos[0]).toMatchObject({
        id: caderno,
        uso: "caixa_experiencia",
        ativo: true,
        mt: { quantidade: 4, minimo: 5, abaixo: true },
        rs: { quantidade: 2, minimo: 1, abaixo: false },
        custoMedioMt: 1000n,
        custoMedioRs: 1200n,
        valor: 6400n,
      });
      expect(tudo.produtos[1]).toMatchObject({ mt: { quantidade: 0, minimo: 0, abaixo: false }, custoMedioMt: 0n, valor: 2000n });

      expect((await comSessao(c.fin, () => listarEstoque({ soAbaixo: true }))).produtos.map((x) => x.id)).toEqual([caderno]);
      expect((await comSessao(c.fin, () => listarEstoque({ uso: "papelaria" }))).produtos.map((x) => x.id)).toEqual([caneta]);
      // Os cartões somam sempre as duas filiais e todos os usos, com qualquer filtro.
      const rs = await comSessao(c.fin, () => listarEstoque({ filial: "RS" }));
      expect(rs).toMatchObject({ valorTotal: 8400n, abaixoDoMinimo: 1 });
      expect(await comSessao(c.fin, () => listarEstoque({ uso: "papelaria" }))).toMatchObject({ valorTotal: 8400n, abaixoDoMinimo: 1 });
      expect(await comSessao(c.fin, () => listarEstoque({ uso: "papelaria", filial: "MT", soAbaixo: true }))).toMatchObject({ produtos: [], valorTotal: 8400n, abaixoDoMinimo: 1 });
      expect(rs.produtos.find((x) => x.id === caderno)?.valor).toBe(2400n);
      expect((await comSessao(c.fin, () => listarEstoque({ filial: "RS", soAbaixo: true }))).produtos).toHaveLength(0);
    });

    it("historicoDoProduto: mais recentes primeiro, com quem, fornecedor e quais entradas se desfazem", async () => {
      const p = await novoProduto();
      const m1 = await entrada(p, { quantidade: 3 });
      const m2 = await entrada(p, { filial: "RS", quantidade: 1, fornecedorTexto: "", fornecedorId: c.fornecedor });
      const s = id(await saida(p, 1));
      const h = await comSessao(c.fin, () => historicoDoProduto(p));
      expect(h.map((x) => x.id)).toEqual([s, m2, m1]);
      expect(h[0]).toMatchObject({ tipo: "saida", filial: "MT", quantidade: -1, custoUnitario: 3800n, motivo: "Brinde avulso", desfazivel: false });
      expect(h[0].usuario).toEqual(expect.any(String));
      expect(h[1]).toMatchObject({ tipo: "entrada", fornecedor: "Papelaria Central", desfazivel: true });
      expect(h[2]).toMatchObject({ fornecedor: "Papelaria do Zé", desfazivel: false });
      expect(await comSessao(c.fin, () => historicoDoProduto("nao-e-uuid"))).toEqual([]);
    });
  });

  it("Review Focus 4: consultor e operacional recebem 'Sem permissão' em cada action e erro de acesso em cada query", async () => {
    const p = await novoProduto();
    const m = await entrada(p);
    const antes = await foto(p);
    for (const u of [c.consultor, c.operacional]) {
      expect(await comSessao(u, () => salvarProduto({ nome: "Outro", uso: "papelaria", minimoMt: 0, minimoRs: 0 }))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => salvarProduto({ nome: "Outro", uso: "papelaria", minimoMt: 0, minimoRs: 0 }, p))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => desativarProduto(p))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => registrarEntrada(dadosEntrada(p)))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => desfazerEntradaDeEstoque(m))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => registrarSaida({ produtoId: p, filial: "MT", quantidade: 1, motivo: "Brinde avulso" }))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => ajustarEstoque({ produtoId: p, filial: "MT", quantidadeNova: 1, motivo: "Contagem do mês" }))).toEqual(SEM_PERMISSAO);
      await expect(comSessao(u, () => listarEstoque({}))).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(u, () => historicoDoProduto(p))).rejects.toBeInstanceOf(ErroAcesso);
    }
    expect(await foto(p)).toEqual(antes);
    const diretor = await criarUsuarioTeste("diretor");
    expect((await comSessao(diretor.id, () => listarEstoque({}))).produtos).toHaveLength(1);
  });
});
