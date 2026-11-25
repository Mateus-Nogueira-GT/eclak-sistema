import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { centroDaFilial, type CategoriaSistema } from "@/domain/financeiro";
import { intervaloDeMeses } from "@/domain/paineis";
import { MSG_NAO_VENDIDA } from "@/domain/venda-entrada";
import { formatarCodigoViagem } from "@/domain/viagens";
import { baixarLinha, desfazerBaixaLinha } from "@/server/actions/financeiro";
import {
  cancelarReembolso,
  clienteReembolsado,
  desfazerMarco,
  editarReembolso,
  fornecedorPagou,
  marcarPedido,
  registrarReembolso,
} from "@/server/actions/reembolsos";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { auditoria, categoriasFinanceiras, clientes, lancamentos, reembolsos, vendas, viagens } from "@/server/db/schema";
import { relatorioDre } from "@/server/queries/paineis";
import { listarReembolsos, reembolsosDaViagem, servicosDaViagem, type ReembolsoCaso } from "@/server/queries/reembolsos";
import { ajustesDaViagem, margensVendidas } from "@/server/queries/vendas";
import type { MargemReal } from "@/domain/venda";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { contaBancaria, vendida, type Fixture } from "../helpers/venda";

const HOJE = hojeEmCuiaba();
const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };

function dias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

function realDe(m: MargemReal | { erro: string }): MargemReal {
  if ("erro" in m) throw new Error("margem sem cálculo no fixture");
  return m;
}

describe("reembolsos", () => {
  let x: Fixture;
  let conta: string;

  const entrada = (extra: Record<string, unknown> = {}) => ({
    viagemId: x.viagemId,
    contaPagarId: x.hotel.id,
    servico: "Palazzo Barocci",
    ocorridoEm: HOJE,
    ocorrido: "O hotel cancelou uma diária na chegada.",
    valorCobrar: "385,00",
    valorDevolver: "411,45",
    formaDevolucao: "pix",
    prazoCliente: dias(HOJE, 10),
    previstoFornecedor: dias(HOJE, 20),
    ...extra,
  });

  const baixa = (valorPago: string, extra: Record<string, unknown> = {}) => ({
    data: HOJE,
    valorPago,
    juros: "",
    desconto: "",
    contaBancariaId: conta,
    observacao: "",
    ...extra,
  });

  async function registrar(extra: Record<string, unknown> = {}): Promise<string> {
    const r = await comSessao(x.fin.id, () => registrarReembolso(entrada(extra)));
    if (!r.ok) throw new Error(r.erro);
    return r.id!;
  }

  const contasDo = (casoId: string) => db.select().from(lancamentos).where(eq(lancamentos.reembolsoId, casoId)).orderBy(asc(lancamentos.criadoEm), asc(lancamentos.id));
  const abertas = async (casoId: string) => (await contasDo(casoId)).filter((l) => l.status !== "cancelado");
  const contaDoLado = async (casoId: string, lado: "pagar" | "receber") => (await abertas(casoId)).find((l) => l.lado === lado);
  const linhaDoCaso = async (casoId: string) => (await db.select().from(reembolsos).where(eq(reembolsos.id, casoId)))[0];
  async function caso(casoId: string): Promise<ReembolsoCaso> {
    const c = (await comSessao(x.fin.id, () => reembolsosDaViagem(x.viagemId))).find((k) => k.id === casoId);
    if (!c) throw new Error("caso não encontrado");
    return c;
  }
  const categoria = async (sistema: CategoriaSistema) => (await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, sistema)))[0].id;

  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
    conta = await contaBancaria(x.fin.id);
  });

  it("registrar com PIX cria o caso e as duas contas ligadas, pela categoria de sistema, centro da filial e pessoas certas", async () => {
    const id = await registrar();
    const c = await linhaDoCaso(id);
    expect(c).toMatchObject({
      viagemId: x.viagemId,
      contaPagarId: x.hotel.id,
      fornecedorId: x.fornecedores.palazzo,
      valorCobrar: 38500n,
      valorDevolver: 41145n,
      formaDevolucao: "pix",
      criadoPor: x.fin.id,
    });
    const [v] = await db.select({ seq: viagens.seq, clienteId: viagens.clienteId, filial: viagens.filial, codigo: clientes.codigo }).from(viagens).innerJoin(clientes, eq(clientes.id, viagens.clienteId)).where(eq(viagens.id, x.viagemId));
    const descricao = `Reembolso ${formatarCodigoViagem(v.codigo, v.seq)}: Palazzo Barocci`;
    const centro = centroDaFilial(v.filial);
    const contas = await contasDo(id);
    expect(contas).toHaveLength(2);
    const receber = contas.find((l) => l.lado === "receber")!;
    const pagar = contas.find((l) => l.lado === "pagar")!;
    expect(receber).toMatchObject({
      descricao,
      categoriaId: await categoria("reembolso_fornecedor"),
      fornecedorId: x.fornecedores.palazzo,
      clienteId: null,
      centro,
      emissao: HOJE,
      competencia: HOJE.slice(0, 7),
      vencimento: dias(HOJE, 20),
      valor: 38500n,
      forma: "transferencia",
      status: "em_aberto",
      reembolsoId: id,
    });
    expect(pagar).toMatchObject({
      descricao,
      categoriaId: await categoria("reembolso_cliente"),
      fornecedorId: null,
      clienteId: v.clienteId,
      centro,
      emissao: HOJE,
      competencia: HOJE.slice(0, 7),
      vencimento: dias(HOJE, 10),
      valor: 41145n,
      forma: "pix",
      status: "em_aberto",
      reembolsoId: id,
    });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "reembolsos"), eq(auditoria.registroId, id)));
    expect(aud.map((a) => a.acao)).toEqual(["criar"]);
    expect((await caso(id)).situacao).toBe("Pedir ao fornecedor");
  });

  it("abatimento: só a conta a receber; cobrar 0: só a conta a pagar (transferência)", async () => {
    const a = await registrar({ formaDevolucao: "abatimento" });
    expect((await contasDo(a)).map((l) => l.lado)).toEqual(["receber"]);
    const b = await registrar({ valorCobrar: "", previstoFornecedor: "", formaDevolucao: "transferencia" });
    const contas = await contasDo(b);
    expect(contas.map((l) => [l.lado, l.forma])).toEqual([["pagar", "transferencia"]]);
    expect((await caso(b)).situacao).toBe("Reembolsar o cliente");
  });

  it("descrição da conta cortada em 200 caracteres com serviço longo", async () => {
    const id = await registrar({ servico: "S".repeat(200) });
    for (const l of await contasDo(id)) expect(l.descricao).toHaveLength(200);
    expect((await linhaDoCaso(id)).servico).toHaveLength(200);
  });

  it("serviço fora da viagem é recusado; servicosDaViagem lista as contas com o fornecedor", async () => {
    const outra = await vendida();
    const r = await comSessao(x.fin.id, () => registrarReembolso(entrada({ contaPagarId: outra.hotel.id })));
    expect(r).toMatchObject({ ok: false, campos: { contaPagarId: expect.any(String) } });
    const servicos = await comSessao(x.fin.id, () => servicosDaViagem(x.viagemId));
    expect(servicos).toContainEqual({ contaId: x.hotel.id, servico: x.hotel.descricao, fornecedor: "Palazzo Hotels" });
    expect(servicos.map((s) => s.contaId)).not.toContain(outra.hotel.id);
  });

  it("fornecedorPagou baixa a conta a receber e a situação muda; valor diferente sem observação é recusado no campo", async () => {
    const id = await registrar();
    expect((await comSessao(x.fin.id, () => marcarPedido(id, { pedidoEm: HOJE, protocolo: "PZ-123" }))).ok).toBe(true);
    expect((await caso(id)).situacao).toBe("Aguardando fornecedor e cliente");

    expect(await comSessao(x.fin.id, () => fornecedorPagou(id, baixa("400,00")))).toMatchObject({ ok: false, campos: { observacao: expect.any(String) } });
    expect((await contaDoLado(id, "receber"))!.status).toBe("em_aberto");

    expect((await comSessao(x.fin.id, () => fornecedorPagou(id, baixa("400,00", { observacao: "Pagou a diária cheia" })))).ok).toBe(true);
    const receber = (await contaDoLado(id, "receber"))!;
    expect(receber).toMatchObject({ status: "baixado", baixadoEm: HOJE, valorPago: 40000n });
    const c = await caso(id);
    expect(c.situacao).toBe("Reembolsar o cliente");
    expect(c.ladoFornecedor).toMatchObject({ recebidoEm: HOJE, valorRecebido: 40000n, pedidoEm: HOJE, protocolo: "PZ-123" });
  });

  it("baixar a mesma conta pela lista única muda a situação igual; desfazer pela lista reabre", async () => {
    const id = await registrar();
    const pagar = (await contaDoLado(id, "pagar"))!;
    expect((await comSessao(x.fin.id, () => baixarLinha("manual", pagar.id, baixa("411,45")))).ok).toBe(true);
    let c = await caso(id);
    expect(c.situacao).toBe("Pedir ao fornecedor");
    expect(c.ladoCliente).toMatchObject({ reembolsadoEm: HOJE, valorDevolvido: 41145n });

    const receber = (await contaDoLado(id, "receber"))!;
    expect((await comSessao(x.fin.id, () => baixarLinha("manual", receber.id, baixa("385,00")))).ok).toBe(true);
    expect((await caso(id)).situacao).toBe("Concluído");

    expect((await comSessao(x.fin.id, () => desfazerBaixaLinha("manual", pagar.id))).ok).toBe(true);
    c = await caso(id);
    expect(c.situacao).toBe("Reembolsar o cliente");
    expect(c.ladoCliente).toMatchObject({ reembolsadoEm: null, valorDevolvido: null });

    // E pelo caso: cliente reembolsado e desfazer o marco do fornecedor.
    expect((await comSessao(x.fin.id, () => clienteReembolsado(id, baixa("411,45")))).ok).toBe(true);
    expect((await caso(id)).situacao).toBe("Concluído");
    expect((await comSessao(x.fin.id, () => desfazerMarco(id, "fornecedor"))).ok).toBe(true);
    expect((await contaDoLado(id, "receber"))!.status).toBe("em_aberto");
    expect((await caso(id)).situacao).toBe("Pedir ao fornecedor");
  });

  it("clienteReembolsado com crédito só grava a data (sem conta); desfazer o marco limpa a data", async () => {
    const id = await registrar({ formaDevolucao: "credito" });
    expect((await abertas(id)).map((l) => l.lado)).toEqual(["receber"]);
    expect(await comSessao(x.fin.id, () => clienteReembolsado(id, { data: dias(HOJE, 1) }))).toMatchObject({ ok: false, campos: { data: expect.any(String) } });
    expect((await comSessao(x.fin.id, () => clienteReembolsado(id, { data: HOJE }))).ok).toBe(true);
    expect((await linhaDoCaso(id)).reembolsadoEm).toBe(HOJE);
    expect((await abertas(id)).map((l) => l.lado)).toEqual(["receber"]);
    expect((await caso(id)).ladoCliente).toMatchObject({ reembolsadoEm: HOJE, valorDevolvido: null });
    expect(await comSessao(x.fin.id, () => clienteReembolsado(id, { data: HOJE }))).toMatchObject({ ok: false });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "reembolsos"), eq(auditoria.registroId, id))).orderBy(asc(auditoria.id));
    expect(aud.map((a) => a.acao)).toEqual(["criar", "alterar"]);

    expect((await comSessao(x.fin.id, () => desfazerMarco(id, "cliente"))).ok).toBe(true);
    expect((await linhaDoCaso(id)).reembolsadoEm).toBeNull();
    expect(await comSessao(x.fin.id, () => desfazerMarco(id, "cliente"))).toMatchObject({ ok: false });
  });

  it("editar: valor em aberto altera a conta; lado baixado recusa o valor mas aceita texto e prazo", async () => {
    const id = await registrar();
    const r = await comSessao(x.fin.id, () =>
      editarReembolso(id, entrada({ servico: "Hotel Palazzo", valorCobrar: "390,00", previstoFornecedor: dias(HOJE, 25), valorDevolver: "420,00", prazoCliente: dias(HOJE, 12) })),
    );
    expect(r.ok).toBe(true);
    const receber = (await contaDoLado(id, "receber"))!;
    const pagar = (await contaDoLado(id, "pagar"))!;
    expect(receber).toMatchObject({ valor: 39000n, vencimento: dias(HOJE, 25) });
    expect(receber.descricao).toMatch(/: Hotel Palazzo$/);
    expect(pagar).toMatchObject({ valor: 42000n, vencimento: dias(HOJE, 12) });
    expect(await linhaDoCaso(id)).toMatchObject({ servico: "Hotel Palazzo", valorCobrar: 39000n, valorDevolver: 42000n });

    expect((await comSessao(x.fin.id, () => fornecedorPagou(id, baixa("390,00")))).ok).toBe(true);
    const recusa = await comSessao(x.fin.id, () => editarReembolso(id, entrada({ servico: "Hotel Palazzo", valorCobrar: "380,00", valorDevolver: "420,00", prazoCliente: dias(HOJE, 12) })));
    expect(recusa).toMatchObject({ ok: false, campos: { valorCobrar: expect.any(String) } });
    expect((await linhaDoCaso(id)).valorCobrar).toBe(39000n);

    // Texto e prazo do lado baixado continuam editáveis; a conta baixada não muda.
    const ok = await comSessao(x.fin.id, () =>
      editarReembolso(id, entrada({ servico: "Hotel Palazzo", ocorrido: "O hotel cancelou duas diárias.", valorCobrar: "390,00", previstoFornecedor: dias(HOJE, 30), valorDevolver: "420,00", prazoCliente: dias(HOJE, 12) })),
    );
    expect(ok.ok).toBe(true);
    expect(await linhaDoCaso(id)).toMatchObject({ ocorrido: "O hotel cancelou duas diárias.", previstoFornecedor: dias(HOJE, 30) });
    expect((await contaDoLado(id, "receber"))!).toMatchObject({ status: "baixado", vencimento: dias(HOJE, 25) });
  });

  it("editar: trocar a forma de PIX para abatimento cancela a conta a pagar; voltar para transferência cria outra", async () => {
    const id = await registrar();
    const pagar = (await contaDoLado(id, "pagar"))!;
    expect((await comSessao(x.fin.id, () => editarReembolso(id, entrada({ formaDevolucao: "abatimento" })))).ok).toBe(true);
    expect((await db.select().from(lancamentos).where(eq(lancamentos.id, pagar.id)))[0].status).toBe("cancelado");
    expect((await abertas(id)).map((l) => l.lado)).toEqual(["receber"]);

    expect((await comSessao(x.fin.id, () => editarReembolso(id, entrada({ formaDevolucao: "transferencia" })))).ok).toBe(true);
    const nova = (await contaDoLado(id, "pagar"))!;
    expect(nova.id).not.toBe(pagar.id);
    expect(nova).toMatchObject({ forma: "transferencia", valor: 41145n, status: "em_aberto" });

    // Lado do cliente baixado: forma e valor recusados.
    expect((await comSessao(x.fin.id, () => clienteReembolsado(id, baixa("411,45")))).ok).toBe(true);
    expect(await comSessao(x.fin.id, () => editarReembolso(id, entrada({ formaDevolucao: "pix" })))).toMatchObject({ ok: false, campos: { formaDevolucao: expect.any(String) } });
    expect(await comSessao(x.fin.id, () => editarReembolso(id, entrada({ formaDevolucao: "transferencia", valorDevolver: "400,00" })))).toMatchObject({
      ok: false,
      campos: { valorDevolver: expect.any(String) },
    });
  });

  it("cancelar: motivo de 5 a 200 caracteres; só sem baixa; cancela as contas em aberto", async () => {
    const id = await registrar();
    expect(await comSessao(x.fin.id, () => cancelarReembolso(id, "   "))).toMatchObject({ ok: false, campos: { motivo: expect.any(String) } });
    expect(await comSessao(x.fin.id, () => cancelarReembolso(id, "Erro"))).toMatchObject({ ok: false, campos: { motivo: expect.any(String) } });

    expect((await comSessao(x.fin.id, () => fornecedorPagou(id, baixa("385,00")))).ok).toBe(true);
    expect(await comSessao(x.fin.id, () => cancelarReembolso(id, "Registrado por engano"))).toMatchObject({ ok: false });
    expect((await linhaDoCaso(id)).canceladoEm).toBeNull();

    expect((await comSessao(x.fin.id, () => desfazerMarco(id, "fornecedor"))).ok).toBe(true);
    expect((await comSessao(x.fin.id, () => cancelarReembolso(id, "Registrado por engano"))).ok).toBe(true);
    expect(await linhaDoCaso(id)).toMatchObject({ canceladoPor: x.fin.id, motivoCancelamento: "Registrado por engano" });
    expect((await contasDo(id)).map((l) => l.status)).toEqual(["cancelado", "cancelado"]);
    expect((await caso(id)).situacao).toBe("Cancelado");
    // Cancelado: nada mais muda.
    expect(await comSessao(x.fin.id, () => marcarPedido(id, { pedidoEm: HOJE, protocolo: "" }))).toMatchObject({ ok: false });
    expect(await comSessao(x.fin.id, () => editarReembolso(id, entrada()))).toMatchObject({ ok: false });

    // Crédito com a data marcada também conta como baixa.
    const b = await registrar({ valorCobrar: "", previstoFornecedor: "", formaDevolucao: "credito" });
    expect((await comSessao(x.fin.id, () => clienteReembolsado(b, { data: HOJE }))).ok).toBe(true);
    expect(await comSessao(x.fin.id, () => cancelarReembolso(b, "Registrado por engano"))).toMatchObject({ ok: false });
  });

  it("viagem não vendida é recusada; conciliada é aceita", async () => {
    await db.update(viagens).set({ status: "aprovado" }).where(eq(viagens.id, x.viagemId));
    expect(await comSessao(x.fin.id, () => registrarReembolso(entrada()))).toEqual({ ok: false, erro: MSG_NAO_VENDIDA });
    await db.update(viagens).set({ status: "vendida", conciliadaEm: new Date() }).where(eq(viagens.id, x.viagemId));
    const id = await registrar();
    expect((await comSessao(x.fin.id, () => fornecedorPagou(id, baixa("385,00")))).ok).toBe(true);
  });

  it("margem real: 411,45 devolvido − 385,00 cobrado → final cai 26,45; depois das baixas, os valores efetivos", async () => {
    const antes = realDe((await margensVendidas([x.viagemId])).get(x.viagemId)!.real);
    const id = await registrar();
    expect(await ajustesDaViagem(db, x.viagemId)).toEqual({ caixa: 0n, reembolsos: 2645n });
    const depois = realDe((await margensVendidas([x.viagemId])).get(x.viagemId)!.real);
    expect(depois.final).toBe(antes.final - 2645n);
    expect({ ...depois, final: antes.final, finalPct: antes.finalPct, ajustes: 0n, ajustesDetalhe: antes.ajustesDetalhe }).toEqual(antes);

    // Fornecedor pagou 400,00 e o cliente recebeu 411,45: 411,45 − 400,00.
    expect((await comSessao(x.fin.id, () => fornecedorPagou(id, baixa("400,00", { observacao: "Diária cheia" })))).ok).toBe(true);
    expect((await comSessao(x.fin.id, () => clienteReembolsado(id, baixa("411,45")))).ok).toBe(true);
    expect(await ajustesDaViagem(db, x.viagemId)).toEqual({ caixa: 0n, reembolsos: 1145n });

    // Abatimento não conta o lado do cliente; crédito conta o valor a devolver; cancelado não conta.
    await registrar({ formaDevolucao: "abatimento", valorCobrar: "100,00", valorDevolver: "100,00" });
    expect(await ajustesDaViagem(db, x.viagemId)).toEqual({ caixa: 0n, reembolsos: 1145n - 10000n });
    const credito = await registrar({ formaDevolucao: "credito", valorCobrar: "", previstoFornecedor: "", valorDevolver: "50,00" });
    expect(await ajustesDaViagem(db, x.viagemId)).toEqual({ caixa: 0n, reembolsos: 1145n - 10000n + 5000n });
    expect((await comSessao(x.fin.id, () => cancelarReembolso(credito, "Registrado por engano"))).ok).toBe(true);
    // A versão em lote vê o mesmo, e outra viagem sem caso fica em 0.
    const outra = await vendida();
    const lote = await margensVendidas([x.viagemId, outra.viagemId]);
    expect(realDe(lote.get(x.viagemId)!.real).ajustesDetalhe).toEqual({ caixa: 0n, reembolsos: 1145n - 10000n });
    expect(realDe(lote.get(outra.viagemId)!.real).ajustesDetalhe).toEqual({ caixa: 0n, reembolsos: 0n });
  });

  it("Review Focus 2: o DRE do período mostra as duas categorias e a margem das viagens não muda", async () => {
    await db.update(vendas).set({ aceiteEm: HOJE }).where(eq(vendas.viagemId, x.viagemId));
    const intervalo = intervaloDeMeses(HOJE.slice(0, 7), HOJE.slice(0, 7));
    const antes = await comSessao(x.fin.id, () => relatorioDre(intervalo));
    await registrar();
    const depois = await comSessao(x.fin.id, () => relatorioDre(intervalo));
    // As linhas das viagens (até "Margem das viagens") não mudam; o resultado do período ganha as duas categorias.
    const totais = (d: typeof antes) => d.linhas.slice(0, d.linhas.findIndex((l) => l.rotulo === "(=) Margem das viagens") + 1);
    expect(totais(depois)).toEqual(totais(antes));
    expect(depois.linhas).toContainEqual(expect.objectContaining({ rotulo: "Reembolso a cliente", valor: -41145n, nivel: "categoria" }));
    expect(depois.linhas).toContainEqual(expect.objectContaining({ rotulo: "Reembolso de fornecedor", valor: 38500n, nivel: "categoria" }));
    expect(depois.resultado).toBe(antes.resultado + 38500n - 41145n);
  });

  it("listarReembolsos: abas e resumo", async () => {
    const a = await registrar();
    const b = await registrar({ valorCobrar: "", previstoFornecedor: "", valorDevolver: "100,00", formaDevolucao: "credito" });
    const cancelado = await registrar({ valorCobrar: "50,00", valorDevolver: "" });
    expect((await comSessao(x.fin.id, () => cancelarReembolso(cancelado, "Registrado por engano"))).ok).toBe(true);
    expect((await comSessao(x.fin.id, () => clienteReembolsado(b, { data: HOJE }))).ok).toBe(true);

    const abertos = await comSessao(x.fin.id, () => listarReembolsos("abertos"));
    expect(abertos.casos.map((c) => c.id)).toEqual([a]);
    expect(abertos.resumo).toEqual({ abertos: 1, aReceber: 38500n, aDevolver: 41145n });
    const concluidos = await comSessao(x.fin.id, () => listarReembolsos("concluidos"));
    expect(concluidos.casos.map((c) => c.id).sort()).toEqual([b, cancelado].sort());
    expect(concluidos.resumo).toEqual(abertos.resumo);
    const c = concluidos.casos.find((k) => k.id === b)!;
    expect(c).toMatchObject({ situacao: "Concluído", viagemId: x.viagemId, formaDevolucao: "credito", rotuloForma: "Crédito para a próxima viagem" });
  });

  it("Review Focus 4: consultor e operacional recusados em todas as actions e queries", async () => {
    const id = await registrar();
    const antes = { caso: await linhaDoCaso(id), contas: await contasDo(id) };
    const operacional = await criarUsuarioTeste("operacional");
    for (const u of [x.u.id, operacional.id]) {
      expect(await comSessao(u, () => registrarReembolso(entrada()))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => editarReembolso(id, entrada({ valorCobrar: "1,00" })))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => marcarPedido(id, { pedidoEm: HOJE, protocolo: "X" }))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => fornecedorPagou(id, baixa("385,00")))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => clienteReembolsado(id, baixa("411,45")))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => desfazerMarco(id, "cliente"))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(u, () => cancelarReembolso(id, "Registrado por engano"))).toEqual(SEM_PERMISSAO);
      await expect(comSessao(u, () => listarReembolsos("abertos"))).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(u, () => reembolsosDaViagem(x.viagemId))).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(u, () => servicosDaViagem(x.viagemId))).rejects.toBeInstanceOf(ErroAcesso);
    }
    expect({ caso: await linhaDoCaso(id), contas: await contasDo(id) }).toEqual(antes);
    expect(await comSessao(x.d.id, () => reembolsosDaViagem(x.viagemId))).toHaveLength(1);
  });
});
