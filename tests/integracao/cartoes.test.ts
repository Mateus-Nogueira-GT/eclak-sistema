import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { auditoria, cartoesCorporativos, categoriasFinanceiras, contasBancarias, faturasCartao, lancamentos, pagamentosFornecedor } from "@/server/db/schema";
import { criarCartao, desativarCartao, editarCartao } from "@/server/actions/cartoes";
import { alternarCategoria, cancelarLancamento, criarLancamento, editarLancamento, salvarCategoria } from "@/server/actions/financeiro";
import { definirFormaFornecedor } from "@/server/actions/financeiro-viagem";
import { listarCartoes, listarCartoesAtivos } from "@/server/queries/cartoes";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida } from "../helpers/venda";

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
});
