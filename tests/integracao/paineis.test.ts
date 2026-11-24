import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { margemPonderada } from "@/domain/paineis";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, lancamentosFinanceiros as lf, parcelasReceber, vendas, versoesPrecificacao } from "@/server/db/schema";
import { salvarCliente } from "@/server/actions/clientes";
import { baixarRepasse } from "@/server/actions/financeiro";
import { baixarPagamento, baixarParcela } from "@/server/actions/financeiro-viagem";
import { salvarRegras } from "@/server/actions/regras";
import { enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { obterVisaoGeral } from "@/server/queries/paineis";
import { regrasVigentes } from "@/server/queries/regras";
import { margensVendidas, obterViagemVendida } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { contaBancaria, cotacao, item, souza, vendida } from "../helpers/venda";

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
