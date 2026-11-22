import { beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import type { ResultadoVersao, Snapshot } from "@/domain/aprovacoes";
import { custoLiquido, margemDaAprovacao, precoDoPacote, type FormaPagamento } from "@/domain/precificacao";
import { db } from "@/server/db/client";
import { auditoria, cotacoes, itensViagem, versoesPrecificacao, viagens } from "@/server/db/schema";
import { salvarCliente, type ClienteEntrada } from "@/server/actions/clientes";
import { salvarRegras } from "@/server/actions/regras";
import { aprovar, aprovarComAjuste, devolver, enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { alterarOrcamento, criarOrcamento, escolherCotacao, salvarCotacao, salvarItem, type ItemEntrada } from "@/server/actions/viagens";
import { ErroAcesso } from "@/server/auth";
import { obterCliente } from "@/server/queries/clientes";
import { regrasVigentes } from "@/server/queries/regras";
import {
  listarPedidosAprovacao,
  obterPedido,
  obterPrecificacao,
  obterProposta,
} from "@/server/queries/viagens";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const souza: ClienteEntrada = {
  tipo: "familia",
  filial: "RS",
  telefone: "(66) 9 9123-4567",
  titular: { nome: "Marcos Souza" },
  acompanhantes: [{ nome: "Júlia Souza", parentesco: "Esposa" }],
};

const AGUARDANDO = "Orçamento aguardando aprovação. Peça ao Diretor para devolver antes de alterar.";
const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };
const DECIDIDO = { ok: false, erro: "Este pedido já foi decidido" };
const CREDITO6: FormaPagamento = { tipo: "credito", parcelas: 6 };

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

async function cenario() {
  const u = await criarUsuarioTeste("consultor");
  const d = await criarUsuarioTeste("diretor");
  const c = await comSessao(u.id, () => salvarCliente(souza));
  if (!c.ok) throw new Error(c.erro);
  const pessoas = (await comSessao(u.id, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
  const r = await comSessao(u.id, () =>
    criarOrcamento({ clienteId: c.id, destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas }),
  );
  if (!r.ok) throw new Error(r.erro);
  return { u, d, clienteId: c.id, pessoas, viagemId: r.id };
}

async function item(uid: string, viagemId: string, dados: Partial<ItemEntrada> = {}, itemId?: string) {
  const r = await comSessao(uid, () => salvarItem(viagemId, { tipo: "Passeio", servico: "Passeio", ...dados }, itemId));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

async function cotacao(uid: string, itemId: string, dados: Record<string, unknown> = {}) {
  const r = await comSessao(uid, () => salvarCotacao(itemId, { moeda: "BRL", valor: "1.000,00", ...dados }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

/** Hotel com duas cotações (escolhida a mais barata), um passeio e um aéreo. */
async function cotado(uid: string, viagemId: string) {
  const hotel = await item(uid, viagemId, { tipo: "Hotelaria", servico: "Palazzo Barocci", cidade: "Roma", checkin: "2027-08-14", checkout: "2027-08-17", diarias: 3 });
  const barata = await cotacao(uid, hotel, { valor: "3.106,00", comissao: "4", descontoAVista: "4" });
  const cara = await cotacao(uid, hotel, { valor: "3.300,00" });
  const passeio = await item(uid, viagemId, { servico: "Coliseu", cidade: "Roma" });
  await cotacao(uid, passeio, { valor: "500,00" });
  const aereo = await item(uid, viagemId, { tipo: "Aéreo", servico: "GRU-FCO" });
  await cotacao(uid, aereo, { valor: "8.000,00", comissao: "6", tarifaFixa: "120,00" });
  return { hotel, barata, cara, passeio, aereo };
}

async function enviar(uid: string, viagemId: string, extra: Partial<Parameters<typeof enviarParaAprovacao>[1]> = {}) {
  const r = await comSessao(uid, () => enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "Primeira versão", ...extra }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

const versoesDa = (viagemId: string) =>
  db.select().from(versoesPrecificacao).where(eq(versoesPrecificacao.viagemId, viagemId)).orderBy(asc(versoesPrecificacao.numero));
const viagem = async (id: string) => (await db.select().from(viagens).where(eq(viagens.id, id)))[0];

describe("envio para aprovação", () => {
  beforeEach(limparBanco);

  it("cria a versão 1 aguardando, com snapshot do que foi precificado, preço calculado e resultado; auditoria", async () => {
    const { u, viagemId, pessoas } = await cenario();
    const { hotel, barata, cara, passeio, aereo } = await cotado(u.id, viagemId);
    const vig = await comSessao(u.id, () => regrasVigentes());
    const r = await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "Primeira versão" }));
    expect(r).toMatchObject({ ok: true, numero: 1 });

    const [v] = await versoesDa(viagemId);
    const custo = 330000n + 50000n; // pior custo do hotel (3.300,00 sem comissão) + passeio
    const preco = precoDoPacote(custo, CREDITO6, vig.valores);
    expect(v).toMatchObject({
      numero: 1,
      status: "aguardando",
      preco,
      forma: CREDITO6,
      dias: 19,
      regrasVersaoId: vig.versaoId,
      rateio: "por_dia",
      alteracao: "Primeira versão",
      enviadoPor: u.id,
      decididoPor: null,
    });
    const snap = v.snapshot as Snapshot;
    expect(snap).toMatchObject({ destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01" });
    expect(snap.passageiros.map((p) => p.id).sort()).toEqual([...pessoas].sort());
    expect(snap.itens.map((i) => i.id)).toEqual([hotel, passeio, aereo]);
    const h = snap.itens[0];
    expect(h).toMatchObject({ tipo: "Hotelaria", servico: "Palazzo Barocci", cidade: "Roma", diarias: 3, checkin: "2027-08-14" });
    expect(h.precificada).toMatchObject({ id: cara, valorBrl: "330000", comissaoPct: "0.000", moeda: "BRL" });
    expect(h.escolhida).toMatchObject({ id: barata, valorBrl: "310600", comissaoPct: "4.000", descontoAVistaPct: "4.000" });
    expect(snap.itens[2].precificada).toMatchObject({ valorBrl: "800000", tarifaFixa: "12000", comissaoPct: "6.000" });

    const res = v.resultado as ResultadoVersao;
    const m = margemDaAprovacao(preco, custo, CREDITO6, 19, "por_dia", vig.valores);
    expect(res).toMatchObject({
      custo: custo.toString(),
      antes: m.antes.toString(),
      fixo: m.fixo.toString(),
      final: m.final.toString(),
      finalPct: m.finalPct,
      antesPct: "19.0",
      custoEscolhidas: (custoLiquido({ id: "", tipo: "Hotelaria", nome: "", diarias: 3, valorFornecedor: 310600n, comissaoPct: "4.000", descontoAVistaPct: null }) + 50000n).toString(),
      precoCalculado: preco.toString(),
    });

    expect(await viagem(viagemId)).toMatchObject({ status: "aguardando_aprovacao", versaoAprovadaId: null });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, v.id));
    expect(aud.map((x) => [x.tabela, x.acao])).toEqual([["versoes_precificacao", "criar"]]);
    const audV = await db.select().from(auditoria).where(eq(auditoria.registroId, viagemId)).orderBy(asc(auditoria.id));
    expect(audV.at(-1)).toMatchObject({ acao: "alterar", antes: { status: "em_edicao" }, depois: { status: "aguardando_aprovacao" } });

    // aguardando: o orçamento não se altera
    expect(await comSessao(u.id, () => salvarItem(viagemId, { tipo: "Passeio", servico: "Novo" }))).toEqual({ ok: false, erro: AGUARDANDO });
  });

  it("preço informado em reais; forma validada pelos Parâmetros", async () => {
    const { u, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const e = (x: Partial<Parameters<typeof enviarParaAprovacao>[1]>) =>
      comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "", ...x } as Parameters<typeof enviarParaAprovacao>[1]));
    expect(await e({ forma: { tipo: "credito", parcelas: 11 } })).toMatchObject({ ok: false, erro: "Parcelas inválidas" });
    expect(await e({ forma: { tipo: "pix", parcelas: 3 } })).toMatchObject({ ok: false, erro: "Parcelas inválidas" });
    expect(await e({ preco: "abc" })).toMatchObject({ ok: false, erro: "Valor inválido" });
    expect(await versoesDa(viagemId)).toHaveLength(0);
    const r = await e({ preco: "50.000,00", forma: { tipo: "boleto", parcelas: 4 } });
    expect(r.ok).toBe(true);
    const [v] = await versoesDa(viagemId);
    expect(v).toMatchObject({ preco: 5000000n, forma: { tipo: "boleto", parcelas: 4 }, alteracao: null });
  });

  it("Review Focus 4: dois envios simultâneos geram uma só versão", async () => {
    const { u, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const rs = await comSessao(u.id, () =>
      Promise.all([
        enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "a" }),
        enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "b" }),
      ]),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, erro: AGUARDANDO });
    expect(await versoesDa(viagemId)).toHaveLength(1);
  });

  it("Review Focus 5: sem item cotado ou com item sem cotação, envio recusado", async () => {
    const { u, viagemId } = await cenario();
    const e = () => comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "" }));
    expect(await e()).toEqual({ ok: false, erro: "Inclua ao menos um item cotado" });
    const aereo = await item(u.id, viagemId, { tipo: "Aéreo", servico: "GRU-FCO" });
    await cotacao(u.id, aereo);
    expect(await e()).toEqual({ ok: false, erro: "Inclua ao menos um item cotado" });
    await cotacao(u.id, await item(u.id, viagemId, { servico: "Coliseu" }));
    await item(u.id, viagemId, { tipo: "Trem", servico: "Roma–Florença" });
    expect(await e()).toEqual({ ok: false, erro: "Roma–Florença está sem cotação" });
    expect(await versoesDa(viagemId)).toHaveLength(0);
    expect((await viagem(viagemId)).status).toBe("em_edicao");
    expect(await comSessao(u.id, () => enviarParaAprovacao("00000000-0000-0000-0000-000000000000", { forma: CREDITO6, alteracao: "" }))).toEqual({
      ok: false,
      erro: "Orçamento não encontrado",
    });
    // id inválido é conferido antes da forma
    expect(await comSessao(u.id, () => enviarParaAprovacao("x", { forma: { tipo: "credito", parcelas: 99 }, alteracao: "" }))).toEqual({
      ok: false,
      erro: "Orçamento não encontrado",
    });
  });
});

describe("decisão do Diretor", () => {
  beforeEach(limparBanco);

  it("só o Diretor decide e vê os pedidos", async () => {
    const { u, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const id = await enviar(u.id, viagemId);
    for (const perfil of ["consultor", "operacional", "fin_operacional", "fin_estrategico"] as const) {
      const x = await criarUsuarioTeste(perfil);
      expect(await comSessao(x.id, () => aprovar(id))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(x.id, () => devolver(id, "motivo"))).toEqual(SEM_PERMISSAO);
      expect(await comSessao(x.id, () => aprovarComAjuste(id, { preco: "1.000,00", forma: CREDITO6 }))).toEqual(SEM_PERMISSAO);
      await expect(comSessao(x.id, () => listarPedidosAprovacao())).rejects.toBeInstanceOf(ErroAcesso);
      await expect(comSessao(x.id, () => obterPedido(id))).rejects.toBeInstanceOf(ErroAcesso);
    }
    expect((await versoesDa(viagemId))[0].status).toBe("aguardando");
  });

  it("aprovar libera a proposta, só com dados para o cliente", async () => {
    const { u, d, viagemId } = await cenario();
    const { aereo } = await cotado(u.id, viagemId);
    // 6 itens do terrestre → taxa de roteiro automática
    for (let i = 0; i < 4; i++) await cotacao(u.id, await item(u.id, viagemId, { servico: `Passeio ${i}` }), { valor: "100,00" });
    const id = await enviar(u.id, viagemId);
    expect(await comSessao(u.id, () => obterProposta(viagemId))).toEqual({
      ok: false,
      erro: "Proposta disponível só depois da aprovação do Diretor",
    });

    expect(await comSessao(d.id, () => aprovar(id))).toEqual({ ok: true });
    const [v] = await versoesDa(viagemId);
    expect(v).toMatchObject({ status: "aprovada", decididoPor: d.id });
    expect(v.decididoEm).toBeInstanceOf(Date);
    expect(await viagem(viagemId)).toMatchObject({ status: "aprovado", versaoAprovadaId: id });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(asc(auditoria.id));
    expect(aud.map((x) => x.acao)).toEqual(["criar", "alterar"]);
    expect(aud[1]).toMatchObject({ usuarioId: d.id, antes: { status: "aguardando" }, depois: { status: "aprovada" } });

    const p = await comSessao(u.id, () => obterProposta(viagemId));
    if (!p.ok) throw new Error(p.erro);
    const total = v.preco + 19n * 15000n;
    expect(p.proposta).toMatchObject({
      codigo: "ECL-0001-01",
      cliente: "Família Souza",
      destino: "Itália",
      inicio: "2027-08-14",
      fim: "2027-09-01",
      dias: 19,
      noites: 18,
      total,
      porPessoa: (total + 1n) / 2n,
      forma: "Cartão em 6x",
      validade: "Orçamento sem caráter de reserva; os valores podem variar conforme as datas. Não inclui aéreo.",
    });
    expect(p.proposta.passageiros.sort()).toEqual(["Júlia Souza", "Marcos Souza"]);
    expect(p.proposta.itens.map((i) => i.servico)).toEqual([
      "Palazzo Barocci",
      "Coliseu",
      "Passeio 0",
      "Passeio 1",
      "Passeio 2",
      "Passeio 3",
      "Taxa de roteiro",
    ]);
    expect(p.proposta.itens[0]).toEqual({
      tipo: "Hotelaria",
      cidade: "Roma",
      servico: "Palazzo Barocci",
      checkin: "2027-08-14",
      checkout: "2027-08-17",
      diarias: 3,
    });
    const s = json(p).toLowerCase();
    for (const proibida of ["comissao", "custo", "margem", "fornecedor", "valorbrl", "precificada", aereo, "gru-fco"]) {
      expect(s, proibida).not.toContain(proibida);
    }
  });

  it("aprovar com ajuste: versão 2 aprovada_com_ajuste, versão 1 devolvida; itens e cotações intactos", async () => {
    const { u, d, viagemId } = await cenario();
    const { passeio, hotel } = await cotado(u.id, viagemId);
    const id1 = await enviar(u.id, viagemId);
    const antesItens = await db.select().from(itensViagem).where(eq(itensViagem.viagemId, viagemId));
    const antesCots = await db.select().from(cotacoes);

    expect(
      await comSessao(d.id, () =>
        aprovarComAjuste(id1, { preco: "6.000,00", forma: CREDITO6, itens: [{ itemId: "00000000-0000-0000-0000-000000000000", valorFornecedor: "1,00" }] }),
      ),
    ).toEqual({ ok: false, erro: "Item não encontrado" });

    const r = await comSessao(d.id, () =>
      aprovarComAjuste(id1, {
        preco: "6.000,00",
        forma: { tipo: "pix", parcelas: 1 },
        itens: [{ itemId: passeio, valorFornecedor: "400,00", comissaoPct: "10" }],
        rateio: "por_viagem",
      }),
    );
    expect(r).toMatchObject({ ok: true, numero: 2 });
    const [v1, v2] = await versoesDa(viagemId);
    expect(v1).toMatchObject({ status: "devolvida", comentario: "Substituída por ajuste do Diretor", decididoPor: d.id });
    expect(v2).toMatchObject({
      status: "aprovada_com_ajuste",
      alteracao: "Ajuste do Diretor",
      preco: 600000n,
      forma: { tipo: "pix", parcelas: 1 },
      rateio: "por_viagem",
      regrasVersaoId: v1.regrasVersaoId,
      dias: 19,
      decididoPor: d.id,
    });
    const snap = v2.snapshot as Snapshot;
    const p2 = snap.itens.find((i) => i.id === passeio)!;
    expect(p2.ajuste).toBeUndefined();
    expect(p2.precificada).toMatchObject({ valorBrl: "40000", valorOriginal: "40000", comissaoPct: "10.000", ajustadoPeloDiretor: true });
    expect(p2.escolhida).toEqual(p2.precificada);
    expect(snap.itens.find((i) => i.id === hotel)!.cotacoes.some((c) => c.ajustadoPeloDiretor)).toBe(false);
    // custo: hotel 3.300,00 + passeio 400,00 × 0,9 = 360,00
    expect((v2.resultado as ResultadoVersao).custo).toBe((330000n + 36000n).toString());
    expect(await viagem(viagemId)).toMatchObject({ status: "aprovado", versaoAprovadaId: v2.id });
    expect(await db.select().from(itensViagem).where(eq(itensViagem.viagemId, viagemId))).toEqual(antesItens);
    expect(await db.select().from(cotacoes)).toEqual(antesCots);
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, v2.id));
    expect(aud.map((x) => [x.acao, x.usuarioId])).toEqual([["criar", d.id]]);
    expect(await comSessao(d.id, () => aprovar(id1))).toEqual(DECIDIDO);
    expect(await comSessao(d.id, () => aprovar(v2.id))).toEqual(DECIDIDO);
  });

  it("ajuste do Diretor reescolhe o pior custo: preço e margem extra seguem o novo pior", async () => {
    const { u, d, viagemId } = await cenario();
    const passeio = await item(u.id, viagemId, { servico: "Coliseu" });
    const a = await cotacao(u.id, passeio, { valor: "1.000,00" }); // custo 1.000,00 (pior no envio)
    const b = await cotacao(u.id, passeio, { valor: "1.100,00", comissao: "20" }); // custo 880,00
    expect((await comSessao(u.id, () => escolherCotacao(b))).ok).toBe(true);
    const vig = await comSessao(u.id, () => regrasVigentes());
    const id1 = await enviar(u.id, viagemId);
    const [v1] = await versoesDa(viagemId);
    expect((v1.snapshot as Snapshot).itens[0].precificada.id).toBe(a);
    expect((v1.snapshot as Snapshot).itens[0].cotacoes.map((c) => c.id)).toEqual([a, b]);
    expect((v1.resultado as ResultadoVersao).margemExtra).toBe((100000n - 88000n).toString());

    // cotação que não é do item → recusa
    const alheia = "00000000-0000-4000-8000-000000000001";
    expect(await comSessao(d.id, () => aprovarComAjuste(id1, { preco: "2.000,00", forma: CREDITO6, itens: [{ itemId: passeio, cotacaoId: alheia, comissaoPct: "0" }] }))).toEqual({
      ok: false,
      erro: "Cotação não encontrada",
    });
    // comissão 0 só em b: b (1.100,00) passa a ser o pior custo; a não muda
    const r = await comSessao(d.id, () => aprovarComAjuste(id1, { preco: "2.000,00", forma: CREDITO6, itens: [{ itemId: passeio, cotacaoId: b, comissaoPct: "0" }] }));
    expect(r.ok).toBe(true);
    const [, v2] = await versoesDa(viagemId);
    const it2 = (v2.snapshot as Snapshot).itens[0];
    expect(it2.precificada).toMatchObject({ id: b, comissaoPct: "0.000", ajustadoPeloDiretor: true });
    expect(it2.cotacoes.find((c) => c.id === a)).toMatchObject({ valorBrl: "100000", comissaoPct: "0.000" });
    expect(it2.cotacoes.find((c) => c.id === a)!.ajustadoPeloDiretor).toBeUndefined();
    expect(it2.precificada.id).toBe(b);
    expect(it2.escolhida.id).toBe(b);
    const res = v2.resultado as ResultadoVersao;
    expect(res.custo).toBe("110000");
    expect(res.margemExtra).toBe("0");
    expect(res.precoCalculado).toBe(precoDoPacote(110000n, CREDITO6, vig.valores).toString());
  });

  it("ajuste padrão vale só para a cotação precificada: a escolhida fica e a margem extra segue", async () => {
    const { u, d, viagemId } = await cenario();
    const { hotel, barata, cara } = await cotado(u.id, viagemId);
    const id1 = await enviar(u.id, viagemId);
    // hotel: precificada = cara (3.300,00), escolhida = barata (3.106,00 com 4%)
    const r = await comSessao(d.id, () => aprovarComAjuste(id1, { preco: "6.000,00", forma: CREDITO6, itens: [{ itemId: hotel, valorFornecedor: "3.200,00" }] }));
    expect(r.ok).toBe(true);
    const [v1, v2] = await versoesDa(viagemId);
    const h1 = (v1.snapshot as Snapshot).itens.find((i) => i.id === hotel)!;
    const h2 = (v2.snapshot as Snapshot).itens.find((i) => i.id === hotel)!;
    expect(h2.precificada).toMatchObject({ id: cara, valorBrl: "320000", ajustadoPeloDiretor: true });
    expect(h2.escolhida).toEqual(h1.escolhida);
    expect(h2.escolhida.id).toBe(barata);
    const res = v2.resultado as ResultadoVersao;
    const escolhidas = BigInt((v1.resultado as ResultadoVersao).custoEscolhidas);
    expect(res.custoEscolhidas).toBe(escolhidas.toString());
    expect(res.custo).toBe((320000n + 50000n).toString());
    expect(res.margemExtra).toBe((320000n + 50000n - escolhidas).toString());
  });

  it("guarda na versão os valores para o cliente (taxa de serviço, preço ao cliente, por pessoa, passageiros)", async () => {
    const { u, d, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const id1 = await enviar(u.id, viagemId);
    const [v1] = await versoesDa(viagemId);
    const taxa = 19n * 15000n;
    expect(v1.resultado).toMatchObject({
      taxaServico: taxa.toString(),
      precoCliente: (v1.preco + taxa).toString(),
      porPessoa: ((v1.preco + taxa + 1n) / 2n).toString(),
      numeroPassageiros: 2,
    });
    expect((await comSessao(d.id, () => aprovarComAjuste(id1, { preco: "7.000,01", forma: CREDITO6 }))).ok).toBe(true);
    const [, v2] = await versoesDa(viagemId);
    expect(v2.resultado).toMatchObject({ taxaServico: taxa.toString(), precoCliente: (700001n + taxa).toString(), porPessoa: ((700001n + taxa + 1n) / 2n).toString(), numeroPassageiros: 2 });
    // a proposta lê da versão
    await db.update(versoesPrecificacao).set({ resultado: { ...(v2.resultado as ResultadoVersao), precoCliente: "123456", porPessoa: "61728", taxaServico: "1000" } }).where(eq(versoesPrecificacao.id, v2.id));
    const p = await comSessao(u.id, () => obterProposta(viagemId));
    if (!p.ok) throw new Error(p.erro);
    expect(p.proposta).toMatchObject({ total: 123456n, porPessoa: 61728n, taxaServico: 1000n });
  });

  it("devolver exige motivo; pedido já decidido não se decide de novo", async () => {
    const { u, d, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const id = await enviar(u.id, viagemId);
    expect(await comSessao(d.id, () => devolver(id, "   "))).toEqual({
      ok: false,
      erro: "Escreva o motivo da devolução",
      campos: { comentario: "Escreva o motivo da devolução" },
    });
    expect(await comSessao(d.id, () => devolver(id, "Margem baixa no hotel"))).toEqual({ ok: true });
    const [v] = await versoesDa(viagemId);
    expect(v).toMatchObject({ status: "devolvida", comentario: "Margem baixa no hotel", decididoPor: d.id });
    expect(await viagem(viagemId)).toMatchObject({ status: "devolvido", versaoAprovadaId: null });
    expect(await comSessao(d.id, () => aprovar(id))).toEqual(DECIDIDO);
    expect(await comSessao(d.id, () => devolver(id, "outro"))).toEqual(DECIDIDO);
    expect(await comSessao(d.id, () => aprovarComAjuste(id, { preco: "1.000,00", forma: CREDITO6 }))).toEqual(DECIDIDO);
    expect(await comSessao(d.id, () => aprovar("00000000-0000-0000-0000-000000000000"))).toEqual({ ok: false, erro: "Pedido não encontrado" });
    expect(await comSessao(d.id, () => aprovar("x"))).toEqual({ ok: false, erro: "Pedido não encontrado" });
    // devolvido: pode reenviar
    const r = await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "Hotel trocado" }));
    expect(r).toMatchObject({ ok: true, numero: 2 });
  });

  it("Review Focus 1: editar depois da aprovação volta a Em edição e a proposta segue na versão aprovada", async () => {
    const { u, d, viagemId, pessoas } = await cenario();
    const { passeio } = await cotado(u.id, viagemId);
    const id1 = await enviar(u.id, viagemId);
    await comSessao(d.id, () => aprovar(id1));
    const antes = await comSessao(u.id, () => obterProposta(viagemId));

    await item(u.id, viagemId, { servico: "Coliseu noturno" }, passeio);
    const f = (await comSessao(u.id, () => obterPrecificacao(viagemId)))!;
    expect(
      (await comSessao(u.id, () => alterarOrcamento(viagemId, { destino: "Itália e Suíça", inicio: "2027-08-14", fim: "2027-09-03", passageiros: [pessoas[0]] }, f.atualizadoEm))).ok,
    ).toBe(true);
    expect(await viagem(viagemId)).toMatchObject({ status: "em_edicao", versaoAprovadaId: id1 });
    if (!antes.ok) throw new Error(antes.erro);
    expect(antes.proposta.desatualizada).toBe(false);
    const desatualizada = { ok: true, proposta: { ...antes.proposta, desatualizada: true } };
    expect(await comSessao(u.id, () => obterProposta(viagemId))).toEqual(desatualizada);

    const r = await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "Passeio noturno" }));
    expect(r).toMatchObject({ ok: true, numero: 2 });
    const [, v2] = await versoesDa(viagemId);
    expect(v2).toMatchObject({ status: "aguardando", dias: 21 });
    expect((v2.snapshot as Snapshot).itens.find((i) => i.id === passeio)!.servico).toBe("Coliseu noturno");
    expect(await viagem(viagemId)).toMatchObject({ status: "aguardando_aprovacao", versaoAprovadaId: id1 });
    const ainda = await comSessao(u.id, () => obterProposta(viagemId));
    expect(ainda).toEqual(desatualizada);
    if (!ainda.ok) throw new Error(ainda.erro);
    expect(ainda.proposta.itens.map((i) => i.servico)).toContain("Coliseu");
    expect(ainda.proposta.destino).toBe("Itália");
  });

  it("a versão guarda as regras: mudar os Parâmetros depois não altera resultado, pedido nem proposta", async () => {
    const { u, d, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const vig = await comSessao(u.id, () => regrasVigentes());
    const id = await enviar(u.id, viagemId);
    const [v] = await versoesDa(viagemId);
    const pedido = (await comSessao(d.id, () => obterPedido(id)))!;

    expect((await comSessao(d.id, () => salvarRegras({ ...vig.valores, custoFixoMensal: "9999999", taxaServicoPorDia: "99900", margemReferenciaPct: "25.000" }))).ok).toBe(true);
    const [depois] = await versoesDa(viagemId);
    expect(depois.resultado).toEqual(v.resultado);
    expect(depois.regrasVersaoId).toBe(vig.versaoId);
    expect(await comSessao(d.id, () => obterPedido(id))).toEqual(pedido);
    expect(pedido.referenciaPct).toBe("19.000");
    const m = (r: "por_dia" | "por_faturamento" | "por_viagem") => margemDaAprovacao(v.preco, 380000n, CREDITO6, 19, r, vig.valores);
    expect(pedido.margens.por_dia).toEqual(m("por_dia"));
    expect(pedido.margens.por_faturamento).toEqual(m("por_faturamento"));
    expect(pedido.margens.por_viagem).toEqual(m("por_viagem"));

    await comSessao(d.id, () => aprovar(id));
    const p = await comSessao(u.id, () => obterProposta(viagemId));
    if (!p.ok) throw new Error(p.erro);
    expect(p.proposta.total).toBe(v.preco + 19n * 15000n);
  });
});

describe("pedidos e versões", () => {
  beforeEach(limparBanco);

  it("listarPedidosAprovacao: aguardando mais antigo primeiro e decididos nos últimos 30 dias", async () => {
    const { u, d, clienteId, pessoas, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const outra = await comSessao(u.id, () =>
      criarOrcamento({ clienteId, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros: pessoas }),
    );
    if (!outra.ok) throw new Error(outra.erro);
    await cotado(u.id, outra.id);
    const terceira = await comSessao(u.id, () =>
      criarOrcamento({ clienteId, destino: "Grécia", inicio: "2027-06-01", fim: "2027-06-10", passageiros: pessoas }),
    );
    if (!terceira.ok) throw new Error(terceira.erro);
    await cotado(u.id, terceira.id);

    const a = await enviar(u.id, viagemId);
    const b = await enviar(u.id, outra.id);
    const c = await enviar(u.id, terceira.id);
    await comSessao(d.id, () => devolver(c, "Rever"));
    // decisão antiga sai da lista
    const antiga = await enviar(u.id, terceira.id);
    await comSessao(d.id, () => aprovar(antiga));
    await db.update(versoesPrecificacao).set({ decididoEm: new Date(Date.now() - 31 * 86_400_000) }).where(eq(versoesPrecificacao.id, antiga));

    const l = await comSessao(d.id, () => listarPedidosAprovacao());
    expect(l.aguardando.map((x) => x.versaoId)).toEqual([a, b]);
    expect(l.aguardando[0]).toMatchObject({ codigo: "ECL-0001-01", cliente: "Família Souza", destino: "Itália", numero: 1, forma: "Cartão em 6x", enviadoPor: "Teste consultor" });
    expect(typeof l.aguardando[0].margemFinalPct).toBe("string");
    expect(l.decididos.map((x) => [x.versaoId, x.status, x.comentario, x.decididoPor])).toEqual([[c, "devolvida", "Rever", "Teste diretor"]]);
  });

  it("obterPedido: snapshot, margens nos três rateios e referência; id inexistente → null", async () => {
    const { u, d, viagemId } = await cenario();
    const { hotel } = await cotado(u.id, viagemId);
    const id = await enviar(u.id, viagemId);
    const p = (await comSessao(d.id, () => obterPedido(id)))!;
    expect(p).toMatchObject({ versaoId: id, viagemId, codigo: "ECL-0001-01", numero: 1, status: "aguardando", rateio: "por_dia", forma: CREDITO6, formaRotulo: "Cartão em 6x", custo: 380000n });
    expect(p.snapshot.itens.find((i) => i.id === hotel)!.precificada.valorBrl).toBe("330000");
    expect(Object.keys(p.margens).sort()).toEqual(["por_dia", "por_faturamento", "por_viagem"]);
    expect(await comSessao(d.id, () => obterPedido("00000000-0000-0000-0000-000000000000"))).toBeNull();
    expect(await comSessao(d.id, () => obterPedido("x"))).toBeNull();
  });

  it("obterPrecificacao lista as versões; preço só para a camada estratégica", async () => {
    const { u, d, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const id1 = await enviar(u.id, viagemId);
    await comSessao(d.id, () => devolver(id1, "Rever hotel"));
    await enviar(u.id, viagemId, { alteracao: "Hotel revisto" });

    const doConsultor = (await comSessao(u.id, () => obterPrecificacao(viagemId)))!;
    expect(doConsultor.versoes.map((x) => [x.numero, x.status, x.alteracao, x.comentario])).toEqual([
      [2, "aguardando", "Hotel revisto", null],
      [1, "devolvida", "Primeira versão", "Rever hotel"],
    ]);
    expect(doConsultor.versoes[1]).toMatchObject({ enviadoPor: "Teste consultor", decididoPor: "Teste diretor" });
    expect(doConsultor.versoes.every((x) => !("preco" in x))).toBe(true);
    const { referencia, ...semReferencia } = doConsultor;
    expect(referencia).toMatchObject({ forma: "Crédito 2x a 6x (referência)" });
    const s = json(semReferencia);
    expect(s).not.toContain('"preco');
    expect(s).not.toContain('"custo');
    expect(s).not.toContain('"margem');

    const doDiretor = (await comSessao(d.id, () => obterPrecificacao(viagemId)))!;
    expect(typeof doDiretor.versoes[0].preco).toBe("bigint");
  });

  it("obterPrecificacao: parâmetros que não permitem calcular → erro na camada estratégica, sem derrubar a ficha", async () => {
    const { u, d, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const vig = await comSessao(d.id, () => regrasVigentes());
    expect((await comSessao(d.id, () => salvarRegras({ ...vig.valores, margemAlvoPct: "93.000" }))).ok).toBe(true);
    const f = (await comSessao(d.id, () => obterPrecificacao(viagemId)))!;
    expect(f.estrategico).toEqual({ erro: "Não foi possível calcular" });
    expect(f.itens).toHaveLength(2);
    // e o envio sem preço informado também não calcula
    expect(await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma: CREDITO6, alteracao: "" }))).toEqual({
      ok: false,
      erro: "Não foi possível calcular o preço com os Parâmetros vigentes",
    });
  });
});

describe("integridade da versão aprovada e proposta desatualizada", () => {
  beforeEach(limparBanco);

  it("o banco recusa versão aprovada de outra viagem ou versão não aprovada", async () => {
    const { u, d, clienteId, pessoas, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    const outra = await comSessao(u.id, () => criarOrcamento({ clienteId, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros: pessoas }));
    if (!outra.ok) throw new Error(outra.erro);
    await cotado(u.id, outra.id);
    const daOutra = await enviar(u.id, outra.id);
    await comSessao(d.id, () => aprovar(daOutra));
    const aguardando = await enviar(u.id, viagemId);

    const apontar = (versaoId: string) => db.update(viagens).set({ versaoAprovadaId: versaoId }).where(eq(viagens.id, viagemId));
    await expect(apontar(daOutra)).rejects.toThrow(); // FK composta (viagem_id, id)
    await expect(apontar(aguardando)).rejects.toThrow(); // gatilho: só aprovada / aprovada_com_ajuste
    expect((await viagem(viagemId)).versaoAprovadaId).toBeNull();
    await comSessao(d.id, () => aprovar(aguardando));
    expect((await viagem(viagemId)).versaoAprovadaId).toBe(aguardando);
  });

  it("proposta desatualizada enquanto o orçamento não volta a ser aprovado; data da aprovação", async () => {
    const { u, d, viagemId } = await cenario();
    const { passeio } = await cotado(u.id, viagemId);
    const id1 = await enviar(u.id, viagemId);
    await comSessao(d.id, () => aprovar(id1));
    const [v1] = await versoesDa(viagemId);
    const p1 = await comSessao(u.id, () => obterProposta(viagemId));
    expect(p1).toMatchObject({ ok: true, proposta: { desatualizada: false, numeroVersao: 1, aprovadaEm: v1.decididoEm } });

    await item(u.id, viagemId, { servico: "Coliseu noturno" }, passeio);
    expect(await comSessao(u.id, () => obterProposta(viagemId))).toMatchObject({ ok: true, proposta: { desatualizada: true, numeroVersao: 1 } });
    const id2 = await enviar(u.id, viagemId, { alteracao: "Passeio noturno" });
    expect(await comSessao(u.id, () => obterProposta(viagemId))).toMatchObject({ ok: true, proposta: { desatualizada: true, numeroVersao: 1 } });
    await comSessao(d.id, () => aprovar(id2));
    expect(await comSessao(u.id, () => obterProposta(viagemId))).toMatchObject({ ok: true, proposta: { desatualizada: false, numeroVersao: 2 } });
  });

  it("envio sincroniza a taxa de roteiro com os Parâmetros vigentes antes do snapshot", async () => {
    const { u, d, viagemId } = await cenario();
    await cotado(u.id, viagemId);
    for (let i = 0; i < 4; i++) await cotacao(u.id, await item(u.id, viagemId, { servico: `Passeio ${i}` }), { valor: "100,00" });
    const vig = await comSessao(d.id, () => regrasVigentes());
    expect((await comSessao(d.id, () => salvarRegras({ ...vig.valores, taxaRoteiro: { ...vig.valores.taxaRoteiro, valor: "77700" } }))).ok).toBe(true);
    // sem editar nada, envia
    await enviar(u.id, viagemId);
    const [v] = await versoesDa(viagemId);
    const taxa = (v.snapshot as Snapshot).itens.find((i) => i.tipo === "Taxa")!;
    expect(taxa.precificada).toMatchObject({ valorBrl: "77700", valorOriginal: "77700" });
    const [cot] = await db.select().from(cotacoes).where(eq(cotacoes.id, taxa.precificada.id));
    expect(cot.valorBrl).toBe(77700n);
  });
});

