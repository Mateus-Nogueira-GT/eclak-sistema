import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { REGRAS_INICIAIS } from "@/domain/regras";
import { db } from "@/server/db/client";
import { auditoria, cotacoes, itensViagem, versoesPrecificacao, viagens } from "@/server/db/schema";
import { salvarCliente, type ClienteEntrada } from "@/server/actions/clientes";
import { salvarRegras } from "@/server/actions/regras";
import {
  alterarOrcamento,
  criarOrcamento,
  escolherCotacao,
  removerCotacao,
  removerItem,
  salvarCotacao,
  salvarItem,
  type ItemEntrada,
} from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { regrasVigentes } from "@/server/queries/regras";
import { listarOrcamentos, obterPrecificacao, type CamadaEstrategica } from "@/server/queries/viagens";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const souza: ClienteEntrada = {
  tipo: "familia",
  filial: "RS",
  telefone: "(66) 9 9123-4567",
  titular: { nome: "Marcos Souza" },
  acompanhantes: [{ nome: "Júlia Souza", parentesco: "Esposa" }],
};

const AGUARDANDO = "Orçamento aguardando aprovação. Peça ao Diretor para devolver antes de alterar.";
const AUTOMATICA = "A taxa de roteiro é automática";

/** JSON com bigint como string. */
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** Todas as chaves de um objeto, em qualquer nível. */
function chaves(x: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(x)) x.forEach((v) => chaves(v, acc));
  else if (x !== null && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) {
      acc.add(k);
      chaves(v, acc);
    }
  }
  return acc;
}

async function cenario(perfil: "consultor" | "diretor" = "consultor", cliente: ClienteEntrada = souza) {
  const u = await criarUsuarioTeste(perfil);
  const c = await comSessao(u.id, () => salvarCliente(cliente));
  if (!c.ok) throw new Error(c.erro);
  const ficha = (await comSessao(u.id, () => obterCliente(c.id)))!;
  return { u, clienteId: c.id, pessoas: ficha.pessoas.map((p) => p.id) };
}

async function novoOrcamento(uid: string, clienteId: string, pessoas: string[], extra: Record<string, unknown> = {}) {
  const r = await comSessao(uid, () =>
    criarOrcamento({ clienteId, destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas, ...extra }),
  );
  if (!r.ok) throw new Error(r.erro);
  return r;
}

async function item(uid: string, viagemId: string, dados: Partial<ItemEntrada> = {}, itemId?: string) {
  const r = await comSessao(uid, () => salvarItem(viagemId, { tipo: "Passeio", servico: "Passeio", ...dados }, itemId));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

async function cotacao(uid: string, itemId: string, dados: Record<string, unknown> = {}, cotacaoId?: string) {
  const r = await comSessao(uid, () => salvarCotacao(itemId, { moeda: "BRL", valor: "1.000,00", ...dados }, cotacaoId));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

const ativosDa = (viagemId: string) =>
  db
    .select()
    .from(itensViagem)
    .where(and(eq(itensViagem.viagemId, viagemId), isNull(itensViagem.excluidoEm)));

describe("orçamentos", () => {
  beforeEach(limparBanco);

  it("dois orçamentos do mesmo cliente: ECL-0001-01 e ECL-0001-02; filial do cliente, consultor atual, auditoria", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const a = await novoOrcamento(u.id, clienteId, pessoas);
    const b = await novoOrcamento(u.id, clienteId, [pessoas[0]]);
    expect([a.codigo, b.codigo]).toEqual(["ECL-0001-01", "ECL-0001-02"]);
    const [v] = await db.select().from(viagens).where(eq(viagens.id, a.id));
    expect(v).toMatchObject({ seq: 1, filial: "RS", consultorId: u.id, status: "em_edicao", destino: "Itália" });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, a.id));
    expect(aud.map((x) => [x.acao, x.tabela])).toEqual([["criar", "viagens"]]);
    expect((aud[0].depois as { passageiros: string[] }).passageiros).toHaveLength(2);
  });

  it("criação concorrente não repete o sequencial", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        comSessao(u.id, () =>
          criarOrcamento({ clienteId, destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas }),
        ),
      ),
    );
    const codigos = rs.map((r) => (r.ok ? r.codigo : r.erro)).sort();
    expect(codigos).toEqual(["ECL-0001-01", "ECL-0001-02", "ECL-0001-03", "ECL-0001-04", "ECL-0001-05"]);
  });

  it("validação: destino, datas, passageiros; passageiro de outro cliente ou removido recusado", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const outro = await comSessao(u.id, () => salvarCliente({ ...souza, titular: { nome: "Ana Lima" }, acompanhantes: [] }));
    if (!outro.ok) throw new Error(outro.erro);
    const alheia = (await comSessao(u.id, () => obterCliente(outro.id)))!.pessoas[0].id;
    const base = { clienteId, destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas };
    const c = (x: Record<string, unknown>) => comSessao(u.id, () => criarOrcamento({ ...base, ...x } as typeof base));
    expect(await c({ destino: "  " })).toMatchObject({ ok: false, erro: "Informe o destino", campos: { destino: "Informe o destino" } });
    expect(await c({ inicio: "2027-02-30" })).toMatchObject({ ok: false, erro: "Data inválida", campos: { inicio: "Data inválida" } });
    expect(await c({ fim: "2027-08-13" })).toMatchObject({
      ok: false,
      erro: "A volta não pode ser antes da ida",
      campos: { fim: "A volta não pode ser antes da ida" },
    });
    expect(await c({ passageiros: [] })).toMatchObject({ ok: false, erro: "Escolha ao menos um passageiro" });
    expect(await c({ passageiros: [pessoas[0], alheia] })).toEqual({ ok: false, erro: "Passageiro não pertence a este cliente" });
    expect(await c({ passageiros: ["nao-e-uuid"] })).toMatchObject({ ok: false, erro: "Passageiro não pertence a este cliente" });
    expect(await c({ clienteId: "00000000-0000-0000-0000-000000000000" })).toEqual({ ok: false, erro: "Cliente não encontrado" });
    // pessoa removida do cliente
    const ficha = (await comSessao(u.id, () => obterCliente(clienteId)))!;
    const r = await comSessao(u.id, () =>
      salvarCliente({ ...souza, titular: { ...souza.titular, id: pessoas[0] }, acompanhantes: [] }, clienteId, ficha.atualizadoEm),
    );
    expect(r.ok).toBe(true);
    expect(await c({ passageiros: [pessoas[1]] })).toEqual({ ok: false, erro: "Passageiro não pertence a este cliente" });
    expect(await db.select().from(viagens)).toHaveLength(0);
  });

  it("sem sessão: actions devolvem 'Sem permissão' e queries recusam", async () => {
    const { clienteId, pessoas } = await cenario();
    const semPermissao = { ok: false, erro: "Sem permissão" };
    const id = "00000000-0000-0000-0000-000000000000";
    expect(await criarOrcamento({ clienteId, destino: "X", inicio: "2027-01-01", fim: "2027-01-02", passageiros: pessoas })).toEqual(semPermissao);
    expect(await alterarOrcamento(id, { destino: "X", inicio: "2027-01-01", fim: "2027-01-02", passageiros: pessoas }, "x")).toEqual(semPermissao);
    expect(await salvarItem(id, { tipo: "Passeio", servico: "X" })).toEqual(semPermissao);
    expect(await removerItem(id)).toEqual(semPermissao);
    expect(await salvarCotacao(id, { moeda: "BRL", valor: "1,00" })).toEqual(semPermissao);
    expect(await removerCotacao(id)).toEqual(semPermissao);
    expect(await escolherCotacao(id)).toEqual(semPermissao);
    await expect(listarOrcamentos()).rejects.toThrow("Sem permissão");
    await expect(obterPrecificacao(id)).rejects.toThrow("Sem permissão");
  });

  it("alterarOrcamento: concorrência com atualizadoEm, passageiros trocados, auditoria antes/depois", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    const f = (await comSessao(u.id, () => obterPrecificacao(id)))!;
    const dados = { destino: "Itália e Suíça", inicio: "2027-08-14", fim: "2027-09-02", passageiros: [pessoas[0]] };
    expect(await comSessao(u.id, () => alterarOrcamento(id, dados, f.atualizadoEm))).toEqual({ ok: true, id });
    const msg = "Este orçamento foi alterado por outra pessoa. Recarregue a página.";
    expect(await comSessao(u.id, () => alterarOrcamento(id, dados, f.atualizadoEm))).toEqual({ ok: false, erro: msg, conflito: true });
    expect(await comSessao(u.id, () => alterarOrcamento(id, dados, "não é data"))).toEqual({ ok: false, erro: msg, conflito: true });
    const g = (await comSessao(u.id, () => obterPrecificacao(id)))!;
    expect(g).toMatchObject({ destino: "Itália e Suíça", fim: "2027-09-02", dias: 20, noites: 19 });
    expect(g.passageiros.map((p) => p.nome)).toEqual(["Marcos Souza"]);
    expect(await comSessao(u.id, () => alterarOrcamento("00000000-0000-0000-0000-000000000000", dados, g.atualizadoEm))).toEqual({
      ok: false,
      erro: "Orçamento não encontrado",
    });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, id)).orderBy(auditoria.id);
    expect(aud.map((a) => a.acao)).toEqual(["criar", "alterar"]);
    expect((aud[1].antes as { destino: string }).destino).toBe("Itália");
    expect((aud[1].depois as { destino: string }).destino).toBe("Itália e Suíça");
  });
});

describe("itens e cotações", () => {
  beforeEach(limparBanco);

  it("cotação em EUR usa o câmbio dos Parâmetros; mudar o câmbio depois não altera a antiga (Review Focus 2)", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const d = await criarUsuarioTeste("diretor");
    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    const i = await item(u.id, id, { tipo: "Hotelaria", servico: "Palazzo Barocci", cidade: "Roma", diarias: 3 });
    // o cliente não consegue mandar câmbio
    expect(await comSessao(u.id, () => salvarCotacao(i, { moeda: "EUR", valor: "1.000,00", cambio: "1.0000" } as never))).toMatchObject({
      ok: false,
    });
    const c1 = await cotacao(u.id, i, { moeda: "EUR", valor: "1.000,00" });
    const [a] = await db.select().from(cotacoes).where(eq(cotacoes.id, c1));
    expect(a).toMatchObject({
      moeda: "EUR",
      valorOriginal: 100000n,
      cambioComercial: "5.8930",
      cambioAplicado: "6.1582",
      cambioData: "2026-11-06",
      valorBrl: 615820n,
      escolhida: true,
    });

    const vig = await comSessao(d.id, () => regrasVigentes());
    const r = await comSessao(d.id, () =>
      salvarRegras({ ...vig.valores, cambio: { ...vig.valores.cambio, EUR: { comercial: "6.0000", data: "2026-11-20" } } }),
    );
    expect(r.ok).toBe(true);
    const c2 = await cotacao(u.id, i, { moeda: "EUR", valor: "1.000,00" });
    const [velha] = await db.select().from(cotacoes).where(eq(cotacoes.id, c1));
    const [nova] = await db.select().from(cotacoes).where(eq(cotacoes.id, c2));
    expect(velha).toMatchObject({ cambioAplicado: "6.1582", valorBrl: 615820n });
    expect(nova).toMatchObject({ cambioComercial: "6.0000", cambioAplicado: "6.2700", cambioData: "2026-11-20", valorBrl: 627000n, escolhida: false });
    // editar a comissão da antiga mantém o câmbio gravado
    await cotacao(u.id, i, { moeda: "EUR", valor: "1.000,00", comissao: "4" }, c1);
    const [editada] = await db.select().from(cotacoes).where(eq(cotacoes.id, c1));
    expect(editada).toMatchObject({ cambioAplicado: "6.1582", valorBrl: 615820n, comissaoPct: "4.000" });
    // editar sem informar a moeda é recusado e nada muda (não vira reais)
    const semMoeda = await comSessao(u.id, () => salvarCotacao(i, { valor: "2.000,00" } as never, c1));
    expect(semMoeda).toMatchObject({ ok: false, erro: "Escolha a moeda", campos: { moeda: "Escolha a moeda" } });
    const [intacta] = await db.select().from(cotacoes).where(eq(cotacoes.id, c1));
    expect(intacta).toEqual(editada);
    // BRL grava câmbio nulo
    const c3 = await cotacao(u.id, i, { valor: "R$ 2.500,50" });
    const [brl] = await db.select().from(cotacoes).where(eq(cotacoes.id, c3));
    expect(brl).toMatchObject({ moeda: "BRL", valorOriginal: 250050n, valorBrl: 250050n, cambioComercial: null, cambioAplicado: null, cambioData: null });
  });

  it("validação de item e cotação", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    expect(await comSessao(u.id, () => salvarItem(id, { tipo: "Passeio", servico: " " }))).toMatchObject({
      ok: false,
      erro: "Informe o serviço",
      campos: { servico: "Informe o serviço" },
    });
    expect(await comSessao(u.id, () => salvarItem(id, { tipo: "Taxa", servico: "Taxa" }))).toMatchObject({ ok: false, erro: "Tipo inválido" });
    expect(await comSessao(u.id, () => salvarItem("00000000-0000-0000-0000-000000000000", { tipo: "Passeio", servico: "X" }))).toEqual({
      ok: false,
      erro: "Orçamento não encontrado",
    });
    const i = await item(u.id, id);
    for (const valor of ["", "abc", "-5,00", "1,234"]) {
      expect(await comSessao(u.id, () => salvarCotacao(i, { moeda: "BRL", valor }))).toMatchObject({ ok: false, erro: "Valor inválido" });
    }
    expect(await comSessao(u.id, () => salvarCotacao("00000000-0000-0000-0000-000000000000", { moeda: "BRL", valor: "1,00" }))).toEqual({
      ok: false,
      erro: "Item não encontrado",
    });
    expect(await comSessao(u.id, () => removerItem("00000000-0000-0000-0000-000000000000"))).toEqual({ ok: false, erro: "Item não encontrado" });
  });

  it("primeira cotação é a escolhida; escolher outra troca; remover a escolhida promove a mais antiga restante", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    const i = await item(u.id, id);
    const a = await cotacao(u.id, i, { valor: "100,00" });
    const b = await cotacao(u.id, i, { valor: "120,00" });
    const c = await cotacao(u.id, i, { valor: "130,00" });
    const escolhidas = async () =>
      (await db.select().from(cotacoes).where(and(eq(cotacoes.itemId, i), eq(cotacoes.escolhida, true), isNull(cotacoes.excluidoEm)))).map(
        (x) => x.id,
      );
    expect(await escolhidas()).toEqual([a]);
    expect(await comSessao(u.id, () => escolherCotacao(b))).toEqual({ ok: true });
    expect(await escolhidas()).toEqual([b]);
    expect(await comSessao(u.id, () => removerCotacao(b))).toEqual({ ok: true });
    expect(await escolhidas()).toEqual([a]);
    expect(await comSessao(u.id, () => removerCotacao(b))).toEqual({ ok: false, erro: "Cotação não encontrada" });
    expect(c).toBeTruthy();
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, b)).orderBy(auditoria.id);
    expect(aud.map((x) => x.acao)).toEqual(["criar", "alterar", "excluir"]);
  });

  it("taxa de roteiro aparece com o 6º item (sem contar aéreo) e some ao remover; não pode ser editada", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    const ids: string[] = [];
    for (let n = 1; n <= 5; n++) ids.push(await item(u.id, id, { servico: `Passeio ${n}` }));
    await item(u.id, id, { tipo: "Aéreo", servico: "GRU-FCO" });
    const taxa = async () => (await ativosDa(id)).filter((x) => x.tipo === "Taxa");
    expect(await taxa()).toEqual([]);
    ids.push(await item(u.id, id, { servico: "Passeio 6" }));
    const [t] = await taxa();
    expect(t).toMatchObject({ automatico: true, servico: "Taxa de roteiro" });
    const ct = await db.select().from(cotacoes).where(eq(cotacoes.itemId, t.id));
    expect(ct.map((x) => [x.moeda, x.valorBrl, x.escolhida])).toEqual([["BRL", 25000n, true]]);
    // continua uma só ao salvar mais
    await item(u.id, id, { servico: "Passeio 7" });
    expect(await taxa()).toHaveLength(1);
    expect(await comSessao(u.id, () => salvarItem(id, { tipo: "Outro", servico: "Mudar" }, t.id))).toEqual({ ok: false, erro: AUTOMATICA });
    expect(await comSessao(u.id, () => removerItem(t.id))).toEqual({ ok: false, erro: AUTOMATICA });
    expect(await comSessao(u.id, () => salvarCotacao(t.id, { moeda: "BRL", valor: "1,00" }))).toEqual({ ok: false, erro: AUTOMATICA });
    expect(await comSessao(u.id, () => removerCotacao(ct[0].id))).toEqual({ ok: false, erro: AUTOMATICA });
    // remove dois: fica com 5 → a taxa sai (exclusão lógica)
    expect(await comSessao(u.id, () => removerItem(ids[0]))).toEqual({ ok: true });
    expect(await taxa()).toHaveLength(1);
    expect(await comSessao(u.id, () => removerItem(ids[1]))).toEqual({ ok: true });
    expect(await taxa()).toEqual([]);
    const [apagada] = await db.select().from(itensViagem).where(eq(itensViagem.id, t.id));
    expect(apagada.excluidoEm).toBeInstanceOf(Date);
    const audTaxa = await db.select().from(auditoria).where(eq(auditoria.registroId, t.id)).orderBy(auditoria.id);
    expect(audTaxa.map((x) => x.acao)).toEqual(["criar", "excluir"]);
  });

  it("aprovado/devolvido: alterar item volta para em_edicao mantendo a versão aprovada; aguardando recusa", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    const i = await item(u.id, id);
    const c = await cotacao(u.id, i);
    const vig = await comSessao(u.id, () => regrasVigentes());
    const [ver] = await db
      .insert(versoesPrecificacao)
      .values({
        viagemId: id,
        numero: 1,
        status: "aprovada",
        snapshot: {},
        preco: 100000n,
        forma: {},
        dias: 19,
        regrasVersaoId: vig.versaoId,
        rateio: "por_dia",
        resultado: {},
        enviadoPor: u.id,
      })
      .returning();
    await db.update(viagens).set({ status: "aprovado", versaoAprovadaId: ver.id }).where(eq(viagens.id, id));
    const [antes] = await db.select().from(viagens).where(eq(viagens.id, id));
    await item(u.id, id, { servico: "Passeio alterado" }, i);
    const [depois] = await db.select().from(viagens).where(eq(viagens.id, id));
    expect(depois).toMatchObject({ status: "em_edicao", versaoAprovadaId: ver.id });
    expect(depois.atualizadoEm.getTime()).toBeGreaterThan(antes.atualizadoEm.getTime());

    await db.update(viagens).set({ status: "devolvido" }).where(eq(viagens.id, id));
    await cotacao(u.id, i, { valor: "900,00" });
    expect((await db.select().from(viagens).where(eq(viagens.id, id)))[0].status).toBe("em_edicao");

    await db.update(viagens).set({ status: "aguardando_aprovacao" }).where(eq(viagens.id, id));
    const recusa = { ok: false, erro: AGUARDANDO };
    expect(await comSessao(u.id, () => salvarItem(id, { tipo: "Passeio", servico: "Novo" }))).toEqual(recusa);
    expect(await comSessao(u.id, () => salvarItem(id, { tipo: "Passeio", servico: "Novo" }, i))).toEqual(recusa);
    expect(await comSessao(u.id, () => removerItem(i))).toEqual(recusa);
    expect(await comSessao(u.id, () => salvarCotacao(i, { moeda: "BRL", valor: "1,00" }))).toEqual(recusa);
    expect(await comSessao(u.id, () => removerCotacao(c))).toEqual(recusa);
    expect(await comSessao(u.id, () => escolherCotacao(c))).toEqual(recusa);
    const f = (await comSessao(u.id, () => obterPrecificacao(id)))!;
    expect(
      await comSessao(u.id, () => alterarOrcamento(id, { destino: "X", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas }, f.atualizadoEm)),
    ).toEqual(recusa);
    expect(await ativosDa(id)).toHaveLength(1);
  });
});

describe("precificação", () => {
  beforeEach(limparBanco);

  it("consultor não recebe nenhum campo estratégico; fin_operacional recebe (Review Focus 3)", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const f = await criarUsuarioTeste("fin_operacional");
    const op = await criarUsuarioTeste("operacional");
    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    const hotel = await item(u.id, id, { tipo: "Hotelaria", servico: "Palazzo Barocci", cidade: "Roma", diarias: 3 });
    await cotacao(u.id, hotel, { valor: "3.106,00", comissao: "4", descontoAVista: "4" });
    await cotacao(u.id, hotel, { valor: "3.300,00" });
    const passeio = await item(u.id, id, { servico: "Coliseu" });
    await item(u.id, id, { servico: "Sem cotação ainda" });
    const aereo = await item(u.id, id, { tipo: "Aéreo", servico: "GRU-FCO" });
    await cotacao(u.id, aereo, { valor: "8.000,00", comissao: "6", tarifaFixa: "120,00" });
    await cotacao(u.id, passeio, { valor: "500,00" });

    for (const quem of [u.id, op.id]) {
      const ficha = (await comSessao(quem, () => obterPrecificacao(id)))!;
      const k = chaves(ficha);
      for (const proibida of ["estrategico", "precificacao", "custo", "margem", "custoLiquido", "venda", "compensacao", "margemExtra"]) {
        expect(k.has(proibida), proibida).toBe(false);
      }
      const s = json(ficha);
      expect(s).not.toContain('"margem');
      expect(s).not.toContain('"custoLiquido"');
      expect(s).not.toContain('"custo');
      for (const proibida of ["porForma", "precoPorForma", "somaVendas", "compensacao"]) expect(k.has(proibida), proibida).toBe(false);
      expect(ficha.referencia).toMatchObject({ forma: "Crédito 2x a 6x (referência)" });
      expect(BigInt(ficha.referencia!.precoCliente)).toBeGreaterThan(0n);
      // operacional: valor do fornecedor, comissão e desconto aparecem
      expect(ficha.itens.find((x) => x.id === hotel)!.cotacoes.map((c) => [c.valorBrl, c.comissaoPct, c.descontoAVistaPct, c.escolhida])).toEqual([
        [310600n, "4.000", "4.000", true],
        [330000n, "0.000", null, false],
      ]);
      expect(ficha.itensSemCotacao.map((x) => x.servico)).toEqual(["Sem cotação ainda"]);
      expect(ficha.aereo).toHaveLength(1);
      expect(ficha.aereo[0].cotacoes[0]).toMatchObject({ valorBrl: 800000n, comissaoPct: "6.000", tarifaFixa: 12000n });
      expect(ficha.itens.some((x) => x.tipo === "Aéreo")).toBe(false);
      expect(ficha).toMatchObject({ codigo: "ECL-0001-01", cliente: "Família Souza", dias: 19, noites: 18, status: "em_edicao" });
    }

    const ficha = (await comSessao(f.id, () => obterPrecificacao(id)))!;
    const e = ficha.estrategico as CamadaEstrategica;
    expect(e).toBeDefined();
    // pior custo do hotel: 3.300,00 (0%) > 2.981,76; passeio 500,00
    expect(e.precificacao.custo).toBe(330000n + 50000n);
    expect(e.custoEscolhidas).toBe(298176n + 50000n);
    expect(e.margemExtra).toBe(330000n - 298176n);
    expect(e.precificacao.itens.map((x) => x.id).sort()).toEqual([hotel, passeio].sort());
    expect(e.precificacao.porForma).toHaveLength(5);
    expect(json(ficha)).toContain('"custoLiquido"');
    expect(ficha.referencia!.precoCliente).toBe(e.precificacao.porForma[2].precoCliente.toString());
  });

  it("sugestão de custo de referência: média de outras viagens com mesmo tipo, serviço e cidade (sem acento/caixa)", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const valores = ["1.000,00", "1.100,00", "1.300,01"];
    for (const v of valores) {
      const { id } = await novoOrcamento(u.id, clienteId, pessoas);
      const i = await item(u.id, id, { tipo: "Hotelaria", servico: "Hotel Lungarno", cidade: "Florença" });
      await cotacao(u.id, i, { valor: v });
    }
    // não conta: outra cidade, outro tipo, item removido
    const { id: x } = await novoOrcamento(u.id, clienteId, pessoas);
    await cotacao(u.id, await item(u.id, x, { tipo: "Hotelaria", servico: "Hotel Lungarno", cidade: "Roma" }), { valor: "9.000,00" });
    await cotacao(u.id, await item(u.id, x, { tipo: "Passeio", servico: "Hotel Lungarno", cidade: "Florença" }), { valor: "9.000,00" });
    const removido = await item(u.id, x, { tipo: "Hotelaria", servico: "Hotel Lungarno", cidade: "Florença" });
    await cotacao(u.id, removido, { valor: "9.000,00" });
    await comSessao(u.id, () => removerItem(removido));

    const { id } = await novoOrcamento(u.id, clienteId, pessoas);
    const i = await item(u.id, id, { tipo: "Hotelaria", servico: "hotel lungarno", cidade: "FLORENCA" });
    await cotacao(u.id, i, { valor: "5.000,00" }); // a própria viagem não conta
    const outro = await item(u.id, id, { tipo: "Hotelaria", servico: "Hotel Novo", cidade: "Florença" });
    const ficha = (await comSessao(u.id, () => obterPrecificacao(id)))!;
    expect(ficha.itens.find((z) => z.id === i)!.sugestao).toEqual({ quantidade: 3, media: 113334n });
    expect(ficha.itens.find((z) => z.id === outro)!.sugestao).toBeNull();
  });

  it("listarOrcamentos: busca, status; preço e margem só para a camada estratégica", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const d = await criarUsuarioTeste("diretor");
    const a = await novoOrcamento(u.id, clienteId, pessoas, { destino: "Itália" });
    const b = await novoOrcamento(u.id, clienteId, [pessoas[0]], { destino: "Portugal" });
    await cotacao(u.id, await item(u.id, a.id, { servico: "Coliseu" }), { valor: "500,00" });
    await db.update(viagens).set({ status: "devolvido" }).where(eq(viagens.id, b.id));

    const l = (uid: string, f?: Parameters<typeof listarOrcamentos>[0]) => comSessao(uid, () => listarOrcamentos(f));
    const todos = await l(u.id);
    expect(todos.map((x) => x.codigo)).toEqual(["ECL-0001-02", "ECL-0001-01"]);
    expect(todos[1]).toMatchObject({
      cliente: "Família Souza",
      destino: "Itália",
      inicio: "2027-08-14",
      fim: "2027-09-01",
      passageiros: ["Marcos Souza", "Júlia Souza"],
      consultor: "Teste consultor",
      status: "em_edicao",
      versaoAprovada: null,
    });
    expect(chaves(todos).has("estrategico")).toBe(false);
    expect(json(todos)).not.toContain('"margem');
    expect((await l(u.id, { busca: "portugal" })).map((x) => x.codigo)).toEqual(["ECL-0001-02"]);
    expect((await l(u.id, { busca: "julia" })).map((x) => x.codigo)).toEqual(["ECL-0001-01"]);
    expect((await l(u.id, { busca: "ECL-0001-01" })).map((x) => x.codigo)).toEqual(["ECL-0001-01"]);
    expect((await l(u.id, { busca: "souza" })).map((x) => x.codigo)).toHaveLength(2);
    expect(await l(u.id, { busca: "%" })).toEqual([]);
    expect((await l(u.id, { status: "devolvido" })).map((x) => x.codigo)).toEqual(["ECL-0001-02"]);

    const doDiretor = await l(d.id);
    const ita = doDiretor.find((x) => x.codigo === "ECL-0001-01")!;
    const est = ita.estrategico as { preco: bigint; margemPct: string };
    expect(est.preco).toBeGreaterThan(50000n);
    expect(est.margemPct).toBe("19.0");
    expect(doDiretor.find((x) => x.codigo === "ECL-0001-02")!.estrategico).toEqual({ preco: null, margemPct: null });
  });

  it("listarOrcamentos: linha que não dá para calcular não derruba a lista", async () => {
    const { u, clienteId, pessoas } = await cenario();
    const d = await criarUsuarioTeste("diretor");
    const a = await novoOrcamento(u.id, clienteId, pessoas);
    const b = await novoOrcamento(u.id, clienteId, pessoas);
    await cotacao(u.id, await item(u.id, a.id), { valor: "500,00" });
    const vig = await comSessao(d.id, () => regrasVigentes());
    expect((await comSessao(d.id, () => salvarRegras({ ...vig.valores, margemAlvoPct: "93.000" }))).ok).toBe(true);
    const lista = await comSessao(d.id, () => listarOrcamentos());
    expect(lista.find((x) => x.id === a.id)!.estrategico).toEqual({ erro: "Não foi possível calcular" });
    expect(lista.find((x) => x.id === b.id)!.estrategico).toEqual({ preco: null, margemPct: null });
  });

  it("obterPrecificacao: id inválido ou inexistente → null", async () => {
    const { u } = await cenario();
    expect(await comSessao(u.id, () => obterPrecificacao("x"))).toBeNull();
    expect(await comSessao(u.id, () => obterPrecificacao("00000000-0000-0000-0000-000000000000"))).toBeNull();
    expect(REGRAS_INICIAIS.taxaRoteiro.minimoItens).toBe(6);
  });
});
