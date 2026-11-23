import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { centroDaFilial } from "@/domain/financeiro";
import { db, sql } from "@/server/db/client";
import { contasPagar, lancamentosFinanceiros, pagamentosFornecedor, viagens } from "@/server/db/schema";
import { CATEGORIAS_INICIAIS, PROXIMA_FATURA_INICIAL } from "@/server/db/seed-financeiro-inicial";
import { criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

// Ordenação em JS dos dois lados (não depende da collation do banco).
const ordenar = <T extends { lado: string; grupo: string; nome: string }>(xs: T[]) =>
  [...xs].sort((a, b) => (a.lado + "|" + a.grupo + "|" + a.nome < b.lado + "|" + b.grupo + "|" + b.nome ? -1 : 1));

const categoriasNoBanco = async () =>
  ordenar([
    ...(await sql<{ lado: string; grupo: string; nome: string; sistema: string | null; ativa: boolean }[]>`
      select lado::text, grupo, nome, sistema, ativa from categorias_financeiras`),
  ]);

describe("esquema do financeiro: dados iniciais", () => {
  beforeEach(async () => {
    await limparBanco();
  });

  it("depois de limparBanco: as 27 categorias do protótipo, as quatro do sistema marcadas", async () => {
    const cats = await categoriasNoBanco();
    expect(cats).toHaveLength(27);
    expect(cats.filter((c) => c.lado === "pagar")).toHaveLength(22);
    expect(cats.filter((c) => c.lado === "receber")).toHaveLength(5);
    expect(cats.every((c) => c.ativa)).toBe(true);
    expect(cats.filter((c) => c.sistema).map((c) => [c.lado, c.grupo, c.nome, c.sistema])).toEqual([
      ["pagar", "Viagens", "Fornecedores de viagem", "fornecedores_viagem"],
      ["receber", "Vendas", "Comissões de hotel", "comissoes_hotel"],
      ["receber", "Vendas", "Comissões de operadora", "comissoes_operadora"],
      ["receber", "Vendas", "Vendas de viagem", "vendas_viagem"],
    ]);
    expect(cats).toEqual(ordenar(CATEGORIAS_INICIAIS.map((c) => ({ ...c, ativa: true }))));
  });

  it("contador de faturas começa em 1405 e tem uma linha só", async () => {
    expect(PROXIMA_FATURA_INICIAL).toBe(1405);
    expect(await sql`select id, proximo from faturas_contador`).toEqual([{ id: 1, proximo: 1405 }]);
    await expect(sql`insert into faturas_contador (id, proximo) values (2, 1)`).rejects.toThrow(/faturas_contador/);
    await expect(sql`insert into faturas_contador (id, proximo) values (1, 1)`).rejects.toThrow(/faturas_contador_pkey/);
    await expect(sql`update faturas_contador set proximo = 0`).rejects.toThrow(/faturas_contador_proximo/);
  });

  it("os INSERTs da migração 0020 produzem exatamente os dados do módulo usado por limparBanco", async () => {
    // Executa as instruções INSERT do arquivo da migração (não o módulo) num banco sem os dados iniciais e compara
    // com o módulo: se alguém mudar um dos dois, este teste quebra.
    const migracao = readFileSync("drizzle/0020_financeiro.sql", "utf8");
    const inserts = migracao
      .split("--> statement-breakpoint")
      .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
      .filter((s) => /^INSERT INTO/i.test(s));
    expect(inserts.length).toBeGreaterThanOrEqual(2);
    await sql`truncate categorias_financeiras, faturas_contador cascade`;
    for (const s of inserts) await sql.unsafe(s);
    expect(await categoriasNoBanco()).toEqual(ordenar(CATEGORIAS_INICIAIS.map((c) => ({ ...c, ativa: true }))));
    expect(await sql`select id, proximo from faturas_contador`).toEqual([{ id: 1, proximo: PROXIMA_FATURA_INICIAL }]);
  });
});

describe("esquema do financeiro: restrições de lançamentos", () => {
  let base: Record<string, unknown>;
  let fornecedorId: string;
  let clienteId: string;
  let contaBancariaId: string;

  beforeEach(async () => {
    await limparBanco();
    const u = await criarUsuarioTeste("fin_operacional");
    const [cat] = await sql`select id from categorias_financeiras where nome = 'Aluguel'`;
    const [f] = await sql`insert into fornecedores (nome, tipos, modalidade) values ('F', '{Outro}', 'net') returning id`;
    const [c] = await sql`insert into clientes (grupo, tipo, filial, telefone) values ('G', 'familia', 'Rondonópolis', '66999999999') returning id`;
    const [cb] = await sql`insert into contas_bancarias (nome, saldo_inicial, saldo_inicial_em) values ('Banco', 0, '2026-11-01') returning id`;
    fornecedorId = f.id;
    clienteId = c.id;
    contaBancariaId = cb.id;
    base = {
      lado: "pagar",
      descricao: "Aluguel",
      categoria_id: cat.id,
      centro: "MT",
      competencia: "2026-11",
      emissao: "2026-11-01",
      vencimento: "2026-11-10",
      valor: 420000,
      forma: "boleto",
      criado_por: u.id,
    };
  });

  const inserir = (extra: Record<string, unknown>) => {
    const linha = { ...base, ...extra };
    return sql`insert into lancamentos ${sql(linha as Record<string, string>)}`;
  };

  it("aceita um lançamento simples", async () => {
    await inserir({ pessoa_texto: "Imobiliária" });
  });

  it("recusa fornecedor e cliente juntos", async () => {
    await expect(inserir({ fornecedor_id: fornecedorId, cliente_id: clienteId })).rejects.toThrow(/lancamentos_uma_pessoa/);
    await expect(inserir({ fornecedor_id: fornecedorId, pessoa_texto: "X" })).rejects.toThrow(/lancamentos_uma_pessoa/);
  });

  it("recusa competência inválida e valor não positivo", async () => {
    await expect(inserir({ competencia: "2026-13" })).rejects.toThrow(/lancamentos_competencia/);
    await expect(inserir({ competencia: "11/2026" })).rejects.toThrow(/lancamentos_competencia/);
    await expect(inserir({ valor: 0 })).rejects.toThrow(/lancamentos_valor/);
  });

  it("baixado exige data, valor pago e conta; em aberto não pode tê-los", async () => {
    await expect(inserir({ status: "baixado" })).rejects.toThrow(/lancamentos_baixa/);
    await expect(inserir({ status: "baixado", baixado_em: "2026-11-10", valor_pago: 420000 })).rejects.toThrow(/lancamentos_baixa/);
    await expect(inserir({ baixado_em: "2026-11-10" })).rejects.toThrow(/lancamentos_baixa/);
    await inserir({ status: "baixado", baixado_em: "2026-11-10", valor_pago: 420000, baixa_conta_bancaria_id: contaBancariaId });
  });

  it("achado 6: parcela número e total vêm juntos (par meio-nulo recusado)", async () => {
    await expect(inserir({ parcela_numero: 1 })).rejects.toThrow(/lancamentos_parcela/);
    await expect(inserir({ parcela_total: 3 })).rejects.toThrow(/lancamentos_parcela/);
    await expect(inserir({ parcela_numero: 0, parcela_total: 3 })).rejects.toThrow(/lancamentos_parcela/);
    await expect(inserir({ parcela_numero: 4, parcela_total: 3 })).rejects.toThrow(/lancamentos_parcela/);
    await inserir({ parcela_numero: 3, parcela_total: 3 });
    await inserir({});
  });

  it("forma é um dos nove slugs", async () => {
    await expect(inserir({ forma: "Boleto bancário" })).rejects.toThrow(/forma_financeiro/);
  });
});

type LinhaView = {
  origem: string;
  id: string;
  lado: string;
  vencimento: string;
  competencia: string;
  valor_previsto: string;
  valor_baixado: string | null;
  baixado_em: string | null;
  status_base: string;
  categoria_id: string;
  centro: string;
  conta_bancaria_id: string | null;
  pessoa: string;
  descricao: string;
  parcela_numero: number | null;
  parcela_total: number | null;
  viagem_id: string | null;
  viagem_codigo: string | null;
  fatura_numero: number | null;
  transita_caixa: boolean;
  taxa: string;
  forma: string;
  exige_individual: boolean;
  repasse: boolean;
};

describe("view lancamentos_financeiros", () => {
  let x: Fixture;
  let cat: Record<string, string>;

  const linhas = () => sql<LinhaView[]>`select * from lancamentos_financeiros order by origem, vencimento, id`;
  const daViagem = async (origem: string) => (await linhas()).filter((l) => l.origem === origem && l.viagem_id === x.viagemId);
  const pagamento = async (id: string) => (await linhas()).find((l) => l.origem === "pagamento" && l.id === id)!;

  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
    cat = Object.fromEntries(
      (await sql<{ sistema: string; id: string }[]>`select sistema, id from categorias_financeiras where sistema is not null`).map((c) => [c.sistema, c.id]),
    );
    const [aluguel] = await sql`select id from categorias_financeiras where nome = 'Aluguel'`;
    const [rend] = await sql`select id from categorias_financeiras where nome = 'Rendimentos'`;
    await sql`insert into lancamentos (lado, descricao, pessoa_texto, categoria_id, centro, competencia, emissao, vencimento, valor, forma, criado_por)
              values ('pagar', 'Aluguel do escritório', 'Imobiliária Centro', ${aluguel.id}, 'MT', '2026-11', '2026-11-01', '2026-11-10', 420000, 'boleto', ${x.fin.id}),
                     ('receber', 'Rendimento', null, ${rend.id}, 'RS', '2026-10', '2026-11-01', '2026-11-05', 1234, 'transferencia', ${x.fin.id})`;
  });

  it("uma linha por parcela, por pagamento, por comissão e por lançamento; nenhuma (origem, id) repetida", async () => {
    const todas = await linhas();
    const contas = await db.select().from(contasPagar).where(eq(contasPagar.viagemId, x.viagemId));
    const [{ n: pagamentos }] = await sql<{ n: number }[]>`
      select count(*)::int as n from pagamentos_fornecedor p join contas_pagar c on c.id = p.conta_id where c.viagem_id = ${x.viagemId}`;
    expect(pagamentos).toBe(contas.length);
    expect(todas.filter((l) => l.origem === "parcela")).toHaveLength(2);
    expect(todas.filter((l) => l.origem === "pagamento")).toHaveLength(pagamentos);
    expect(todas.filter((l) => l.origem === "comissao")).toHaveLength(1);
    expect(todas.filter((l) => l.origem === "manual")).toHaveLength(2);
    expect(new Set(todas.map((l) => `${l.origem}:${l.id}`)).size).toBe(todas.length);
  });

  it("parcela: receber, Vendas de viagem, centro da filial, pessoa da fatura, forma em slug", async () => {
    const [v] = await db.select().from(viagens).where(eq(viagens.id, x.viagemId));
    const ps = await daViagem("parcela");
    expect(ps.map((p) => p.id).sort()).toEqual(x.parcelas.map((p) => p.id).sort());
    const p1 = ps.find((p) => p.id === x.parcelas[0].id)!;
    expect(p1).toMatchObject({
      lado: "receber",
      categoria_id: cat.vendas_viagem,
      centro: centroDaFilial(v.filial),
      pessoa: "Marcos Souza",
      vencimento: x.parcelas[0].vencimento,
      competencia: x.parcelas[0].vencimento.slice(0, 7),
      valor_previsto: String(x.parcelas[0].valor),
      valor_baixado: null,
      status_base: "em_aberto",
      parcela_numero: 1,
      parcela_total: 2,
      forma: "boleto",
      transita_caixa: true,
      exige_individual: false,
      repasse: false,
      taxa: String(x.parcelas[0].taxaPrevista),
      fatura_numero: null,
    });
    expect(centroDaFilial(v.filial)).toBe("RS");
    expect(p1.viagem_codigo).toMatch(/^ECL-\d{4}-01$/);
  });

  it("parcela recebida: baixado com valor bruto e taxa efetiva; cancelada: cancelado", async () => {
    await sql`update parcelas_receber set status = 'recebida', recebida_em = '2026-11-21', valor_recebido = valor, taxa_efetiva = 350 where id = ${x.parcelas[0].id}`;
    await sql`update parcelas_receber set status = 'cancelada' where id = ${x.parcelas[1].id}`;
    const ps = await daViagem("parcela");
    expect(ps.find((p) => p.id === x.parcelas[0].id)).toMatchObject({
      status_base: "baixado",
      baixado_em: "2026-11-21",
      valor_baixado: String(x.parcelas[0].valor),
      taxa: "350",
    });
    expect(ps.find((p) => p.id === x.parcelas[1].id)!.status_base).toBe("cancelado");
  });

  it("fatura emitida: número em todas as linhas da viagem", async () => {
    const [venda] = await sql`select id from vendas where viagem_id = ${x.viagemId}`;
    await sql`insert into faturas (venda_id, numero, emitida_por) values (${venda.id}, 1405, ${x.fin.id})`;
    const daV = (await linhas()).filter((l) => l.viagem_id === x.viagemId);
    expect(daV.length).toBeGreaterThan(0);
    expect(daV.every((l) => l.fatura_numero === 1405)).toBe(true);
  });

  it("pagamento: pagar, Fornecedores de viagem, pessoa = fornecedor; EUR exige baixa individual", async () => {
    const hotel = await pagamento(x.pagHotel.id);
    expect(hotel).toMatchObject({
      lado: "pagar",
      categoria_id: cat.fornecedores_viagem,
      pessoa: "Palazzo Hotels",
      valor_previsto: String(x.pagHotel.valorBrlPrevisto),
      status_base: "em_aberto",
      exige_individual: false,
      transita_caixa: true,
      forma: "a_vista",
      parcela_numero: 1,
      parcela_total: 1,
      taxa: "0",
      centro: "RS",
    });
    const transfer = await pagamento(x.pagTransfer.id);
    expect(transfer).toMatchObject({ pessoa: "Euro Transfer", exige_individual: true, valor_previsto: String(x.pagTransfer.valorBrlPrevisto) });
  });

  it("aéreo sem fornecedor: pessoa = descrição da conta", async () => {
    expect(x.aereo.fornecedorId).toBeNull();
    expect((await pagamento(x.pagAereo.id)).pessoa).toBe(x.aereo.descricao);
  });

  it("pagamento pago: baixado com o valor em BRL pago", async () => {
    await db
      .update(pagamentosFornecedor)
      .set({ status: "pago", pagoEm: "2026-11-21", valorOriginalPago: 50000n, valorBrlPago: 50000n })
      .where(eq(pagamentosFornecedor.id, x.pagPasseio.id));
    expect(await pagamento(x.pagPasseio.id)).toMatchObject({ status_base: "baixado", valor_baixado: "50000", baixado_em: "2026-11-21" });
  });

  it("conta excluída ou cancelada: pagamento em aberto sai como cancelado", async () => {
    await sql`update contas_pagar set excluido_em = now() where id = ${x.passeio.id}`;
    await sql`update contas_pagar set status = 'cancelada' where id = ${x.hotel.id}`;
    expect((await pagamento(x.pagPasseio.id)).status_base).toBe("cancelado");
    expect((await pagamento(x.pagHotel.id)).status_base).toBe("cancelado");
    expect((await pagamento(x.pagTransfer.id)).status_base).toBe("em_aberto");
  });

  it("comissão: receber, Comissões de hotel, vencimento na data prevista, forma transferência", async () => {
    const [c] = await daViagem("comissao");
    expect(c).toMatchObject({
      id: x.comissao.id,
      lado: "receber",
      categoria_id: cat.comissoes_hotel,
      pessoa: "Palazzo Hotels",
      vencimento: x.comissao.previstaPara,
      competencia: x.comissao.previstaPara.slice(0, 7),
      valor_previsto: String(x.comissao.valorPrevisto),
      status_base: "em_aberto",
      forma: "transferencia",
      transita_caixa: true,
      exige_individual: false,
    });
  });

  it("comissão de operadora; não recebida e cancelada saem como cancelado; recebida, baixado", async () => {
    await sql`update fornecedores set tipos = '{Hotelaria,Operadora}' where id = ${x.hotel.fornecedorId}`;
    expect((await daViagem("comissao"))[0].categoria_id).toBe(cat.comissoes_operadora);
    await sql`update comissoes set status = 'nao_recebida' where id = ${x.comissao.id}`;
    expect((await daViagem("comissao"))[0].status_base).toBe("cancelado");
    await sql`update comissoes set status = 'cancelada' where id = ${x.comissao.id}`;
    expect((await daViagem("comissao"))[0].status_base).toBe("cancelado");
    await sql`update comissoes set status = 'recebida', recebida_em = '2026-11-21', valor_recebido = 12000 where id = ${x.comissao.id}`;
    expect((await daViagem("comissao"))[0]).toMatchObject({ status_base: "baixado", valor_baixado: "12000", baixado_em: "2026-11-21" });
  });

  it("a declaração Drizzle da view (.existing()) lê as mesmas colunas", async () => {
    const [p] = await db.select().from(lancamentosFinanceiros).where(eq(lancamentosFinanceiros.id, x.parcelas[0].id));
    expect(p).toMatchObject({
      origem: "parcela",
      lado: "receber",
      valorPrevisto: x.parcelas[0].valor,
      statusBase: "em_aberto",
      categoriaId: cat.vendas_viagem,
      centro: "RS",
      parcelaNumero: 1,
      parcelaTotal: 2,
      viagemId: x.viagemId,
      transitaCaixa: true,
      taxa: x.parcelas[0].taxaPrevista,
      forma: "boleto",
      exigeIndividual: false,
      repasse: false,
    });
    // Mesmo número de colunas que a view do banco (24): nenhuma coluna esquecida na declaração.
    const [cru] = await sql`select * from lancamentos_financeiros limit 1`;
    expect(Object.keys(p)).toHaveLength(Object.keys(cru).length);
    expect(Object.keys(cru)).toHaveLength(24);
  });

    it("manual: os campos do lançamento", async () => {
    const ms = (await linhas()).filter((l) => l.origem === "manual");
    expect(ms.find((m) => m.lado === "pagar")).toMatchObject({
      descricao: "Aluguel do escritório",
      pessoa: "Imobiliária Centro",
      centro: "MT",
      competencia: "2026-11",
      vencimento: "2026-11-10",
      valor_previsto: "420000",
      status_base: "em_aberto",
      forma: "boleto",
      viagem_id: null,
      viagem_codigo: null,
      fatura_numero: null,
      transita_caixa: true,
      taxa: "0",
      repasse: false,
      exige_individual: false,
    });
    expect(ms.find((m) => m.lado === "receber")).toMatchObject({ pessoa: "", competencia: "2026-10", forma: "transferencia" });
  });

  it("cartão direto no fornecedor: repasse pela diferença; contas do fornecedor do cartão fora do caixa", async () => {
    const [venda] = await sql`select id from vendas where viagem_id = ${x.viagemId}`;
    await sql`update parcelas_receber set meio = 'cartao_fornecedor' where venda_id = ${venda.id}`;
    // Sem fornecedor escolhido: pede escolher e exige baixa individual; nenhuma conta sai do caixa.
    let p1 = (await daViagem("parcela")).find((p) => p.id === x.parcelas[0].id)!;
    expect(p1).toMatchObject({
      repasse: true,
      exige_individual: true,
      descricao: "Repasse: escolha o fornecedor na viagem",
      valor_previsto: String(x.parcelas[0].valor),
      forma: "cartao_fornecedor",
    });
    expect((await daViagem("pagamento")).every((l) => l.transita_caixa)).toBe(true);

    await sql`update vendas set fornecedor_cartao_id = ${x.hotel.fornecedorId} where id = ${venda.id}`;
    // O hotel já pago (em BRL) entra pelo pago, não pelo previsto.
    await db
      .update(pagamentosFornecedor)
      .set({ status: "pago", pagoEm: "2026-11-21", valorOriginalPago: 100n, valorBrlPago: 100n })
      .where(eq(pagamentosFornecedor.id, x.pagHotel.id));
    p1 = (await daViagem("parcela")).find((p) => p.id === x.parcelas[0].id)!;
    expect(p1).toMatchObject({
      repasse: true,
      exige_individual: false,
      descricao: "Repasse de Palazzo Hotels",
      valor_previsto: String(x.parcelas[0].valor - 100n),
      transita_caixa: true,
    });
    const hotel = await pagamento(x.pagHotel.id);
    expect(hotel).toMatchObject({
      transita_caixa: false,
      exige_individual: false,
      descricao: `${x.hotel.descricao} (pago pelo cliente no cartão do fornecedor)`,
    });
    expect((await pagamento(x.pagPasseio.id)).transita_caixa).toBe(true);

    // Conta excluída do fornecedor do cartão não entra na soma.
    await sql`update contas_pagar set excluido_em = now() where id = ${x.hotel.id}`;
    p1 = (await daViagem("parcela")).find((p) => p.id === x.parcelas[0].id)!;
    expect(p1.valor_previsto).toBe(String(x.parcelas[0].valor));
  });
});
