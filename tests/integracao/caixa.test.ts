import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { competenciaDe, type Origem } from "@/domain/financeiro";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, lancamentosFinanceiros as lf, parcelasReceber } from "@/server/db/schema";
import { baixarLancamento, baixarRepasse, criarLancamento, desativarContaBancaria, salvarContaBancaria } from "@/server/actions/financeiro";
import { baixarPagamento, baixarParcela } from "@/server/actions/financeiro-viagem";
import { obterFluxoDeCaixa, saldosDasContas } from "@/server/queries/caixa";
import { listarContasBancarias } from "@/server/queries/financeiro";
import { regrasVigentes } from "@/server/queries/regras";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { contaBancaria, vendida } from "../helpers/venda";

function dias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

const reais = (c: bigint) => `${c / 100n},${(c % 100n).toString().padStart(2, "0")}`;

/** Linha da view com as colunas de caixa. */
async function linha(origem: Origem, id: string) {
  const [l] = await db.select().from(lf).where(and(eq(lf.origem, origem), eq(lf.id, id)));
  return l;
}

async function categoria(nome: string): Promise<string> {
  const [c] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, nome));
  return c.id;
}

async function manual(uid: string, o: { lado: "pagar" | "receber"; vencimento: string; valor: string; categoria: string }) {
  const r = await comSessao(uid, () =>
    criarLancamento({
      lado: o.lado,
      descricao: "Conta da empresa",
      fornecedorId: "",
      clienteId: "",
      pessoaTexto: "Fornecedor local",
      categoriaId: o.categoria,
      centro: "MT",
      competencia: competenciaDe(o.vencimento),
      emissao: "2026-01-02",
      vencimento: o.vencimento,
      valor: o.valor,
      forma: "PIX",
      contaBancariaId: "",
      observacao: "",
      repeticao: { tipo: "unica" },
    }),
  );
  if (!r.ok) throw new Error(r.erro);
  return (r as { ids: string[] }).ids[0];
}

async function baixarManual(uid: string, id: string, data: string, valor: string, cb: string) {
  const r = await comSessao(uid, () => baixarLancamento(id, { data, valorPago: valor, juros: "", desconto: "", contaBancariaId: cb, observacao: "" }));
  if (!r.ok) throw new Error(r.erro);
}

async function contaComSaldo(uid: string, nome: string, saldoInicial: string, saldoInicialEm: string): Promise<string> {
  const r = await comSessao(uid, () => salvarContaBancaria({ nome, banco: "341", saldoInicial, saldoInicialEm }));
  if (!r.ok || !r.id) throw new Error(r.ok ? "Conta bancária sem id" : r.erro);
  return r.id;
}

const CREDITO_3X = { tipo: "credito", parcelas: 3 } as const;

describe("colunas de caixa da view", () => {
  beforeEach(limparBanco);

  it("Review Focus 2: parcela de cartão de crédito entra pelo líquido (previsto − taxa prevista; recebido − taxa efetiva)", async () => {
    const x = await vendida({ forma: CREDITO_3X });
    const cb = await contaBancaria(x.fin.id);
    const p = x.parcelas[0];
    expect(p.meio).toBe("cartao_credito");
    expect(p.taxaPrevista > 0n).toBe(true);
    const aberta = await linha("parcela", p.id);
    expect(aberta.valorPrevisto).toBe(p.valor);
    expect(aberta.valorCaixaPrevisto).toBe(p.valor - p.taxaPrevista);
    expect(aberta.valorCaixaBaixado).toBeNull();
    expect(aberta.dataCaixa).toBe(p.vencimento);
    const d = { recebidaEm: hojeEmCuiaba(), valorRecebido: reais(p.valor), taxaEfetiva: "7,00", observacao: null, contaBancariaId: cb };
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, d))).toEqual({ ok: true });
    const recebida = await linha("parcela", p.id);
    expect(recebida.valorBaixado).toBe(p.valor);
    expect(recebida.valorCaixaBaixado).toBe(p.valor - 700n);
  });

  it("boleto: líquido da taxa prevista; recebido sem taxa efetiva usa a prevista", async () => {
    const x = await vendida();
    const cb = await contaBancaria(x.fin.id);
    const p = x.parcelas[0];
    expect(p.meio).toBe("boleto");
    expect((await linha("parcela", p.id)).valorCaixaPrevisto).toBe(p.valor - p.taxaPrevista);
    const d = { recebidaEm: hojeEmCuiaba(), valorRecebido: reais(p.valor), taxaEfetiva: null, observacao: null, contaBancariaId: cb };
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, d))).toEqual({ ok: true });
    expect((await linha("parcela", p.id)).valorCaixaBaixado).toBe(p.valor - p.taxaPrevista);
  });

  it("Review Focus 2: repasse do cartão direto já é líquido (a taxa não é descontada de novo)", async () => {
    const x = await vendida({ cartao: "hotel" });
    const cb = await contaBancaria(x.fin.id);
    const p = x.parcelas[0];
    const aberta = await linha("parcela", p.id);
    expect(aberta.repasse).toBe(true);
    expect(aberta.valorCaixaPrevisto).toBe(aberta.valorPrevisto);
    const esperado = aberta.valorPrevisto;
    expect(await comSessao(x.fin.id, () => baixarRepasse(p.id, { data: hojeEmCuiaba(), valorRepassado: reais(esperado - 10000n), contaBancariaId: cb }))).toEqual({
      ok: true,
    });
    const recebida = await linha("parcela", p.id);
    expect(recebida.valorBaixado).toBe(esperado - 10000n);
    expect(recebida.valorCaixaBaixado).toBe(esperado - 10000n);
    expect(recebida.valorCaixaPrevisto).toBe(recebida.valorPrevisto);
  });

  it("pix, pagamento, comissão e manual: valor cheio; data = vencimento", async () => {
    const x = await vendida({ forma: { tipo: "pix", parcelas: 1 } });
    const cb = await contaBancaria(x.fin.id);
    const p = x.parcelas[0];
    expect(p.meio).toBe("pix");
    const lp = await linha("parcela", p.id);
    expect(lp).toMatchObject({ valorCaixaPrevisto: lp.valorPrevisto, dataCaixa: lp.vencimento });
    const pg = await linha("pagamento", x.pagPasseio.id);
    expect(pg).toMatchObject({ valorCaixaPrevisto: pg.valorPrevisto, valorCaixaBaixado: null, dataCaixa: pg.vencimento });
    const co = await linha("comissao", x.comissao.id);
    expect(co).toMatchObject({ valorCaixaPrevisto: co.valorPrevisto, dataCaixa: co.vencimento });
    const m = await manual(x.fin.id, { lado: "pagar", vencimento: "2027-01-31", valor: "300,00", categoria: await categoria("Aluguel") });
    expect(await linha("manual", m)).toMatchObject({ valorCaixaPrevisto: 30000n, valorCaixaBaixado: null, dataCaixa: "2027-01-31" });
    const hoje = hojeEmCuiaba();
    await baixarManual(x.fin.id, m, hoje, "300,00", cb);
    expect((await linha("manual", m)).valorCaixaBaixado).toBe(30000n);
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagPasseio.id, { pagoEm: hoje, valorOriginalPago: reais(x.pagPasseio.valorOriginal), contaBancariaId: cb }))).toEqual({ ok: true });
    const pago = await linha("pagamento", x.pagPasseio.id);
    expect(pago.valorCaixaBaixado).toBe(pago.valorBaixado);
    const d = { recebidaEm: hoje, valorRecebido: reais(p.valor), taxaEfetiva: null, observacao: null, contaBancariaId: cb };
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, d))).toEqual({ ok: true });
    expect((await linha("parcela", p.id)).valorCaixaBaixado).toBe(p.valor);
  });

  it("crédito parcelado: cada parcela no seu vencimento (sem antecipação automática, Augusto 23/11/2026)", async () => {
    const y = await vendida({ forma: CREDITO_3X });
    expect(y.parcelas).toHaveLength(3);
    for (const p of y.parcelas) expect((await linha("parcela", p.id)).dataCaixa).toBe(p.vencimento);
  });
});

describe("saldo das contas", () => {
  beforeEach(limparBanco);

  it("saldo inicial + baixas a partir da data do saldo inicial; cartão direto (transita_caixa = false) não mexe", async () => {
    const x = await vendida({ cartao: "hotel" });
    const fin = x.fin.id;
    const hoje = hojeEmCuiaba();
    const D = dias(hoje, -3);
    const cb = await contaComSaldo(fin, "Sicredi", "1.000,00", D);
    const outra = await contaBancaria(fin, "Caixa");
    const aluguel = await categoria("Aluguel");
    const receitas = await categoria("Rendimentos");
    const rec = await manual(fin, { lado: "receber", vencimento: D, valor: "300,00", categoria: receitas });
    const pag = await manual(fin, { lado: "pagar", vencimento: D, valor: "100,00", categoria: aluguel });
    await baixarManual(fin, rec, dias(D, 1), "300,00", cb);
    await baixarManual(fin, pag, dias(D, -1), "100,00", cb);
    let saldos = await comSessao(fin, () => saldosDasContas());
    expect(saldos.find((s) => s.contaId === cb)).toEqual({ contaId: cb, nome: "Sicredi", saldoAtual: 130000n });
    expect(saldos.find((s) => s.contaId === outra)!.saldoAtual).toBe(0n);
    expect((await comSessao(fin, () => listarContasBancarias())).find((c) => c.id === cb)!.saldoAtual).toBe(130000n);

    // Repasse do cartão direto: entra o repasse; o pagamento do hotel (quitado pelo repasse) não sai do banco.
    const rep = await linha("parcela", x.parcelas[0].id);
    expect(await comSessao(fin, () => baixarRepasse(x.parcelas[0].id, { data: hoje, valorRepassado: reais(rep.valorPrevisto), contaBancariaId: cb }))).toEqual({ ok: true });
    const hotel = await linha("pagamento", x.pagHotel.id);
    expect(hotel).toMatchObject({ statusBase: "baixado", transitaCaixa: false });
    saldos = await comSessao(fin, () => saldosDasContas());
    expect(saldos.find((s) => s.contaId === cb)!.saldoAtual).toBe(130000n + rep.valorPrevisto);
  });

  it("só contas ativas em saldosDasContas", async () => {
    const fin = (await criarUsuarioTeste("fin_operacional")).id;
    const a = await contaComSaldo(fin, "Ativa", "50,00", "2026-01-01");
    const b = await contaComSaldo(fin, "Inativa", "70,00", "2026-01-01");
    const r = await comSessao(fin, () => desativarContaBancaria(b));
    expect(r.ok).toBe(true);
    const saldos = await comSessao(fin, () => saldosDasContas());
    expect(saldos.map((s) => s.contaId)).toEqual([a]);
    expect((await comSessao(fin, () => listarContasBancarias())).find((c) => c.id === b)!.saldoAtual).toBe(7000n);
  });
});

describe("fluxo de caixa", () => {
  beforeEach(limparBanco);

  it("Review Focus 5: vencida em aberto entra na semana e no mês atuais, marcada; filtro por tipo só mexe nos movimentos", async () => {
    const x = await vendida();
    const fin = x.fin.id;
    const hoje = hojeEmCuiaba();
    await contaComSaldo(fin, "Sicredi", "5.000,00", "2026-01-01");
    const aluguel = await categoria("Aluguel");
    await manual(fin, { lado: "pagar", vencimento: dias(hoje, -40), valor: "250,00", categoria: aluguel });

    const tudo = await comSessao(fin, () => obterFluxoDeCaixa({}));
    expect(tudo.hoje).toBe(hoje);
    expect(tudo.saldoAtual).toBe(500000n);
    expect(tudo.semanas).toHaveLength(8);
    expect(tudo.meses).toHaveLength(12);
    expect(tudo.semanas[0].vencidas).toBe(25000n);
    expect(tudo.meses[0].vencidas).toBe(25000n);
    expect(tudo.semanas[0].saidas >= 25000n).toBe(true);
    // As parcelas (boleto, líquidas) entram como entradas em algum mês da projeção.
    const liquido = x.parcelas.reduce((s, p) => s + p.valor - p.taxaPrevista, 0n);
    const entradasMeses = tudo.meses.reduce((s, m) => s + m.entradas, 0n);
    expect(entradasMeses >= liquido).toBe(true);

    const clientes = await comSessao(fin, () => obterFluxoDeCaixa({ tipo: "clientes" }));
    expect(clientes.saldoAtual).toBe(500000n);
    expect(clientes.semanas[0].vencidas).toBe(0n);
    expect(clientes.meses.reduce((s, m) => s + m.saidas, 0n)).toBe(0n);
    expect(clientes.meses.reduce((s, m) => s + m.entradas, 0n)).toBe(liquido);

    const empresa = await comSessao(fin, () => obterFluxoDeCaixa({ tipo: "empresa" }));
    expect(empresa.meses.reduce((s, m) => s + m.saidas, 0n)).toBe(25000n);
    expect(empresa.meses.reduce((s, m) => s + m.entradas, 0n)).toBe(0n);

    // Centro e viagem filtram os movimentos: a viagem é RS, o manual é MT.
    const mt = await comSessao(fin, () => obterFluxoDeCaixa({ centro: "MT" }));
    expect(mt.meses.reduce((s, m) => s + m.entradas, 0n)).toBe(0n);
    const viagem = await comSessao(fin, () => obterFluxoDeCaixa({ viagemId: x.viagemId }));
    expect(viagem.semanas[0].vencidas).toBe(0n);
    expect(viagem.meses.reduce((s, m) => s + m.entradas, 0n)).toBe(entradasMeses);
  });

  it("baixados e cancelados não entram; recebido entra no saldo", async () => {
    const x = await vendida();
    const fin = x.fin.id;
    const cb = await contaBancaria(fin);
    const p = x.parcelas[0];
    const antes = await comSessao(fin, () => obterFluxoDeCaixa({ tipo: "clientes" }));
    const d = { recebidaEm: hojeEmCuiaba(), valorRecebido: reais(p.valor), taxaEfetiva: null, observacao: null, contaBancariaId: cb };
    expect(await comSessao(fin, () => baixarParcela(p.id, d))).toEqual({ ok: true });
    const depois = await comSessao(fin, () => obterFluxoDeCaixa({ tipo: "clientes" }));
    const soma = (r: typeof antes) => r.meses.reduce((s, m) => s + m.entradas, 0n);
    expect(soma(antes) - soma(depois)).toBe(p.valor - p.taxaPrevista);
    expect(depois.saldoAtual - antes.saldoAtual).toBe(p.valor - p.taxaPrevista);
    expect((await db.select().from(parcelasReceber).where(eq(parcelasReceber.id, p.id)))[0].status).toBe("recebida");
  });

  it("reserva: meta = 6 × custo fixo mensal vigente; temos = saldo atual", async () => {
    const fin = (await criarUsuarioTeste("fin_estrategico")).id;
    await contaComSaldo(fin, "Sicredi", "10.000,00", "2026-01-01");
    const custo = BigInt((await comSessao(fin, () => regrasVigentes())).valores.custoFixoMensal);
    expect(custo > 0n).toBe(true);
    const r = await comSessao(fin, () => obterFluxoDeCaixa({}));
    expect(r.reserva).toEqual({ meta: 6n * custo, temos: 1000000n, falta: 6n * custo - 1000000n, atingidaEm: null });
  });

  it("consultor e operacional: obterFluxoDeCaixa e saldosDasContas → Sem permissão", async () => {
    for (const perfil of ["consultor", "operacional"] as const) {
      const u = (await criarUsuarioTeste(perfil)).id;
      await expect(comSessao(u, () => obterFluxoDeCaixa({}))).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(u, () => saldosDasContas())).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(u, () => obterFluxoDeCaixa({}))).rejects.toThrow("Sem permissão");
    }
  });
});
