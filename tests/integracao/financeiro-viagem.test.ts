import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { converter } from "@/domain/cambio";
import { arredondar } from "@/domain/decimal";
import type { FormaPagamento } from "@/domain/precificacao";
import { db } from "@/server/db/client";
import { auditoria, comissoes, contasPagar, pagamentosFornecedor, parcelasReceber, viagens } from "@/server/db/schema";
import { salvarCliente, type ClienteEntrada } from "@/server/actions/clientes";
import { salvarFornecedor } from "@/server/actions/fornecedores";
import { salvarRegras } from "@/server/actions/regras";
import { regrasVigentes } from "@/server/queries/regras";
import { aprovar, enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { criarOrcamento, salvarCotacao, salvarItem, type ItemEntrada } from "@/server/actions/viagens";
import { fecharVenda } from "@/server/actions/vendas";
import {
  atualizarPrevisto,
  baixarPagamento,
  baixarParcela,
  cancelarParcela,
  comissaoNaoRecebida,
  conciliar,
  contestar,
  definirComissaoTipo,
  definirFormaFornecedor,
  desfazerBaixaPagamento,
  desfazerBaixaParcela,
  desfazerComissao,
  desfazerConciliacao,
  registrarComissao,
} from "@/server/actions/financeiro-viagem";
import { obterCliente } from "@/server/queries/clientes";
import { obterViagemVendida } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const souza: ClienteEntrada = {
  tipo: "familia",
  filial: "RS",
  telefone: "(66) 9 9123-4567",
  titular: { nome: "Marcos Souza" },
  acompanhantes: [{ nome: "Júlia Souza", parentesco: "Esposa" }],
};

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };
const CONCILIADA = { ok: false, erro: "Viagem conciliada: desfaça a conciliação para alterar" };
const BOLETO2: FormaPagamento = { tipo: "boleto", parcelas: 2 };

/** JSON com bigint (para inspecionar as chaves da resposta). */
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

async function fornecedor(uid: string, nome: string, modalidade: "net" | "comissionado", tipos: string[]) {
  const r = await comSessao(uid, () => salvarFornecedor({ nome, tipos, modalidade } as Parameters<typeof salvarFornecedor>[0]));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

async function item(uid: string, viagemId: string, dados: Partial<ItemEntrada>) {
  const r = await comSessao(uid, () => salvarItem(viagemId, { tipo: "Passeio", servico: "Passeio", ...dados }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

async function cotacao(uid: string, itemId: string, dados: Record<string, unknown>) {
  const r = await comSessao(uid, () => salvarCotacao(itemId, { moeda: "BRL", valor: "1.000,00", ...dados }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

/**
 * Viagem vendida em boleto 2x: hotel em fornecedor comissionado (3.106,00, 4% a receber, 4% à vista), passeio net
 * (500,00), transfer em EUR net (1.000,00 EUR), aéreo (8.000,00) e a taxa de roteiro automática.
 */
async function vendida() {
  const u = await criarUsuarioTeste("consultor");
  const d = await criarUsuarioTeste("diretor");
  const fin = await criarUsuarioTeste("fin_operacional");
  const vig = await comSessao(d.id, () => regrasVigentes());
  if (vig.valores.taxaRoteiro.minimoItens !== 2) {
    const g = await comSessao(d.id, () => salvarRegras({ ...vig.valores, taxaRoteiro: { ...vig.valores.taxaRoteiro, minimoItens: 2 } }));
    if (!g.ok) throw new Error(g.erro);
  }
  const c = await comSessao(u.id, () => salvarCliente(souza));
  if (!c.ok) throw new Error(c.erro);
  const pessoas = (await comSessao(u.id, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
  const r = await comSessao(u.id, () =>
    criarOrcamento({ clienteId: c.id, destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas }),
  );
  if (!r.ok) throw new Error(r.erro);
  const viagemId = r.id;
  const palazzo = await fornecedor(u.id, "Palazzo Hotels", "comissionado", ["Hotelaria"]);
  const roma = await fornecedor(u.id, "Roma Tours", "net", ["Passeio guiado"]);
  const euro = await fornecedor(u.id, "Euro Transfer", "net", ["Transfer"]);
  const hotel = await item(u.id, viagemId, { tipo: "Hotelaria", servico: "Palazzo Barocci", cidade: "Roma", diarias: 3 });
  await cotacao(u.id, hotel, { valor: "3.106,00", comissao: "4", descontoAVista: "4", fornecedorId: palazzo });
  const passeio = await item(u.id, viagemId, { servico: "Coliseu", cidade: "Roma" });
  await cotacao(u.id, passeio, { valor: "500,00", fornecedorId: roma });
  const transfer = await item(u.id, viagemId, { tipo: "Transfer", servico: "Transfer FCO", cidade: "Roma" });
  await cotacao(u.id, transfer, { moeda: "EUR", valor: "1.000,00", fornecedorId: euro });
  const aereo = await item(u.id, viagemId, { tipo: "Aéreo", servico: "GRU-FCO" });
  await cotacao(u.id, aereo, { valor: "8.000,00", comissao: "6" });
  const e = await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: BOLETO2, alteracao: "Primeira versão" }));
  if (!e.ok) throw new Error(e.erro);
  const a = await comSessao(d.id, () => aprovar(e.id));
  if (!a.ok) throw new Error(a.erro);
  const f = await comSessao(u.id, () =>
    fecharVenda(viagemId, {
      aceiteEm: "2026-11-20",
      forma: BOLETO2,
      parcelas: 2,
      primeiroVencimento: "2026-12-10",
      faturaNome: "Marcos Souza",
      faturaDocumento: "529.982.247-25",
    }),
  );
  if (!f.ok) throw new Error(f.erro);

  const contas = await db.select().from(contasPagar).where(eq(contasPagar.viagemId, viagemId));
  const conta = (itemId: string) => contas.find((x) => x.itemId === itemId)!;
  const pagamentoDa = async (contaId: string) =>
    (await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, contaId)).orderBy(asc(pagamentosFornecedor.numero)))[0];
  const parcelas = await db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, viagemId)).orderBy(asc(parcelasReceber.numero));
  const [comissao] = await db.select().from(comissoes).where(eq(comissoes.viagemId, viagemId));
  return {
    u,
    d,
    fin,
    viagemId,
    hotel: conta(hotel),
    passeio: conta(passeio),
    transfer: conta(transfer),
    aereo: conta(aereo),
    pagHotel: await pagamentoDa(conta(hotel).id),
    pagPasseio: await pagamentoDa(conta(passeio).id),
    pagTransfer: await pagamentoDa(conta(transfer).id),
    pagAereo: await pagamentoDa(conta(aereo).id),
    parcelas,
    comissao,
  };
}

type Fixture = Awaited<ReturnType<typeof vendida>>;

const BAIXA_PARCELA = { recebidaEm: "2026-11-21", valorRecebido: "1,00" };
const BAIXA_PAGAMENTO = { pagoEm: "2026-11-21", valorOriginalPago: "500,00" };

/** Todas as actions do financeiro da viagem, com entradas válidas. */
function todasAsActions(x: Fixture) {
  return {
    definirFormaFornecedor: () => definirFormaFornecedor(x.passeio.id, { tipo: "cartao_corporativo", vencimento: "2027-07-01" }),
    definirComissaoTipo: () => definirComissaoTipo(x.hotel.id, { tipo: "descontada" }),
    atualizarPrevisto: () => atualizarPrevisto(x.passeio.id, "600,00", "Fornecedor reajustou"),
    contestar: () => contestar(x.passeio.id, "Cobrança indevida"),
    baixarParcela: () => baixarParcela(x.parcelas[0].id, BAIXA_PARCELA),
    desfazerBaixaParcela: () => desfazerBaixaParcela(x.parcelas[0].id),
    cancelarParcela: () => cancelarParcela(x.parcelas[0].id, "Cliente desistiu"),
    baixarPagamento: () => baixarPagamento(x.pagPasseio.id, BAIXA_PAGAMENTO),
    desfazerBaixaPagamento: () => desfazerBaixaPagamento(x.pagPasseio.id),
    registrarComissao: () => registrarComissao(x.comissao.id, { recebidaEm: "2026-11-21", valorRecebido: "124,24" }),
    comissaoNaoRecebida: () => comissaoNaoRecebida(x.comissao.id, "Hotel não pagou"),
    desfazerComissao: () => desfazerComissao(x.comissao.id),
    conciliar: () => conciliar(x.viagemId),
    desfazerConciliacao: () => desfazerConciliacao(x.viagemId),
  };
}

async function estadoFinanceiro(viagemId: string) {
  const contas = await db.select().from(contasPagar).where(eq(contasPagar.viagemId, viagemId)).orderBy(asc(contasPagar.id));
  return json({
    viagem: await db.select().from(viagens).where(eq(viagens.id, viagemId)),
    parcelas: await db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, viagemId)).orderBy(asc(parcelasReceber.id)),
    contas,
    pagamentos: await db
      .select()
      .from(pagamentosFornecedor)
      .where(inArray(pagamentosFornecedor.contaId, contas.map((c) => c.id)))
      .orderBy(asc(pagamentosFornecedor.id)),
    comissoes: await db.select().from(comissoes).where(eq(comissoes.viagemId, viagemId)).orderBy(asc(comissoes.id)),
    auditoria: (await db.select().from(auditoria)).length,
  });
}

const ficha = (uid: string, viagemId: string) => comSessao(uid, () => obterViagemVendida(viagemId));

/** Ficha de quem vê a camada estratégica, com margem real e ponte calculadas. */
async function estrategico(uid: string, viagemId: string) {
  const f = await ficha(uid, viagemId);
  const e = f!.estrategico!;
  if ("erro" in e.real) throw new Error(e.real.erro);
  if ("erro" in e.ponte) throw new Error(e.ponte.erro);
  return { f: f!, real: e.real, ponte: e.ponte, planejada: e.planejada };
}

describe("financeiro da viagem: perfis (Review Focus 4)", () => {
  beforeEach(limparBanco);

  it("consultor e operacional chamando cada action → 'Sem permissão', nada gravado", async () => {
    const x = await vendida();
    const op = await criarUsuarioTeste("operacional");
    const antes = await estadoFinanceiro(x.viagemId);
    for (const uid of [x.u.id, op.id]) {
      for (const [nome, acao] of Object.entries(todasAsActions(x))) {
        expect([nome, await comSessao(uid, acao)]).toEqual([nome, SEM_PERMISSAO]);
      }
    }
    expect(await estadoFinanceiro(x.viagemId)).toBe(antes);
  });

  it("desfazer a conciliação é só do Diretor", async () => {
    const x = await vendida();
    await db.update(viagens).set({ conciliadaEm: new Date() }).where(eq(viagens.id, x.viagemId));
    const fe = await criarUsuarioTeste("fin_estrategico");
    expect(await comSessao(x.fin.id, () => desfazerConciliacao(x.viagemId))).toEqual(SEM_PERMISSAO);
    expect(await comSessao(fe.id, () => desfazerConciliacao(x.viagemId))).toEqual(SEM_PERMISSAO);
    expect(await comSessao(x.d.id, () => desfazerConciliacao(x.viagemId))).toEqual({ ok: true });
    const [v] = await db.select().from(viagens).where(eq(viagens.id, x.viagemId));
    expect(v.conciliadaEm).toBeNull();
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, x.viagemId)).orderBy(asc(auditoria.id));
    expect(aud.at(-1)).toMatchObject({ usuarioId: x.d.id, acao: "alterar", depois: { conciliadaEm: null } });
    expect(await comSessao(x.d.id, () => desfazerConciliacao(x.viagemId))).toEqual({ ok: false, erro: "A viagem não está conciliada" });
  });

  it("ids inexistentes ou inválidos → não encontrado, nada gravado", async () => {
    const x = await vendida();
    const antes = await estadoFinanceiro(x.viagemId);
    const outro = "00000000-0000-4000-8000-000000000000";
    const f = (acao: () => Promise<unknown>) => comSessao(x.fin.id, acao);
    expect(await f(() => baixarParcela(outro, BAIXA_PARCELA))).toEqual({ ok: false, erro: "Parcela não encontrada" });
    expect(await f(() => baixarParcela("x", BAIXA_PARCELA))).toEqual({ ok: false, erro: "Parcela não encontrada" });
    expect(await f(() => baixarPagamento(outro, BAIXA_PAGAMENTO))).toEqual({ ok: false, erro: "Pagamento não encontrado" });
    expect(await f(() => registrarComissao(outro, { recebidaEm: "2026-11-21", valorRecebido: "1,00" }))).toEqual({
      ok: false,
      erro: "Comissão não encontrada",
    });
    expect(await f(() => contestar(outro, "x"))).toEqual({ ok: false, erro: "Conta não encontrada" });
    expect(await f(() => conciliar(outro))).toEqual({ ok: false, erro: "Viagem não encontrada" });
    // conta excluída logicamente: nem ela nem seus pagamentos
    await db.update(contasPagar).set({ excluidoEm: new Date() }).where(eq(contasPagar.id, x.aereo.id));
    const antes2 = await estadoFinanceiro(x.viagemId);
    expect(await f(() => contestar(x.aereo.id, "x"))).toEqual({ ok: false, erro: "Conta não encontrada" });
    expect(await f(() => baixarPagamento(x.pagAereo.id, BAIXA_PAGAMENTO))).toEqual({ ok: false, erro: "Pagamento não encontrado" });
    expect(await estadoFinanceiro(x.viagemId)).toBe(antes2);
    expect(antes2).not.toBe(antes);
  });

  it("viagem que não está vendida: recusado", async () => {
    const x = await vendida();
    await db.update(viagens).set({ status: "aprovado" }).where(eq(viagens.id, x.viagemId));
    expect(await comSessao(x.fin.id, () => baixarParcela(x.parcelas[0].id, BAIXA_PARCELA))).toEqual({
      ok: false,
      erro: "A viagem ainda não foi vendida",
    });
    expect(await comSessao(x.fin.id, () => conciliar(x.viagemId))).toEqual({ ok: false, erro: "A viagem ainda não foi vendida" });
    expect(await ficha(x.fin.id, x.viagemId)).toBeNull();
  });
});

describe("baixa de parcela", () => {
  beforeEach(limparBanco);

  it("Review Focus 5: baixar, desfazer, baixar com outro valor → um registro, 3 linhas de auditoria, margem real com o último", async () => {
    const x = await vendida();
    const p = x.parcelas[0];
    const r0 = await estrategico(x.fin.id, x.viagemId);

    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, { recebidaEm: "2026-11-20", valorRecebido: "1.000,00", taxaEfetiva: "10,00" }))).toEqual({
      ok: true,
    });
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, BAIXA_PARCELA))).toEqual({ ok: false, erro: "Parcela já recebida" });
    expect(await comSessao(x.fin.id, () => desfazerBaixaParcela(p.id))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => desfazerBaixaParcela(p.id))).toEqual({ ok: false, erro: "Esta parcela não foi baixada" });
    expect(
      await comSessao(x.fin.id, () => baixarParcela(p.id, { recebidaEm: "2026-11-21", valorRecebido: p.valor.toString().replace(/(\d\d)$/, ",$1"), taxaEfetiva: "25,00" })),
    ).toEqual({ ok: true });

    const linhas = await db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, x.viagemId));
    expect(linhas).toHaveLength(2);
    expect(linhas.find((l) => l.id === p.id)).toMatchObject({ status: "recebida", recebidaEm: "2026-11-21", valorRecebido: p.valor, taxaEfetiva: 2500n });

    const aud = await db.select().from(auditoria).where(and(eq(auditoria.registroId, p.id), eq(auditoria.acao, "alterar"))).orderBy(asc(auditoria.id));
    expect(aud).toHaveLength(3);
    expect(aud.map((a) => a.usuarioId)).toEqual([x.fin.id, x.fin.id, x.fin.id]);
    expect(aud[0]).toMatchObject({ antes: { status: "a_receber", valorRecebido: null }, depois: { status: "recebida", valorRecebido: "100000", taxaEfetiva: "1000" } });
    expect(aud[1]).toMatchObject({ antes: { status: "recebida", taxaEfetiva: "1000" }, depois: { status: "a_receber", taxaEfetiva: null } });
    expect(aud[2]).toMatchObject({ depois: { status: "recebida", taxaEfetiva: "2500" } });

    const r1 = await estrategico(x.fin.id, x.viagemId);
    expect(r1.real.taxas).toBe(r0.real.taxas - p.taxaPrevista + 2500n);
    expect(r1.f.resumo).toMatchObject({ recebido: p.valor, aReceber: x.parcelas[1].valor });
  });

  it("cancelar parcela: motivo obrigatório; sai do a receber; desfazer volta", async () => {
    const x = await vendida();
    const p = x.parcelas[1];
    expect(await comSessao(x.fin.id, () => cancelarParcela(p.id, " "))).toMatchObject({ ok: false, erro: "Escreva o motivo" });
    expect(await comSessao(x.fin.id, () => cancelarParcela(p.id, "Cliente pagou à parte"))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, BAIXA_PARCELA))).toEqual({ ok: false, erro: "Parcela cancelada" });
    const f = (await ficha(x.fin.id, x.viagemId))!;
    expect(f.resumo.aReceber).toBe(x.parcelas[0].valor);
    expect(f.parcelas.find((l) => l.id === p.id)).toMatchObject({ status: "cancelada", observacao: "Cliente pagou à parte" });
    expect(await comSessao(x.fin.id, () => desfazerBaixaParcela(p.id))).toEqual({ ok: true });
    expect((await db.select().from(parcelasReceber).where(eq(parcelasReceber.id, p.id)))[0]).toMatchObject({ status: "a_receber", observacao: null });
  });

  it("validações da baixa", async () => {
    const x = await vendida();
    const p = x.parcelas[0];
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, { recebidaEm: "", valorRecebido: "1,00" }))).toMatchObject({ ok: false, erro: "Informe a data" });
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, { recebidaEm: "2999-01-01", valorRecebido: "1,00" }))).toMatchObject({
      ok: false,
      erro: "Data no futuro",
    });
    expect(await comSessao(x.fin.id, () => baixarParcela(p.id, { recebidaEm: "2026-11-21", valorRecebido: "" }))).toMatchObject({
      ok: false,
      erro: "Valor inválido",
      campos: { valorRecebido: "Valor inválido" },
    });
  });
});

describe("baixa de pagamento ao fornecedor", () => {
  beforeEach(limparBanco);

  it("Review Focus 5 no pagamento: baixar, desfazer, baixar com outro valor → margem real com o último", async () => {
    const x = await vendida();
    const r0 = await estrategico(x.fin.id, x.viagemId);
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagPasseio.id, { pagoEm: "2026-11-21", valorOriginalPago: "500,00" }))).toEqual({ ok: true });
    let [conta] = await db.select().from(contasPagar).where(eq(contasPagar.id, x.passeio.id));
    expect(conta.status).toBe("paga");
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagPasseio.id, BAIXA_PAGAMENTO))).toEqual({ ok: false, erro: "Pagamento já baixado" });
    expect(await comSessao(x.fin.id, () => desfazerBaixaPagamento(x.pagPasseio.id))).toEqual({ ok: true });
    [conta] = await db.select().from(contasPagar).where(eq(contasPagar.id, x.passeio.id));
    expect(conta.status).toBe("a_pagar");
    expect(await comSessao(x.fin.id, () => desfazerBaixaPagamento(x.pagPasseio.id))).toEqual({ ok: false, erro: "Este pagamento não foi baixado" });
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagPasseio.id, { pagoEm: "2026-11-21", valorOriginalPago: "520,00", cambioEfetivo: "5,5" }))).toEqual({
      ok: true,
    });

    const pags = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));
    expect(pags).toHaveLength(1);
    expect(pags[0]).toMatchObject({ status: "pago", pagoEm: "2026-11-21", valorOriginalPago: 52000n, cambioEfetivo: null, valorBrlPago: 52000n });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.registroId, x.pagPasseio.id), eq(auditoria.acao, "alterar")));
    expect(aud).toHaveLength(3);

    const r1 = await estrategico(x.fin.id, x.viagemId);
    expect(r1.real.custo).toBe(r0.real.custo + 2000n);
    expect(r1.ponte).toContainEqual({ rotulo: "Roma Tours: valor atualizado", valor: -2000n });
    expect(r1.f.resumo.pagoFornecedores).toBe(52000n);
  });

  it("duas baixas do mesmo pagamento ao mesmo tempo → uma; a outra 'Pagamento já baixado'", async () => {
    const x = await vendida();
    const rs = await comSessao(x.fin.id, () =>
      Promise.all([baixarPagamento(x.pagPasseio.id, BAIXA_PAGAMENTO), baixarPagamento(x.pagPasseio.id, { ...BAIXA_PAGAMENTO, valorOriginalPago: "510,00" })]),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, erro: "Pagamento já baixado" });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.registroId, x.pagPasseio.id), eq(auditoria.acao, "alterar")));
    expect(aud).toHaveLength(1);
  });

  it("EUR com câmbio efetivo maior que o da venda: valor em reais maior e 'Diferença de câmbio' na ponte", async () => {
    const x = await vendida();
    expect(x.transfer.moeda).toBe("EUR");
    const aplicado = x.transfer.cambioAplicado!;
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagTransfer.id, { pagoEm: "2026-11-21", valorOriginalPago: "1.000,00" }))).toEqual({
      ok: false,
      erro: "Informe o câmbio efetivo",
      campos: { cambioEfetivo: "Informe o câmbio efetivo" },
    });
    expect(await comSessao(x.fin.id, () => baixarPagamento(x.pagTransfer.id, { pagoEm: "2026-11-21", valorOriginalPago: "1.000,00", cambioEfetivo: "6,5000" }))).toEqual({
      ok: true,
    });
    const [p] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, x.pagTransfer.id));
    expect(p).toMatchObject({ valorOriginalPago: 100000n, cambioEfetivo: "6.5000", valorBrlPago: converter(100000n, "6.5000") });
    expect(p.valorBrlPago!).toBeGreaterThan(p.valorBrlPrevisto);
    expect(converter(100000n, aplicado)).toBe(p.valorBrlPrevisto);

    const { ponte } = await estrategico(x.fin.id, x.viagemId);
    expect(ponte).toContainEqual({ rotulo: "Diferença de câmbio", valor: -(p.valorBrlPago! - p.valorBrlPrevisto) });
  });
});

describe("comissões", () => {
  beforeEach(limparBanco);

  it("a receber pendente aparece na ponte e entra na margem real só quando recebida", async () => {
    const x = await vendida();
    expect(x.comissao).toMatchObject({ status: "prevista", valorPrevisto: 12424n });
    const r0 = await estrategico(x.fin.id, x.viagemId);
    expect(r0.ponte).toContainEqual({ rotulo: "Comissão pendente: Palazzo Hotels", valor: -12424n });
    expect(r0.f.comissoes).toMatchObject([{ id: x.comissao.id, status: "prevista", pendente: true }]);

    expect(await comSessao(x.fin.id, () => registrarComissao(x.comissao.id, { recebidaEm: "2026-11-21", valorRecebido: "124,24" }))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => registrarComissao(x.comissao.id, { recebidaEm: "2026-11-21", valorRecebido: "124,24" }))).toEqual({
      ok: false,
      erro: "Comissão já registrada",
    });
    const r1 = await estrategico(x.fin.id, x.viagemId);
    expect(r1.real.custo).toBe(r0.real.custo - 12424n);
    expect(r1.ponte.map((l) => l.rotulo)).not.toContain("Comissão pendente: Palazzo Hotels");
    expect(r1.real.final).toBeGreaterThan(r0.real.final);

    expect(await comSessao(x.fin.id, () => desfazerComissao(x.comissao.id))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => desfazerComissao(x.comissao.id))).toEqual({ ok: false, erro: "Esta comissão não foi registrada" });
    expect(await comSessao(x.fin.id, () => comissaoNaoRecebida(x.comissao.id, ""))).toMatchObject({ ok: false, erro: "Escreva o motivo" });
    expect(await comSessao(x.fin.id, () => comissaoNaoRecebida(x.comissao.id, "Hotel não pagou"))).toEqual({ ok: true });
    const r2 = await estrategico(x.fin.id, x.viagemId);
    expect(r2.ponte).toContainEqual({ rotulo: "Comissão não recebida: Palazzo Hotels", valor: -12424n });
    expect(r2.real.final).toBe(r0.real.final);
    expect((await db.select().from(comissoes).where(eq(comissoes.id, x.comissao.id)))[0]).toMatchObject({ status: "nao_recebida", motivo: "Hotel não pagou" });
  });

  it("definirComissaoTipo: recalcula o previsto e cria/cancela a comissão; previsto na venda não muda; recusado depois de baixa", async () => {
    const x = await vendida();
    expect(x.hotel).toMatchObject({ comissaoTipo: "a_receber", previstoBrl: 310600n, previstoVendaBrl: 310600n });
    expect(await comSessao(x.fin.id, () => definirComissaoTipo(x.hotel.id, { tipo: "descontada" }))).toEqual({ ok: true });
    let [c] = await db.select().from(contasPagar).where(eq(contasPagar.id, x.hotel.id));
    expect(c).toMatchObject({ comissaoTipo: "descontada", previstoBrl: 298176n, previstoVendaBrl: 310600n });
    expect(await db.select().from(comissoes).where(eq(comissoes.contaId, x.hotel.id))).toHaveLength(0);
    let [p] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.hotel.id));
    // líquido 298176 com 4% à vista
    expect(p).toMatchObject({ valorOriginal: 286249n, valorBrlPrevisto: 286249n });

    expect(await comSessao(x.fin.id, () => definirComissaoTipo(x.hotel.id, { tipo: "a_receber", previstaPara: "2027-09-30" }))).toEqual({ ok: true });
    [c] = await db.select().from(contasPagar).where(eq(contasPagar.id, x.hotel.id));
    expect(c).toMatchObject({ comissaoTipo: "a_receber", previstoBrl: 310600n, previstoVendaBrl: 310600n });
    const cs = await db.select().from(comissoes).where(eq(comissoes.contaId, x.hotel.id));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ valorPrevisto: 12424n, previstaPara: "2027-09-30", status: "prevista", baseBrl: 310600n });
    [p] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.hotel.id));
    expect(p).toMatchObject({ valorOriginal: 298176n, valorBrlPrevisto: 298176n });
    const aud = await db.select().from(auditoria).where(eq(auditoria.tabela, "comissoes"));
    expect(aud.map((a) => a.acao)).toEqual(expect.arrayContaining(["criar", "excluir", "criar"]));

    // sem fornecedor não há comissão a receber
    expect(await comSessao(x.fin.id, () => definirComissaoTipo(x.aereo.id, { tipo: "a_receber" }))).toEqual({
      ok: false,
      erro: "Conta sem fornecedor: a comissão só pode ser descontada",
    });

    expect(await comSessao(x.fin.id, () => baixarPagamento(p.id, { pagoEm: "2026-11-21", valorOriginalPago: "2.981,76" }))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => definirComissaoTipo(x.hotel.id, { tipo: "descontada" }))).toEqual({
      ok: false,
      erro: "Já há pagamento baixado nesta conta",
    });
  });
});

describe("contas a pagar", () => {
  beforeEach(limparBanco);

  it("definirFormaFornecedor: parcelado refaz as linhas; soma conferida; recusado depois de baixa", async () => {
    const x = await vendida();
    const f = (forma: Parameters<typeof definirFormaFornecedor>[1]) => comSessao(x.fin.id, () => definirFormaFornecedor(x.passeio.id, forma));
    expect(await f({ tipo: "parcelado", parcelas: [{ vencimento: "2027-06-01", valor: "200,00" }] })).toMatchObject({
      ok: false,
      erro: "A soma das parcelas deve ser igual ao valor previsto",
    });
    expect(
      await f({
        tipo: "parcelado",
        parcelas: [
          { vencimento: "2027-06-01", valor: "200,00" },
          { vencimento: "2027-07-01", valor: "300,00" },
        ],
      }),
    ).toEqual({ ok: true });
    const linhas = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id)).orderBy(asc(pagamentosFornecedor.numero));
    expect(linhas.map((l) => [l.numero, l.vencimento, l.valorOriginal, l.valorBrlPrevisto, l.status])).toEqual([
      [1, "2027-06-01", 20000n, 20000n, "a_pagar"],
      [2, "2027-07-01", 30000n, 30000n, "a_pagar"],
    ]);
    expect((await db.select().from(contasPagar).where(eq(contasPagar.id, x.passeio.id)))[0].forma).toBe("parcelado");
    expect(await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, x.pagPasseio.id))).toHaveLength(0);
    const aud = await db.select().from(auditoria).where(eq(auditoria.tabela, "pagamentos_fornecedor"));
    expect(aud.filter((a) => a.acao === "excluir").map((a) => a.registroId)).toEqual([x.pagPasseio.id]);

    // conta parcelada: paga só quando todas as linhas pagas
    expect(await comSessao(x.fin.id, () => baixarPagamento(linhas[0].id, { pagoEm: "2026-11-21", valorOriginalPago: "200,00" }))).toEqual({ ok: true });
    expect((await db.select().from(contasPagar).where(eq(contasPagar.id, x.passeio.id)))[0].status).toBe("a_pagar");
    expect(await f({ tipo: "a_vista" })).toEqual({ ok: false, erro: "Já há pagamento baixado nesta conta" });
    expect(await comSessao(x.fin.id, () => baixarPagamento(linhas[1].id, { pagoEm: "2026-11-21", valorOriginalPago: "300,00" }))).toEqual({ ok: true });
    expect((await db.select().from(contasPagar).where(eq(contasPagar.id, x.passeio.id)))[0].status).toBe("paga");

    // cartão corporativo e à vista (mantém o vencimento) em outra conta
    expect(await comSessao(x.fin.id, () => definirFormaFornecedor(x.hotel.id, { tipo: "cartao_corporativo", vencimento: "2027-07-20" }))).toEqual({ ok: true });
    let [h] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.hotel.id));
    expect(h).toMatchObject({ vencimento: "2027-07-20", valorOriginal: 310600n, valorBrlPrevisto: 310600n });
    expect(await comSessao(x.fin.id, () => definirFormaFornecedor(x.hotel.id, { tipo: "a_vista" }))).toEqual({ ok: true });
    [h] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.hotel.id));
    expect(h).toMatchObject({ vencimento: "2027-07-20", valorOriginal: 298176n, valorBrlPrevisto: 298176n });
  });

  it("atualizarPrevisto com motivo, linhas em aberto reescaladas, divergência; contestar", async () => {
    const x = await vendida();
    expect(await comSessao(x.fin.id, () => atualizarPrevisto(x.passeio.id, "684,00", " "))).toMatchObject({
      ok: false,
      erro: "Escreva o motivo da alteração",
    });
    expect(await comSessao(x.fin.id, () => atualizarPrevisto(x.passeio.id, "x", "Reajuste"))).toMatchObject({ ok: false, erro: "Valor inválido" });
    expect(await comSessao(x.fin.id, () => atualizarPrevisto(x.passeio.id, "684,00", "Fornecedor cobrou R$ 184 a mais"))).toEqual({ ok: true });
    const [c] = await db.select().from(contasPagar).where(eq(contasPagar.id, x.passeio.id));
    expect(c).toMatchObject({ previstoBrl: 68400n, previstoVendaBrl: 50000n, motivoPrevisto: "Fornecedor cobrou R$ 184 a mais" });
    const [p] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));
    expect(p).toMatchObject({ valorOriginal: 68400n, valorBrlPrevisto: 68400n });

    // EUR: previsto em reais muda e o original da linha acompanha
    expect(await comSessao(x.fin.id, () => atualizarPrevisto(x.transfer.id, "7.000,00", "Mudou o veículo"))).toEqual({ ok: true });
    const [t] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.transfer.id));
    expect(t.valorBrlPrevisto).toBe(700000n);
    expect(t.valorOriginal).toBe(arredondar(100000n * 700000n, x.transfer.previstoBrl));

    expect(await comSessao(x.fin.id, () => contestar(x.hotel.id, " "))).toMatchObject({ ok: false, erro: "Escreva a contestação" });
    expect(await comSessao(x.fin.id, () => contestar(x.hotel.id, "Cobraram uma diária a mais"))).toEqual({ ok: true });
    const [h] = await db.select().from(contasPagar).where(eq(contasPagar.id, x.hotel.id));
    expect(h.contestacao).toBe("Cobraram uma diária a mais");
    expect(h.contestadaEm).toBeInstanceOf(Date);

    const f = (await ficha(x.fin.id, x.viagemId))!;
    expect(f.contas.find((k) => k.id === x.passeio.id)).toMatchObject({ divergente: true, contestada: false, motivoPrevisto: "Fornecedor cobrou R$ 184 a mais" });
    expect(f.contas.find((k) => k.id === x.hotel.id)).toMatchObject({ divergente: false, contestada: true });
    // passeio e transfer divergentes, hotel contestado, comissão do hotel pendente
    expect(f.divergencias).toBe(4);
    const { ponte } = await estrategico(x.fin.id, x.viagemId);
    expect(ponte).toContainEqual({ rotulo: "Roma Tours: valor atualizado", valor: -18400n });
  });
});

describe("conciliar", () => {
  beforeEach(limparBanco);

  it("com algo em aberto: recusado com a lista curta; com tudo baixado grava a data e trava as alterações", async () => {
    const x = await vendida();
    const r = await comSessao(x.fin.id, () => conciliar(x.viagemId));
    expect(r).toEqual({
      ok: false,
      erro: "Ainda há valores em aberto: Parcela 1/2, Parcela 2/2, Palazzo Barocci e mais 4",
    });

    const fin = (acao: () => Promise<unknown>) => comSessao(x.fin.id, acao);
    for (const p of x.parcelas) expect(await fin(() => baixarParcela(p.id, BAIXA_PARCELA))).toEqual({ ok: true });
    expect(await fin(() => baixarPagamento(x.pagHotel.id, { pagoEm: "2026-11-21", valorOriginalPago: "2.981,76" }))).toEqual({ ok: true });
    expect(await fin(() => baixarPagamento(x.pagPasseio.id, BAIXA_PAGAMENTO))).toEqual({ ok: true });
    expect(await fin(() => baixarPagamento(x.pagAereo.id, { pagoEm: "2026-11-21", valorOriginalPago: "7.520,00" }))).toEqual({ ok: true });
    expect(await fin(() => conciliar(x.viagemId))).toEqual({ ok: false, erro: "Ainda há valores em aberto: Transfer FCO, Comissão Palazzo Hotels" });
    expect(await fin(() => baixarPagamento(x.pagTransfer.id, { pagoEm: "2026-11-21", valorOriginalPago: "1.000,00", cambioEfetivo: "6,1" }))).toEqual({ ok: true });
    expect(await fin(() => comissaoNaoRecebida(x.comissao.id, "Hotel não pagou"))).toEqual({ ok: true });
    expect((await db.select().from(viagens).where(eq(viagens.id, x.viagemId)))[0].conciliadaEm).toBeNull();

    expect(await fin(() => conciliar(x.viagemId))).toEqual({ ok: true });
    const [v] = await db.select().from(viagens).where(eq(viagens.id, x.viagemId));
    expect(v.conciliadaEm).toBeInstanceOf(Date);
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, x.viagemId)).orderBy(asc(auditoria.id));
    expect(aud.at(-1)).toMatchObject({ usuarioId: x.fin.id, acao: "alterar", antes: { conciliadaEm: null } });
    expect((await ficha(x.u.id, x.viagemId))!.status).toBe("conciliada");

    // conciliada: nada muda
    const antes = await estadoFinanceiro(x.viagemId);
    for (const [nome, acao] of Object.entries(todasAsActions(x))) {
      if (nome === "desfazerConciliacao") continue;
      expect([nome, await fin(acao)]).toEqual([nome, CONCILIADA]);
    }
    expect(await estadoFinanceiro(x.viagemId)).toBe(antes);

    expect(await comSessao(x.d.id, () => desfazerConciliacao(x.viagemId))).toEqual({ ok: true });
    expect(await fin(() => desfazerComissao(x.comissao.id))).toEqual({ ok: true });
  });
});

describe("obterViagemVendida", () => {
  beforeEach(limparBanco);

  it("base para todos; camada estratégica só para quem a vê", async () => {
    const x = await vendida();
    const op = await criarUsuarioTeste("operacional");
    for (const uid of [x.u.id, op.id]) {
      const f = (await ficha(uid, x.viagemId))!;
      expect(f.estrategico).toBeUndefined();
      const s = json(f);
      expect(s).not.toMatch(/margem|ponte|imposto/i);
      expect(f.parcelas[0]).not.toHaveProperty("taxaPrevista");
    }

    const f = (await ficha(x.u.id, x.viagemId))!;
    const total = x.parcelas.reduce((a, p) => a + p.valor, 0n);
    expect(f).toMatchObject({
      id: x.viagemId,
      codigo: expect.stringMatching(/^ECL-\d{4}-01$/),
      destino: "Itália",
      inicio: "2027-08-14",
      fim: "2027-09-01",
      passageiros: expect.arrayContaining(["Marcos Souza", "Júlia Souza"]),
      consultor: "Teste consultor",
      status: "vendida",
      rotuloStatus: "Vendida",
      conciliadaEm: null,
      venda: { aceiteEm: "2026-11-20", forma: "Boleto em 2x", parcelas: 2, faturaNome: "Marcos Souza", faturaDocumento: "529.982.247-25" },
      resumo: {
        valorVendido: total,
        recebido: 0n,
        aReceber: total,
        pagoFornecedores: 0n,
        aPagar: x.pagHotel.valorBrlPrevisto + x.pagPasseio.valorBrlPrevisto + x.pagTransfer.valorBrlPrevisto + x.pagAereo.valorBrlPrevisto,
      },
      divergencias: 1,
    });
    expect(f.parcelas.map((p) => [p.numero, p.status, p.rotuloMeio])).toEqual([
      [1, "a_receber", "Boleto"],
      [2, "a_receber", "Boleto"],
    ]);
    expect(f.contas).toHaveLength(4);
    const hotel = f.contas.find((c) => c.id === x.hotel.id)!;
    expect(hotel).toMatchObject({
      descricao: "Palazzo Barocci",
      fornecedor: "Palazzo Hotels",
      comissaoTipo: "a_receber",
      pagamentos: [{ id: x.pagHotel.id, status: "a_pagar" }],
      comissao: { id: x.comissao.id, valorPrevisto: 12424n },
    });
    expect(f.comissoes).toHaveLength(1);

    const e = await estrategico(x.fin.id, x.viagemId);
    expect(e.f.parcelas[0]).toHaveProperty("taxaPrevista");
    expect(e.planejada.final).toBe(e.ponte[0].valor);
    expect(e.ponte[0].rotulo).toBe("Margem planejada");
    expect(e.ponte.at(-1)).toEqual({ rotulo: "Margem real", valor: e.real.final });
    const d = await estrategico(x.d.id, x.viagemId);
    expect(d.real).toEqual(e.real);
  });

  it("inexistente → null; não logado → erro", async () => {
    const x = await vendida();
    expect(await ficha(x.fin.id, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect(await ficha(x.fin.id, "x")).toBeNull();
    await expect(obterViagemVendida(x.viagemId)).rejects.toThrow();
  });
});
