import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarReais } from "@/domain/dinheiro";
import type { Origem } from "@/domain/financeiro";
import { arredondar } from "@/domain/decimal";
import { ErroAcesso } from "@/server/auth";
import { db, sql } from "@/server/db/client";
import { auditoria, cartoesCorporativos, categoriasFinanceiras, contasBancarias, contasPagar, faturasCartao, lancamentos, lancamentosFinanceiros as lf, pagamentosFornecedor, viagens } from "@/server/db/schema";
import { criarCartao, desativarCartao, editarCartao } from "@/server/actions/cartoes";
import {
  alternarCategoria,
  baixarEmLote,
  baixarLancamento,
  baixarLinha,
  cancelarLancamento,
  criarLancamento,
  desfazerBaixaLancamento,
  desfazerBaixaLinha,
  editarLancamento,
  salvarCategoria,
  salvarContaBancaria,
} from "@/server/actions/financeiro";
import { atualizarPrevisto, baixarPagamento, definirFormaFornecedor, desfazerBaixaPagamento } from "@/server/actions/financeiro-viagem";
import { obterFluxoDeCaixa, saldosDasContas } from "@/server/queries/caixa";
import { listarCartoes, listarCartoesAtivos } from "@/server/queries/cartoes";
import { listarLancamentos } from "@/server/queries/financeiro";
import { obterViagemVendida } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { chaveTrava } from "@/server/trava-viagem";
import { vendida, type Fixture } from "../helpers/venda";

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };
const MSG_FATURA_PAGA = "A fatura do cartão deste período já foi paga";
const MSG_DESFACA_FATURA = "Desfaça a baixa da fatura do cartão antes";

type Contexto = { fin: string; categoria: string; conta: string };
let c: Contexto;

async function preparar(): Promise<Contexto> {
  await limparBanco();
  const fin = await criarUsuarioTeste("fin_estrategico");
  const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, "Aluguel"));
  const [conta] = await db.insert(contasBancarias).values({ nome: "Itaú", saldoInicialEm: "2026-01-01" }).returning();
  return { fin: fin.id, categoria: cat.id, conta: conta.id };
}

const dadosCartao = (extra: Record<string, unknown> = {}) => ({
  nome: "Visa empresarial",
  final: "1234",
  diaFechamento: "15",
  diaVencimento: "25",
  contaBancariaId: c.conta,
  centro: "MT",
  ...extra,
});

async function novoCartao(extra: Record<string, unknown> = {}, uid = c.fin): Promise<string> {
  const r = await comSessao(uid, () => criarCartao(dadosCartao(extra)));
  if (!r.ok || !r.id) throw new Error(r.ok ? "sem id" : r.erro);
  return r.id;
}

const compra = (cartaoId: string | undefined, extra: Record<string, unknown> = {}) => ({
  lado: "pagar",
  descricao: "Passagem do diretor",
  fornecedorId: "",
  clienteId: "",
  pessoaTexto: "",
  categoriaId: c.categoria,
  centro: "MT",
  competencia: "2027-01",
  emissao: "2027-01-10",
  vencimento: "2027-01-10",
  valor: "300,00",
  forma: "Cartão de crédito",
  contaBancariaId: "",
  observacao: "",
  repeticao: { tipo: "unica" },
  ...(cartaoId === undefined ? {} : { cartaoId }),
  ...extra,
});

async function comprar(cartaoId: string, extra: Record<string, unknown> = {}): Promise<string[]> {
  const r = await comSessao(c.fin, () => criarLancamento(compra(cartaoId, extra)));
  if (!r.ok) throw new Error(r.erro);
  return (r as { ids: string[] }).ids;
}

const lancamento = async (id: string) => (await db.select().from(lancamentos).where(eq(lancamentos.id, id)))[0];
const faturas = (cartaoId: string) => db.select().from(faturasCartao).where(eq(faturasCartao.cartaoId, cartaoId)).orderBy(asc(faturasCartao.fechamento));
const pagarFatura = (id: string) =>
  db.update(faturasCartao).set({ status: "baixado", pagoEm: "2027-01-25", valorPago: 30000n, contaBancariaId: c.conta }).where(eq(faturasCartao.id, id));

describe("cartões corporativos", () => {
  beforeEach(async () => {
    c = await preparar();
  });

  describe("cadastro", () => {
    it("cria, edita e desativa com auditoria", async () => {
      const id = await novoCartao();
      const [k] = await db.select().from(cartoesCorporativos).where(eq(cartoesCorporativos.id, id));
      expect(k).toMatchObject({ nome: "Visa empresarial", final: "1234", diaFechamento: 15, diaVencimento: 25, contaBancariaId: c.conta, centro: "MT", ativo: true });

      expect(await comSessao(c.fin, () => editarCartao(id, dadosCartao({ nome: "Visa ECLAK", diaFechamento: "10" })))).toMatchObject({ ok: true });
      const [e] = await db.select().from(cartoesCorporativos).where(eq(cartoesCorporativos.id, id));
      expect(e).toMatchObject({ nome: "Visa ECLAK", diaFechamento: 10 });

      expect(await comSessao(c.fin, () => desativarCartao(id))).toMatchObject({ ok: true });
      const [d] = await db.select().from(cartoesCorporativos).where(eq(cartoesCorporativos.id, id));
      expect(d.ativo).toBe(false);

      const a = await db.select().from(auditoria).where(eq(auditoria.tabela, "cartoes_corporativos")).orderBy(asc(auditoria.id));
      expect(a.map((x) => x.acao)).toEqual(["criar", "alterar", "desativar"]);
      expect(a[1].antes).toEqual({ nome: "Visa empresarial", diaFechamento: 15 });
    });

    it("recusa final com 3 dígitos ou letras, dia 29 ou 0 e conta bancária desativada", async () => {
      expect(await comSessao(c.fin, () => criarCartao(dadosCartao({ final: "123" })))).toMatchObject({ ok: false, campos: { final: expect.any(String) } });
      expect(await comSessao(c.fin, () => criarCartao(dadosCartao({ final: "12a4" })))).toMatchObject({ ok: false, campos: { final: expect.any(String) } });
      expect(await comSessao(c.fin, () => criarCartao(dadosCartao({ diaFechamento: "29" })))).toMatchObject({ ok: false, campos: { diaFechamento: expect.any(String) } });
      expect(await comSessao(c.fin, () => criarCartao(dadosCartao({ diaVencimento: "0" })))).toMatchObject({ ok: false, campos: { diaVencimento: expect.any(String) } });
      await db.update(contasBancarias).set({ ativa: false }).where(eq(contasBancarias.id, c.conta));
      expect(await comSessao(c.fin, () => criarCartao(dadosCartao()))).toMatchObject({ ok: false, campos: { contaBancariaId: expect.any(String) } });
      expect(await db.select().from(cartoesCorporativos)).toHaveLength(0);
    });

    it("categoria de sistema 'Cartão corporativo': não desativa nem troca de lado, mas renomeia", async () => {
      const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, "cartao_corporativo"));
      expect(cat).toMatchObject({ lado: "pagar", grupo: "Administrativo", nome: "Cartão corporativo" });
      expect(await comSessao(c.fin, () => alternarCategoria(cat.id, false))).toEqual({ ok: false, erro: "Categoria usada pelo cartão corporativo: não pode ser desativada" });
      expect(await comSessao(c.fin, () => salvarCategoria({ lado: "receber", grupo: "Administrativo", nome: "Cartão corporativo" }, cat.id))).toMatchObject({
        ok: false,
        campos: { lado: "Categoria usada pelo cartão corporativo: não pode trocar de lado" },
      });
      expect(await comSessao(c.fin, () => salvarCategoria({ lado: "pagar", grupo: "Administrativo", nome: "Cartões da empresa" }, cat.id))).toMatchObject({ ok: true });
    });

    it("nome repetido entre os ativos é recusado", async () => {
      await novoCartao();
      expect(await comSessao(c.fin, () => criarCartao(dadosCartao({ final: "9999" })))).toMatchObject({ ok: false, campos: { nome: expect.any(String) } });
    });

    it("perfis: consultor e operacional recebem 'Sem permissão'; queries lançam ErroAcesso; diretor e fin_operacional podem", async () => {
      const id = await novoCartao();
      for (const perfil of ["consultor", "operacional"] as const) {
        const u = await criarUsuarioTeste(perfil);
        expect(await comSessao(u.id, () => criarCartao(dadosCartao({ nome: "Outro" })))).toEqual(SEM_PERMISSAO);
        expect(await comSessao(u.id, () => editarCartao(id, dadosCartao({ nome: "Outro" })))).toEqual(SEM_PERMISSAO);
        expect(await comSessao(u.id, () => desativarCartao(id))).toEqual(SEM_PERMISSAO);
        await expect(comSessao(u.id, () => listarCartoes())).rejects.toBeInstanceOf(ErroAcesso);
        await expect(comSessao(u.id, () => listarCartoesAtivos())).rejects.toBeInstanceOf(ErroAcesso);
      }
      const dir = await criarUsuarioTeste("diretor");
      await novoCartao({ nome: "Master" }, dir.id);
      const op = await criarUsuarioTeste("fin_operacional");
      await novoCartao({ nome: "Elo" }, op.id);
      expect((await comSessao(op.id, () => listarCartoesAtivos())).map((k) => k.nome).sort()).toEqual(["Elo", "Master", "Visa empresarial"]);
    });
  });

  describe("compras em lançamento manual", () => {
    it("cria a fatura do ciclo (fechamento e vencimento pela ruling 8) e vincula; segunda compra no mesmo ciclo usa a mesma fatura", async () => {
      const k = await novoCartao();
      const [id1] = await comprar(k);
      const [id2] = await comprar(k, { vencimento: "2027-01-15", emissao: "2027-01-15" });
      const fs = await faturas(k);
      expect(fs).toHaveLength(1);
      expect(fs[0]).toMatchObject({ fechamento: "2027-01-15", vencimento: "2027-01-25", status: "em_aberto", pagoEm: null, valorPago: null });
      expect(await lancamento(id1)).toMatchObject({ cartaoId: k, faturaCartaoId: fs[0].id, vencimento: "2027-01-10", forma: "cartao_credito" });
      expect(await lancamento(id2)).toMatchObject({ cartaoId: k, faturaCartaoId: fs[0].id });
      const a = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "faturas_cartao"), eq(auditoria.acao, "criar")));
      expect(a.map((x) => x.registroId)).toEqual([fs[0].id]);
    });

    it("dia de vencimento menor que o de fechamento: vence no mês seguinte; compra depois do fechamento vai para a fatura seguinte", async () => {
      const k = await novoCartao({ diaFechamento: "25", diaVencimento: "5" });
      await comprar(k, { vencimento: "2027-12-28", emissao: "2027-12-28", competencia: "2027-12" });
      expect(await faturas(k)).toMatchObject([{ fechamento: "2028-01-25", vencimento: "2028-02-05" }]);
    });

    it("exige o cartão (ativo) na compra a pagar com cartão de crédito; a receber e outras formas ficam sem cartão", async () => {
      const k = await novoCartao();
      expect(await comSessao(c.fin, () => criarLancamento(compra(undefined)))).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });
      expect(await comSessao(c.fin, () => criarLancamento(compra("")))).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });
      expect(await comSessao(c.fin, () => criarLancamento(compra(crypto.randomUUID())))).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });
      const [pix] = await comprar(k, { forma: "PIX" });
      expect(await lancamento(pix)).toMatchObject({ cartaoId: null, faturaCartaoId: null });
      const [rec] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, "vendas_viagem"));
      const [receber] = await comprar(k, { lado: "receber", categoriaId: rec.id });
      expect(await lancamento(receber)).toMatchObject({ cartaoId: null, faturaCartaoId: null });
      await comSessao(c.fin, () => desativarCartao(k));
      expect(await comSessao(c.fin, () => criarLancamento(compra(k)))).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });
      expect(await faturas(k)).toHaveLength(0);
    });

    it("parcelada no cartão: cada parcela na fatura do seu ciclo", async () => {
      const k = await novoCartao();
      const ids = await comprar(k, { valor: "900,00", repeticao: { tipo: "parcelado", parcelas: 3 } });
      const fs = await faturas(k);
      expect(fs.map((f) => f.fechamento)).toEqual(["2027-01-15", "2027-02-15", "2027-03-15"]);
      const ls = await Promise.all(ids.map(lancamento));
      expect(ls.map((l) => l.faturaCartaoId)).toEqual(fs.map((f) => f.id));
    });

    it("compras ao mesmo tempo no mesmo ciclo: uma fatura só", async () => {
      const k = await novoCartao();
      const rs = await Promise.all([1, 2, 3, 4].map(() => comSessao(c.fin, () => criarLancamento(compra(k)))));
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(await faturas(k)).toHaveLength(1);
    });

    it("editar a data para depois do fechamento move para a fatura seguinte (a antiga fica); voltar a forma para PIX desvincula; auditoria", async () => {
      const k = await novoCartao();
      const [id] = await comprar(k);
      const [jan] = await faturas(k);
      expect(await comSessao(c.fin, () => editarLancamento(id, compra(k, { vencimento: "2027-01-20" }), "esta"))).toMatchObject({ ok: true });
      const fs = await faturas(k);
      expect(fs.map((f) => f.fechamento)).toEqual(["2027-01-15", "2027-02-15"]);
      expect(fs[1].vencimento).toBe("2027-02-25");
      expect(await lancamento(id)).toMatchObject({ faturaCartaoId: fs[1].id, vencimento: "2027-01-20" });
      const a = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "lancamentos"), eq(auditoria.acao, "alterar"), eq(auditoria.registroId, id)));
      expect(a.at(-1)!.antes).toMatchObject({ faturaCartaoId: jan.id, vencimento: "2027-01-10" });
      expect(a.at(-1)!.depois).toMatchObject({ faturaCartaoId: fs[1].id, vencimento: "2027-01-20" });

      // trocar de cartão revincula na fatura do outro cartão
      const k2 = await novoCartao({ nome: "Master", final: "5678" });
      expect(await comSessao(c.fin, () => editarLancamento(id, compra(k2, { vencimento: "2027-01-20" }), "esta"))).toMatchObject({ ok: true });
      const [f2] = await faturas(k2);
      expect(await lancamento(id)).toMatchObject({ cartaoId: k2, faturaCartaoId: f2.id });

      expect(await comSessao(c.fin, () => editarLancamento(id, compra(k2, { forma: "PIX", vencimento: "2027-01-20" }), "esta"))).toMatchObject({ ok: true });
      expect(await lancamento(id)).toMatchObject({ cartaoId: null, faturaCartaoId: null, forma: "pix" });
      expect(await faturas(k)).toHaveLength(2);
    });

    it("cartão desativado depois da compra: a compra continua editável (até mudar a data); trocar para ele é recusado", async () => {
      const k = await novoCartao();
      const k2 = await novoCartao({ nome: "Master", final: "5678" });
      const [id] = await comprar(k);
      await comSessao(c.fin, () => desativarCartao(k));
      expect(await comSessao(c.fin, () => editarLancamento(id, compra(k, { descricao: "Passagem" }), "esta"))).toMatchObject({ ok: true });
      expect(await comSessao(c.fin, () => editarLancamento(id, compra(k, { vencimento: "2027-01-20" }), "esta"))).toMatchObject({ ok: true });
      expect((await faturas(k)).map((f) => f.fechamento)).toEqual(["2027-01-15", "2027-02-15"]);
      await comSessao(c.fin, () => desativarCartao(k2));
      expect(await comSessao(c.fin, () => editarLancamento(id, compra(k2, { vencimento: "2027-01-20" }), "esta"))).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });
      expect(await lancamento(id)).toMatchObject({ cartaoId: k, descricao: "Passagem do diretor" });
    });

    it("duas edições ao mesmo tempo movendo compras em sentidos opostos (dez→jan e jan→dez): as duas terminam, sem impasse", async () => {
      const k = await novoCartao();
      const [a] = await comprar(k, { vencimento: "2026-12-10", emissao: "2026-12-10", competencia: "2026-12" });
      const [b] = await comprar(k, { vencimento: "2027-01-10" });
      const [dez, jan] = await faturas(k);
      expect([dez.fechamento, jan.fechamento]).toEqual(["2026-12-15", "2027-01-15"]);
      // Uma transação de fora segura a fatura de dezembro: as duas edições começam e param nas travas das faturas;
      // ao soltar, cada uma precisa das duas faturas. Com travas em ordem diferente por caminho, o Postgres abortaria
      // uma delas (40P01); com a ordem única (cartao_id, fechamento), elas se enfileiram.
      let soltar!: () => void;
      const segurando = new Promise<void>((r) => (soltar = r));
      let travou!: () => void;
      const travada = new Promise<void>((r) => (travou = r));
      const bloqueio = sql.begin(async (t) => {
        await t`select id from faturas_cartao where id = ${dez.id} for update`;
        travou();
        await segurando;
      });
      await travada;
      const edicoes = Promise.all([
        comSessao(c.fin, () => editarLancamento(a, compra(k, { vencimento: "2027-01-12", emissao: "2026-12-10", competencia: "2026-12" }), "esta")),
        comSessao(c.fin, () => editarLancamento(b, compra(k, { vencimento: "2026-12-12" }), "esta")),
      ]);
      // Espera as duas edições pararem numa trava antes de soltar.
      for (let i = 0; i < 100; i++) {
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
        if (n >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      soltar();
      await bloqueio;
      expect(await edicoes).toEqual([{ ok: true, ids: [a] }, { ok: true, ids: [b] }]);
      expect(await lancamento(a)).toMatchObject({ faturaCartaoId: jan.id, vencimento: "2027-01-12" });
      expect(await lancamento(b)).toMatchObject({ faturaCartaoId: dez.id, vencimento: "2026-12-12" });
    });

    it("editar 'próximas' revincula cada parcela pela sua data", async () => {
      const k = await novoCartao();
      const k2 = await novoCartao({ nome: "Master", final: "5678", diaFechamento: "5", diaVencimento: "12" });
      const ids = await comprar(k, { valor: "900,00", repeticao: { tipo: "parcelado", parcelas: 3 } });
      expect(await comSessao(c.fin, () => editarLancamento(ids[1], compra(k2, { valor: "300,00", vencimento: "2027-02-10" }), "proximas"))).toMatchObject({ ok: true });
      const fs = await faturas(k2);
      expect(fs.map((f) => f.fechamento)).toEqual(["2027-03-05", "2027-04-05"]);
      const ls = await Promise.all(ids.map(lancamento));
      expect(ls.map((l) => l.cartaoId)).toEqual([k, k2, k2]);
      expect(ls[1].faturaCartaoId).toBe(fs[0].id);
      expect(ls[2].faturaCartaoId).toBe(fs[1].id);
    });

    it("cancelar a compra desvincula da fatura (o cartão fica registrado)", async () => {
      const k = await novoCartao();
      const [id] = await comprar(k);
      const [f] = await faturas(k);
      expect(await comSessao(c.fin, () => cancelarLancamento(id, "Compra estornada", "esta"))).toMatchObject({ ok: true });
      expect(await lancamento(id)).toMatchObject({ status: "cancelado", cartaoId: k, faturaCartaoId: null });
      const [a] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "lancamentos"), eq(auditoria.acao, "alterar"), eq(auditoria.registroId, id)));
      expect(a.antes).toMatchObject({ faturaCartaoId: f.id });
      expect(await faturas(k)).toHaveLength(1);
    });

    it("compra em fatura já paga é recusada; sair de fatura paga também", async () => {
      const k = await novoCartao();
      const [id] = await comprar(k);
      const [f] = await faturas(k);
      await pagarFatura(f.id);
      expect(await comSessao(c.fin, () => criarLancamento(compra(k, { vencimento: "2027-01-12" })))).toMatchObject({ ok: false, erro: MSG_FATURA_PAGA });
      expect(await comSessao(c.fin, () => editarLancamento(id, compra(k, { vencimento: "2027-01-20" }), "esta"))).toMatchObject({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await comSessao(c.fin, () => cancelarLancamento(id, "Estorno", "esta"))).toMatchObject({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await lancamento(id)).toMatchObject({ status: "em_aberto", faturaCartaoId: f.id });
      // fora do ciclo pago, tudo bem
      await comprar(k, { vencimento: "2027-01-20" });
    });

    it("listarCartoes traz as faturas com total e as compras", async () => {
      const k = await novoCartao();
      await comprar(k);
      await comprar(k, { vencimento: "2027-01-12", valor: "200,00" });
      const [cancelada] = await comprar(k, { vencimento: "2027-01-13", valor: "50,00" });
      await comSessao(c.fin, () => cancelarLancamento(cancelada, "Estorno", "esta"));
      const [cartao] = await comSessao(c.fin, () => listarCartoes());
      expect(cartao).toMatchObject({ id: k, nome: "Visa empresarial", final: "1234", contaBancaria: "Itaú" });
      expect(cartao.faturas).toHaveLength(1);
      expect(cartao.faturas[0]).toMatchObject({ fechamento: "2027-01-15", vencimento: "2027-01-25", status: "em_aberto", total: 50000n });
      expect(cartao.faturas[0].compras.map((x) => x.valor)).toEqual([30000n, 20000n]);
    });
  });

  describe("pagamento a fornecedor no cartão corporativo", () => {
    it("definirFormaFornecedor com cartão vincula; sem cartão recusa; à vista desvincula; fatura paga bloqueia a troca", async () => {
      const x = await vendida();
      c = { ...c, fin: x.fin.id };
      const [conta] = await db.insert(contasBancarias).values({ nome: "Bradesco", saldoInicialEm: "2026-01-01" }).returning();
      c.conta = conta.id;
      const k = await novoCartao();
      const f = (forma: Parameters<typeof definirFormaFornecedor>[1]) => comSessao(x.fin.id, () => definirFormaFornecedor(x.passeio.id, forma));
      const pagamentos = () => db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));

      expect(await f({ tipo: "cartao_corporativo", vencimento: "2027-07-10" } as never)).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });
      expect(await f({ tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId: crypto.randomUUID() })).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });

      expect(await f({ tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId: k })).toEqual({ ok: true });
      const [fat] = await faturas(k);
      expect(fat).toMatchObject({ fechamento: "2027-07-15", vencimento: "2027-07-25" });
      let [p] = await pagamentos();
      expect(p).toMatchObject({ vencimento: "2027-07-10", cartaoId: k, faturaCartaoId: fat.id });
      const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "pagamentos_fornecedor"), eq(auditoria.acao, "criar"), eq(auditoria.registroId, p.id)));
      expect(aud[0].depois).toMatchObject({ cartaoId: k, faturaCartaoId: fat.id });

      // compra depois do fechamento: a fatura seguinte
      expect(await f({ tipo: "cartao_corporativo", vencimento: "2027-07-20", cartaoId: k })).toEqual({ ok: true });
      [p] = await pagamentos();
      const fs = await faturas(k);
      expect(fs.map((y) => y.fechamento)).toEqual(["2027-07-15", "2027-08-15"]);
      expect(p.faturaCartaoId).toBe(fs[1].id);

      // de volta à vista: sem cartão nem fatura (a fatura fica, vazia)
      expect(await f({ tipo: "a_vista" })).toEqual({ ok: true });
      [p] = await pagamentos();
      expect(p).toMatchObject({ cartaoId: null, faturaCartaoId: null });
      expect(await faturas(k)).toHaveLength(2);

      // fatura paga: compra nova no ciclo recusada; trocar a forma recusada (ruling 12)
      await pagarFatura(fs[1].id);
      expect(await f({ tipo: "cartao_corporativo", vencimento: "2027-07-20", cartaoId: k })).toMatchObject({ ok: false, erro: MSG_FATURA_PAGA });
      expect(await f({ tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId: k })).toEqual({ ok: true });
      await pagarFatura(fs[0].id);
      expect(await f({ tipo: "a_vista" })).toMatchObject({ ok: false, erro: MSG_DESFACA_FATURA });
      [p] = await pagamentos();
      expect(p).toMatchObject({ cartaoId: k, faturaCartaoId: fs[0].id });
    });

    it("cartão desativado já usado na conta continua aceito nela; numa conta nova, recusado", async () => {
      const x = await vendida();
      const k = await novoCartao();
      const f = (contaId: string, forma: Parameters<typeof definirFormaFornecedor>[1]) => comSessao(x.fin.id, () => definirFormaFornecedor(contaId, forma));
      expect(await f(x.passeio.id, { tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId: k })).toEqual({ ok: true });
      await comSessao(c.fin, () => desativarCartao(k));
      expect(await f(x.passeio.id, { tipo: "cartao_corporativo", vencimento: "2027-07-20", cartaoId: k })).toEqual({ ok: true });
      const [p] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));
      expect(p).toMatchObject({ cartaoId: k, vencimento: "2027-07-20" });
      expect(await f(x.hotel.id, { tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId: k })).toMatchObject({ ok: false, campos: { cartaoId: expect.any(String) } });
    });

    it("conta em moeda estrangeira também vai para a fatura", async () => {
      const x = await vendida();
      c = { ...c, fin: x.fin.id };
      const [conta] = await db.insert(contasBancarias).values({ nome: "Bradesco", saldoInicialEm: "2026-01-01" }).returning();
      c.conta = conta.id;
      const k = await novoCartao();
      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(x.transfer.id, { tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId: k }))).toEqual({ ok: true });
      const [p] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.transfer.id));
      expect(p.cartaoId).toBe(k);
      expect(p.faturaCartaoId).not.toBeNull();
    });
  });

  describe("fatura do cartão na lista única e no caixa", () => {
    /** Dia `dia` do mês que vem daqui a `meses` meses (dentro do horizonte do fluxo). */
    function diaDoMes(meses: number, dia: number): string {
      const [a, m] = hojeEmCuiaba().split("-").map(Number);
      const t = new Date(Date.UTC(a, m - 1 + meses, dia));
      return t.toISOString().slice(0, 10);
    }
    const TUDO = { lado: "todos", de: "2000-01-01", ate: "2099-12-31", base: "vencimento", pagina: 1 } as const;
    const MES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

    it("Review Focus 1: totais da lista, saldo e fluxo iguais antes e depois de as compras irem para o cartão; a lista mostra só a fatura", async () => {
      const x = await vendida();
      const fin = x.fin.id;
      const r = await comSessao(fin, () => salvarContaBancaria({ nome: "Santander", banco: "033", saldoInicial: "10.000,00", saldoInicialEm: "2026-01-01" }));
      if (!r.ok || !r.id) throw new Error("conta");
      c = { ...c, fin, conta: r.id };
      const k = await novoCartao();
      const vencFatura = diaDoMes(2, 25);
      const compraA = diaDoMes(2, 5);
      const compraB = diaDoMes(2, 10);
      const compraViagem = diaDoMes(2, 12);
      const comp = vencFatura.slice(0, 7);

      // Saldo mexido por uma baixa qualquer (fora do cartão).
      const [outra] = await comprar(k, { forma: "PIX", valor: "100,00", vencimento: hojeEmCuiaba(), emissao: hojeEmCuiaba(), competencia: hojeEmCuiaba().slice(0, 7) });
      const b = await comSessao(fin, () => baixarLancamento(outra, { data: hojeEmCuiaba(), valorPago: "100,00", juros: "", desconto: "", contaBancariaId: c.conta, observacao: "" }));
      expect(b).toMatchObject({ ok: true });

      // Antes: as mesmas compras sem cartão, vencendo no dia da fatura.
      const [a1] = await comprar(k, { forma: "PIX", valor: "300,00", vencimento: vencFatura, emissao: compraA, competencia: comp });
      const [a2] = await comprar(k, { forma: "PIX", valor: "200,00", vencimento: vencFatura, emissao: compraA, competencia: comp });
      expect(await comSessao(fin, () => definirFormaFornecedor(x.passeio.id, { tipo: "a_vista", vencimento: vencFatura }))).toEqual({ ok: true });
      const [pAntes] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));

      const foto = async () => {
        const lista = await comSessao(fin, () => listarLancamentos(TUDO as Parameters<typeof listarLancamentos>[0]));
        const saldos = await comSessao(fin, () => saldosDasContas());
        const fluxo = await comSessao(fin, () => obterFluxoDeCaixa({}));
        const ficha = await comSessao(x.d.id, () => obterViagemVendida(x.viagemId));
        return { lista, totais: lista.totais, saldos, meses: fluxo.meses, semanas: fluxo.semanas, saldoAtual: fluxo.saldoAtual, real: ficha!.estrategico!.real };
      };
      const antes = await foto();

      // Depois: as compras no cartão, cada uma na sua data.
      expect(await comSessao(fin, () => editarLancamento(a1, compra(k, { valor: "300,00", vencimento: compraA, emissao: compraA, competencia: comp }), "esta"))).toMatchObject({ ok: true });
      expect(await comSessao(fin, () => editarLancamento(a2, compra(k, { valor: "200,00", vencimento: compraB, emissao: compraA, competencia: comp }), "esta"))).toMatchObject({ ok: true });
      expect(await comSessao(fin, () => definirFormaFornecedor(x.passeio.id, { tipo: "cartao_corporativo", vencimento: compraViagem, cartaoId: k }))).toEqual({ ok: true });
      const [pDepois] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));
      expect(pDepois.valorBrlPrevisto).toBe(pAntes.valorBrlPrevisto);
      const [fatura] = await faturas(k);
      expect(fatura.vencimento).toBe(vencFatura);
      const depois = await foto();

      // Não vazio: há o que pagar e o mês da fatura tem saídas de pelo menos o total.
      const total = 30000n + 20000n + pAntes.valorBrlPrevisto;
      expect(antes.totais.pagar.aVencer).toBeGreaterThanOrEqual(total);
      const mes = antes.meses.find((m) => m.inicio <= vencFatura && vencFatura <= m.fim)!;
      expect(mes.saidas).toBeGreaterThanOrEqual(total);
      expect(antes.saldoAtual).toBe(1000000n - 10000n);

      expect(depois.totais).toEqual(antes.totais);
      expect(depois.saldos).toEqual(antes.saldos);
      expect(depois.saldoAtual).toEqual(antes.saldoAtual);
      expect(depois.meses).toEqual(antes.meses);
      expect(depois.semanas).toEqual(antes.semanas);
      expect(antes.real).toHaveProperty("custo");
      expect(depois.real).toEqual(antes.real);

      // A lista: uma linha da fatura com o total, nenhuma compra solta; mesmo número de linhas menos as 3 compras + 1.
      const fs = depois.lista.linhas.filter((l) => l.origem === "fatura_cartao");
      expect(fs).toHaveLength(1);
      const mm = Number(fatura.fechamento.slice(5, 7));
      const aa = fatura.fechamento.slice(0, 4);
      expect(fs[0]).toMatchObject({
        id: fatura.id,
        lado: "pagar",
        vencimento: vencFatura,
        competencia: fatura.fechamento.slice(0, 7),
        valorPrevisto: total,
        statusBase: "em_aberto",
        centro: "MT",
        contaBancariaId: c.conta,
        pessoa: "Visa empresarial · final 1234",
        descricao: `Fatura do cartão · ${MES[mm - 1]}/${aa}`,
        transitaCaixa: true,
        exigeIndividual: false,
        categoria: { grupo: "Administrativo", nome: "Cartão corporativo" },
      });
      const ids = depois.lista.linhas.map((l) => l.id);
      expect(ids).not.toContain(a1);
      expect(ids).not.toContain(a2);
      expect(ids).not.toContain(pDepois.id);
      expect(depois.lista.totalLinhas).toBe(antes.lista.totalLinhas - 3 + 1);

      // Na view, as compras continuam, fora do caixa e apontando a fatura.
      const compras = await db.select().from(lf).where(eq(lf.faturaCartaoId, fatura.id));
      expect(compras.map((l) => l.origem).sort()).toEqual(["manual", "manual", "pagamento"]);
      expect(compras.every((l) => !l.transitaCaixa)).toBe(true);
      const [linhaFatura] = await db.select().from(lf).where(and(eq(lf.origem, "fatura_cartao"), eq(lf.id, fatura.id)));
      expect(linhaFatura).toMatchObject({ faturaCartaoId: null, valorCaixaPrevisto: total, valorCaixaBaixado: null, dataCaixa: vencFatura, forma: "cartao_credito" });
    });

    it("fatura com compra estrangeira exige baixa individual; compra cancelada sai do total; fatura sem compras some", async () => {
      const x = await vendida();
      c = { ...c, fin: x.fin.id };
      const k = await novoCartao();
      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(x.transfer.id, { tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId: k }))).toEqual({ ok: true });
      const [m] = await comprar(k, { vencimento: "2027-07-11", emissao: "2027-07-11", competencia: "2027-07" });
      const [f] = await faturas(k);
      const [pt] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.transfer.id));
      const linhaF = async () => (await db.select().from(lf).where(and(eq(lf.origem, "fatura_cartao"), eq(lf.id, f.id))))[0];
      expect(await linhaF()).toMatchObject({ exigeIndividual: true, valorPrevisto: pt.valorBrlPrevisto + 30000n, descricao: "Fatura do cartão · jul/2027", competencia: "2027-07" });

      expect(await comSessao(c.fin, () => cancelarLancamento(m, "Estorno", "esta"))).toMatchObject({ ok: true });
      expect((await linhaF()).valorPrevisto).toBe(pt.valorBrlPrevisto);

      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(x.transfer.id, { tipo: "a_vista" }))).toEqual({ ok: true });
      expect(await linhaF()).toBeUndefined();
      expect(await faturas(k)).toHaveLength(1);
    });

    it("fatura paga: o saldo cai uma vez só (valor pago da fatura); compras baixadas ficam fora do caixa", async () => {
      const k = await novoCartao();
      const [id] = await comprar(k);
      const [f] = await faturas(k);
      const saldo = async () => (await comSessao(c.fin, () => saldosDasContas())).find((s) => s.contaId === c.conta)!.saldoAtual;
      const antes = await saldo();
      await pagarFatura(f.id);
      await db.update(lancamentos).set({ status: "baixado", baixadoEm: "2027-01-25", valorPago: 30000n, baixaContaBancariaId: c.conta }).where(eq(lancamentos.id, id));
      expect(await saldo()).toBe(antes - 30000n);
      const [l] = await db.select().from(lf).where(and(eq(lf.origem, "fatura_cartao"), eq(lf.id, f.id)));
      expect(l).toMatchObject({ statusBase: "baixado", valorBaixado: 30000n, valorCaixaBaixado: 30000n, baixadoEm: "2027-01-25", contaBancariaId: c.conta });
    });
  });

  describe("baixa da fatura do cartão", () => {
    const HOJE = hojeEmCuiaba();
    const COMPRA_NO_CARTAO = "Compra no cartão corporativo: dê baixa na fatura do cartão";
    const CONCILIADA = "Viagem conciliada: desfaça a conciliação para alterar";
    const campo = (v: bigint) => formatarReais(v).replace("R$ ", "");

    /** Viagem vendida, conta com saldo de 10.000,00, cartão; compra manual de 300,00 e a conta da viagem no cartão, na fatura de jul/2027. */
    async function cenario(o: { estrangeira?: boolean } = {}) {
      const x = await vendida();
      const r = await comSessao(x.fin.id, () => salvarContaBancaria({ nome: "Santander", banco: "033", saldoInicial: "10.000,00", saldoInicialEm: "2026-01-01" }));
      if (!r.ok || !r.id) throw new Error("conta");
      c = { ...c, fin: x.fin.id, conta: r.id };
      const k = await novoCartao();
      const [manual] = await comprar(k, { vencimento: "2027-07-10", emissao: "2027-07-10", competencia: "2027-07" });
      const contaViagem = o.estrangeira ? x.transfer : x.passeio;
      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(contaViagem.id, { tipo: "cartao_corporativo", vencimento: "2027-07-12", cartaoId: k }))).toEqual({ ok: true });
      const [fatura] = await faturas(k);
      const [pag] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, contaViagem.id));
      expect(pag.faturaCartaoId).toBe(fatura.id);
      return { x, k, manual, fatura, pag, contaViagem };
    }
    const baixar = (faturaId: string, extra: Record<string, unknown> = {}) =>
      comSessao(c.fin, () => baixarLinha("fatura_cartao", faturaId, { data: HOJE, contaBancariaId: c.conta, ...extra }));
    const desfazer = (faturaId: string) => comSessao(c.fin, () => desfazerBaixaLinha("fatura_cartao", faturaId));
    const saldo = async () => (await comSessao(c.fin, () => saldosDasContas())).find((s) => s.contaId === c.conta)!.saldoAtual;
    const margem = async (x: Fixture) => (await comSessao(x.d.id, () => obterViagemVendida(x.viagemId)))!.estrategico!.real;
    const pagamento = async (id: string) => (await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, id)))[0];
    const contaPagar = async (id: string) => (await db.select().from(contasPagar).where(eq(contasPagar.id, id)))[0];
    const fatura = async (id: string) => (await db.select().from(faturasCartao).where(eq(faturasCartao.id, id)))[0];
    const naView = async (origem: Origem, id: string) => (await db.select().from(lf).where(and(eq(lf.origem, origem), eq(lf.id, id))))[0];

    it("baixa com compra manual e de viagem em reais: fatura paga pelo total, compras quitadas sem passar de novo pelo caixa; desfazer volta tudo", async () => {
      const { x, manual, fatura: f, pag, contaViagem } = await cenario();
      const total = 30000n + pag.valorBrlPrevisto;
      const saldoAntes = await saldo();
      const margemAntes = await margem(x);

      expect(await baixar(f.id)).toEqual({ ok: true });
      expect(await fatura(f.id)).toMatchObject({ status: "baixado", pagoEm: HOJE, valorPago: total, contaBancariaId: c.conta });
      expect(await lancamento(manual)).toMatchObject({ status: "baixado", baixadoEm: HOJE, valorPago: 30000n, baixaContaBancariaId: c.conta, faturaCartaoId: f.id });
      expect(await naView("manual", manual)).toMatchObject({ statusBase: "baixado", transitaCaixa: false });
      expect(await pagamento(pag.id)).toMatchObject({
        status: "pago",
        pagoEm: HOJE,
        valorOriginalPago: pag.valorOriginal,
        cambioEfetivo: null,
        valorBrlPago: pag.valorBrlPrevisto,
        contaBancariaId: null,
        faturaCartaoId: f.id,
      });
      expect((await contaPagar(contaViagem.id)).status).toBe("paga");
      expect(await naView("fatura_cartao", f.id)).toMatchObject({ statusBase: "baixado", valorBaixado: total, valorCaixaBaixado: total, baixadoEm: HOJE });
      // O banco vê uma saída só: a da fatura.
      expect(await saldo()).toBe(saldoAntes - total);
      const margemFatura = await margem(x);
      const aud = await db.select().from(auditoria).where(and(eq(auditoria.acao, "alterar"), inArray(auditoria.registroId, [f.id, manual, pag.id, contaViagem.id])));
      const status = (id: string) => aud.filter((a) => a.registroId === id).map((a) => (a.depois as { status?: string }).status);
      expect(status(f.id)).toEqual(["baixado"]);
      expect(status(manual)).toEqual(["baixado"]);
      expect(status(pag.id)).toEqual(["pago"]);
      expect(status(contaViagem.id)).toContain("paga");

      // Já paga: recusa a segunda baixa.
      expect(await baixar(f.id)).toMatchObject({ ok: false, erro: "Fatura do cartão já paga" });

      // Desfazer volta tudo.
      expect(await desfazer(f.id)).toEqual({ ok: true });
      expect(await fatura(f.id)).toMatchObject({ status: "em_aberto", pagoEm: null, valorPago: null, contaBancariaId: null });
      expect(await lancamento(manual)).toMatchObject({ status: "em_aberto", baixadoEm: null, valorPago: null, baixaContaBancariaId: null, faturaCartaoId: f.id });
      expect(await pagamento(pag.id)).toMatchObject({ status: "a_pagar", pagoEm: null, valorOriginalPago: null, valorBrlPago: null, faturaCartaoId: f.id });
      expect((await contaPagar(contaViagem.id)).status).toBe("a_pagar");
      expect(await saldo()).toBe(saldoAntes);
      expect(await margem(x)).toEqual(margemAntes);
      expect(await desfazer(f.id)).toMatchObject({ ok: false, erro: "Esta fatura do cartão não foi paga" });

      // Margem real = a de uma baixa direta pelo previsto (mesma data, mesmo valor).
      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(contaViagem.id, { tipo: "a_vista", vencimento: "2027-07-12" }))).toEqual({ ok: true });
      const [direto] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, contaViagem.id));
      expect(direto.valorBrlPrevisto).toBe(pag.valorBrlPrevisto);
      expect(await comSessao(x.fin.id, () => baixarPagamento(direto.id, { pagoEm: HOJE, valorOriginalPago: campo(direto.valorOriginal), contaBancariaId: c.conta }))).toEqual({ ok: true });
      expect(await margem(x)).toEqual(margemFatura);
    });

    it("compra em moeda estrangeira: sem o valor em reais recusa no campo; com ele, câmbio efetivo = reais ÷ original; lote recusa (baixa individual)", async () => {
      const { manual, fatura: f, pag } = await cenario({ estrangeira: true });
      expect(await naView("fatura_cartao", f.id)).toMatchObject({ exigeIndividual: true });

      const lote = await comSessao(c.fin, () => baixarEmLote({ itens: [{ origem: "fatura_cartao", id: f.id }], data: HOJE, contaBancariaId: c.conta }));
      expect(lote).toMatchObject({ ok: false, linhas: [{ origem: "fatura_cartao", id: f.id, motivo: expect.stringContaining("baixa individual") }] });

      const sem = await baixar(f.id);
      expect(sem).toMatchObject({ ok: false, campos: { [`estrangeiras.${pag.id}`]: "Informe o valor em reais cobrado no cartão" } });
      // Compra que não é desta fatura (ou não é estrangeira): recusada.
      expect(await baixar(f.id, { estrangeiras: [{ pagamentoId: pag.id, valorBrl: "6.543,21" }, { pagamentoId: crypto.randomUUID(), valorBrl: "1,00" }] })).toMatchObject({ ok: false });
      expect(await fatura(f.id)).toMatchObject({ status: "em_aberto" });
      expect(await lancamento(manual)).toMatchObject({ status: "em_aberto" });
      expect(await pagamento(pag.id)).toMatchObject({ status: "a_pagar" });

      expect(await baixar(f.id, { estrangeiras: [{ pagamentoId: pag.id, valorBrl: "6.543,21" }] })).toEqual({ ok: true });
      const cambio = arredondar(654321n * 10_000n, pag.valorOriginal);
      const p = await pagamento(pag.id);
      expect(p).toMatchObject({ status: "pago", valorBrlPago: 654321n, valorOriginalPago: pag.valorOriginal, contaBancariaId: null });
      expect(p.cambioEfetivo).toBe(`${cambio / 10_000n}.${String(cambio % 10_000n).padStart(4, "0")}`);
      expect((await fatura(f.id)).valorPago).toBe(30000n + 654321n);
    });

    it("viagem conciliada: recusa a baixa e o desfazer, nada gravado", async () => {
      const { x, manual, fatura: f, pag } = await cenario();
      await db.update(viagens).set({ conciliadaEm: new Date() }).where(eq(viagens.id, x.viagemId));
      const saldoAntes = await saldo();
      expect(await baixar(f.id)).toEqual({ ok: false, erro: CONCILIADA });
      expect(await fatura(f.id)).toMatchObject({ status: "em_aberto" });
      expect(await lancamento(manual)).toMatchObject({ status: "em_aberto" });
      expect(await pagamento(pag.id)).toMatchObject({ status: "a_pagar" });
      expect(await saldo()).toBe(saldoAntes);

      await db.update(viagens).set({ conciliadaEm: null }).where(eq(viagens.id, x.viagemId));
      expect(await baixar(f.id)).toEqual({ ok: true });
      await db.update(viagens).set({ conciliadaEm: new Date() }).where(eq(viagens.id, x.viagemId));
      expect(await desfazer(f.id)).toEqual({ ok: false, erro: CONCILIADA });
      expect(await fatura(f.id)).toMatchObject({ status: "baixado" });
      expect(await pagamento(pag.id)).toMatchObject({ status: "pago" });
    });

    it("duas viagens em duas faturas, baixadas ao mesmo tempo: travas em ordem crescente, as duas terminam sem impasse", async () => {
      const x = await vendida();
      const y = await vendida();
      c = { ...c, fin: x.fin.id };
      const k1 = await novoCartao();
      const k2 = await novoCartao({ nome: "Master", final: "5678" });
      const forma = (contaId: string, cartaoId: string) =>
        comSessao(x.fin.id, () => definirFormaFornecedor(contaId, { tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId }));
      for (const [conta, k] of [[x.passeio.id, k1], [y.passeio.id, k1], [x.hotel.id, k2], [y.hotel.id, k2]] as const) expect(await forma(conta, k)).toEqual({ ok: true });
      const [f1] = await faturas(k1);
      const [f2] = await faturas(k2);
      // Uma transação de fora segura a viagem de id maior (a mesma trava de `travarViagem`): as duas baixas param nas
      // travas; com ordem crescente nas duas, elas se enfileiram; com ordem diferente, o Postgres abortaria uma (40P01).
      const maior = [x.viagemId, y.viagemId].sort()[1];
      let soltar!: () => void;
      const segurando = new Promise<void>((r) => (soltar = r));
      let travou!: () => void;
      const travada = new Promise<void>((r) => (travou = r));
      const bloqueio = sql.begin(async (t) => {
        await t`select pg_advisory_xact_lock(hashtext(${chaveTrava(maior)}))`;
        await t`select id from viagens where id = ${maior} for update`;
        travou();
        await segurando;
      });
      await travada;
      const baixas = Promise.all([baixar(f1.id), baixar(f2.id)]);
      for (let i = 0; i < 100; i++) {
        const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`;
        if (n >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      soltar();
      await bloqueio;
      expect(await baixas).toEqual([{ ok: true }, { ok: true }]);
      expect((await fatura(f1.id)).status).toBe("baixado");
      expect((await fatura(f2.id)).status).toBe("baixado");
      const ps = await db.select().from(pagamentosFornecedor).where(inArray(pagamentosFornecedor.contaId, [x.passeio.id, y.passeio.id, x.hotel.id, y.hotel.id]));
      expect(ps.every((p) => p.status === "pago" && p.contaBancariaId === null)).toBe(true);
    });

    it("baixa direta de compra no cartão recusada pela viagem e pela lista (individual e lote); desfazer direto de compra paga na fatura também", async () => {
      const { x, manual, fatura: f, pag } = await cenario();
      const dadosPag = { pagoEm: HOJE, valorOriginalPago: campo(pag.valorOriginal), contaBancariaId: c.conta };
      expect(await comSessao(x.fin.id, () => baixarPagamento(pag.id, dadosPag))).toEqual({ ok: false, erro: COMPRA_NO_CARTAO });
      expect(await comSessao(c.fin, () => baixarLinha("pagamento", pag.id, dadosPag))).toEqual({ ok: false, erro: COMPRA_NO_CARTAO });
      const dadosManual = { data: HOJE, valorPago: "300,00", juros: "", desconto: "", contaBancariaId: c.conta, observacao: "" };
      expect(await comSessao(c.fin, () => baixarLancamento(manual, dadosManual))).toEqual({ ok: false, erro: COMPRA_NO_CARTAO });
      expect(await comSessao(c.fin, () => baixarLinha("manual", manual, dadosManual))).toEqual({ ok: false, erro: COMPRA_NO_CARTAO });
      const lote = await comSessao(c.fin, () =>
        baixarEmLote({ itens: [{ origem: "manual", id: manual }, { origem: "pagamento", id: pag.id }], data: HOJE, contaBancariaId: c.conta }),
      );
      expect(lote).toMatchObject({ ok: false, linhas: [{ id: manual, motivo: COMPRA_NO_CARTAO }, { id: pag.id, motivo: COMPRA_NO_CARTAO }] });
      expect(await pagamento(pag.id)).toMatchObject({ status: "a_pagar" });
      expect(await lancamento(manual)).toMatchObject({ status: "em_aberto" });

      expect(await baixar(f.id)).toEqual({ ok: true });
      expect(await comSessao(x.fin.id, () => desfazerBaixaPagamento(pag.id))).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await comSessao(c.fin, () => desfazerBaixaLinha("pagamento", pag.id))).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await comSessao(c.fin, () => desfazerBaixaLancamento(manual))).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await comSessao(c.fin, () => desfazerBaixaLinha("manual", manual))).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
      expect(await pagamento(pag.id)).toMatchObject({ status: "pago" });
      expect(await lancamento(manual)).toMatchObject({ status: "baixado" });
    });

    it("definirFormaFornecedor com a fatura paga pela baixa: 'Desfaça a baixa da fatura do cartão antes'", async () => {
      const { x, fatura: f, contaViagem } = await cenario();
      expect(await baixar(f.id)).toEqual({ ok: true });
      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(contaViagem.id, { tipo: "a_vista" }))).toEqual({ ok: false, erro: MSG_DESFACA_FATURA });
    });

    it("lote: fatura em reais entra junto com outra linha; as compras ficam quitadas", async () => {
      const { manual, fatura: f, pag } = await cenario();
      const [outra] = await comprar(f.cartaoId, { forma: "PIX", valor: "50,00", vencimento: HOJE, emissao: HOJE, competencia: HOJE.slice(0, 7) });
      const saldoAntes = await saldo();
      const lote = await comSessao(c.fin, () =>
        baixarEmLote({ itens: [{ origem: "manual", id: outra }, { origem: "fatura_cartao", id: f.id }], data: HOJE, contaBancariaId: c.conta }),
      );
      expect(lote).toEqual({ ok: true });
      expect(await fatura(f.id)).toMatchObject({ status: "baixado", valorPago: 30000n + pag.valorBrlPrevisto });
      expect(await lancamento(manual)).toMatchObject({ status: "baixado" });
      expect(await pagamento(pag.id)).toMatchObject({ status: "pago", contaBancariaId: null });
      expect(await saldo()).toBe(saldoAntes - 5000n - 30000n - pag.valorBrlPrevisto);
    });

    it("lote com duas faturas de cartões diferentes e um manual: tudo baixado; uma viagem conciliada recusa o lote inteiro e nada fica gravado", async () => {
      const x = await vendida();
      const y = await vendida();
      const r = await comSessao(x.fin.id, () => salvarContaBancaria({ nome: "Santander", banco: "033", saldoInicial: "10.000,00", saldoInicialEm: "2026-01-01" }));
      if (!r.ok || !r.id) throw new Error("conta");
      c = { ...c, fin: x.fin.id, conta: r.id };
      const k1 = await novoCartao();
      const k2 = await novoCartao({ nome: "Master", final: "5678" });
      const forma = (contaId: string, cartaoId: string) =>
        comSessao(x.fin.id, () => definirFormaFornecedor(contaId, { tipo: "cartao_corporativo", vencimento: "2027-07-10", cartaoId }));
      expect(await forma(x.passeio.id, k1)).toEqual({ ok: true });
      expect(await forma(y.passeio.id, k2)).toEqual({ ok: true });
      const [m1] = await comprar(k1, { vencimento: "2027-07-11", emissao: "2027-07-11", competencia: "2027-07" });
      const [f1] = await faturas(k1);
      const [f2] = await faturas(k2);
      const lote = (ids: string[]) =>
        comSessao(c.fin, () =>
          baixarEmLote({ itens: [{ origem: "manual", id: ids[0] }, { origem: "fatura_cartao", id: f1.id }, { origem: "fatura_cartao", id: f2.id }], data: HOJE, contaBancariaId: c.conta }),
        );

      // Viagem de uma das faturas conciliada: recusa inteira, o manual comum (gravado antes) também volta.
      const [comum] = await comprar(k1, { forma: "PIX", valor: "50,00", vencimento: HOJE, emissao: HOJE, competencia: HOJE.slice(0, 7) });
      await db.update(viagens).set({ conciliadaEm: new Date() }).where(eq(viagens.id, y.viagemId));
      const saldoAntes = await saldo();
      expect(await lote([comum])).toMatchObject({ ok: false, erro: CONCILIADA, linhas: [{ id: f1.id }, { id: f2.id }] });
      expect(await lancamento(comum)).toMatchObject({ status: "em_aberto" });
      expect(await lancamento(m1)).toMatchObject({ status: "em_aberto" });
      expect((await fatura(f1.id)).status).toBe("em_aberto");
      expect((await fatura(f2.id)).status).toBe("em_aberto");
      const pags = () => db.select().from(pagamentosFornecedor).where(inArray(pagamentosFornecedor.contaId, [x.passeio.id, y.passeio.id]));
      expect((await pags()).every((p) => p.status === "a_pagar")).toBe(true);
      expect(await saldo()).toBe(saldoAntes);

      await db.update(viagens).set({ conciliadaEm: null }).where(eq(viagens.id, y.viagemId));
      expect(await lote([comum])).toEqual({ ok: true });
      expect(await lancamento(comum)).toMatchObject({ status: "baixado" });
      expect(await lancamento(m1)).toMatchObject({ status: "baixado", baixaContaBancariaId: c.conta });
      expect((await fatura(f1.id)).status).toBe("baixado");
      expect((await fatura(f2.id)).status).toBe("baixado");
      const ps = await pags();
      expect(ps.every((p) => p.status === "pago" && p.contaBancariaId === null)).toBe(true);
      const total = 5000n + 30000n + ps.reduce((t, p) => t + p.valorBrlPrevisto, 0n);
      expect(await saldo()).toBe(saldoAntes - total);
    });

    it("fatura paga continua na lista mesmo sem compras ativas; pagamento de conta cancelada aparece em Canceladas", async () => {
      const { fatura: f, contaViagem, pag, manual } = await cenario();
      expect(await baixar(f.id)).toEqual({ ok: true });
      // Compras que deixam de contar depois da baixa (conta cancelada; o lançamento baixado não se cancela).
      await db.update(contasPagar).set({ status: "cancelada" }).where(eq(contasPagar.id, contaViagem.id));
      await db.update(lancamentos).set({ faturaCartaoId: null, cartaoId: null, status: "em_aberto", baixadoEm: null, valorPago: null, baixaContaBancariaId: null }).where(eq(lancamentos.id, manual));
      await db.update(pagamentosFornecedor).set({ status: "a_pagar", pagoEm: null, valorOriginalPago: null, valorBrlPago: null }).where(eq(pagamentosFornecedor.id, pag.id));
      expect(await naView("fatura_cartao", f.id)).toMatchObject({ statusBase: "baixado", valorPrevisto: 0n });
      const [cartao] = await comSessao(c.fin, () => listarCartoes());
      expect(cartao.faturas.map((y) => y.id)).toEqual([f.id]);
      const canceladas = await comSessao(c.fin, () =>
        listarLancamentos({ lado: "pagar", de: "2000-01-01", ate: "2099-12-31", base: "vencimento", situacao: "cancelada", pagina: 1 }),
      );
      expect(canceladas.linhas.map((l) => l.id)).toContain(pag.id);
      const abertas = await comSessao(c.fin, () => listarLancamentos({ lado: "pagar", de: "2000-01-01", ate: "2099-12-31", base: "vencimento", pagina: 1 }));
      expect(abertas.linhas.map((l) => l.id)).not.toContain(pag.id);
      expect(abertas.linhas.find((l) => l.id === f.id)).toMatchObject({ origem: "fatura_cartao", situacao: "baixada" });
    });

    it("complemento do previsto em conta no cartão: entra na fatura do ciclo de hoje; se ela já foi paga, recusa", async () => {
      const x = await vendida();
      const r = await comSessao(x.fin.id, () => salvarContaBancaria({ nome: "Santander", banco: "033", saldoInicial: "10.000,00", saldoInicialEm: "2026-01-01" }));
      if (!r.ok || !r.id) throw new Error("conta");
      c = { ...c, fin: x.fin.id, conta: r.id };
      const k = await novoCartao();
      // Compra no ciclo de hoje: a fatura de hoje paga; o complemento (vence hoje) seria compra em fatura paga.
      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(x.passeio.id, { tipo: "cartao_corporativo", vencimento: HOJE, cartaoId: k }))).toEqual({ ok: true });
      const [fHoje] = await faturas(k);
      expect(await baixar(fHoje.id)).toEqual({ ok: true });
      const conta = await contaPagar(x.passeio.id);
      const maior = campo(conta.previstoBrl + 10000n);
      expect(await comSessao(x.fin.id, () => atualizarPrevisto(x.passeio.id, maior, "Fornecedor cobrou mais"))).toEqual({ ok: false, erro: MSG_FATURA_PAGA });
      expect(await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id))).toHaveLength(1);

      // Compra num ciclo anterior (fatura paga): o complemento vai para a fatura do ciclo de hoje, no mesmo cartão.
      expect(await desfazer(fHoje.id)).toEqual({ ok: true });
      const antiga = (() => {
        const [a, m] = HOJE.split("-").map(Number);
        return new Date(Date.UTC(a, m - 3, 10)).toISOString().slice(0, 10);
      })();
      expect(await comSessao(x.fin.id, () => definirFormaFornecedor(x.passeio.id, { tipo: "cartao_corporativo", vencimento: antiga, cartaoId: k }))).toEqual({ ok: true });
      const [p0] = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id));
      expect(p0.faturaCartaoId).not.toBe(fHoje.id);
      expect(await baixar(p0.faturaCartaoId!)).toEqual({ ok: true });
      expect(await comSessao(x.fin.id, () => atualizarPrevisto(x.passeio.id, maior, "Fornecedor cobrou mais"))).toEqual({ ok: true });
      const linhas = await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, x.passeio.id)).orderBy(asc(pagamentosFornecedor.numero));
      expect(linhas).toHaveLength(2);
      expect(linhas[1]).toMatchObject({ status: "a_pagar", vencimento: HOJE, valorBrlPrevisto: 10000n, cartaoId: k, faturaCartaoId: fHoje.id });
    });
  });
});
