import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { diferencaPp, intervaloDeMeses, margemPonderada } from "@/domain/paineis";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, lancamentosFinanceiros as lf, pagamentosFornecedor, parcelasReceber, vendas, versoesPrecificacao } from "@/server/db/schema";
import { salvarCliente } from "@/server/actions/clientes";
import { baixarLinha, baixarRepasse, cancelarLancamento, criarLancamento } from "@/server/actions/financeiro";
import { baixarPagamento, baixarParcela } from "@/server/actions/financeiro-viagem";
import { salvarRegras } from "@/server/actions/regras";
import { enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { saldosDasContas } from "@/server/queries/caixa";
import { obterVisaoGeral, relatorioBancos, relatorioConsultores, relatorioContas, relatorioDre, relatorioMargens } from "@/server/queries/paineis";
import { regrasVigentes } from "@/server/queries/regras";
import { margensVendidas, obterViagemVendida } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { cartaoCorporativo, contaBancaria, cotacao, item, souza, vendida } from "../helpers/venda";

function dias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

const reais = (c: bigint) => `${c / 100n},${(c % 100n).toString().padStart(2, "0")}`;

async function aceite(viagemId: string, data: string) {
  await db.update(vendas).set({ aceiteEm: data }).where(eq(vendas.viagemId, viagemId));
}

async function totalVendido(viagemId: string): Promise<bigint> {
  const [v] = await db.select({ total: vendas.total }).from(vendas).where(eq(vendas.viagemId, viagemId));
  return v.total;
}

async function linha(origem: "parcela" | "pagamento", id: string) {
  const [l] = await db.select().from(lf).where(and(eq(lf.origem, origem), eq(lf.id, id)));
  return l;
}

describe("obterVisaoGeral", () => {
  beforeEach(limparBanco);

  it("Review Focus 4: só diretor e fin_estrategico", async () => {
    for (const perfil of ["consultor", "operacional", "fin_operacional"] as const) {
      const u = await criarUsuarioTeste(perfil);
      await expect(comSessao(u.id, () => obterVisaoGeral("30d"))).rejects.toBeInstanceOf(ErroAcesso);
    }
    for (const perfil of ["diretor", "fin_estrategico"] as const) {
      const u = await criarUsuarioTeste(perfil);
      await expect(comSessao(u.id, () => obterVisaoGeral("30d"))).resolves.toMatchObject({ hoje: hojeEmCuiaba() });
    }
  });

  it("banco vazio: zeros, margens nulas, sem avisos e sem exceção", async () => {
    const d = await criarUsuarioTeste("diretor");
    const r = await comSessao(d.id, () => obterVisaoGeral("mes"));
    expect(r).toMatchObject({
      vendido: 0n,
      viagensVendidas: 0,
      variacaoVendidoPct: null,
      margemRealPct: null,
      margemPlanejadaPct: null,
      recebido: 0n,
      pago: 0n,
      resultadoCaixa: 0n,
      primeiraNegativa: null,
      avisos: [],
      avisosRestantes: 0,
      perdas: [],
      viagensAbaixoReferencia: 0,
    });
    expect(r.semanas).toHaveLength(8);
    expect(r.margemReferenciaPct).toBe((await comSessao(d.id, () => regrasVigentes())).valores.margemReferenciaPct);
  });

  it("Review Focus 2: vendido e margens só das viagens com aceite no período; margem real igual à da tela da viagem", async () => {
    const hoje = hojeEmCuiaba();
    const a = await vendida();
    const b = await vendida();
    const fora = await vendida();
    await aceite(a.viagemId, dias(hoje, -5));
    await aceite(b.viagemId, dias(hoje, -10));
    await aceite(fora.viagemId, dias(hoje, -40)); // no período anterior dos 30 dias
    // Passeio de A pago acima do previsto: A perde margem.
    const cb = await contaBancaria(a.fin.id);
    expect(await comSessao(a.fin.id, () => baixarPagamento(a.pagPasseio.id, { pagoEm: hoje, valorOriginalPago: "800,00", contaBancariaId: cb }))).toEqual({ ok: true });

    const r = await comSessao(a.d.id, () => obterVisaoGeral("30d"));
    const va = await totalVendido(a.viagemId);
    const vb = await totalVendido(b.viagemId);
    const vf = await totalVendido(fora.viagemId);
    expect(r.viagensVendidas).toBe(2);
    expect(r.vendido).toBe(va + vb);
    const variacao = ((Number(va + vb - vf) / Number(vf)) * 100).toFixed(1);
    expect(r.variacaoVendidoPct).toBe(variacao);

    const m = await margensVendidas([a.viagemId, b.viagemId]);
    const reais_ = [...m.values()].map((x) => {
      if ("erro" in x.real) throw new Error("margem sem cálculo no fixture");
      return { final: x.real.final, receita: x.real.receita };
    });
    expect(r.margemRealPct).toBe(margemPonderada(reais_));
    expect(r.margemRealPct).not.toBeNull();
    // Planejada: Σ final planejado ÷ Σ preço do pacote da versão vendida.
    const precos = await db
      .select({ viagemId: vendas.viagemId, preco: versoesPrecificacao.preco })
      .from(vendas)
      .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, vendas.versaoId));
    const planejadas = [a.viagemId, b.viagemId].map((id) => ({ final: m.get(id)!.planejada.final, receita: precos.find((x) => x.viagemId === id)!.preco }));
    expect(r.margemPlanejadaPct).toBe(margemPonderada(planejadas));

    // A viagem A aparece nas perdas com a mesma margem real da tela da viagem.
    const telaA = await comSessao(a.d.id, () => obterViagemVendida(a.viagemId));
    const realA = telaA!.estrategico!.real;
    if ("erro" in realA) throw new Error("margem sem cálculo");
    const perdaA = r.perdas.find((p) => p.viagemId === a.viagemId);
    expect(perdaA).toBeDefined();
    expect(perdaA!.realPct).toBe(realA.finalPct);
    expect(perdaA!.planejadaPct).toBe(telaA!.estrategico!.planejada.finalPct);
    expect(perdaA!.vendido).toBe(telaA!.resumo.valorVendido);
    expect(r.perdas[0].viagemId).toBe(a.viagemId);
    for (const p of r.perdas) expect(Number(p.diferencaPp)).toBeLessThan(0);
    // Toda margem real das perdas confere com a tela da viagem.
    for (const p of r.perdas) {
      const tela = await comSessao(a.d.id, () => obterViagemVendida(p.viagemId));
      const real = tela!.estrategico!.real;
      expect("erro" in real ? null : real.finalPct).toBe(p.realPct);
    }
  });

  it("recebido e pago pelas baixas do período no caixa; pagamento quitado pelo cartão direto não entra", async () => {
    const hoje = hojeEmCuiaba();
    const x = await vendida({ forma: { tipo: "pix", parcelas: 1 } });
    const cb = await contaBancaria(x.fin.id);
    const p = x.parcelas[0];
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, { recebidaEm: hoje, valorRecebido: reais(p.valor), taxaEfetiva: null, observacao: null, contaBancariaId: cb }))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagPasseio.id, { pagoEm: hoje, valorOriginalPago: reais(x.pagPasseio.valorOriginal), contaBancariaId: cb }))).toEqual({ ok: true });

    const y = await vendida({ cartao: "hotel" });
    const cbY = await contaBancaria(y.fin.id, "Sicredi");
    const repasse = (await linha("parcela", y.parcelas[0].id)).valorPrevisto;
    expect(await comSessao(y.fin.id, () => baixarRepasse(y.parcelas[0].id, { data: hoje, valorRepassado: reais(repasse), contaBancariaId: cbY }))).toEqual({ ok: true });
    expect(await linha("pagamento", y.pagHotel.id)).toMatchObject({ statusBase: "baixado", transitaCaixa: false });

    const r = await comSessao(x.d.id, () => obterVisaoGeral("30d"));
    expect(r.recebido).toBe(p.valor + repasse);
    expect(r.pago).toBe(x.pagPasseio.valorOriginal);
    expect(r.resultadoCaixa).toBe(r.recebido - r.pago);
  });

  it("avisos: parcela vencida, margem abaixo da referência e aprovação só para o diretor", async () => {
    const hoje = hojeEmCuiaba();
    const x = await vendida();
    await aceite(x.viagemId, dias(hoje, -5));
    const p = x.parcelas[0];
    await db.update(parcelasReceber).set({ vencimento: dias(hoje, -3) }).where(eq(parcelasReceber.id, p.id));
    const vig = await comSessao(x.d.id, () => regrasVigentes());
    expect((await comSessao(x.d.id, () => salvarRegras({ ...vig.valores, margemReferenciaPct: "99.000" }))).ok).toBe(true);

    // Pedido aguardando aprovação.
    const c = await comSessao(x.u.id, () => salvarCliente(souza));
    if (!c.ok) throw new Error(c.erro);
    const pessoas = (await comSessao(x.u.id, () => obterCliente(c.id)))!.pessoas.map((x) => x.id);
    const o = await comSessao(x.u.id, () => criarOrcamento({ clienteId: c.id, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros: pessoas }));
    if (!o.ok) throw new Error(o.erro);
    const passeio = await item(x.u.id, o.id, { servico: "Belém", cidade: "Lisboa" });
    await cotacao(x.u.id, passeio, { valor: "900,00" });
    const e = await comSessao(x.u.id, () => enviarParaAprovacao(o.id, { forma: { tipo: "pix", parcelas: 1 }, alteracao: "Primeira versão" }));
    if (!e.ok) throw new Error(e.erro);

    const r = await comSessao(x.d.id, () => obterVisaoGeral("30d"));
    const tipos = r.avisos.map((a) => a.tipo);
    expect(tipos).toEqual(expect.arrayContaining(["margem", "parcela", "aprovacao"]));
    // Ordem: margem antes de parcela, aprovação por último.
    expect(tipos.indexOf("margem")).toBeLessThan(tipos.indexOf("parcela"));
    expect(tipos.at(-1)).toBe("aprovacao");

    expect(r.viagensAbaixoReferencia).toBe(1);
    expect(r.viagensAbaixoReferencia).toBe(r.avisos.filter((a) => a.tipo === "margem").length);
    const margem = r.avisos.find((a) => a.tipo === "margem")!;
    expect(margem).toMatchObject({ href: `/viagens/${x.viagemId}`, responsavel: "Gestão" });
    const parcela = r.avisos.find((a) => a.tipo === "parcela")!;
    expect(parcela.responsavel).toBe("Financeiro");
    expect(parcela.titulo).toBe("1 parcela de cliente vencida");
    const [vendasViagem] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, "vendas_viagem"));
    const q = new URL(parcela.href, "http://x").searchParams;
    expect(Object.fromEntries(q)).toEqual({
      lado: "receber",
      base: "vencimento",
      situacao: "vencida",
      origem: "viagem",
      categoriaId: vendasViagem.id,
      de: dias(hoje, -3),
      ate: dias(hoje, -1),
    });
    expect(r.avisos.find((a) => a.tipo === "aprovacao")).toMatchObject({ titulo: "1 pedido aguardando aprovação", href: "/aprovacoes" });
    expect(r.avisos.length + r.avisosRestantes).toBeGreaterThanOrEqual(3);
    expect(r.avisos.length).toBeLessThanOrEqual(8);

    const fe = await criarUsuarioTeste("fin_estrategico");
    const rf = await comSessao(fe.id, () => obterVisaoGeral("30d"));
    expect(rf.avisos.map((a) => a.tipo)).not.toContain("aprovacao");
    expect(rf.avisos.map((a) => a.tipo)).toEqual(expect.arrayContaining(["margem", "parcela"]));
  });
});

async function categoria(nome: string): Promise<string> {
  const [c] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, nome));
  return c.id;
}

/** Lançamento manual a pagar (PIX, ou no cartão corporativo com `cartaoId`); devolve o id. */
async function manual(uid: string, o: { categoria: string; competencia: string; vencimento: string; valor: string; descricao?: string; cartaoId?: string }) {
  const categoriaId = await categoria(o.categoria);
  const r = await comSessao(uid, () =>
    criarLancamento({
      lado: "pagar",
      descricao: o.descricao ?? "Conta da empresa",
      fornecedorId: "",
      clienteId: "",
      pessoaTexto: "Fornecedor local",
      categoriaId,
      centro: "MT",
      competencia: o.competencia,
      emissao: o.vencimento,
      vencimento: o.vencimento,
      valor: o.valor,
      forma: o.cartaoId ? "Cartão de crédito" : "PIX",
      contaBancariaId: "",
      observacao: "",
      repeticao: { tipo: "unica" },
      ...(o.cartaoId ? { cartaoId: o.cartaoId } : {}),
    }),
  );
  if (!r.ok) throw new Error(r.erro);
  return (r as { ids: string[] }).ids[0];
}

const JANEIRO = intervaloDeMeses("2027-01", "2027-01");

describe("relatórios", () => {
  beforeEach(limparBanco);

  it("Review Focus 4: consultor e operacional recusados em todos; fin_operacional lê", async () => {
    const chamadas: (() => Promise<unknown>)[] = [
      () => relatorioDre(JANEIRO),
      () => relatorioContas("pagar", JANEIRO),
      () => relatorioContas("receber", JANEIRO),
      () => relatorioBancos(JANEIRO),
      () => relatorioMargens(JANEIRO),
      () => relatorioConsultores(JANEIRO),
    ];
    for (const perfil of ["consultor", "operacional"] as const) {
      const u = await criarUsuarioTeste(perfil);
      for (const f of chamadas) await expect(comSessao(u.id, f)).rejects.toBeInstanceOf(ErroAcesso);
    }
    const fo = await criarUsuarioTeste("fin_operacional");
    for (const f of chamadas) await expect(comSessao(fo.id, f)).resolves.toBeDefined();
  });

  it("Review Focus 1: DRE sem dupla contagem do cartão; cancelado e outra competência fora; resultado sem o fixo", async () => {
    const x = await vendida();
    await aceite(x.viagemId, "2027-01-15");
    const fin = x.fin.id;
    const cb = await contaBancaria(fin);
    const k = await cartaoCorporativo(fin, cb);
    // Aluguel com competência de janeiro e vencimento em fevereiro: entra (competência, não vencimento).
    await manual(fin, { categoria: "Aluguel", competencia: "2027-01", vencimento: "2027-02-05", valor: "2.000,00" });
    await manual(fin, { categoria: "Papelaria", competencia: "2027-01", vencimento: "2027-01-10", valor: "300,00", cartaoId: k });
    await manual(fin, { categoria: "Telefone", competencia: "2027-01", vencimento: "2027-01-10", valor: "150,00", cartaoId: k });
    const seguro = await manual(fin, { categoria: "Seguros", competencia: "2027-01", vencimento: "2027-01-12", valor: "500,00" });
    expect(await comSessao(fin, () => cancelarLancamento(seguro, "Lançado por engano", "esta"))).toMatchObject({ ok: true });
    // Outra competência com vencimento em janeiro: fora.
    await manual(fin, { categoria: "Internet", competencia: "2026-12", vencimento: "2027-01-12", valor: "700,00" });

    // A fatura do cartão existe na view, com o total das compras, na mesma competência.
    const faturasDoMes = await db.select().from(lf).where(and(eq(lf.origem, "fatura_cartao"), eq(lf.competencia, "2027-01")));
    expect(faturasDoMes.map((f) => f.valorPrevisto)).toEqual([45000n]);

    const r = await comSessao(fin, () => relatorioDre(JANEIRO));
    const categorias = r.linhas.filter((l) => l.nivel === "categoria");
    expect(categorias.map((l) => [l.rotulo, l.valor])).toEqual([
      ["Aluguel", -200000n],
      ["Papelaria", -30000n],
      ["Telefone", -15000n],
    ]);
    expect(categorias.map((l) => l.categoriaId)).not.toContain(await categoria("Cartão corporativo"));
    expect(r.linhas.find((l) => l.valor === -45000n)).toBeUndefined();
    expect(r.linhas.filter((l) => l.nivel === "grupo")).toEqual([{ rotulo: "Administrativo", valor: -245000n, nivel: "grupo" }]);

    const real = (await margensVendidas([x.viagemId])).get(x.viagemId)!.real;
    if ("erro" in real) throw new Error("margem sem cálculo no fixture");
    const valor = (rotulo: string) => r.linhas.find((l) => l.rotulo === rotulo)!.valor;
    expect(valor("Receita de viagens")).toBe(real.receita);
    expect(valor("(-) Custo dos fornecedores")).toBe(-real.custo);
    expect(valor("(-) Imposto sobre a margem")).toBe(-real.imposto);
    expect(valor("(-) Taxas financeiras")).toBe(-real.taxas);
    expect(r.resultado).toBe(real.receita - real.custo - real.imposto - real.taxas - 200000n - 30000n - 15000n);
    expect(valor("(=) Resultado do período")).toBe(r.resultado);
    expect(r.semMargem).toEqual([]);

    // Mês sem nada: só os totais, zerados.
    const vazio = await comSessao(fin, () => relatorioDre(intervaloDeMeses("2027-03", "2027-03")));
    expect(vazio.resultado).toBe(0n);
    expect(vazio.linhas.every((l) => l.nivel === "total" && l.valor === 0n)).toBe(true);
  });

  it("contas a pagar e a receber: pelo vencimento, sem canceladas, compras do cartão pela fatura, totais por situação", async () => {
    const x = await vendida();
    const fin = x.fin.id;
    const cb = await contaBancaria(fin);
    const k = await cartaoCorporativo(fin, cb);
    await db.update(pagamentosFornecedor).set({ vencimento: "2027-01-20" }).where(eq(pagamentosFornecedor.id, x.pagPasseio.id));
    const aluguel = await manual(fin, { categoria: "Aluguel", competencia: "2027-01", vencimento: "2027-01-05", valor: "2.000,00", descricao: "Aluguel de janeiro" });
    const cancelada = await manual(fin, { categoria: "Seguros", competencia: "2027-01", vencimento: "2027-01-07", valor: "500,00" });
    expect(await comSessao(fin, () => cancelarLancamento(cancelada, "Lançado por engano", "esta"))).toMatchObject({ ok: true });
    const compra = await manual(fin, { categoria: "Papelaria", competencia: "2027-01", vencimento: "2027-01-10", valor: "300,00", cartaoId: k });
    const foraDoMes = await manual(fin, { categoria: "Telefone", competencia: "2027-01", vencimento: "2027-02-03", valor: "80,00" });

    const r = await comSessao(fin, () => relatorioContas("pagar", JANEIRO));
    const ids = r.linhas.map((l) => l.id);
    expect(ids).not.toContain(cancelada);
    expect(ids).not.toContain(compra);
    expect(ids).not.toContain(foraDoMes);
    expect(r.linhas.find((l) => l.id === aluguel)).toMatchObject({
      origem: "manual",
      vencimento: "2027-01-05",
      pessoa: "Fornecedor local",
      descricao: "Aluguel de janeiro",
      categoria: "Aluguel",
      viagemId: null,
      viagemCodigo: null,
      valor: 200000n,
      situacao: "A vencer",
    });
    const passeio = r.linhas.find((l) => l.id === x.pagPasseio.id)!;
    expect(passeio).toMatchObject({ origem: "pagamento", viagemId: x.viagemId, situacao: "A vencer" });
    expect(passeio.viagemCodigo).toMatch(/.+/);
    expect(r.linhas.find((l) => l.origem === "fatura_cartao")).toMatchObject({ valor: 30000n, situacao: "A vencer" });
    for (const l of r.linhas) {
      expect(l.vencimento >= JANEIRO.de && l.vencimento <= JANEIRO.ate).toBe(true);
    }
    const somas: Record<string, bigint> = {};
    for (const l of r.linhas) somas[l.situacao] = (somas[l.situacao] ?? 0n) + l.valor;
    expect(r.totais).toEqual(somas);

    // A receber: a segunda parcela do boleto (vence em 10/01/2027), da viagem.
    const rr = await comSessao(fin, () => relatorioContas("receber", JANEIRO));
    expect(rr.linhas.find((l) => l.id === x.parcelas[1].id)).toMatchObject({ origem: "parcela", viagemId: x.viagemId, valor: x.parcelas[1].valor, situacao: "A vencer" });
    expect(rr.linhas.map((l) => l.id)).not.toContain(x.parcelas[0].id);
  });

  it("volume por banco: baixas do período por conta, fora do período não entra, saldo atual da conta", async () => {
    const hoje = hojeEmCuiaba();
    const mes = intervaloDeMeses(hoje.slice(0, 7), hoje.slice(0, 7));
    const x = await vendida({ forma: { tipo: "pix", parcelas: 1 } });
    const fin = x.fin.id;
    const itau = await contaBancaria(fin, "Itaú");
    const sicredi = await contaBancaria(fin, "Sicredi");
    const p = x.parcelas[0];
    expect(await comSessao(fin, () => baixarParcela(p.id, { recebidaEm: hoje, valorRecebido: reais(p.valor), taxaEfetiva: null, observacao: null, contaBancariaId: itau }))).toEqual({ ok: true });
    expect(await comSessao(fin, () => baixarPagamento(x.pagPasseio.id, { pagoEm: hoje, valorOriginalPago: reais(x.pagPasseio.valorOriginal), contaBancariaId: sicredi }))).toEqual({ ok: true });
    // Baixa no mês anterior, na conta Itaú: fica fora do período (mas entra no saldo atual).
    const antes = dias(mes.de, -1);
    const conta = await manual(fin, { categoria: "Telefone", competencia: antes.slice(0, 7), vencimento: antes, valor: "80,00" });
    expect(await comSessao(fin, () => baixarLinha("manual", conta, { data: antes, valorPago: "80,00", contaBancariaId: itau }))).toEqual({ ok: true });

    const recebido = (await linha("parcela", p.id)).valorCaixaBaixado!;
    const pago = (await linha("pagamento", x.pagPasseio.id)).valorCaixaBaixado!;
    const r = await comSessao(fin, () => relatorioBancos(mes));
    const saldos = await comSessao(fin, () => saldosDasContas());
    expect(r.contas.map((c) => c.nome)).toEqual(["Itaú", "Sicredi"]);
    expect(r.contas[0]).toMatchObject({ contaId: itau, entradas: recebido, saidas: 0n, saldoPeriodo: recebido });
    expect(r.contas[1]).toMatchObject({ contaId: sicredi, entradas: 0n, saidas: pago, saldoPeriodo: -pago });
    for (const c of r.contas) expect(c.saldoAtual).toBe(saldos.find((s) => s.contaId === c.contaId)!.saldoAtual);
    expect(r.contas[0].saldoAtual).toBe(recebido - 8000n);
    expect(r.total).toEqual({ entradas: recebido, saidas: pago, saldoPeriodo: recebido - pago });
  });

  it("margem por viagem e vendas por consultor: margem real igual à da tela da viagem; filtro por consultor", async () => {
    const a = await vendida();
    const b = await vendida();
    await aceite(a.viagemId, "2027-01-05");
    await aceite(b.viagemId, "2027-01-25");
    const cb = await contaBancaria(a.fin.id);
    expect(await comSessao(a.fin.id, () => baixarPagamento(a.pagPasseio.id, { pagoEm: hojeEmCuiaba(), valorOriginalPago: "800,00", contaBancariaId: cb }))).toEqual({ ok: true });
    const fin = a.fin.id;

    const r = await comSessao(fin, () => relatorioMargens(JANEIRO));
    expect(r.map((l) => l.viagemId)).toEqual([a.viagemId, b.viagemId]);
    for (const l of r) {
      const tela = (await comSessao(a.d.id, () => obterViagemVendida(l.viagemId)))!;
      const real = tela.estrategico!.real;
      if ("erro" in real) throw new Error("margem sem cálculo no fixture");
      expect(l).toMatchObject({
        vendido: tela.resumo.valorVendido,
        planejadaPct: tela.estrategico!.planejada.finalPct,
        realPct: real.finalPct,
        diferencaPp: diferencaPp(real.finalPct, tela.estrategico!.planejada.finalPct),
        erro: null,
      });
      expect(l.codigo).toMatch(/.+/);
      expect(l.destino).toBe("Itália");
    }
    expect(Number(r[0].diferencaPp)).toBeLessThan(0);

    const soA = await comSessao(fin, () => relatorioMargens(JANEIRO, a.u.id));
    expect(soA.map((l) => l.viagemId)).toEqual([a.viagemId]);

    const c = await comSessao(fin, () => relatorioConsultores(JANEIRO));
    const m = await margensVendidas([a.viagemId, b.viagemId]);
    const pondera = (id: string) => {
      const real = m.get(id)!.real;
      if ("erro" in real) throw new Error("margem sem cálculo no fixture");
      return { final: real.final, receita: real.receita };
    };
    const va = await totalVendido(a.viagemId);
    const vb = await totalVendido(b.viagemId);
    expect(c.linhas).toHaveLength(2);
    expect(c.linhas.find((l) => l.consultorId === a.u.id)).toMatchObject({ viagens: 1, vendido: va, margemPct: margemPonderada([pondera(a.viagemId)]) });
    expect(c.linhas.find((l) => l.consultorId === b.u.id)).toMatchObject({ viagens: 1, vendido: vb, margemPct: margemPonderada([pondera(b.viagemId)]) });
    expect(c.total).toEqual({ viagens: 2, vendido: va + vb, margemPct: margemPonderada([pondera(a.viagemId), pondera(b.viagemId)]) });
  });
});
