import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { criarCartao } from "@/server/actions/cartoes";
import { baixarLinha, cancelarLancamento, criarLancamento, desfazerBaixaLinha, editarLancamento } from "@/server/actions/financeiro";
import { db, sql } from "@/server/db/client";
import { auditoria, categoriasFinanceiras, contasBancarias, faturasCartao, lancamentos, lancamentosFinanceiros } from "@/server/db/schema";
import {
  Desfazer,
  MSG_LANCAMENTO_ESTOQUE,
  MSG_LANCAMENTO_REEMBOLSO,
  alterarEmAbertoNa,
  cancelarLancamentoNa,
  desfazerBaixaLancamentoNa,
  vinculoDoLancamento,
  type Falha,
  type Ok,
} from "@/server/financeiro/lancamentos";
import { listarLancamentos } from "@/server/queries/financeiro";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const MSG_DESFACA_FATURA = "Desfaça a baixa da fatura do cartão antes";
const HOJE = hojeEmCuiaba();

type Contexto = { fin: string; categoria: string; conta: string };
let c: Contexto;

const dados = (extra: Record<string, unknown> = {}) => ({
  lado: "pagar",
  descricao: "Cadernos da caixa",
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

async function criar(extra: Record<string, unknown> = {}): Promise<string> {
  const r = await comSessao(c.fin, () => criarLancamento(dados(extra)));
  if (!r.ok) throw new Error(r.erro);
  return (r as { ids: string[] }).ids[0];
}

const lancamento = async (id: string) => (await db.select().from(lancamentos).where(eq(lancamentos.id, id)))[0];
const alteracoes = (id: string) =>
  db.select().from(auditoria).where(and(eq(auditoria.tabela, "lancamentos"), eq(auditoria.registroId, id), eq(auditoria.acao, "alterar"))).orderBy(asc(auditoria.id));

/** Conta ligada a uma entrada de estoque (movimento mínimo, inserido à mão: as actions do estoque vêm na Task 4). */
async function comEstoque(id: string): Promise<string> {
  const [p] = await sql<{ id: string }[]>`insert into produtos_estoque (nome, uso) values ('Caderno', 'caixa_experiencia') returning id`;
  const [m] = await sql<{ id: string }[]>`insert into estoque_movimentos (produto_id, filial, tipo, quantidade, custo_unitario, custo_medio_antes, usuario_id)
    values (${p.id}, 'MT', 'entrada', 5, 20000, 0, ${c.fin}) returning id`;
  await db.update(lancamentos).set({ estoqueMovimentoId: m.id }).where(eq(lancamentos.id, id));
  return m.id;
}

/** Conta ligada a um caso de reembolso (a tabela `reembolsos` e a FK vêm na Task 9: qualquer uuid serve). */
async function comReembolso(id: string): Promise<string> {
  const r = crypto.randomUUID();
  await db.update(lancamentos).set({ reembolsoId: r }).where(eq(lancamentos.id, id));
  return r;
}

/** O núcleo numa transação, como as actions o chamam (`Desfazer` vira a falha). */
async function noNucleo(fn: Parameters<typeof db.transaction>[0] extends (tx: infer T) => unknown ? (tx: T) => Promise<Ok | Falha> : never): Promise<Ok | Falha> {
  try {
    return await db.transaction(fn);
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    throw x;
  }
}

async function novoCartao(): Promise<string> {
  const r = await comSessao(c.fin, () =>
    criarCartao({ nome: "Visa empresarial", final: "1234", diaFechamento: "15", diaVencimento: "25", contaBancariaId: c.conta, centro: "MT" }),
  );
  if (!r.ok || !r.id) throw new Error(r.ok ? "sem id" : r.erro);
  return r.id;
}
const compra = (cartaoId: string, extra: Record<string, unknown> = {}) =>
  criar({ forma: "Cartão de crédito", cartaoId, emissao: "2027-01-10", vencimento: "2027-01-10", valor: "300,00", ...extra });
const faturas = (cartaoId: string) => db.select().from(faturasCartao).where(eq(faturasCartao.cartaoId, cartaoId)).orderBy(asc(faturasCartao.fechamento));

const baixa = () => ({ data: HOJE, valorPago: "1.000,00", juros: "", desconto: "", contaBancariaId: c.conta, observacao: "" });

describe("núcleo do financeiro e contas com vínculo", () => {
  beforeEach(async () => {
    await limparBanco();
    const fin = await criarUsuarioTeste("fin_operacional");
    const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, "Aluguel"));
    const [conta] = await db.insert(contasBancarias).values({ nome: "Itaú", saldoInicialEm: "2026-01-01" }).returning();
    c = { fin: fin.id, categoria: cat.id, conta: conta.id };
  });

  it("vinculoDoLancamento: estoque, reembolso ou nenhum", () => {
    expect(vinculoDoLancamento({ estoqueMovimentoId: "x", reembolsoId: null })).toBe("estoque");
    expect(vinculoDoLancamento({ estoqueMovimentoId: null, reembolsoId: "y" })).toBe("reembolso");
    expect(vinculoDoLancamento({ estoqueMovimentoId: null, reembolsoId: null })).toBeNull();
  });

  describe("lista única: conta com vínculo não é editada nem cancelada", () => {
    for (const [nome, ligar, msg] of [
      ["estoque", comEstoque, MSG_LANCAMENTO_ESTOQUE],
      ["reembolso", comReembolso, MSG_LANCAMENTO_REEMBOLSO],
    ] as const) {
      it(`${nome}: editar e cancelar recusados com a mensagem, nada gravado`, async () => {
        const id = await criar();
        await ligar(id);
        const antes = await lancamento(id);
        expect(await comSessao(c.fin, () => editarLancamento(id, dados({ valor: "900,00", descricao: "Outra" }), "esta"))).toEqual({ ok: false, erro: msg });
        expect(await comSessao(c.fin, () => editarLancamento(id, dados({ valor: "900,00" }), "proximas"))).toEqual({ ok: false, erro: msg });
        expect(await comSessao(c.fin, () => cancelarLancamento(id, "Não quero mais", "esta"))).toEqual({ ok: false, erro: msg });
        expect(await comSessao(c.fin, () => cancelarLancamento(id, "Não quero mais", "proximas"))).toEqual({ ok: false, erro: msg });
        expect(await lancamento(id)).toEqual(antes);
        expect(await alteracoes(id)).toHaveLength(0);
      });

      it(`${nome}: baixar e desfazer a baixa pela lista continuam funcionando`, async () => {
        const id = await criar();
        await ligar(id);
        expect(await comSessao(c.fin, () => baixarLinha("manual", id, baixa()))).toEqual({ ok: true });
        expect(await lancamento(id)).toMatchObject({ status: "baixado", valorPago: 100000n, baixaContaBancariaId: c.conta });
        expect(await comSessao(c.fin, () => desfazerBaixaLinha("manual", id))).toEqual({ ok: true });
        expect(await lancamento(id)).toMatchObject({ status: "em_aberto", valorPago: null, baixadoEm: null });
      });
    }

    it("conta sem vínculo continua editável e cancelável", async () => {
      const id = await criar();
      expect(await comSessao(c.fin, () => editarLancamento(id, dados({ valor: "900,00" }), "esta"))).toMatchObject({ ok: true });
      expect(await comSessao(c.fin, () => cancelarLancamento(id, "Contrato encerrado", "esta"))).toMatchObject({ ok: true });
      expect(await lancamento(id)).toMatchObject({ valor: 90000n, status: "cancelado", motivoCancelamento: "Contrato encerrado" });
    });
  });

  describe("cancelarLancamentoNa", () => {
    it("cancela uma linha (com vínculo também: é o caminho do estoque e do reembolso) e audita", async () => {
      const id = await criar();
      await comEstoque(id);
      expect(await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, id, "Entrada de estoque desfeita"))).toEqual({ ok: true, id });
      expect(await lancamento(id)).toMatchObject({ status: "cancelado", motivoCancelamento: "Entrada de estoque desfeita" });
      const [a] = await alteracoes(id);
      expect(a.antes).toEqual({ status: "em_aberto", motivoCancelamento: null });
    });

    it("recusa baixado e já cancelado", async () => {
      const id = await criar();
      await comSessao(c.fin, () => baixarLinha("manual", id, baixa()));
      expect(await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, id, "x"))).toEqual({ ok: false, erro: "Desfaça a baixa para cancelar" });
      await comSessao(c.fin, () => desfazerBaixaLinha("manual", id));
      await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, id, "Erro"));
      expect(await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, id, "x"))).toEqual({ ok: false, erro: "Lançamento já cancelado" });
      expect(await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, crypto.randomUUID(), "x"))).toEqual({ ok: false, erro: "Lançamento não encontrado" });
    });

    it("compra no cartão: sai da fatura (o cartão fica); com a fatura paga, recusa e nada muda", async () => {
      const k = await novoCartao();
      const id = await compra(k);
      const [f] = await faturas(k);
      expect(await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, id, "Compra estornada"))).toEqual({ ok: true, id });
      expect(await lancamento(id)).toMatchObject({ status: "cancelado", cartaoId: k, faturaCartaoId: null });
      const [a] = await alteracoes(id);
      expect(a.antes).toMatchObject({ faturaCartaoId: f.id });

      const id2 = await compra(k, { vencimento: "2027-01-11", emissao: "2027-01-11" });
      await db.update(faturasCartao).set({ status: "baixado", pagoEm: "2027-01-25", valorPago: 30000n, contaBancariaId: c.conta }).where(eq(faturasCartao.id, f.id));
      const antes = await lancamento(id2);
      expect(await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, id2, "Estorno"))).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await lancamento(id2)).toEqual(antes);
    });
  });

  describe("alterarEmAbertoNa", () => {
    it("altera valor, vencimento e descrição de uma linha em aberto e audita só o que mudou", async () => {
      const id = await criar();
      await comReembolso(id);
      expect(await noNucleo((tx) => alterarEmAbertoNa(tx, c.fin, id, { valor: 75000n, vencimento: "2027-02-10", descricao: "Reembolso ECL-0001-01: hotel" }))).toEqual({ ok: true, id });
      expect(await lancamento(id)).toMatchObject({ valor: 75000n, vencimento: "2027-02-10", descricao: "Reembolso ECL-0001-01: hotel", competencia: "2027-01" });
      const [a] = await alteracoes(id);
      expect(a.antes).toEqual({ valor: "100000", vencimento: "2027-01-31", descricao: "Cadernos da caixa" });
      // sem mudança: nada gravado
      expect(await noNucleo((tx) => alterarEmAbertoNa(tx, c.fin, id, { valor: 75000n }))).toEqual({ ok: true, id });
      expect(await alteracoes(id)).toHaveLength(1);
    });

    it("recusa linha baixada ou cancelada, e valor zero", async () => {
      const id = await criar();
      expect(await noNucleo((tx) => alterarEmAbertoNa(tx, c.fin, id, { valor: 0n }))).toMatchObject({ ok: false });
      await comSessao(c.fin, () => baixarLinha("manual", id, baixa()));
      const antes = await lancamento(id);
      expect(await noNucleo((tx) => alterarEmAbertoNa(tx, c.fin, id, { valor: 50000n }))).toEqual({ ok: false, erro: "Desfaça a baixa para editar" });
      expect(await lancamento(id)).toEqual(antes);
      await comSessao(c.fin, () => desfazerBaixaLinha("manual", id));
      await noNucleo((tx) => cancelarLancamentoNa(tx, c.fin, id, "Erro"));
      expect(await noNucleo((tx) => alterarEmAbertoNa(tx, c.fin, id, { valor: 50000n }))).toEqual({ ok: false, erro: "Lançamento cancelado não pode ser editado" });
    });

    it("compra no cartão: novo vencimento leva a compra à fatura do ciclo da nova data", async () => {
      const k = await novoCartao();
      const id = await compra(k);
      expect(await noNucleo((tx) => alterarEmAbertoNa(tx, c.fin, id, { vencimento: "2027-01-20" }))).toEqual({ ok: true, id });
      const fs = await faturas(k);
      expect(fs.map((f) => f.fechamento)).toEqual(["2027-01-15", "2027-02-15"]);
      expect(await lancamento(id)).toMatchObject({ vencimento: "2027-01-20", faturaCartaoId: fs[1].id });
    });
  });

  it("desfazerBaixaLancamentoNa no núcleo: reabre a baixa e recusa o que não foi baixado", async () => {
    const id = await criar();
    expect(await noNucleo((tx) => desfazerBaixaLancamentoNa(tx, c.fin, id))).toEqual({ ok: false, erro: "Este lançamento não foi baixado" });
    await comSessao(c.fin, () => baixarLinha("manual", id, baixa()));
    expect(await noNucleo((tx) => desfazerBaixaLancamentoNa(tx, c.fin, id))).toEqual({ ok: true, id });
    expect(await lancamento(id)).toMatchObject({ status: "em_aberto", valorPago: null, baixaContaBancariaId: null });
  });

  it("a view traz estoque_movimento_id e reembolso_id da conta manual", async () => {
    const a = await criar();
    const b = await criar({ descricao: "Reembolso" });
    const d = await criar({ descricao: "Aluguel" });
    const m = await comEstoque(a);
    const r = await comReembolso(b);
    const vs = await db
      .select({ id: lancamentosFinanceiros.id, estoqueMovimentoId: lancamentosFinanceiros.estoqueMovimentoId, reembolsoId: lancamentosFinanceiros.reembolsoId })
      .from(lancamentosFinanceiros);
    expect(vs.find((v) => v.id === a)).toEqual({ id: a, estoqueMovimentoId: m, reembolsoId: null });
    expect(vs.find((v) => v.id === b)).toEqual({ id: b, estoqueMovimentoId: null, reembolsoId: r });
    expect(vs.find((v) => v.id === d)).toEqual({ id: d, estoqueMovimentoId: null, reembolsoId: null });
  });

  it("listarLancamentos devolve o vínculo de cada linha", async () => {
    const a = await criar();
    const b = await criar({ descricao: "Reembolso" });
    const d = await criar({ descricao: "Aluguel" });
    await comEstoque(a);
    await comReembolso(b);
    const { linhas } = await comSessao(c.fin, () =>
      listarLancamentos({ lado: "todos", base: "vencimento", de: "2027-01-01", ate: "2027-01-31", pagina: 1 } as Parameters<typeof listarLancamentos>[0]),
    );
    const vinculo = (id: string) => linhas.find((l) => l.id === id)?.vinculo;
    expect(vinculo(a)).toBe("estoque");
    expect(vinculo(b)).toBe("reembolso");
    expect(vinculo(d)).toBeNull();
  });
});
