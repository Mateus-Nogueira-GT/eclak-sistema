import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { auditoria, faturas, faturasContador, faturasVersoes, lancamentosFinanceiros, vendas } from "@/server/db/schema";
import { definirProximoNumeroFatura, emitirFatura, reemitirFatura } from "@/server/actions/faturas";
import { baixarParcela, cancelarParcela, desfazerBaixaParcela } from "@/server/actions/financeiro-viagem";
import { emitirFaturaNa } from "@/server/financeiro/faturas";
import { listarFaturas, obterFatura, proximoNumeroFatura, vendasParaFaturar } from "@/server/queries/faturas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { contaBancaria, vendida, type Fixture } from "../helpers/venda";

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };

const contador = async () => (await db.select().from(faturasContador))[0].proximo;
const vendaDe = async (x: Fixture) => (await db.select().from(vendas).where(eq(vendas.viagemId, x.viagemId)))[0].id;

beforeEach(async () => {
  await limparBanco();
}, 60_000);

describe("emitirFatura", () => {
  it("numera a partir de 1405, uma por venda, com retrato das parcelas e auditoria", async () => {
    const x = await vendida();
    const y = await vendida();
    const vx = await vendaDe(x);
    const vy = await vendaDe(y);
    expect((await comSessao(x.fin.id, () => vendasParaFaturar())).map((v) => v.vendaId).sort()).toEqual([vx, vy].sort());

    expect(await comSessao(x.fin.id, () => emitirFatura(vx))).toEqual({ ok: true, numero: 1405 });
    expect(await comSessao(x.fin.id, () => emitirFatura(vy))).toEqual({ ok: true, numero: 1406 });
    expect(await contador()).toBe(1407);
    expect(await comSessao(x.fin.id, () => vendasParaFaturar())).toEqual([]);

    const [f] = await db.select().from(faturas).where(eq(faturas.vendaId, vx));
    const [v1] = await db.select().from(faturasVersoes).where(eq(faturasVersoes.faturaId, f.id));
    expect(v1.versao).toBe(1);
    expect(v1.dados).toEqual({
      nome: "Marcos Souza",
      documento: "52998224725",
      codigoViagem: expect.stringMatching(/^ECL-\d{4}-01$/),
      destino: "Itália",
      inicio: "2027-08-14",
      fim: "2027-09-01",
      total: expect.any(String),
      forma: "Boleto em 2x",
      parcelas: x.parcelas.map((p) => ({ numero: p.numero, total: 2, vencimento: p.vencimento, valor: p.valor.toString() })),
      canceladas: "0",
      parcelasCanceladas: [],
    });
    const [venda] = await db.select().from(vendas).where(eq(vendas.id, vx));
    expect(v1.dados.total).toBe(venda.total.toString());
    expect(await db.select().from(auditoria).where(and(eq(auditoria.tabela, "faturas"), eq(auditoria.registroId, f.id)))).toHaveLength(1);

    // a lista única mostra o número da fatura nas parcelas da viagem
    const linhas = await db.select().from(lancamentosFinanceiros).where(and(eq(lancamentosFinanceiros.viagemId, x.viagemId), eq(lancamentosFinanceiros.origem, "parcela")));
    expect(linhas.map((l) => l.faturaNumero)).toEqual([1405, 1405]);

    const lista = await comSessao(x.fin.id, () => listarFaturas());
    expect(lista.map((l) => l.numero)).toEqual([1406, 1405]);
    expect(lista.find((l) => l.numero === 1405)).toMatchObject({ cliente: expect.any(String), desatualizada: false, recebido: 0n, total: venda.total });
  }, 120_000);

  it("emitir duas vezes a mesma venda é recusado com o número já dado", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    expect(await comSessao(x.fin.id, () => emitirFatura(v))).toEqual({ ok: true, numero: 1405 });
    expect(await comSessao(x.fin.id, () => emitirFatura(v))).toEqual({ ok: false, erro: "Esta venda já tem a fatura 1405" });
    expect(await contador()).toBe(1406);
    expect(await comSessao(x.fin.id, () => emitirFatura("x"))).toEqual({ ok: false, erro: "Venda não encontrada" });
  }, 60_000);

  it("concorrência: três emissões simultâneas dão 1405, 1406 e 1407 sem repetição", async () => {
    const xs = [await vendida(), await vendida(), await vendida()];
    const ids = await Promise.all(xs.map(vendaDe));
    // Uma sessão só para as três (o mock de sessão é um global: comSessao em paralelo vazaria).
    const r = await comSessao(xs[0].fin.id, () => Promise.all(ids.map((id) => emitirFatura(id))));
    expect(r.every((x) => x.ok)).toBe(true);
    expect(r.map((x) => (x as { numero: number }).numero).sort()).toEqual([1405, 1406, 1407]);
    expect(await contador()).toBe(1408);
  }, 180_000);

  it("concorrência na mesma venda: uma emite, a outra é recusada; o contador avança uma vez", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    const r = await comSessao(x.fin.id, () => Promise.all([emitirFatura(v), emitirFatura(v)]));
    expect(r).toContainEqual({ ok: true, numero: 1405 });
    expect(r).toContainEqual({ ok: false, erro: "Esta venda já tem a fatura 1405" });
    expect(await contador()).toBe(1406);
  }, 60_000);

  it("falha depois de ler o contador não consome número", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    // Mesmo núcleo da action, na transação do teste: emite (lê e avança o contador) e então a transação falha.
    await expect(
      db.transaction(async (tx) => {
        const r = await emitirFaturaNa(tx, x.fin.id, v);
        expect(r).toMatchObject({ ok: true, numero: 1405 });
        throw new Error("falha depois do contador");
      }),
    ).rejects.toThrow("falha depois do contador");
    expect(await contador()).toBe(1405);
    expect(await db.select().from(faturas)).toEqual([]);
    expect(await comSessao(x.fin.id, () => emitirFatura(v))).toEqual({ ok: true, numero: 1405 });
  }, 60_000);

  it("consultor não emite nem consulta", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    expect(await comSessao(x.u.id, () => emitirFatura(v))).toEqual(SEM_PERMISSAO);
    await expect(comSessao(x.u.id, () => listarFaturas())).rejects.toBeInstanceOf(ErroAcesso);
    await expect(comSessao(x.u.id, () => vendasParaFaturar())).rejects.toBeInstanceOf(ErroAcesso);
    expect(await contador()).toBe(1405);
  }, 60_000);
});

describe("reemitirFatura", () => {
  it("parcela cancelada depois da emissão: desatualizada; reemite a versão 2 com o mesmo número; a versão 1 fica fixa", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    expect(await comSessao(x.fin.id, () => emitirFatura(v))).toEqual({ ok: true, numero: 1405 });
    const [f] = await db.select().from(faturas).where(eq(faturas.vendaId, v));
    expect(await comSessao(x.fin.id, () => reemitirFatura(f.id))).toEqual({ ok: false, erro: "A fatura já está atualizada" });

    expect(await comSessao(x.fin.id, () => cancelarParcela(x.parcelas[1].id, "Cliente pagou à parte"))).toEqual({ ok: true });
    expect((await comSessao(x.fin.id, () => listarFaturas()))[0]).toMatchObject({ numero: 1405, desatualizada: true });

    expect(await comSessao(x.fin.id, () => reemitirFatura(f.id))).toEqual({ ok: true, numero: 1405, versao: 2 });
    expect((await comSessao(x.fin.id, () => listarFaturas()))[0]).toMatchObject({ numero: 1405, desatualizada: false });
    expect(await contador()).toBe(1406);

    const atual = await comSessao(x.fin.id, () => obterFatura(f.id));
    expect(atual).toMatchObject({ numero: 1405, versao: 2, versoes: [1, 2], desatualizada: false });
    expect(atual!.dados.parcelas.map((p) => p.numero)).toEqual([1]);
    const v1 = await comSessao(x.fin.id, () => obterFatura(f.id, 1));
    expect(v1).toMatchObject({ numero: 1405, versao: 1 });
    expect(v1!.dados.parcelas.map((p) => p.numero)).toEqual([1, 2]);
    expect(v1!.dados.canceladas).toBe("0");
    expect(v1!.totais).toMatchObject({ canceladas: 0n, aPagar: x.parcelas[0].valor + x.parcelas[1].valor });
    // versão 2 reconcilia: Σ parcelas + canceladas = valor da venda; total a pagar = Σ parcelas listadas
    const [vendaRow] = await db.select().from(vendas).where(eq(vendas.id, v));
    const soma = atual!.dados.parcelas.reduce((s, p) => s + BigInt(p.valor), 0n);
    expect(atual!.dados.parcelasCanceladas).toEqual([{ numero: 2, total: 2 }]);
    expect(soma + BigInt(atual!.dados.canceladas!)).toBe(vendaRow.total);
    expect(atual!.totais).toEqual({ venda: vendaRow.total, canceladas: x.parcelas[1].valor, numerosCancelados: "2/2", aPagar: soma });
    expect((await comSessao(x.fin.id, () => listarFaturas()))[0].total).toBe(soma);
    expect(await comSessao(x.fin.id, () => obterFatura(f.id, 3))).toBeNull();
    // situação atual das parcelas (detalhe)
    expect(atual!.parcelas.map((p) => p.status)).toEqual(["a_receber", "cancelada"]);
    expect(await db.select().from(auditoria).where(and(eq(auditoria.tabela, "faturas_versoes")))).toHaveLength(2);

    // recebido = Σ das parcelas recebidas
    const cb = await contaBancaria(x.fin.id);
    const p1 = x.parcelas[0];
    const valor = `${p1.valor / 100n},${(p1.valor % 100n).toString().padStart(2, "0")}`;
    expect(await comSessao(x.fin.id, () => baixarParcela(p1.id, { recebidaEm: hojeEmCuiaba(), valorRecebido: valor, contaBancariaId: cb }))).toEqual({ ok: true });
    expect((await comSessao(x.fin.id, () => listarFaturas()))[0]).toMatchObject({ recebido: p1.valor, desatualizada: false });
    // desfazer o cancelamento traz a parcela de volta: a versão 2 fica desatualizada
    expect(await comSessao(x.fin.id, () => desfazerBaixaParcela(x.parcelas[1].id))).toEqual({ ok: true });
    expect((await comSessao(x.fin.id, () => listarFaturas()))[0]).toMatchObject({ desatualizada: true });
  }, 60_000);

  it("parcela cancelada antes da emissão fica fora do retrato", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    expect(await comSessao(x.fin.id, () => cancelarParcela(x.parcelas[0].id, "Paga na agência"))).toEqual({ ok: true });
    expect(await comSessao(x.fin.id, () => emitirFatura(v))).toEqual({ ok: true, numero: 1405 });
    const [l] = await comSessao(x.fin.id, () => listarFaturas());
    expect(l.desatualizada).toBe(false);
    const f = await comSessao(x.fin.id, () => obterFatura(l.id));
    expect(f!.dados.parcelas).toEqual([{ numero: 2, total: 2, vencimento: x.parcelas[1].vencimento, valor: x.parcelas[1].valor.toString() }]);
  }, 60_000);

  it("consultor não reemite", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    await comSessao(x.fin.id, () => emitirFatura(v));
    const [f] = await db.select().from(faturas);
    expect(await comSessao(x.u.id, () => reemitirFatura(f.id))).toEqual(SEM_PERMISSAO);
  }, 60_000);
});

describe("definirProximoNumeroFatura", () => {
  it("só o Diretor, só sem faturas, de 1 a 999999", async () => {
    const x = await vendida();
    const v = await vendaDe(x);
    expect(await comSessao(x.fin.id, () => definirProximoNumeroFatura(2000))).toEqual(SEM_PERMISSAO);
    const est = await criarUsuarioTeste("fin_estrategico");
    expect(await comSessao(est.id, () => definirProximoNumeroFatura(2000))).toEqual(SEM_PERMISSAO);
    expect(await comSessao(x.d.id, () => definirProximoNumeroFatura(0))).toMatchObject({ ok: false });
    expect(await comSessao(x.d.id, () => definirProximoNumeroFatura(1_000_000))).toMatchObject({ ok: false });
    expect(await comSessao(x.d.id, () => proximoNumeroFatura())).toEqual({ proximo: 1405, haFaturas: false });

    expect(await comSessao(x.d.id, () => definirProximoNumeroFatura(2000))).toEqual({ ok: true });
    expect(await comSessao(x.d.id, () => proximoNumeroFatura())).toEqual({ proximo: 2000, haFaturas: false });
    expect(await db.select().from(auditoria).where(eq(auditoria.tabela, "faturas_contador"))).toHaveLength(1);

    expect(await comSessao(x.fin.id, () => emitirFatura(v))).toEqual({ ok: true, numero: 2000 });
    expect(await comSessao(x.d.id, () => definirProximoNumeroFatura(3000))).toEqual({ ok: false, erro: "Já há faturas emitidas: a numeração só avança" });
    expect(await comSessao(x.d.id, () => proximoNumeroFatura())).toEqual({ proximo: 2001, haFaturas: true });
  }, 60_000);
});
