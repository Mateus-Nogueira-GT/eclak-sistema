import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { MSG_CONCILIADA, MSG_NAO_VENDIDA } from "@/domain/venda-entrada";
import type { MargemReal } from "@/domain/venda";
import { cancelarCaixa, confirmarCaixa, salvarCaixa } from "@/server/actions/caixa-experiencia";
import { ajustarEstoque, desativarProduto, registrarEntrada, registrarSaida, salvarProduto } from "@/server/actions/estoque";
import { conciliar } from "@/server/actions/financeiro-viagem";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { auditoria, caixaItens, caixasExperiencia, estoqueMovimentos, estoqueSaldos, viagens } from "@/server/db/schema";
import { caixaDaViagem, caixasProximas, produtosParaCaixa } from "@/server/queries/caixa-experiencia";
import { margensVendidas } from "@/server/queries/vendas";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

// A viagem da fixture é da filial RS (cliente Souza): a caixa sai do estoque RS.

const HOJE = hojeEmCuiaba();
const MSG_CONFIRME_OU_CANCELE = "Confirme ou cancele a caixa de experiência antes";
const MSG_JA_CONFIRMADA = "A caixa já foi confirmada";
const MSG_SEM_ITENS = "Caixa sem itens não pode ser confirmada";

const id = (r: { ok: boolean; id?: string; erro?: string }) => {
  if (!r.ok || !r.id) throw new Error(r.ok ? "sem id" : r.erro);
  return r.id;
};
const ok = (r: { ok: boolean; erro?: string }) => {
  if (!r.ok) throw new Error(r.erro);
};

function dias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

async function produto(fin: string, nome: string, uso = "caixa_experiencia") {
  return id(await comSessao(fin, () => salvarProduto({ nome, uso, minimoMt: 0, minimoRs: 0 })));
}

async function entrada(fin: string, produtoId: string, quantidade: number, valorUnitario: string, filial = "RS") {
  return id(
    await comSessao(fin, () =>
      registrarEntrada({
        produtoId,
        filial,
        quantidade,
        valorUnitario,
        fornecedorId: "",
        fornecedorTexto: "Papelaria do Zé",
        vencimento: "2027-01-31",
        forma: "PIX",
        cartaoId: "",
      }),
    ),
  );
}

const saldo = async (produtoId: string, filial: "MT" | "RS" = "RS") =>
  (await db.select().from(estoqueSaldos).where(and(eq(estoqueSaldos.produtoId, produtoId), eq(estoqueSaldos.filial, filial))))[0];
const movimentosDaCaixa = (caixaId: string) =>
  db.select().from(estoqueMovimentos).where(eq(estoqueMovimentos.caixaId, caixaId)).orderBy(asc(estoqueMovimentos.produtoId));
const caixasDa = (viagemId: string) => db.select().from(caixasExperiencia).where(eq(caixasExperiencia.viagemId, viagemId)).orderBy(asc(caixasExperiencia.criadoEm));
const itensDa = (caixaId: string) => db.select().from(caixaItens).where(eq(caixaItens.caixaId, caixaId)).orderBy(asc(caixaItens.produtoId));
const auditoriaDe = (tabela: string, registroId: string) =>
  db.select().from(auditoria).where(and(eq(auditoria.tabela, tabela), eq(auditoria.registroId, registroId))).orderBy(asc(auditoria.id));

/** Tudo do estoque e das caixas, para conferir que uma recusa não gravou nada. */
const foto = async () => ({
  saldos: await db.select().from(estoqueSaldos).orderBy(asc(estoqueSaldos.produtoId), asc(estoqueSaldos.filial)),
  movimentos: await db.select().from(estoqueMovimentos).orderBy(asc(estoqueMovimentos.id)),
  caixas: await db.select().from(caixasExperiencia).orderBy(asc(caixasExperiencia.id)),
  itens: await db.select().from(caixaItens).orderBy(asc(caixaItens.id)),
  auditoria: (await db.select().from(auditoria)).length,
});

function realDe(m: MargemReal | { erro: string }): MargemReal {
  if ("erro" in m) throw new Error("margem sem cálculo no fixture");
  return m;
}
const finalDa = async (viagemId: string) => realDe((await margensVendidas([viagemId])).get(viagemId)!.real).final;

/** Dois produtos de caixa com estoque na RS: A (10 a 38,00) e B (5 a 12,50); `a` é o de menor id. */
async function doisProdutos(fin: string) {
  const p1 = await produto(fin, "Caderno de viagem");
  const p2 = await produto(fin, "Necessaire");
  await entrada(fin, p1, 10, "38,00");
  await entrada(fin, p2, 5, "12,50");
  return { p1, p2 };
}

describe("caixa de experiência", () => {
  let x: Fixture;
  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
  });

  it("só em viagem vendida e não conciliada", async () => {
    const { p1 } = await doisProdutos(x.fin.id);
    await db.update(viagens).set({ status: "aprovado" }).where(eq(viagens.id, x.viagemId));
    expect(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 1 }]))).toEqual({ ok: false, erro: MSG_NAO_VENDIDA });
    await db.update(viagens).set({ status: "vendida", conciliadaEm: new Date() }).where(eq(viagens.id, x.viagemId));
    expect(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 1 }]))).toEqual({ ok: false, erro: MSG_CONCILIADA });
    expect(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId))).toEqual({ ok: false, erro: MSG_CONCILIADA });
    expect(await comSessao(x.u.id, () => cancelarCaixa(x.viagemId, "Cliente desistiu"))).toEqual({ ok: false, erro: MSG_CONCILIADA });
    expect(await caixasDa(x.viagemId)).toEqual([]);
  });

  it("rascunho não mexe no estoque; salvar de novo substitui os itens; produto de papelaria é recusado", async () => {
    const { p1, p2 } = await doisProdutos(x.fin.id);
    const papel = await produto(x.fin.id, "Envelope", "papelaria");
    const antes = await foto();

    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }])));
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 3 }, { produtoId: p2, quantidade: 1 }])));
    const depois = await foto();
    expect(depois.saldos).toEqual(antes.saldos);
    expect(depois.movimentos).toEqual(antes.movimentos);

    const [caixa] = await caixasDa(x.viagemId);
    expect(caixa).toMatchObject({ situacao: "rascunho", filial: "RS", custoTotal: null, criadoPor: x.u.id });
    expect((await itensDa(caixa.id)).map((i) => ({ produtoId: i.produtoId, quantidade: i.quantidade, custoUnitario: i.custoUnitario }))).toEqual(
      [
        { produtoId: p1, quantidade: 3, custoUnitario: null },
        { produtoId: p2, quantidade: 1, custoUnitario: null },
      ].sort((a, b) => a.produtoId.localeCompare(b.produtoId)),
    );
    expect((await auditoriaDe("caixas_experiencia", caixa.id)).map((a) => a.acao)).toEqual(["criar", "alterar"]);

    const r = await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: papel, quantidade: 1 }]));
    expect(r.ok).toBe(false);
    expect((await itensDa(caixa.id)).length).toBe(2);
    // Rascunho vazio pode existir.
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [])));
    expect(await itensDa(caixa.id)).toEqual([]);
  });

  it("confirmar grava os movimentos `caixa` ao custo médio, o custo de cada item, o total e a auditoria; a margem real cai o total e volta ao cancelar", async () => {
    const { p1, p2 } = await doisProdutos(x.fin.id);
    const finalAntes = await finalDa(x.viagemId);
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }, { produtoId: p2, quantidade: 1 }])));
    // O rascunho não entra na margem.
    expect(await finalDa(x.viagemId)).toBe(finalAntes);

    ok(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId)));
    const [caixa] = await caixasDa(x.viagemId);
    const total = 2n * 3800n + 1250n;
    expect(caixa).toMatchObject({ situacao: "confirmada", custoTotal: total, confirmadaPor: x.u.id });
    expect(caixa.confirmadaEm).toBeInstanceOf(Date);
    const custo = { [p1]: 3800n, [p2]: 1250n };
    const qtd = { [p1]: 2, [p2]: 1 };
    expect((await itensDa(caixa.id)).map((i) => [i.produtoId, i.custoUnitario])).toEqual(
      [p1, p2].sort().map((p) => [p, custo[p]]),
    );
    const movs = await movimentosDaCaixa(caixa.id);
    expect(movs.map((m) => ({ produtoId: m.produtoId, filial: m.filial, tipo: m.tipo, quantidade: m.quantidade, custoUnitario: m.custoUnitario, custoMedioAntes: m.custoMedioAntes, usuarioId: m.usuarioId }))).toEqual(
      [p1, p2].sort().map((p) => ({ produtoId: p, filial: "RS", tipo: "caixa", quantidade: -qtd[p], custoUnitario: custo[p], custoMedioAntes: custo[p], usuarioId: x.u.id })),
    );
    expect(await saldo(p1)).toMatchObject({ quantidade: 8, custoMedio: 3800n });
    expect(await saldo(p2)).toMatchObject({ quantidade: 4, custoMedio: 1250n });
    const aud = await auditoriaDe("caixas_experiencia", caixa.id);
    expect(aud.at(-1)).toMatchObject({ acao: "alterar", usuarioId: x.u.id, depois: { situacao: "confirmada", custoTotal: total.toString() } });
    for (const m of movs) expect((await auditoriaDe("estoque_movimentos", m.id)).length).toBe(1);

    // Margem real: cai exatamente o custo total.
    expect(await finalDa(x.viagemId)).toBe(finalAntes - total);
    // Editar a confirmada é recusado; confirmar de novo também.
    expect((await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 1 }]))).ok).toBe(false);
    expect(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId))).toEqual({ ok: false, erro: MSG_JA_CONFIRMADA });

    ok(await comSessao(x.u.id, () => cancelarCaixa(x.viagemId, "Cliente pediu outros itens")));
    expect(await finalDa(x.viagemId)).toBe(finalAntes);
  });

  it("item acima do saldo: a mensagem do spec e nada gravado", async () => {
    const { p1, p2 } = await doisProdutos(x.fin.id);
    // O de maior id fica sem saldo na RS (a entrada é na MT): o de menor id já foi travado e conferido quando ele falha.
    const [menor, maior] = [p1, p2].sort();
    const sem = await produto(x.fin.id, "Garrafa térmica");
    await entrada(x.fin.id, sem, 3, "50,00", "MT");
    const itens = [{ produtoId: menor, quantidade: 1 }, { produtoId: maior, quantidade: 1 }, { produtoId: sem, quantidade: 2 }];
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, itens)));
    const antes = await foto();
    expect(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId))).toEqual({ ok: false, erro: "Estoque insuficiente de Garrafa térmica em RS: há 0" });
    expect(await foto()).toEqual(antes);

    // Acima de um saldo que existe.
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p2, quantidade: 6 }])));
    const antes2 = await foto();
    expect(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId))).toEqual({ ok: false, erro: "Estoque insuficiente de Necessaire em RS: há 5" });
    expect(await foto()).toEqual(antes2);
  });

  it("produto que deixou de ser de caixa de experiência depois do rascunho: confirmar é recusado e nada gravado", async () => {
    const { p1, p2 } = await doisProdutos(x.fin.id);
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 1 }, { produtoId: p2, quantidade: 1 }])));
    ok(await comSessao(x.fin.id, () => salvarProduto({ nome: "Necessaire", uso: "papelaria", minimoMt: 0, minimoRs: 0 }, p2)));
    const antes = await foto();
    expect(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId))).toEqual({ ok: false, erro: "Produto não é mais de caixa de experiência: Necessaire" });
    expect(await foto()).toEqual(antes);
  });

  it("caixa vazia não confirma; sem caixa, confirmar e cancelar são recusados", async () => {
    expect((await comSessao(x.u.id, () => confirmarCaixa(x.viagemId))).ok).toBe(false);
    expect((await comSessao(x.u.id, () => cancelarCaixa(x.viagemId, "Engano"))).ok).toBe(false);
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [])));
    expect(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId))).toEqual({ ok: false, erro: MSG_SEM_ITENS });
    expect((await caixasDa(x.viagemId))[0].situacao).toBe("rascunho");
  });

  it("cancelar a confirmada devolve ao custo gravado (`devolucao_caixa`) e recalcula o custo médio; depois outra caixa pode ser montada", async () => {
    const { p1 } = await doisProdutos(x.fin.id);
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }])));
    ok(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId)));
    // Nova compra mais cara: 8 a 38,00 + 2 a 44,00 → custo médio 39,20.
    await entrada(x.fin.id, p1, 2, "44,00");
    expect(await saldo(p1)).toMatchObject({ quantidade: 10, custoMedio: 3920n });

    expect((await comSessao(x.u.id, () => cancelarCaixa(x.viagemId, ""))).ok).toBe(false);
    ok(await comSessao(x.u.id, () => cancelarCaixa(x.viagemId, "Cliente pediu outros itens")));
    // (10 × 39,20 + 2 × 38,00) ÷ 12 = 39,00
    expect(await saldo(p1)).toMatchObject({ quantidade: 12, custoMedio: 3900n });
    const [caixa] = await caixasDa(x.viagemId);
    expect(caixa).toMatchObject({ situacao: "cancelada", canceladaPor: x.u.id, motivoCancelamento: "Cliente pediu outros itens", custoTotal: 7600n });
    expect(caixa.canceladaEm).toBeInstanceOf(Date);
    const movs = await movimentosDaCaixa(caixa.id);
    expect(movs.map((m) => [m.tipo, m.quantidade, m.custoUnitario, m.custoMedioAntes]).sort()).toEqual(
      [
        ["caixa", -2, 3800n, 3800n],
        ["devolucao_caixa", 2, 3800n, 3920n],
      ].sort(),
    );
    expect((await auditoriaDe("caixas_experiencia", caixa.id)).at(-1)).toMatchObject({ acao: "alterar", depois: { situacao: "cancelada" } });

    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 1 }])));
    // Sem depender da ordem de `criado_em` (o relógio do banco pode voltar entre as duas): a cancelada pelo id já lido.
    const caixas = await caixasDa(x.viagemId);
    expect(caixas.map((c) => c.situacao).sort()).toEqual(["cancelada", "rascunho"]);
    expect(caixas.find((c) => c.id === caixa.id)?.situacao).toBe("cancelada");
    ok(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId)));
    expect(await saldo(p1)).toMatchObject({ quantidade: 11, custoMedio: 3900n });
  });

  it("cancelar o rascunho apaga a caixa e os itens (com auditoria) e libera outra caixa", async () => {
    const { p1 } = await doisProdutos(x.fin.id);
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }])));
    const [caixa] = await caixasDa(x.viagemId);
    const [item] = await itensDa(caixa.id);
    const antes = await foto();
    ok(await comSessao(x.u.id, () => cancelarCaixa(x.viagemId, "Montada por engano")));
    expect(await caixasDa(x.viagemId)).toEqual([]);
    expect(await itensDa(caixa.id)).toEqual([]);
    const depois = await foto();
    expect(depois.saldos).toEqual(antes.saldos);
    expect(depois.movimentos).toEqual(antes.movimentos);
    expect((await auditoriaDe("caixas_experiencia", caixa.id)).at(-1)).toMatchObject({ acao: "excluir", antes: { situacao: "rascunho" } });
    expect((await auditoriaDe("caixa_itens", item.id)).at(-1)).toMatchObject({ acao: "excluir" });
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 1 }])));
  });

  it("conciliar com a caixa em rascunho é recusado", async () => {
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [])));
    expect(await comSessao(x.fin.id, () => conciliar(x.viagemId))).toEqual({ ok: false, erro: MSG_CONFIRME_OU_CANCELE });
  });

  it("Review Focus 1: duas confirmações simultâneas da mesma caixa dão uma só baixa", async () => {
    const { p1, p2 } = await doisProdutos(x.fin.id);
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }, { produtoId: p2, quantidade: 1 }])));
    const rs = await comSessao(x.u.id, () => Promise.all([confirmarCaixa(x.viagemId), confirmarCaixa(x.viagemId)]));
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, erro: MSG_JA_CONFIRMADA });
    const [caixa] = await caixasDa(x.viagemId);
    expect((await movimentosDaCaixa(caixa.id)).length).toBe(2);
    expect((await saldo(p1)).quantidade).toBe(8);
    expect((await saldo(p2)).quantidade).toBe(4);
  });

  it("Review Focus 1: duas viagens da mesma filial disputando o último item: uma recusa, saldo 0", async () => {
    const y = await vendida();
    const p = await produto(x.fin.id, "Kit de chá");
    await entrada(x.fin.id, p, 1, "20,00");
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p, quantidade: 1 }])));
    ok(await comSessao(x.u.id, () => salvarCaixa(y.viagemId, [{ produtoId: p, quantidade: 1 }])));
    const rs = await comSessao(x.u.id, () => Promise.all([confirmarCaixa(x.viagemId), confirmarCaixa(y.viagemId)]));
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, erro: "Estoque insuficiente de Kit de chá em RS: há 0" });
    expect(await saldo(p)).toMatchObject({ quantidade: 0, custoMedio: 0n });
    const caixas = [...(await caixasDa(x.viagemId)), ...(await caixasDa(y.viagemId))];
    expect(caixas.map((c) => c.situacao).sort()).toEqual(["confirmada", "rascunho"]);
  });

  it("Review Focus 4: consultor e operacional veem a caixa sem valores e montam, confirmam e cancelam; o Diretor vê os valores", async () => {
    const { p1, p2 } = await doisProdutos(x.fin.id);
    const op = await criarUsuarioTeste("operacional");
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }])));

    for (const quem of [x.u.id, op.id]) {
      const c = (await comSessao(quem, () => caixaDaViagem(x.viagemId)))!;
      expect(c).not.toHaveProperty("total");
      expect(c.situacao).toBe("rascunho");
      expect(c.filial).toBe("RS");
      expect(c.itens).toEqual([{ produtoId: p1, nome: "Caderno de viagem", quantidade: 2, disponivel: 10 }]);
      for (const i of c.itens) expect(Object.keys(i)).not.toContain("custoUnitario");
      const ps = await comSessao(quem, () => produtosParaCaixa("RS"));
      expect(ps.map((p) => p.nome)).toEqual(["Caderno de viagem", "Necessaire"]);
      for (const p of ps) expect(Object.keys(p)).not.toContain("custoMedio");
      await expect(comSessao(quem, () => caixasProximas())).rejects.toBeInstanceOf(ErroAcesso);
    }

    // Diretor: o rascunho com o total estimado pelo custo médio atual.
    const est = (await comSessao(x.d.id, () => caixaDaViagem(x.viagemId)))!;
    expect(est.itens).toEqual([{ produtoId: p1, nome: "Caderno de viagem", quantidade: 2, disponivel: 10, custoUnitario: 3800n }]);
    expect(est.total).toBe(7600n);
    expect(await comSessao(x.d.id, () => produtosParaCaixa("RS"))).toEqual(
      [
        { id: p1, nome: "Caderno de viagem", disponivel: 10, custoMedio: 3800n },
        { id: p2, nome: "Necessaire", disponivel: 5, custoMedio: 1250n },
      ],
    );

    ok(await comSessao(op.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }, { produtoId: p2, quantidade: 1 }])));
    ok(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId)));
    const conf = (await comSessao(x.u.id, () => caixaDaViagem(x.viagemId)))!;
    expect(conf.situacao).toBe("confirmada");
    expect(conf).not.toHaveProperty("total");
    expect(conf.confirmadaPor).toBe("Teste consultor");
    expect(conf.confirmadaEm).toBeInstanceOf(Date);
    for (const i of conf.itens) expect(Object.keys(i)).not.toContain("custoUnitario");
    const confD = (await comSessao(x.d.id, () => caixaDaViagem(x.viagemId)))!;
    expect(confD.total).toBe(8850n);

    ok(await comSessao(op.id, () => cancelarCaixa(x.viagemId, "Cliente pediu outros itens")));
    expect(await comSessao(x.u.id, () => caixaDaViagem(x.viagemId))).toBeNull();
  });

  it("caixasProximas: vendidas com embarque nos próximos 60 dias, com a situação da caixa", async () => {
    const y = await vendida();
    await db.update(viagens).set({ inicio: dias(HOJE, 10), fim: dias(HOJE, 20) }).where(eq(viagens.id, x.viagemId));
    await db.update(viagens).set({ inicio: dias(HOJE, 90), fim: dias(HOJE, 100) }).where(eq(viagens.id, y.viagemId));
    const lista = await comSessao(x.fin.id, () => caixasProximas());
    expect(lista).toEqual([{ viagemId: x.viagemId, codigo: expect.any(String), cliente: expect.any(String), embarque: dias(HOJE, 10), filial: "RS", situacao: "sem_caixa" }]);

    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [])));
    expect((await comSessao(x.d.id, () => caixasProximas()))[0].situacao).toBe("rascunho");

    // Conciliada sai da lista.
    await db.update(viagens).set({ conciliadaEm: new Date() }).where(eq(viagens.id, x.viagemId));
    expect(await comSessao(x.fin.id, () => caixasProximas())).toEqual([]);
  });

  it("caixasProximas: viagem excluída sai da lista", async () => {
    await db.update(viagens).set({ inicio: dias(HOJE, 10), fim: dias(HOJE, 20) }).where(eq(viagens.id, x.viagemId));
    expect((await comSessao(x.fin.id, () => caixasProximas())).map((c) => c.viagemId)).toEqual([x.viagemId]);
    await db.update(viagens).set({ excluidoEm: new Date() }).where(eq(viagens.id, x.viagemId));
    expect(await comSessao(x.fin.id, () => caixasProximas())).toEqual([]);
  });

  it("I1: produto desativado com saldo devolvido pela caixa cancelada aceita saída e ajuste; entrada e caixa continuam recusadas", async () => {
    const p1 = await produto(x.fin.id, "Caderno de viagem");
    await entrada(x.fin.id, p1, 2, "38,00");
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 2 }])));
    ok(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId)));
    expect(await saldo(p1)).toMatchObject({ quantidade: 0 });
    ok(await comSessao(x.fin.id, () => desativarProduto(p1)));
    ok(await comSessao(x.u.id, () => cancelarCaixa(x.viagemId, "Cliente desistiu da caixa")));
    expect(await saldo(p1)).toMatchObject({ quantidade: 2, custoMedio: 3800n });

    // Saída e ajuste esvaziam o produto desativado.
    ok(await comSessao(x.fin.id, () => registrarSaida({ produtoId: p1, filial: "RS", quantidade: 1, motivo: "Brinde avulso" })));
    expect(await saldo(p1)).toMatchObject({ quantidade: 1, custoMedio: 3800n });
    ok(await comSessao(x.fin.id, () => ajustarEstoque({ produtoId: p1, filial: "RS", quantidadeNova: 0, motivo: "Contagem do mês" })));
    expect(await saldo(p1)).toMatchObject({ quantidade: 0, custoMedio: 0n });

    // Entrada e caixa só com produto ativo.
    const antes = await foto();
    expect(
      await comSessao(x.fin.id, () =>
        registrarEntrada({ produtoId: p1, filial: "RS", quantidade: 1, valorUnitario: "38,00", fornecedorId: "", fornecedorTexto: "Loja", vencimento: "2027-01-31", forma: "PIX", cartaoId: "" }),
      ),
    ).toEqual({ ok: false, erro: "Produto desativado" });
    expect((await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p1, quantidade: 1 }]))).ok).toBe(false);
    expect(await foto()).toEqual(antes);
  });
});
