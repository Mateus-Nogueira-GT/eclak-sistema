import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { diferencaPp, intervaloDeMeses, margemPonderada, pctAbaixoDe } from "@/domain/paineis";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, comissoes, lancamentosFinanceiros as lf, pagamentosFornecedor, parcelasReceber, usuarios, vendas, versoesPrecificacao } from "@/server/db/schema";
import { formatarReais } from "@/domain/dinheiro";
import { salvarCliente } from "@/server/actions/clientes";
import { baixarLinha, baixarRepasse, cancelarLancamento, criarLancamento } from "@/server/actions/financeiro";
import { baixarPagamento, baixarParcela } from "@/server/actions/financeiro-viagem";
import { salvarRegras } from "@/server/actions/regras";
import { enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { saldosDasContas } from "@/server/queries/caixa";
import { nomeDoConsultor, obterVisaoGeral, relatorioBancos, relatorioConsultores, relatorioContas, relatorioDre, relatorioMargens } from "@/server/queries/paineis";
import { regrasVigentes } from "@/server/queries/regras";
import { margensVendidas, obterViagemVendida } from "@/server/queries/vendas";
import { GET } from "@/app/(app)/financeiro/relatorios/planilha/route";
import { hrefCategoria } from "@/app/(app)/financeiro/relatorios/tabelas";
import { filtroDaUrl } from "@/domain/financeiro-entrada";
import { listarLancamentos } from "@/server/queries/financeiro";
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

/** Pedido aguardando aprovação, criado pelo consultor `uid`. */
async function pedidoAguardando(uid: string) {
  const c = await comSessao(uid, () => salvarCliente(souza));
  if (!c.ok) throw new Error(c.erro);
  const pessoas = (await comSessao(uid, () => obterCliente(c.id)))!.pessoas.map((x) => x.id);
  const o = await comSessao(uid, () => criarOrcamento({ clienteId: c.id, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros: pessoas }));
  if (!o.ok) throw new Error(o.erro);
  const passeio = await item(uid, o.id, { servico: "Belém", cidade: "Lisboa" });
  await cotacao(uid, passeio, { valor: "900,00" });
  const e = await comSessao(uid, () => enviarParaAprovacao(o.id, { forma: { tipo: "pix", parcelas: 1 }, alteracao: "Primeira versão" }));
  if (!e.ok) throw new Error(e.erro);
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
      avisosOcultos: [],
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

    // Abaixo da referência: as não conciliadas (as 3, inclusive a de fora do período) com margem real abaixo dela.
    const referencia = (await comSessao(a.d.id, () => regrasVigentes())).valores.margemReferenciaPct;
    const todas = await margensVendidas([a.viagemId, b.viagemId, fora.viagemId]);
    const abaixo = [...todas.values()].filter((x) => !("erro" in x.real) && pctAbaixoDe(x.real.finalPct, referencia)).length;
    expect(abaixo).toBeGreaterThan(0);
    expect(r.viagensAbaixoReferencia).toBe(abaixo);

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

    await pedidoAguardando(x.u.id);

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
    expect(r.avisos.length + r.avisosOcultos.length).toBeGreaterThanOrEqual(3);
    expect(r.avisosOcultos).toEqual([]);
    // Margem por viagem abre a viagem; parcela e aprovação abrem uma lista.
    expect(margem.agregado).toBe(false);
    expect(parcela.agregado).toBe(true);
    expect(r.avisos.find((a) => a.tipo === "aprovacao")!.agregado).toBe(true);
    expect(r.avisos.length).toBeLessThanOrEqual(8);

    const fe = await criarUsuarioTeste("fin_estrategico");
    const rf = await comSessao(fe.id, () => obterVisaoGeral("30d"));
    expect(rf.avisos.map((a) => a.tipo)).not.toContain("aprovacao");
    expect(rf.avisos.map((a) => a.tipo)).toEqual(expect.arrayContaining(["margem", "parcela"]));
  });

  it("avisos: caixa numa linha só, margem até 3 e um resumo, parcela vencida dentro dos 8 e o excesso listado", async () => {
    const hoje = hojeEmCuiaba();
    const vs = [];
    for (let n = 0; n < 5; n++) vs.push(await vendida());
    const [a] = vs;
    for (const v of vs) await aceite(v.viagemId, dias(hoje, -5));
    // A perde mais margem: passeio pago acima do previsto.
    const cb = await contaBancaria(a.fin.id);
    expect(await comSessao(a.fin.id, () => baixarPagamento(a.pagPasseio.id, { pagoEm: hoje, valorOriginalPago: "800,00", contaBancariaId: cb }))).toEqual({ ok: true });
    const vig = await comSessao(a.d.id, () => regrasVigentes());
    expect((await comSessao(a.d.id, () => salvarRegras({ ...vig.valores, margemReferenciaPct: "99.000" }))).ok).toBe(true);
    // Parcela de cliente e comissão de fornecedor vencidas.
    await db.update(parcelasReceber).set({ vencimento: dias(hoje, -3) }).where(eq(parcelasReceber.id, a.parcelas[0].id));
    await db.update(comissoes).set({ previstaPara: dias(hoje, -3) }).where(eq(comissoes.id, a.comissao.id));
    // Conta da empresa vencida e grande: o caixa fica negativo nas 8 semanas (e vira aviso de contas a pagar).
    await manual(a.fin.id, { categoria: "Aluguel", competencia: dias(hoje, -1).slice(0, 7), vencimento: dias(hoje, -1), valor: "9.000.000,00" });
    await pedidoAguardando(a.u.id);

    const r = await comSessao(a.d.id, () => obterVisaoGeral("30d"));
    expect(r.semanas.every((s) => s.saldoFinal < 0n)).toBe(true);
    const caixa = r.avisos.filter((x) => x.tipo === "caixa");
    expect(caixa).toHaveLength(1);
    const menor = r.semanas.reduce((m, s) => (s.saldoFinal < m.saldoFinal ? s : m));
    expect(caixa[0]).toMatchObject({
      titulo: `Caixa negativo em 8 das próximas 8 semanas, a partir da semana de ${r.semanas[0].rotulo}`,
      detalhe: `Menor saldo projetado: ${formatarReais(menor.saldoFinal)}, na semana de ${menor.rotulo}`,
      href: "/financeiro/caixa",
      agregado: false,
    });

    // Margem: as 5 contam; 3 linhas por viagem (A primeiro, a menor margem real) e um resumo das outras 2.
    expect(r.viagensAbaixoReferencia).toBe(5);
    const margem = r.avisos.filter((x) => x.tipo === "margem");
    expect(margem).toHaveLength(4);
    expect(margem[0].href).toBe(`/viagens/${a.viagemId}`);
    expect(margem.slice(0, 3).every((x) => x.href.startsWith("/viagens/") && !x.agregado)).toBe(true);
    expect(margem[3]).toMatchObject({ titulo: "e mais 2 viagens abaixo da margem de referência", href: "/financeiro/relatorios?rel=margens", agregado: true, responsavel: "Gestão" });

    // Caixa, 4 de margem, parcela, comissão e contas a pagar: 8 na tela; a aprovação fica no excesso.
    expect(r.avisos.map((x) => x.tipo)).toEqual(["caixa", "margem", "margem", "margem", "margem", "parcela", "comissao", "pagar"]);
    expect(r.avisos.filter((x) => x.tipo !== "caixa" && x.tipo !== "margem").every((x) => x.agregado)).toBe(true);
    expect(r.avisosOcultos.map((x) => [x.tipo, x.titulo, x.href])).toEqual([["aprovacao", "1 pedido aguardando aprovação", "/aprovacoes"]]);
  }, 30_000); // cinco viagens vendidas no fixture
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
    // O fixture tem custo fixo: o resultado abaixo prova que ele fica fora.
    expect(real.fixo > 0n).toBe(true);
    const valor = (rotulo: string) => r.linhas.find((l) => l.rotulo === rotulo)!.valor;
    expect(valor("Receita de viagens")).toBe(real.receita);
    expect(valor("(-) Custo dos fornecedores")).toBe(-real.custo);
    expect(valor("(-) Imposto sobre a margem")).toBe(-real.imposto);
    expect(valor("(-) Taxas financeiras")).toBe(-real.taxas);
    expect(r.resultado).toBe(real.receita - real.custo - real.imposto - real.taxas - 200000n - 30000n - 15000n);
    expect(valor("(=) Resultado do período")).toBe(r.resultado);
    expect(r.semMargem).toEqual([]);

    // O link da categoria na DRE abre a lista com as compras do cartão uma a uma; sem o filtro, a lista as esconde.
    const papelaria = categorias.find((l) => l.rotulo === "Papelaria")!;
    const href = new URL(hrefCategoria(papelaria.categoriaId!, JANEIRO), "http://x");
    const filtro = filtroDaUrl(Object.fromEntries(href.searchParams), hojeEmCuiaba());
    expect(filtro.compras).toBe("incluir");
    const comCompras = await comSessao(fin, () => listarLancamentos(filtro));
    expect(comCompras.linhas.map((l) => [l.origem, l.valorPrevisto, l.faturaCartaoId !== null])).toEqual([["manual", 30000n, true]]);
    const semCompras = await comSessao(fin, () => listarLancamentos({ ...filtro, compras: undefined }));
    expect(semCompras.linhas).toEqual([]);

    // Mês sem nada: só os totais, zerados.
    const vazio = await comSessao(fin, () => relatorioDre(intervaloDeMeses("2027-03", "2027-03")));
    expect(vazio.resultado).toBe(0n);
    expect(vazio.linhas.every((l) => l.nivel === "total" && l.valor === 0n)).toBe(true);
  });

  it("contas a pagar e a receber: pelo vencimento, sem canceladas, compras do cartão pela fatura, situação e totais da lista", async () => {
    const hoje = hojeEmCuiaba();
    const ontem = dias(hoje, -1);
    const amanha = dias(hoje, 1);
    // De ontem até o fim do mês seguinte (a fatura de uma compra de hoje vence no dia 25 deste mês ou do próximo).
    const periodo = intervaloDeMeses(ontem.slice(0, 7), dias(hoje, 40).slice(0, 7));
    const x = await vendida();
    const fin = x.fin.id;
    const cb = await contaBancaria(fin);
    const k = await cartaoCorporativo(fin, cb);
    // Contas e parcelas da viagem para longe do período; só o passeio e a 1ª parcela voltam para dentro.
    const contasDaViagem = [x.hotel.id, x.passeio.id, x.transfer.id, x.aereo.id];
    await db.update(pagamentosFornecedor).set({ vencimento: "2029-06-01" }).where(inArray(pagamentosFornecedor.contaId, contasDaViagem));
    await db.update(pagamentosFornecedor).set({ vencimento: dias(hoje, 2) }).where(eq(pagamentosFornecedor.id, x.pagPasseio.id));
    await db.update(parcelasReceber).set({ vencimento: "2029-06-01" }).where(eq(parcelasReceber.viagemId, x.viagemId));
    await db.update(parcelasReceber).set({ vencimento: ontem }).where(eq(parcelasReceber.id, x.parcelas[0].id));

    const comp = (d: string) => d.slice(0, 7);
    const aluguel = await manual(fin, { categoria: "Aluguel", competencia: comp(ontem), vencimento: ontem, valor: "2.000,00", descricao: "Aluguel do mês" });
    const internet = await manual(fin, { categoria: "Internet", competencia: comp(hoje), vencimento: hoje, valor: "50,00" });
    const telefone = await manual(fin, { categoria: "Telefone", competencia: comp(amanha), vencimento: amanha, valor: "80,00" });
    const paga = await manual(fin, { categoria: "Serviços contratados", competencia: comp(hoje), vencimento: hoje, valor: "100,00" });
    expect(await comSessao(fin, () => baixarLinha("manual", paga, { data: hoje, valorPago: "90,00", observacao: "Desconto do fornecedor", contaBancariaId: cb }))).toEqual({ ok: true });
    const cancelada = await manual(fin, { categoria: "Seguros", competencia: comp(hoje), vencimento: hoje, valor: "500,00" });
    expect(await comSessao(fin, () => cancelarLancamento(cancelada, "Lançado por engano", "esta"))).toMatchObject({ ok: true });
    const compra = await manual(fin, { categoria: "Papelaria", competencia: comp(hoje), vencimento: hoje, valor: "120,00", cartaoId: k });
    const foraDoPeriodo = await manual(fin, { categoria: "Telefone", competencia: comp(dias(periodo.ate, 1)), vencimento: dias(periodo.ate, 1), valor: "70,00" });
    const [fatura] = await db.select().from(lf).where(eq(lf.origem, "fatura_cartao"));
    expect(fatura.vencimento >= hoje && fatura.vencimento <= periodo.ate).toBe(true);
    const passeioPrevisto = (await linha("pagamento", x.pagPasseio.id)).valorPrevisto;

    const r = await comSessao(fin, () => relatorioContas("pagar", periodo));
    const ids = r.linhas.map((l) => l.id);
    expect(ids).not.toContain(cancelada);
    expect(ids).not.toContain(compra);
    expect(ids).not.toContain(foraDoPeriodo);
    expect(r.linhas).toHaveLength(6);
    expect(r.linhas.find((l) => l.id === aluguel)).toEqual({
      origem: "manual",
      id: aluguel,
      vencimento: ontem,
      pessoa: "Fornecedor local",
      descricao: "Aluguel do mês",
      categoria: "Aluguel",
      viagemId: null,
      viagemCodigo: null,
      valor: 200000n,
      situacao: "Vencida",
    });
    expect(r.linhas.find((l) => l.id === internet)).toMatchObject({ valor: 5000n, situacao: "Vence hoje" });
    expect(r.linhas.find((l) => l.id === telefone)).toMatchObject({ valor: 8000n, situacao: "A vencer" });
    // Baixada: o valor pago, rótulo do lado.
    expect(r.linhas.find((l) => l.id === paga)).toMatchObject({ valor: 9000n, situacao: "Paga" });
    const passeio = r.linhas.find((l) => l.id === x.pagPasseio.id)!;
    expect(passeio).toMatchObject({ origem: "pagamento", viagemId: x.viagemId, valor: passeioPrevisto, situacao: "A vencer" });
    expect(passeio.viagemCodigo).toMatch(/.+/);
    expect(r.linhas.find((l) => l.origem === "fatura_cartao")).toMatchObject({ id: fatura.id, valor: 12000n, situacao: "A vencer" });
    expect(r.totais).toEqual({ Vencida: 200000n, "Vence hoje": 5000n, Paga: 9000n, "A vencer": 8000n + passeioPrevisto + 12000n });

    // A receber: a 1ª parcela da viagem, baixada, como "Recebida"; a 2ª fora do período.
    const p = x.parcelas[0];
    expect(await comSessao(fin, () => baixarParcela(p.id, { recebidaEm: hoje, valorRecebido: reais(p.valor), taxaEfetiva: null, observacao: null, contaBancariaId: cb }))).toEqual({ ok: true });
    const rr = await comSessao(fin, () => relatorioContas("receber", periodo));
    expect(rr.linhas.find((l) => l.id === p.id)).toMatchObject({ origem: "parcela", viagemId: x.viagemId, valor: (await linha("parcela", p.id)).valorBaixado, situacao: "Recebida" });
    expect(rr.linhas.map((l) => l.id)).not.toContain(x.parcelas[1].id);
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
    // O nome do consultor do filtro não depende de vendas no período; consultor não lê.
    const [consultorA] = await db.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, a.u.id));
    expect(await comSessao(fin, () => nomeDoConsultor(a.u.id))).toBe(consultorA.nome);
    expect(await comSessao(fin, () => relatorioMargens(intervaloDeMeses("2027-03", "2027-03"), a.u.id))).toEqual([]);
    await expect(comSessao(a.u.id, () => nomeDoConsultor(a.u.id))).rejects.toBeInstanceOf(ErroAcesso);

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

describe("planilha dos relatórios (CSV)", () => {
  beforeEach(limparBanco);
  const url = (q: string) => new Request(`http://localhost/financeiro/relatorios/planilha?${q}`);

  it("financeiro baixa o CSV com BOM, tipo e nome do arquivo; consultor recebe 403 sem corpo", async () => {
    const a = await vendida();
    await aceite(a.viagemId, "2027-01-05");

    const resposta = await comSessao(a.fin.id, () => GET(url("rel=margens&de=2027-01&ate=2027-01")));
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(resposta.headers.get("content-disposition")).toBe('attachment; filename="relatorio-margens-2027-01.csv"');
    // `text()` descarta o BOM: confere os bytes (EF BB BF) e o texto depois deles.
    const bytes = new Uint8Array(await resposta.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const texto = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(texto.startsWith("\uFEFFViagem;Cliente;Destino;Valor vendido;Planejada;Real;Diferença (pontos)\r\n")).toBe(true);
    expect(texto).toContain("Itália");

    // Filtrada por consultor: o nome do arquivo diz que é só de um consultor.
    const doConsultor = await comSessao(a.fin.id, () => GET(url(`rel=margens&de=2027-01&ate=2027-01&consultor=${a.u.id}`)));
    expect(doConsultor.headers.get("content-disposition")).toBe('attachment; filename="relatorio-margens-2027-01-consultor.csv"');
    expect(await doConsultor.text()).toContain("Itália");

    const dre = await comSessao(a.fin.id, () => GET(url("rel=dre&de=2027-01&ate=2027-03")));
    expect(dre.headers.get("content-disposition")).toBe('attachment; filename="relatorio-dre-2027-01_2027-03.csv"');
    expect(await dre.text()).toMatch(/^Linha;Valor\r\n/);

    const negada = await comSessao(a.u.id, () => GET(url("rel=dre&de=2027-01&ate=2027-01")));
    expect(negada.status).toBe(403);
    expect(await negada.text()).toBe("");
    expect(negada.headers.get("content-type") ?? "").not.toMatch(/csv/);
  });

  it("período inválido cai no mês atual; rel desconhecido vira DRE", async () => {
    const a = await vendida();
    const r = await comSessao(a.fin.id, () => GET(url("rel=xx&de=2027-05&ate=2027-01")));
    expect(r.headers.get("content-disposition")).toBe(`attachment; filename="relatorio-dre-${hojeEmCuiaba().slice(0, 7)}.csv"`);
  });
});
