import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import type { ResultadoVersao, Snapshot } from "@/domain/aprovacoes";
import type { FormaPagamento } from "@/domain/precificacao";
import { db, sql } from "@/server/db/client";
import { chaveTrava } from "@/server/trava-viagem";
import {
  auditoria,
  comissoes,
  contasPagar,
  pagamentosFornecedor,
  parcelasReceber,
  vendas,
  versoesPrecificacao,
  viagens,
} from "@/server/db/schema";
import { salvarCliente, type ClienteEntrada } from "@/server/actions/clientes";
import { salvarFornecedor } from "@/server/actions/fornecedores";
import { salvarRegras } from "@/server/actions/regras";
import { regrasVigentes } from "@/server/queries/regras";
import { aprovar, devolver, enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { alterarOrcamento, criarOrcamento, escolherCotacao, salvarCotacao, salvarItem, type ItemEntrada } from "@/server/actions/viagens";
import { fecharVenda, pedirNovaForma, registrarAjustesCliente, type FechamentoEntrada } from "@/server/actions/vendas";
import { obterCliente } from "@/server/queries/clientes";
import { obterPrecificacao } from "@/server/queries/viagens";
import { listarPropostas } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const souza: ClienteEntrada = {
  tipo: "familia",
  filial: "RS",
  telefone: "(66) 9 9123-4567",
  titular: { nome: "Marcos Souza" },
  acompanhantes: [{ nome: "Júlia Souza", parentesco: "Esposa" }],
};

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };
const VENDIDA = { ok: false, erro: "Viagem vendida: ajustes de valor vão em Contas a pagar" };
const JA_VENDIDA = { ok: false, erro: "Esta viagem já foi vendida" };
const BOLETO4: FormaPagamento = { tipo: "boleto", parcelas: 4 };

const fechamento: FechamentoEntrada = {
  aceiteEm: "2026-11-20",
  forma: BOLETO4,
  parcelas: 4,
  primeiroVencimento: "2026-12-10",
  faturaNome: "Marcos Souza",
  faturaDocumento: "529.982.247-25",
  comprovante: "Aceite pelo WhatsApp em 20/11/2026",
  observacao: "Emitir fatura em nome do titular",
};

async function fornecedor(uid: string, nome: string, modalidade: "net" | "comissionado", tipos: string[]) {
  const r = await comSessao(uid, () => salvarFornecedor({ nome, tipos, modalidade } as Parameters<typeof salvarFornecedor>[0]));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

async function item(uid: string, viagemId: string, dados: Partial<ItemEntrada> = {}) {
  const r = await comSessao(uid, () => salvarItem(viagemId, { tipo: "Passeio", servico: "Passeio", ...dados }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

async function cotacao(uid: string, itemId: string, dados: Record<string, unknown> = {}) {
  const r = await comSessao(uid, () => salvarCotacao(itemId, { moeda: "BRL", valor: "1.000,00", ...dados }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

/**
 * Viagem aprovada em boleto 4x: hotel em fornecedor comissionado (escolhida 3.106,00 com 4% e 4% à vista),
 * passeio em fornecedor net (500,00), aéreo (8.000,00, 6%) e a taxa de roteiro automática.
 */
async function aprovada(forma: FormaPagamento = BOLETO4) {
  const u = await criarUsuarioTeste("consultor");
  const d = await criarUsuarioTeste("diretor");
  // Taxa de roteiro a partir de 2 itens terrestres: entra no snapshot (e não vira conta a pagar).
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
  const hotel = await item(u.id, viagemId, { tipo: "Hotelaria", servico: "Palazzo Barocci", cidade: "Roma", diarias: 3 });
  const barata = await cotacao(u.id, hotel, { valor: "3.106,00", comissao: "4", descontoAVista: "4", fornecedorId: palazzo });
  await cotacao(u.id, hotel, { valor: "3.300,00" });
  const passeio = await item(u.id, viagemId, { servico: "Coliseu", cidade: "Roma" });
  await cotacao(u.id, passeio, { valor: "500,00", fornecedorId: roma });
  const aereo = await item(u.id, viagemId, { tipo: "Aéreo", servico: "GRU-FCO" });
  await cotacao(u.id, aereo, { valor: "8.000,00", comissao: "6", tarifaFixa: "120,00" });
  const e = await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma, alteracao: "Primeira versão" }));
  if (!e.ok) throw new Error(e.erro);
  const a = await comSessao(d.id, () => aprovar(e.id));
  if (!a.ok) throw new Error(a.erro);
  return { u, d, viagemId, versaoId: e.id, hotel, barata, passeio, aereo, palazzo, roma, pessoas };
}

const viagem = async (id: string) => (await db.select().from(viagens).where(eq(viagens.id, id)))[0];
const versao = async (id: string) => (await db.select().from(versoesPrecificacao).where(eq(versoesPrecificacao.id, id)))[0];
const versoesDa = (viagemId: string) =>
  db.select().from(versoesPrecificacao).where(eq(versoesPrecificacao.viagemId, viagemId)).orderBy(asc(versoesPrecificacao.numero));

async function nadaGravado(viagemId: string) {
  expect(await db.select().from(vendas).where(eq(vendas.viagemId, viagemId))).toHaveLength(0);
  expect(await db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, viagemId))).toHaveLength(0);
  expect(await db.select().from(contasPagar).where(eq(contasPagar.viagemId, viagemId))).toHaveLength(0);
  expect(await db.select().from(comissoes).where(eq(comissoes.viagemId, viagemId))).toHaveLength(0);
}

/** Segura o lock consultivo da viagem (chaveTrava) em outra conexão enquanto `acao` roda; diz se ela esperou. */
async function comTravaSegura<T>(viagemId: string, acao: () => Promise<T>): Promise<{ esperou: boolean; r: T }> {
  let soltar!: () => void;
  const solto = new Promise<void>((ok) => (soltar = ok));
  let travou!: () => void;
  const travado = new Promise<void>((ok) => (travou = ok));
  const segurando = sql.begin(async (t) => {
    await t`select pg_advisory_xact_lock(hashtext(${chaveTrava(viagemId)}))`;
    travou();
    await solto;
  });
  await travado;
  let terminou = false;
  const p = acao().then((r) => {
    terminou = true;
    return r;
  });
  await new Promise((ok) => setTimeout(ok, 400));
  const esperou = !terminou;
  soltar();
  await segurando;
  return { esperou, r: await p };
}

describe("trava compartilhada da viagem", () => {
  beforeEach(limparBanco);

  it("venda (vendas.ts) e decisão/envio (aprovacoes.ts) esperam o mesmo lock consultivo (chaveTrava)", async () => {
    const { u, d, viagemId } = await aprovada();
    const n = await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: { tipo: "pix", parcelas: 1 } }));
    if (!n.ok) throw new Error(n.erro);
    const dev = await comTravaSegura(viagemId, () => comSessao(d.id, () => devolver(n.id, "Mantenha o boleto")));
    expect(dev).toEqual({ esperou: true, r: { ok: true } });
    const venda = await comTravaSegura(viagemId, () => comSessao(u.id, () => fecharVenda(viagemId, fechamento)));
    expect(venda.esperou).toBe(true);
    expect(venda.r).toMatchObject({ ok: true });
    const envio = await comTravaSegura(viagemId, () => comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: BOLETO4, alteracao: "" })));
    expect(envio).toEqual({ esperou: true, r: VENDIDA });
  });

  it("fecharVenda e pedirNovaForma ao mesmo tempo: só uma vale", async () => {
    const { u, viagemId } = await aprovada();
    const rs = await comSessao(u.id, () =>
      Promise.all([fecharVenda(viagemId, fechamento), pedirNovaForma(viagemId, { forma: { tipo: "pix", parcelas: 1 } })]),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    const v = await viagem(viagemId);
    if (rs[0].ok) {
      expect(rs[1]).toEqual(VENDIDA);
      expect(v.status).toBe("vendida");
      expect(await versoesDa(viagemId)).toHaveLength(1);
    } else {
      expect(rs[0]).toEqual({ ok: false, erro: "Orçamento aguardando aprovação do Diretor" });
      expect(v.status).toBe("aguardando_aprovacao");
      await nadaGravado(viagemId);
    }
  });
});

describe("fecharVenda", () => {
  beforeEach(limparBanco);

  it("cria venda, parcelas somando o preço ao cliente, contas (sem a taxa), pagamentos à vista e comissões a receber", async () => {
    const { u, viagemId, versaoId, hotel, barata, passeio, aereo, palazzo, roma } = await aprovada();
    const r = await comSessao(u.id, () => fecharVenda(viagemId, fechamento));
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(Object.keys(r).sort()).toEqual(["id", "ok"]);

    const ver = await versao(versaoId);
    const res = ver.resultado as ResultadoVersao;
    const total = BigInt(res.precoCliente!);
    expect(total).toBe(ver.preco + BigInt(res.taxaServico!));

    const [venda] = await db.select().from(vendas).where(eq(vendas.viagemId, viagemId));
    expect(venda).toMatchObject({
      id: r.id,
      versaoId,
      aceiteEm: "2026-11-20",
      forma: BOLETO4,
      parcelas: 4,
      primeiroVencimento: "2026-12-10",
      total,
      faturaNome: "Marcos Souza",
      faturaDocumento: "52998224725",
      comprovante: "Aceite pelo WhatsApp em 20/11/2026",
      observacao: "Emitir fatura em nome do titular",
      criadoPor: u.id,
    });

    const ps = await db.select().from(parcelasReceber).where(eq(parcelasReceber.vendaId, venda.id)).orderBy(asc(parcelasReceber.numero));
    expect(ps.map((p) => [p.numero, p.totalParcelas, p.vencimento, p.meio, p.status])).toEqual([
      [1, 4, "2026-12-10", "boleto", "a_receber"],
      [2, 4, "2027-01-10", "boleto", "a_receber"],
      [3, 4, "2027-02-10", "boleto", "a_receber"],
      [4, 4, "2027-03-10", "boleto", "a_receber"],
    ]);
    expect(ps.reduce((a, p) => a + p.valor, 0n)).toBe(total);
    expect(ps[0].valor).toBe(total / 4n);
    expect(ps.reduce((a, p) => a + p.taxaPrevista, 0n)).toBe(BigInt(res.taxa));

    const contas = await db.select().from(contasPagar).where(eq(contasPagar.viagemId, viagemId));
    const snap = ver.snapshot as Snapshot;
    const naoTaxa = snap.itens.filter((i) => i.tipo !== "Taxa").map((i) => i.id);
    expect(snap.itens.some((i) => i.tipo === "Taxa")).toBe(true);
    expect(contas.map((c) => c.itemId).sort()).toEqual([...naoTaxa].sort());
    expect(contas.map((c) => c.itemId).sort()).toEqual([hotel, passeio, aereo].sort());
    const ch = contas.find((c) => c.itemId === hotel)!;
    expect(ch).toMatchObject({
      cotacaoId: barata,
      fornecedorId: palazzo,
      descricao: "Palazzo Barocci",
      aereo: false,
      moeda: "BRL",
      valorOriginal: 310600n,
      previstoVendaBrl: 310600n, // comissionado: paga-se cheio
      previstoBrl: 310600n,
      comissaoPct: "4.000",
      comissaoTipo: "a_receber",
      descontoAVistaPct: "4.000",
      forma: "a_vista",
      status: "a_pagar",
    });
    const cp = contas.find((c) => c.itemId === passeio)!;
    expect(cp).toMatchObject({ fornecedorId: roma, comissaoTipo: "descontada", previstoBrl: 50000n, previstoVendaBrl: 50000n });
    const ca = contas.find((c) => c.itemId === aereo)!;
    expect(ca).toMatchObject({ aereo: true, comissaoTipo: "descontada", fornecedorId: null });

    const pags = await db.select().from(pagamentosFornecedor).where(inArray(pagamentosFornecedor.contaId, contas.map((c) => c.id)));
    expect(pags).toHaveLength(3);
    for (const p of pags) expect(p).toMatchObject({ numero: 1, vencimento: "2027-07-15", status: "a_pagar" });
    expect(pags.find((p) => p.contaId === ch.id)).toMatchObject({ valorOriginal: 298176n, valorBrlPrevisto: 298176n }); // 4% à vista
    expect(pags.find((p) => p.contaId === cp.id)).toMatchObject({ valorOriginal: 50000n, valorBrlPrevisto: 50000n });

    const cs = await db.select().from(comissoes).where(eq(comissoes.viagemId, viagemId));
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({
      contaId: ch.id,
      fornecedorId: palazzo,
      baseBrl: 310600n,
      pct: "4.000",
      valorPrevisto: 12424n,
      previstaPara: "2027-10-15",
      status: "prevista",
    });

    const v = await viagem(viagemId);
    expect(v.status).toBe("vendida");
    expect(v.vendidaEm).toBeInstanceOf(Date);
    expect(v.versaoAprovadaId).toBe(versaoId);

    const aud = await db.select().from(auditoria).where(eq(auditoria.usuarioId, u.id));
    const contagem = (t: string) => aud.filter((a) => a.tabela === t && a.acao === "criar").length;
    expect(contagem("vendas")).toBe(1);
    expect(contagem("parcelas_receber")).toBe(4);
    expect(contagem("contas_pagar")).toBe(3);
    expect(contagem("pagamentos_fornecedor")).toBe(3);
    expect(contagem("comissoes")).toBe(1);
    expect(contagem("tarefas")).toBe(5);
    expect(aud.find((a) => a.tabela === "viagens" && a.registroId === viagemId && (a.depois as { status?: string })?.status === "vendida")).toMatchObject({
      antes: { status: "aprovado" },
    });
  });

  it("Review Focus 1: duas vendas ao mesmo tempo → uma; a outra 'Esta viagem já foi vendida'", async () => {
    const { u, viagemId } = await aprovada();
    const rs = await comSessao(u.id, () => Promise.all([fecharVenda(viagemId, fechamento), fecharVenda(viagemId, fechamento)]));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual(JA_VENDIDA);
    expect(await db.select().from(vendas).where(eq(vendas.viagemId, viagemId))).toHaveLength(1);
    expect(await db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, viagemId))).toHaveLength(4);
    expect(await db.select().from(contasPagar).where(eq(contasPagar.viagemId, viagemId))).toHaveLength(3);
    // e depois, de novo
    expect(await comSessao(u.id, () => fecharVenda(viagemId, fechamento))).toEqual(JA_VENDIDA);
  });

  it("Review Focus 2: orçamento editado depois da aprovação → recusado", async () => {
    const { u, viagemId } = await aprovada();
    await item(u.id, viagemId, { servico: "Vaticano" });
    const v = await viagem(viagemId);
    expect(v.status).toBe("em_edicao");
    expect(v.versaoAprovadaId).not.toBeNull();
    expect(await comSessao(u.id, () => fecharVenda(viagemId, fechamento))).toEqual({
      ok: false,
      erro: "O orçamento mudou depois da aprovação. Envie a nova versão para o Diretor.",
    });
    await nadaGravado(viagemId);
  });

  it("forma diferente da aprovada recusada; validações; perfis", async () => {
    const { u, d, viagemId } = await aprovada();
    const f = (x: Partial<FechamentoEntrada>) => comSessao(u.id, () => fecharVenda(viagemId, { ...fechamento, ...x }));
    const DIF = { ok: false, erro: "A forma acordada é diferente da aprovada. Envie a nova forma para o Diretor." };
    expect(await f({ forma: { tipo: "credito", parcelas: 4 } })).toEqual(DIF);
    expect(await f({ forma: { tipo: "boleto", parcelas: 3 }, parcelas: 3 })).toEqual(DIF);
    expect(await f({ parcelas: 3 })).toEqual(DIF);
    expect(await f({ aceiteEm: "" })).toMatchObject({ ok: false, erro: "Informe a data do aceite" });
    expect(await f({ primeiroVencimento: "" })).toMatchObject({ ok: false, erro: "Informe o primeiro vencimento" });
    expect(await f({ faturaNome: " " })).toMatchObject({ ok: false, erro: "Informe o nome da fatura" });
    expect(await f({ faturaDocumento: "111.111.111-11" })).toMatchObject({ ok: false, erro: "CPF ou CNPJ inválido" });
    expect(await f({ parcelas: 0 })).toMatchObject({ ok: false, erro: "Número de parcelas inválido" });
    expect(await f({ aceiteEm: "2999-01-01", primeiroVencimento: "2999-02-01" })).toMatchObject({ ok: false, erro: "Data do aceite no futuro" });
    expect(await f({ primeiroVencimento: "2026-11-19" })).toMatchObject({ ok: false, erro: "O primeiro vencimento não pode ser antes do aceite" });
    expect(await comSessao(u.id, () => fecharVenda("x", fechamento))).toEqual({ ok: false, erro: "Orçamento não encontrado" });
    await nadaGravado(viagemId);

    const fin = await criarUsuarioTeste("fin_operacional");
    expect(await comSessao(fin.id, () => fecharVenda(viagemId, fechamento))).toEqual(SEM_PERMISSAO);
    expect(await comSessao(fin.id, () => pedirNovaForma(viagemId, { forma: { tipo: "pix", parcelas: 1 } }))).toEqual(SEM_PERMISSAO);
    expect(await comSessao(fin.id, () => registrarAjustesCliente(viagemId, "Trocar hotel"))).toEqual(SEM_PERMISSAO);
    await nadaGravado(viagemId);
    expect((await viagem(viagemId)).status).toBe("aprovado");

    // operacional e diretor fecham
    const op = await criarUsuarioTeste("operacional");
    expect(await comSessao(op.id, () => fecharVenda(viagemId, fechamento))).toMatchObject({ ok: true });
    expect(await comSessao(d.id, () => fecharVenda(viagemId, fechamento))).toEqual(JA_VENDIDA);
  });

  it("cartão direto no fornecedor: exige o fornecedor com conta na viagem; grava fornecedor_cartao_id", async () => {
    const CARTAO: FormaPagamento = { tipo: "cartao_fornecedor", parcelas: 1 };
    const { u, viagemId, palazzo } = await aprovada(CARTAO);
    const f = (x: Partial<FechamentoEntrada>) => comSessao(u.id, () => fecharVenda(viagemId, { ...fechamento, forma: CARTAO, parcelas: 1, ...x }));
    const ESCOLHA = { ok: false, erro: "Escolha o fornecedor que recebeu no cartão", campos: { fornecedorCartaoId: "Escolha o fornecedor que recebeu no cartão" } };
    expect(await f({})).toEqual(ESCOLHA);
    expect(await f({ fornecedorCartaoId: "" })).toEqual(ESCOLHA);
    expect(await f({ fornecedorCartaoId: null })).toEqual(ESCOLHA);
    expect(await f({ fornecedorCartaoId: "x" })).toEqual(ESCOLHA);
    // fornecedor sem conta na viagem (não é de nenhum item)
    const outro = await fornecedor(u.id, "Outro Hotel", "net", ["Hotelaria"]);
    expect(await f({ fornecedorCartaoId: outro })).toEqual(ESCOLHA);
    await nadaGravado(viagemId);

    expect(await f({ fornecedorCartaoId: palazzo })).toMatchObject({ ok: true });
    const [venda] = await db.select().from(vendas).where(eq(vendas.viagemId, viagemId));
    expect(venda.fornecedorCartaoId).toBe(palazzo);
    const [a] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "vendas"), eq(auditoria.registroId, venda.id)));
    expect((a.depois as Record<string, unknown>).fornecedorCartaoId).toBe(palazzo);
  });

  it("outras formas: fornecedor do cartão ignorado (fica nulo)", async () => {
    const { u, viagemId, palazzo } = await aprovada();
    expect(await comSessao(u.id, () => fecharVenda(viagemId, { ...fechamento, fornecedorCartaoId: palazzo }))).toMatchObject({ ok: true });
    const [venda] = await db.select().from(vendas).where(eq(vendas.viagemId, viagemId));
    expect(venda.fornecedorCartaoId).toBeNull();
  });

  it("não aprovado: recusado", async () => {
    const { u, viagemId } = await aprovada();
    expect(await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: { tipo: "pix", parcelas: 1 } }))).toMatchObject({ ok: true });
    expect(await comSessao(u.id, () => fecharVenda(viagemId, fechamento))).toEqual({ ok: false, erro: "Orçamento aguardando aprovação do Diretor" });
    await nadaGravado(viagemId);
  });
});

describe("viagem vendida não muda", () => {
  beforeEach(limparBanco);

  it("itens, cotações, cabeçalho, envio e ajustes recusados", async () => {
    const { u, viagemId, hotel, barata, pessoas } = await aprovada();
    const fechou = await comSessao(u.id, () => fecharVenda(viagemId, fechamento));
    expect(fechou.ok).toBe(true);
    const antes = await viagem(viagemId);
    expect(await comSessao(u.id, () => salvarItem(viagemId, { tipo: "Passeio", servico: "Novo" }))).toEqual(VENDIDA);
    expect(await comSessao(u.id, () => salvarCotacao(hotel, { moeda: "BRL", valor: "1,00" }))).toEqual(VENDIDA);
    expect(await comSessao(u.id, () => salvarCotacao(hotel, { moeda: "BRL", valor: "1,00" }, barata))).toEqual(VENDIDA);
    expect(await comSessao(u.id, () => escolherCotacao(barata))).toEqual(VENDIDA);
    expect(
      await comSessao(u.id, () =>
        alterarOrcamento(viagemId, { destino: "Grécia", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas }, antes.atualizadoEm.toISOString()),
      ),
    ).toEqual(VENDIDA);
    expect(await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: BOLETO4, alteracao: "" }))).toEqual(VENDIDA);
    expect(await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: { tipo: "pix", parcelas: 1 } }))).toEqual(VENDIDA);
    expect(await comSessao(u.id, () => registrarAjustesCliente(viagemId, "Trocar hotel"))).toEqual(VENDIDA);
    const depois = await viagem(viagemId);
    expect(depois).toMatchObject({ status: "vendida", destino: "Itália", atualizadoEm: antes.atualizadoEm });
    expect(await versoesDa(viagemId)).toHaveLength(1);
  });
});

describe("pedirNovaForma", () => {
  beforeEach(limparBanco);

  it("cria versão aguardando com o mesmo preço e a nova forma; aprovada, a venda usa a nova forma", async () => {
    const { u, d, viagemId, versaoId } = await aprovada();
    const nova: FormaPagamento = { tipo: "credito", parcelas: 6 };
    const r = await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: nova, nota: "Cliente prefere cartão em 6x" }));
    expect(r).toMatchObject({ ok: true, numero: 2 });
    if (!r.ok) return;
    expect(Object.keys(r).sort()).toEqual(["id", "numero", "ok"]);
    const [v1, v2] = await versoesDa(viagemId);
    expect(v2).toMatchObject({
      id: r.id,
      numero: 2,
      status: "aguardando",
      preco: v1.preco,
      forma: nova,
      dias: v1.dias,
      regrasVersaoId: v1.regrasVersaoId,
      rateio: v1.rateio,
      snapshot: v1.snapshot,
      alteracao: "Nova forma de pagamento acordada com o cliente: Cliente prefere cartão em 6x",
      enviadoPor: u.id,
    });
    const r1 = v1.resultado as ResultadoVersao;
    const r2 = v2.resultado as ResultadoVersao;
    expect(r2.precoCliente).toBe(r1.precoCliente);
    expect(r2.taxa).not.toBe(r1.taxa); // a taxa da forma muda a margem
    expect(await viagem(viagemId)).toMatchObject({ status: "aguardando_aprovacao", versaoAprovadaId: versaoId });
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.registroId, r.id), eq(auditoria.tabela, "versoes_precificacao")));
    expect(aud.map((a) => a.acao)).toEqual(["criar"]);

    // forma antiga não fecha mais; aprovada a nova, fecha com ela
    expect(await comSessao(d.id, () => aprovar(r.id))).toEqual({ ok: true });
    expect(await viagem(viagemId)).toMatchObject({ status: "aprovado", versaoAprovadaId: r.id });
    expect((await comSessao(u.id, () => fecharVenda(viagemId, fechamento))).ok).toBe(false);
    const f = await comSessao(u.id, () => fecharVenda(viagemId, { ...fechamento, forma: nova, parcelas: 6 }));
    expect(f.ok).toBe(true);
    const [venda] = await db.select().from(vendas).where(eq(vendas.viagemId, viagemId));
    expect(venda).toMatchObject({ versaoId: r.id, forma: nova, parcelas: 6, total: BigInt(r2.precoCliente!) });
    const ps = await db.select().from(parcelasReceber).where(eq(parcelasReceber.vendaId, venda.id));
    expect(ps).toHaveLength(6);
    expect(ps.every((p) => p.meio === "cartao_credito")).toBe(true);
    expect(ps.reduce((a, p) => a + p.taxaPrevista, 0n)).toBe(BigInt(r2.taxa));
  });

  it("nova forma devolvida pelo Diretor: viagem volta a aprovado e a forma original ainda fecha", async () => {
    const { u, d, viagemId, versaoId } = await aprovada();
    const n = await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: { tipo: "credito", parcelas: 6 }, nota: "Cartão" }));
    if (!n.ok) throw new Error(n.erro);
    expect(((await versao(n.id)).resultado as ResultadoVersao).origem).toBe("nova_forma");
    expect(await comSessao(d.id, () => devolver(n.id, "Mantenha o boleto"))).toEqual({ ok: true });
    expect(await versao(n.id)).toMatchObject({ status: "devolvida", comentario: "Mantenha o boleto", decididoPor: d.id });
    expect(await viagem(viagemId)).toMatchObject({ status: "aprovado", versaoAprovadaId: versaoId });
    const audV = await db.select().from(auditoria).where(eq(auditoria.registroId, viagemId)).orderBy(asc(auditoria.id));
    expect(audV.at(-1)).toMatchObject({ antes: { status: "aguardando_aprovacao" }, depois: { status: "aprovado" } });
    const f = await comSessao(u.id, () => fecharVenda(viagemId, fechamento));
    expect(f.ok).toBe(true);
    const [venda] = await db.select().from(vendas).where(eq(vendas.viagemId, viagemId));
    expect(venda).toMatchObject({ versaoId, forma: BOLETO4 });
  });

  it("versão enviada normalmente e devolvida continua indo a devolvido", async () => {
    const { u, d, viagemId } = await aprovada();
    await cotacao(u.id, await item(u.id, viagemId, { servico: "Vaticano" }), { valor: "300,00" });
    const e = await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: BOLETO4, alteracao: "Vaticano" }));
    if (!e.ok) throw new Error(e.erro);
    expect(((await versao(e.id)).resultado as ResultadoVersao).origem).toBeUndefined();
    expect(await comSessao(d.id, () => devolver(e.id, "Caro demais"))).toEqual({ ok: true });
    expect((await viagem(viagemId)).status).toBe("devolvido");
  });

  it("forma igual ou inválida para os Parâmetros recusada; só com aprovado", async () => {
    const { u, viagemId } = await aprovada();
    expect(await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: BOLETO4 }))).toEqual({ ok: false, erro: "A nova forma é igual à aprovada" });
    expect(await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: { tipo: "credito", parcelas: 11 } }))).toMatchObject({
      ok: false,
      erro: "Parcelas inválidas",
    });
    expect(await versoesDa(viagemId)).toHaveLength(1);
    await item(u.id, viagemId, { servico: "Vaticano" });
    expect(await comSessao(u.id, () => pedirNovaForma(viagemId, { forma: { tipo: "pix", parcelas: 1 } }))).toEqual({
      ok: false,
      erro: "O orçamento mudou depois da aprovação. Envie a nova versão para o Diretor.",
    });
    expect(await versoesDa(viagemId)).toHaveLength(1);
  });
});

describe("registrarAjustesCliente", () => {
  beforeEach(limparBanco);

  it("volta a em_edicao com a nota do cliente; nota obrigatória; precificação mostra a nota", async () => {
    const { u, viagemId, versaoId } = await aprovada();
    expect(await comSessao(u.id, () => registrarAjustesCliente(viagemId, "  "))).toMatchObject({ ok: false, erro: "Escreva o pedido do cliente" });
    expect((await viagem(viagemId)).status).toBe("aprovado");
    const r = await comSessao(u.id, () => registrarAjustesCliente(viagemId, " Trocar duas noites do cruzeiro por hotel em Luxor "));
    expect(r).toEqual({ ok: true });
    expect(await viagem(viagemId)).toMatchObject({
      status: "em_edicao",
      notaCliente: "Trocar duas noites do cruzeiro por hotel em Luxor",
      versaoAprovadaId: versaoId,
    });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, viagemId)).orderBy(asc(auditoria.id));
    expect(aud.at(-1)).toMatchObject({
      acao: "alterar",
      antes: { status: "aprovado", notaCliente: null },
      depois: { status: "em_edicao", notaCliente: "Trocar duas noites do cruzeiro por hotel em Luxor" },
    });
    const ficha = await comSessao(u.id, () => obterPrecificacao(viagemId));
    expect(ficha).toMatchObject({ internacional: true, notaCliente: "Trocar duas noites do cruzeiro por hotel em Luxor" });
    // não aprovado: recusado
    expect(await comSessao(u.id, () => registrarAjustesCliente(viagemId, "Outro pedido"))).toEqual({
      ok: false,
      erro: "O orçamento mudou depois da aprovação. Envie a nova versão para o Diretor.",
    });
    // o próximo envio atende o pedido: a nota sai
    expect((await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: BOLETO4, alteracao: "Hotel em Luxor" }))).ok).toBe(true);
    expect(await viagem(viagemId)).toMatchObject({ status: "aguardando_aprovacao", notaCliente: null });
    const audEnvio = await db.select().from(auditoria).where(eq(auditoria.registroId, viagemId)).orderBy(asc(auditoria.id));
    expect(audEnvio.at(-1)).toMatchObject({
      antes: { status: "em_edicao", notaCliente: "Trocar duas noites do cruzeiro por hotel em Luxor" },
      depois: { status: "aguardando_aprovacao", notaCliente: null },
    });
  });
});

describe("internacional no orçamento", () => {
  beforeEach(limparBanco);

  it("padrão true; editável; omitido na edição mantém", async () => {
    const { u, viagemId, pessoas } = await aprovada();
    expect((await viagem(viagemId)).internacional).toBe(true);
    const alt = (x: Record<string, unknown>) =>
      viagem(viagemId).then((v) =>
        comSessao(u.id, () =>
          alterarOrcamento(viagemId, { destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas, ...x }, v.atualizadoEm.toISOString()),
        ),
      );
    expect(await alt({ internacional: false })).toMatchObject({ ok: true });
    expect((await viagem(viagemId)).internacional).toBe(false);
    expect(await alt({})).toMatchObject({ ok: true });
    expect((await viagem(viagemId)).internacional).toBe(false);
    expect(await alt({ internacional: "sim" })).toMatchObject({ ok: false });
    expect((await comSessao(u.id, () => obterPrecificacao(viagemId)))?.internacional).toBe(false);
  });
});

describe("listarPropostas", () => {
  beforeEach(limparBanco);

  it("aprovadas aguardando o cliente, vendidas nos últimos 30 dias e ajustes pedidos; operacional, sem margem", async () => {
    const a = await aprovada();
    const b = await aprovada({ tipo: "pix", parcelas: 1 });
    const c = await aprovada();
    await aprovada(); // outra, editada sem nota: fora
    const fora = (await db.select().from(viagens)).map((v) => v.id).find((id) => ![a.viagemId, b.viagemId, c.viagemId].includes(id))!;
    await item(a.u.id, fora, { servico: "Vaticano" });
    expect((await comSessao(b.u.id, () => fecharVenda(b.viagemId, { ...fechamento, forma: { tipo: "pix", parcelas: 1 }, parcelas: 1 }))).ok).toBe(true);
    expect((await comSessao(c.u.id, () => registrarAjustesCliente(c.viagemId, "Trocar hotel"))).ok).toBe(true);

    const fin = await criarUsuarioTeste("fin_operacional");
    const l = await comSessao(fin.id, () => listarPropostas());
    expect(l.map((x) => x.id).sort()).toEqual([a.viagemId, b.viagemId, c.viagemId].sort());
    const pa = l.find((x) => x.id === a.viagemId)!;
    const ver = await versao(a.versaoId);
    expect(pa).toMatchObject({
      estado: "aguardando",
      codigo: expect.stringMatching(/^ECL-\d{4}-01$/),
      numeroVersao: 1,
      cliente: expect.any(String),
      destino: "Itália",
      inicio: "2027-08-14",
      fim: "2027-09-01",
      passageiros: expect.arrayContaining(["Marcos Souza", "Júlia Souza"]),
      consultor: "Teste consultor",
      precoCliente: (ver.resultado as ResultadoVersao).precoCliente,
      forma: "Boleto em 4x",
      aprovadoPor: "Teste diretor",
      notaCliente: null,
    });
    expect(pa.aprovadoEm).toBeInstanceOf(Date);
    // fornecedores com conta na viagem (itens não-Taxa com fornecedor), para o select do cartão direto
    expect(pa.fornecedores).toEqual(
      [
        { id: a.palazzo, nome: "Palazzo Hotels" },
        { id: a.roma, nome: "Roma Tours" },
      ].sort((x, y) => x.nome.localeCompare(y.nome)),
    );
    expect(l.find((x) => x.id === b.viagemId)).toMatchObject({ estado: "vendida", forma: "Pix" });
    expect(l.find((x) => x.id === b.viagemId)!.vendidaEm).toBeInstanceOf(Date);
    expect(l.find((x) => x.id === c.viagemId)).toMatchObject({ estado: "ajustes", notaCliente: "Trocar hotel" });
    const s = JSON.stringify(l);
    expect(s).not.toMatch(/margem|imposto|custo|final/i);

    // vendida há mais de 30 dias sai da lista
    await db.update(viagens).set({ vendidaEm: new Date(Date.now() - 31 * 86_400_000) }).where(eq(viagens.id, b.viagemId));
    expect((await comSessao(fin.id, () => listarPropostas())).map((x) => x.id)).not.toContain(b.viagemId);
  });
});
