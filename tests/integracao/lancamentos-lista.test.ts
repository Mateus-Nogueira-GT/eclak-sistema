import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { competenciaDe, type Origem } from "@/domain/financeiro";
import { MSG_LOTE_LADOS, MSG_LOTE_RECUSADO } from "@/domain/financeiro-entrada";
import { MSG_CONCILIADA, MSG_PARCELA_RECEBIDA } from "@/domain/venda-entrada";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import {
  auditoria,
  categoriasFinanceiras,
  comissoes,
  contasPagar,
  lancamentos,
  pagamentosFornecedor,
  parcelasReceber,
  viagens,
} from "@/server/db/schema";
import { baixarEmLote, baixarLancamento, baixarLinha, criarLancamento, desfazerBaixaLinha } from "@/server/actions/financeiro";
import { baixarParcela, definirFormaFornecedor } from "@/server/actions/financeiro-viagem";
import { listarLancamentos } from "@/server/queries/financeiro";
import { obterViagemVendida } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { contaBancaria, vendida } from "../helpers/venda";

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };

/** Soma `n` dias a "AAAA-MM-DD". */
function dias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Centavos → "1234,56" (entrada das actions). */
const reais = (c: bigint) => `${c / 100n},${(c % 100n).toString().padStart(2, "0")}`;

const TUDO = { lado: "todos", de: "2000-01-01", ate: "2099-12-31", base: "vencimento", pagina: 1 } as const;

const listar = (uid: string, extra: Record<string, unknown> = {}) =>
  comSessao(uid, () => listarLancamentos({ ...TUDO, ...extra } as Parameters<typeof listarLancamentos>[0]));

async function categoria(nome: string): Promise<string> {
  const [c] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, nome));
  return c.id;
}

/** Lançamento manual em aberto; devolve o id (ou os ids da série). */
async function manual(uid: string, o: { lado?: "pagar" | "receber"; vencimento: string; valor: string; categoria: string; centro?: "MT" | "RS"; descricao?: string; repeticao?: unknown }) {
  const r = await comSessao(uid, () =>
    criarLancamento({
      lado: o.lado ?? "pagar",
      descricao: o.descricao ?? "Conta da empresa",
      fornecedorId: "",
      clienteId: "",
      pessoaTexto: "Fornecedor local",
      categoriaId: o.categoria,
      centro: o.centro ?? "MT",
      competencia: competenciaDe(o.vencimento),
      emissao: "2026-01-02",
      vencimento: o.vencimento,
      valor: o.valor,
      forma: "PIX",
      contaBancariaId: "",
      observacao: "",
      repeticao: o.repeticao ?? { tipo: "unica" },
    }),
  );
  if (!r.ok) throw new Error(r.erro);
  return (r as { ids: string[] }).ids;
}

const chave = (l: { origem: string; id: string }) => `${l.origem}:${l.id}`;

describe("lista única de lançamentos", () => {
  beforeEach(limparBanco);

  it("viagem vendida + 2 manuais: cada fonte uma vez, sem id repetido; parcelas em Vendas de viagem e centro RS", async () => {
    const x = await vendida();
    const aluguel = await categoria("Aluguel");
    await manual(x.fin.id, { vencimento: "2027-01-31", valor: "1.000,00", categoria: aluguel });
    await manual(x.fin.id, { vencimento: "2027-02-28", valor: "500,00", categoria: aluguel });
    const pagamentos = await db
      .select({ id: pagamentosFornecedor.id })
      .from(pagamentosFornecedor)
      .innerJoin(contasPagar, eq(contasPagar.id, pagamentosFornecedor.contaId))
      .where(eq(contasPagar.viagemId, x.viagemId));

    const r = await listar(x.fin.id);
    const por = (o: Origem) => r.linhas.filter((l) => l.origem === o);
    expect(por("parcela")).toHaveLength(2);
    expect(por("pagamento").map((l) => l.id).sort()).toEqual(pagamentos.map((p) => p.id).sort());
    expect(por("comissao")).toHaveLength(1);
    expect(por("manual")).toHaveLength(2);
    expect(r.linhas).toHaveLength(2 + pagamentos.length + 1 + 2);
    expect(r.totalLinhas).toBe(r.linhas.length);
    expect(new Set(r.linhas.map(chave)).size).toBe(r.linhas.length);
    for (const p of por("parcela")) {
      expect(p.categoria).toEqual({ grupo: "Vendas", nome: "Vendas de viagem" });
      expect(p.centro).toBe("RS");
      expect(p.viagemId).toBe(x.viagemId);
      expect(p.situacao).toBe("a_vencer");
    }
    expect(por("manual")[0].categoria).toEqual({ grupo: "Administrativo", nome: "Aluguel" });
    // Busca pelo código da viagem: só as linhas dela.
    const codigo = por("parcela")[0].viagemCodigo!;
    expect((await listar(x.fin.id, { busca: codigo })).linhas.every((l) => l.viagemCodigo === codigo)).toBe(true);
    expect((await listar(x.fin.id, { busca: codigo })).totalLinhas).toBe(r.linhas.length - 2);
    // Ordem: vencimento, depois id.
    const ordem = r.linhas.map((l) => `${l.vencimento}|${l.id}`);
    expect(ordem).toEqual([...ordem].sort());
    // Pagamento traz moeda e valor original (para o diálogo de baixa).
    const transfer = r.linhas.find((l) => l.id === x.pagTransfer.id)!;
    expect(transfer).toMatchObject({ moeda: "EUR", valorOriginal: x.pagTransfer.valorOriginal, exigeIndividual: true });
  });

  it("depois de definirFormaFornecedor (parcelado em 2) a conta aparece nas 2 linhas novas e a antiga some", async () => {
    const x = await vendida();
    const f = await comSessao(x.fin.id, () =>
      definirFormaFornecedor(x.passeio.id, {
        tipo: "parcelado",
        parcelas: [
          { vencimento: "2027-06-01", valor: "200,00" },
          { vencimento: "2027-07-01", valor: "300,00" },
        ],
      }),
    );
    expect(f).toEqual({ ok: true });
    const novas = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));
    const r = await listar(x.fin.id);
    const doPasseio = r.linhas.filter((l) => l.origem === "pagamento" && novas.some((n) => n.id === l.id));
    expect(doPasseio.map((l) => [l.parcelaNumero, l.parcelaTotal, l.valorPrevisto, l.forma])).toEqual([
      [1, 2, 20000n, "parcelado"],
      [2, 2, 30000n, "parcelado"],
    ]);
    expect(r.linhas.some((l) => l.id === x.pagPasseio.id)).toBe(false);
  });

  it("cartão direto no fornecedor: contas do fornecedor fora do caixa e dos totais; parcela vira o repasse", async () => {
    const x = await vendida({ cartao: "hotel" });
    const r = await listar(x.fin.id);
    const doHotel = r.linhas.filter((l) => l.origem === "pagamento" && l.pessoa === "Palazzo Hotels");
    expect(doHotel.length).toBeGreaterThan(0);
    expect(doHotel.every((l) => !l.transitaCaixa)).toBe(true);
    const demais = r.linhas.filter((l) => l.origem === "pagamento" && l.pessoa !== "Palazzo Hotels");
    expect(demais.every((l) => l.transitaCaixa)).toBe(true);
    // Totais a pagar: só os demais (todos em aberto e futuros).
    expect(r.totais.pagar.aVencer).toBe(demais.reduce((t, l) => t + l.valorPrevisto, 0n));
    const [parcela] = r.linhas.filter((l) => l.origem === "parcela");
    expect(parcela.descricao).toBe("Repasse de Palazzo Hotels");
    expect(parcela.repasse).toBe(true);
    expect(parcela.valorPrevisto).toBe(x.parcelas[0].valor - doHotel.reduce((t, l) => t + l.valorPrevisto, 0n));
  });

  it("totais por lado: vencidos, vence hoje, a vencer e baixados; filtros de centro e categoria; cancelado fora", async () => {
    const fin = (await criarUsuarioTeste("fin_operacional")).id;
    const cb = await contaBancaria(fin);
    const hoje = hojeEmCuiaba();
    const aluguel = await categoria("Aluguel");
    const telefone = await categoria("Telefone");
    const rendimentos = await categoria("Rendimentos");
    const [vencido] = await manual(fin, { vencimento: dias(hoje, -5), valor: "100,00", categoria: aluguel });
    const [deHoje] = await manual(fin, { vencimento: hoje, valor: "200,00", categoria: aluguel });
    const [futuro] = await manual(fin, { vencimento: dias(hoje, 10), valor: "400,00", categoria: aluguel });
    const [baixado] = await manual(fin, { vencimento: dias(hoje, -2), valor: "800,00", categoria: aluguel });
    const [cancelado] = await manual(fin, { vencimento: dias(hoje, 3), valor: "1.600,00", categoria: aluguel });
    await manual(fin, { vencimento: dias(hoje, 4), valor: "50,00", categoria: telefone, descricao: "Celular da agência" });
    await manual(fin, { lado: "receber", vencimento: dias(hoje, 6), valor: "32,00", categoria: rendimentos, centro: "RS" });
    const b = await comSessao(fin, () => baixarLancamento(baixado, { data: hoje, valorPago: "800,00", juros: "", desconto: "", contaBancariaId: cb, observacao: "" }));
    expect(b.ok).toBe(true);
    await db.update(lancamentos).set({ status: "cancelado", motivoCancelamento: "Teste" }).where(eq(lancamentos.id, cancelado));

    const r = await listar(fin);
    expect(r.totais).toEqual({
      pagar: { vencidos: 10000n, venceHoje: 20000n, aVencer: 45000n, baixados: 80000n },
      receber: { vencidos: 0n, venceHoje: 0n, aVencer: 3200n, baixados: 0n },
    });
    const sit = Object.fromEntries(r.linhas.map((l) => [l.id, l.situacao]));
    expect([sit[vencido], sit[deHoje], sit[futuro], sit[baixado]]).toEqual(["vencida", "vence_hoje", "a_vencer", "baixada"]);
    expect(sit[cancelado]).toBeUndefined();
    expect(r.linhas.find((l) => l.id === baixado)!.contaBancaria).toBe("Banco do Brasil");

    // A aba não muda os totais (os dois lados sempre); a situação filtra a lista, não os totais.
    const soPagarVencidas = await listar(fin, { lado: "pagar", situacao: "vencida" });
    expect(soPagarVencidas.linhas.map((l) => l.id)).toEqual([vencido]);
    expect(soPagarVencidas.totais).toEqual(r.totais);
    const canceladas = await listar(fin, { situacao: "cancelada" });
    expect(canceladas.linhas.map((l) => [l.id, l.situacao])).toEqual([[cancelado, "cancelada"]]);
    expect(canceladas.totais).toEqual(r.totais);

    // Centro e categoria mudam os totais.
    expect((await listar(fin, { centro: "MT" })).totais.receber.aVencer).toBe(0n);
    expect((await listar(fin, { centro: "RS" })).totais.pagar).toEqual({ vencidos: 0n, venceHoje: 0n, aVencer: 0n, baixados: 0n });
    expect((await listar(fin, { categoriaId: telefone })).totais.pagar).toEqual({ vencidos: 0n, venceHoje: 0n, aVencer: 5000n, baixados: 0n });
    expect((await listar(fin, { grupo: "Administrativo" })).totais.pagar.aVencer).toBe(45000n);
    expect((await listar(fin, { busca: "celular" })).linhas).toHaveLength(1);
    expect((await listar(fin, { busca: "AGENCIA" })).linhas).toHaveLength(1);
    expect((await listar(fin, { busca: "%" })).linhas).toHaveLength(0);
    expect((await listar(fin, { origem: "viagem" })).linhas).toHaveLength(0);
    expect((await listar(fin, { contaBancariaId: cb })).linhas.map((l) => l.id)).toEqual([baixado]);

    // Período: vencimento a partir de amanhã; os baixados contam pela data da baixa (hoje) → fora.
    const daqui = await listar(fin, { de: dias(hoje, 1) });
    expect(daqui.totais.pagar).toEqual({ vencidos: 0n, venceHoje: 0n, aVencer: 45000n, baixados: 0n });
    // Baixa no período mesmo com vencimento fora dele.
    const soHoje = await listar(fin, { de: hoje, ate: hoje });
    expect(soHoje.totais.pagar).toEqual({ vencidos: 0n, venceHoje: 20000n, aVencer: 0n, baixados: 80000n });
    // Base da baixa: só as baixadas no período.
    const pelaBaixa = await listar(fin, { base: "baixa", de: hoje, ate: hoje });
    expect(pelaBaixa.linhas.map((l) => l.id)).toEqual([baixado]);
    // Base competência: compara o mês.
    const competencia = await listar(fin, { base: "competencia", de: `${competenciaDe(dias(hoje, 10))}-01`, ate: `${competenciaDe(dias(hoje, 10))}-01` });
    expect(competencia.linhas.some((l) => l.id === futuro)).toBe(true);
    expect(competencia.linhas.every((l) => l.competencia === competenciaDe(dias(hoje, 10)))).toBe(true);
  });

  it("paginação de 50 no servidor, pela ordem de vencimento", async () => {
    const fin = (await criarUsuarioTeste("fin_operacional")).id;
    await manual(fin, { vencimento: "2027-01-04", valor: "10,00", categoria: await categoria("Aluguel"), repeticao: { tipo: "recorrente", frequencia: "semanal", quantidade: 55 } });
    const p1 = await listar(fin);
    const p2 = await listar(fin, { pagina: 2 });
    expect(p1.totalLinhas).toBe(55);
    expect(p1.linhas).toHaveLength(50);
    expect(p2.linhas).toHaveLength(5);
    expect(p2.linhas[0].vencimento > p1.linhas[49].vencimento).toBe(true);
    expect(p1.totais.pagar.aVencer).toBe(55n * 1000n);
  });

  it("mesma baixa: a parcela baixada pela lista fica igual à baixada pela viagem (margem real idêntica)", async () => {
    const x = await vendida();
    const cb = await contaBancaria(x.fin.id);
    const p1 = x.parcelas[0];
    const dados = { recebidaEm: hojeEmCuiaba(), valorRecebido: reais(p1.valor - 10000n), taxaEfetiva: "5,00", observacao: "Cliente pagou a menos", contaBancariaId: cb };
    expect(await comSessao(x.fin.id, () => baixarLinha("parcela", p1.id, dados))).toEqual({ ok: true });
    const f1 = await comSessao(x.fin.id, () => obterViagemVendida(x.viagemId));
    expect(f1!.parcelas[0]).toMatchObject({ status: "recebida", valorRecebido: p1.valor - 10000n });
    const real1 = f1!.estrategico!.real;
    if ("erro" in real1) throw new Error(real1.erro);
    expect(f1!.resumo.recebido).toBe(p1.valor - 10000n);
    expect(await comSessao(x.fin.id, () => desfazerBaixaLinha("parcela", p1.id))).toEqual({ ok: true });
    expect((await db.select().from(parcelasReceber).where(eq(parcelasReceber.id, p1.id)))[0].status).toBe("a_receber");
    expect(await comSessao(x.fin.id, () => baixarParcela(p1.id, dados))).toEqual({ ok: true });
    const f2 = await comSessao(x.fin.id, () => obterViagemVendida(x.viagemId));
    expect(f2!.estrategico!.real).toEqual(real1);
  });

  it("baixar e desfazer pela lista: manual, pagamento e comissão", async () => {
    const x = await vendida();
    const cb = await contaBancaria(x.fin.id);
    const hoje = hojeEmCuiaba();
    const [m] = await manual(x.fin.id, { vencimento: "2027-01-31", valor: "300,00", categoria: await categoria("Aluguel") });
    const ops: [Origem, string, Record<string, unknown>][] = [
      ["manual", m, { data: hoje, valorPago: "300,00", juros: "", desconto: "", contaBancariaId: cb, observacao: "" }],
      ["pagamento", x.pagPasseio.id, { pagoEm: hoje, valorOriginalPago: reais(x.pagPasseio.valorOriginal), contaBancariaId: cb }],
      ["comissao", x.comissao.id, { recebidaEm: hoje, valorRecebido: reais(x.comissao.valorPrevisto), contaBancariaId: cb }],
    ];
    for (const [origem, id, d] of ops) expect(await comSessao(x.fin.id, () => baixarLinha(origem, id, d))).toEqual({ ok: true });
    let r = await listar(x.fin.id);
    for (const [origem, id] of ops) expect(r.linhas.find((l) => l.origem === origem && l.id === id)).toMatchObject({ situacao: "baixada", baixadoEm: hoje, contaBancariaId: cb });
    for (const [origem, id] of ops) expect(await comSessao(x.fin.id, () => desfazerBaixaLinha(origem, id))).toEqual({ ok: true });
    r = await listar(x.fin.id);
    for (const [origem, id] of ops) expect(r.linhas.find((l) => l.origem === origem && l.id === id)!.situacao).toBe("a_vencer");
    // Entradas inválidas.
    expect(await comSessao(x.fin.id, () => baixarLinha("outra" as Origem, m, {}))).toMatchObject({ ok: false });
    expect(await comSessao(x.fin.id, () => baixarLinha("manual", "nao-e-uuid", {}))).toMatchObject({ ok: false, erro: "Lançamento não encontrado" });
  });

  it("Review Focus 2: baixarLinha e baixarParcela ao mesmo tempo na mesma parcela → um ok e um 'Parcela já recebida'", async () => {
    const x = await vendida();
    const cb = await contaBancaria(x.fin.id);
    const p1 = x.parcelas[0];
    const d = { recebidaEm: hojeEmCuiaba(), valorRecebido: reais(p1.valor), taxaEfetiva: null, observacao: null, contaBancariaId: cb };
    const rs = await comSessao(x.fin.id, () => Promise.all([baixarLinha("parcela", p1.id, d), baixarParcela(p1.id, d)]));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok)).toEqual([{ ok: false, erro: MSG_PARCELA_RECEBIDA }]);
    expect(MSG_PARCELA_RECEBIDA).toBe("Parcela já recebida");
  });

  it("parcela de repasse: baixarLinha recusa e aponta para o repasse", async () => {
    const x = await vendida({ cartao: "hotel" });
    const cb = await contaBancaria(x.fin.id);
    const d = { recebidaEm: hojeEmCuiaba(), valorRecebido: reais(x.parcelas[0].valor), taxaEfetiva: null, observacao: null, contaBancariaId: cb };
    expect(await comSessao(x.fin.id, () => baixarLinha("parcela", x.parcelas[0].id, d))).toEqual({ ok: false, erro: "Use o repasse do fornecedor para esta parcela" });
  });

  it("consultor: listarLancamentos lança ErroAcesso; baixarEmLote, baixarLinha e desfazerBaixaLinha → Sem permissão", async () => {
    const consultor = (await criarUsuarioTeste("consultor")).id;
    await expect(listar(consultor)).rejects.toBeInstanceOf(ErroAcesso);
    const id = "00000000-0000-4000-8000-000000000000";
    expect(await comSessao(consultor, () => baixarEmLote({ itens: [{ origem: "manual", id }], data: hojeEmCuiaba(), contaBancariaId: id }))).toEqual(SEM_PERMISSAO);
    expect(await comSessao(consultor, () => baixarLinha("manual", id, {}))).toEqual(SEM_PERMISSAO);
    expect(await comSessao(consultor, () => desfazerBaixaLinha("manual", id))).toEqual(SEM_PERMISSAO);
  });
});

describe("baixa em lote", () => {
  beforeEach(limparBanco);

  const statusManuais = async (ids: string[]) =>
    (await db.select({ id: lancamentos.id, status: lancamentos.status }).from(lancamentos).where(inArray(lancamentos.id, ids))).map((l) => l.status);

  it("Review Focus 3: 2 manuais + pagamento em EUR → recusado inteiro, aponta o EUR, nada baixado", async () => {
    const x = await vendida();
    const cb = await contaBancaria(x.fin.id);
    const aluguel = await categoria("Aluguel");
    const [a] = await manual(x.fin.id, { vencimento: "2027-01-31", valor: "100,00", categoria: aluguel });
    const [b] = await manual(x.fin.id, { vencimento: "2027-02-28", valor: "200,00", categoria: aluguel });
    const r = await comSessao(x.fin.id, () =>
      baixarEmLote({
        itens: [
          { origem: "manual", id: a },
          { origem: "manual", id: b },
          { origem: "pagamento", id: x.pagTransfer.id },
        ],
        data: hojeEmCuiaba(),
        contaBancariaId: cb,
      }),
    );
    expect(r).toMatchObject({ ok: false, erro: MSG_LOTE_RECUSADO });
    const linhas = (r as { linhas: { origem: string; id: string; motivo: string }[] }).linhas;
    expect(linhas.map(chave)).toEqual([`pagamento:${x.pagTransfer.id}`]);
    expect(linhas[0].motivo).toMatch(/moeda estrangeira/);
    expect(await statusManuais([a, b])).toEqual(["em_aberto", "em_aberto"]);
    expect((await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, x.pagTransfer.id)))[0].status).toBe("a_pagar");
  });

  it("recusa repasse, conta fora do caixa, linha já baixada e lados misturados", async () => {
    const x = await vendida({ cartao: "hotel" });
    const cb = await contaBancaria(x.fin.id);
    const hoje = hojeEmCuiaba();
    const aluguel = await categoria("Aluguel");
    const [a] = await manual(x.fin.id, { vencimento: "2027-01-31", valor: "100,00", categoria: aluguel });
    const [pago] = await manual(x.fin.id, { vencimento: "2027-01-31", valor: "100,00", categoria: aluguel });
    expect((await comSessao(x.fin.id, () => baixarLancamento(pago, { data: hoje, valorPago: "100,00", juros: "", desconto: "", contaBancariaId: cb, observacao: "" }))).ok).toBe(true);
    const lote = (itens: { origem: Origem; id: string }[]) => comSessao(x.fin.id, () => baixarEmLote({ itens, data: hoje, contaBancariaId: cb }));
    const motivos = (r: unknown) => (r as { linhas: { origem: string; id: string }[] }).linhas.map(chave);

    // Conta do hotel (pago pelo cliente no cartão do fornecedor) e linha já baixada.
    const r1 = await lote([
      { origem: "manual", id: a },
      { origem: "pagamento", id: x.pagHotel.id },
      { origem: "manual", id: pago },
    ]);
    expect(r1).toMatchObject({ ok: false, erro: MSG_LOTE_RECUSADO });
    expect(motivos(r1).sort()).toEqual([`manual:${pago}`, `pagamento:${x.pagHotel.id}`].sort());
    // Repasse.
    const r2 = await lote([{ origem: "parcela", id: x.parcelas[0].id }]);
    expect(motivos(r2)).toEqual([`parcela:${x.parcelas[0].id}`]);
    // Lados misturados.
    const r3 = await lote([
      { origem: "manual", id: a },
      { origem: "comissao", id: x.comissao.id },
    ]);
    expect(r3).toMatchObject({ ok: false, erro: MSG_LOTE_LADOS });
    expect(motivos(r3)).toEqual([`comissao:${x.comissao.id}`]);
    // Linha inexistente.
    const r4 = await lote([{ origem: "parcela", id: "00000000-0000-4000-8000-000000000000" }]);
    expect(r4).toMatchObject({ ok: false, erro: MSG_LOTE_RECUSADO });
    expect(await statusManuais([a])).toEqual(["em_aberto"]);
  });

  it("Review Focus 3: manuais + parcelas e manuais + pagamentos BRL de duas viagens → tudo baixado com a mesma data e conta, pelo previsto", async () => {
    const x1 = await vendida();
    const x2 = await vendida();
    const fin = x1.fin.id;
    const cb = await contaBancaria(fin);
    const hoje = hojeEmCuiaba();
    const aluguel = await categoria("Aluguel");
    const rendimentos = await categoria("Rendimentos");
    const pagar = [...(await manual(fin, { vencimento: "2027-01-31", valor: "100,00", categoria: aluguel })), ...(await manual(fin, { vencimento: "2027-02-28", valor: "200,00", categoria: aluguel }))];
    const receber = [
      ...(await manual(fin, { lado: "receber", vencimento: "2027-01-31", valor: "10,00", categoria: rendimentos })),
      ...(await manual(fin, { lado: "receber", vencimento: "2027-02-28", valor: "20,00", categoria: rendimentos })),
    ];
    const itensPagar = [
      ...pagar.map((id) => ({ origem: "manual" as const, id })),
      { origem: "pagamento" as const, id: x1.pagPasseio.id },
      { origem: "pagamento" as const, id: x2.pagAereo.id },
    ];
    const itensReceber = [
      ...receber.map((id) => ({ origem: "manual" as const, id })),
      { origem: "parcela" as const, id: x1.parcelas[0].id },
      { origem: "parcela" as const, id: x2.parcelas[1].id },
    ];
    expect(await comSessao(fin, () => baixarEmLote({ itens: itensPagar, data: hoje, contaBancariaId: cb }))).toEqual({ ok: true });
    expect(await comSessao(fin, () => baixarEmLote({ itens: itensReceber, data: hoje, contaBancariaId: cb }))).toEqual({ ok: true });

    const r = await listar(fin);
    for (const i of [...itensPagar, ...itensReceber]) {
      const l = r.linhas.find((y) => y.origem === i.origem && y.id === i.id)!;
      expect(l).toMatchObject({ situacao: "baixada", baixadoEm: hoje, contaBancariaId: cb });
      expect(l.valorBaixado).toBe(l.valorPrevisto);
    }
    const [pp] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, x1.pagPasseio.id));
    expect(pp).toMatchObject({ status: "pago", valorOriginalPago: x1.pagPasseio.valorOriginal, valorBrlPago: x1.pagPasseio.valorBrlPrevisto, cambioEfetivo: null });
    const [p] = await db.select().from(parcelasReceber).where(eq(parcelasReceber.id, x1.parcelas[0].id));
    expect(p).toMatchObject({ status: "recebida", valorRecebido: x1.parcelas[0].valor, taxaEfetiva: x1.parcelas[0].taxaPrevista, contaBancariaId: cb });
    // A mesma baixa da viagem: a ficha mostra a parcela recebida.
    const f = await comSessao(fin, () => obterViagemVendida(x2.viagemId));
    expect(f!.parcelas[1].status).toBe("recebida");
  });

  it("Review Focus 3: falha depois de gravar parte do lote → rollback total (viagem conciliada no meio)", async () => {
    const x = await vendida();
    const cb = await contaBancaria(x.fin.id);
    const aluguel = await categoria("Aluguel");
    const [a] = await manual(x.fin.id, { vencimento: "2027-01-31", valor: "100,00", categoria: aluguel });
    const [b] = await manual(x.fin.id, { vencimento: "2027-02-28", valor: "200,00", categoria: aluguel });
    // A view não sabe da conciliação: as linhas passam na conferência e o núcleo recusa depois dos manuais gravados.
    await db.update(viagens).set({ conciliadaEm: new Date() }).where(eq(viagens.id, x.viagemId));
    const antes = (await db.select().from(auditoria)).length;
    const r = await comSessao(x.fin.id, () =>
      baixarEmLote({
        itens: [
          { origem: "pagamento", id: x.pagPasseio.id },
          { origem: "manual", id: a },
          { origem: "manual", id: b },
        ],
        data: hojeEmCuiaba(),
        contaBancariaId: cb,
      }),
    );
    expect(r).toMatchObject({ ok: false, erro: MSG_CONCILIADA });
    expect((r as { linhas: { origem: string; id: string }[] }).linhas.map(chave)).toEqual([`pagamento:${x.pagPasseio.id}`]);
    expect(await statusManuais([a, b])).toEqual(["em_aberto", "em_aberto"]);
    expect((await db.select().from(auditoria)).length).toBe(antes);
    expect((await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, x.pagPasseio.id)))[0].status).toBe("a_pagar");
  });

  it("linha baixada por outro antes do lote → recusado inteiro, nada baixado", async () => {
    const x = await vendida();
    const cb = await contaBancaria(x.fin.id);
    const hoje = hojeEmCuiaba();
    const [a] = await manual(x.fin.id, { lado: "receber", vencimento: "2027-01-31", valor: "100,00", categoria: await categoria("Rendimentos") });
    const d = { recebidaEm: hoje, valorRecebido: reais(x.comissao.valorPrevisto), contaBancariaId: cb };
    expect(await comSessao(x.fin.id, () => baixarLinha("comissao", x.comissao.id, d))).toEqual({ ok: true });
    const r = await comSessao(x.fin.id, () =>
      baixarEmLote({
        itens: [
          { origem: "manual", id: a },
          { origem: "comissao", id: x.comissao.id },
          { origem: "parcela", id: x.parcelas[0].id },
        ],
        data: hoje,
        contaBancariaId: cb,
      }),
    );
    expect(r).toMatchObject({ ok: false, erro: MSG_LOTE_RECUSADO });
    expect((r as { linhas: { origem: string; id: string }[] }).linhas.map(chave)).toEqual([`comissao:${x.comissao.id}`]);
    expect(await statusManuais([a])).toEqual(["em_aberto"]);
    expect((await db.select().from(parcelasReceber).where(eq(parcelasReceber.id, x.parcelas[0].id)))[0].status).toBe("a_receber");
    expect((await db.select().from(comissoes).where(and(eq(comissoes.id, x.comissao.id))))[0].status).toBe("recebida");
  });

  it("entrada inválida: sem linhas, repetida, sem conta", async () => {
    const fin = (await criarUsuarioTeste("fin_operacional")).id;
    const hoje = hojeEmCuiaba();
    const id = "00000000-0000-4000-8000-000000000000";
    expect(await comSessao(fin, () => baixarEmLote({ itens: [], data: hoje, contaBancariaId: id }))).toMatchObject({ ok: false, erro: "Escolha ao menos uma linha" });
    expect(await comSessao(fin, () => baixarEmLote({ itens: [{ origem: "manual", id }, { origem: "manual", id }], data: hoje, contaBancariaId: id }))).toMatchObject({ ok: false, erro: "Linha repetida no lote" });
    expect(await comSessao(fin, () => baixarEmLote({ itens: [{ origem: "manual", id }], data: hoje, contaBancariaId: "" }))).toMatchObject({ ok: false });
  });
});
