import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { CATEGORIAS_SISTEMA, type CategoriaSistema, type Origem } from "@/domain/financeiro";
import { cartoesCorporativos, faturasCartao } from "./cartoes";
import { clientes } from "./clientes";
import { centroCustoEnum, formaFinanceiroEnum, ladoFinanceiroEnum, statusLancamentoEnum } from "./financeiro-enums";
import { estoqueMovimentos } from "./estoque";
import { fornecedores } from "./fornecedores";
import { reembolsos } from "./reembolsos";
import { usuarios } from "./usuarios";
import { vendas } from "./vendas";

export { centroCustoEnum, formaFinanceiroEnum, ladoFinanceiroEnum, statusLancamentoEnum };

const centavos = (nome: string) => bigint(nome, { mode: "bigint" });

// RLS das seis tabelas e os dados iniciais (categorias e contador em 1405) estão na migração custom
// 0020_financeiro.sql; a view `lancamentos_financeiros` (a regra da lista única) na 0021_view_lancamentos.sql.

export const categoriasFinanceiras = pgTable(
  "categorias_financeiras",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lado: ladoFinanceiroEnum("lado").notNull(),
    grupo: text("grupo").notNull(),
    nome: text("nome").notNull(),
    ativa: boolean("ativa").notNull().default(true),
    /** Categoria fixa das linhas de viagem (pode ser renomeada, não desativada nem trocada de lado). */
    sistema: text("sistema").$type<CategoriaSistema>(),
  },
  (t) => [
    unique("categorias_financeiras_nome_unico").on(t.lado, t.grupo, t.nome),
    unique("categorias_financeiras_sistema_unico").on(t.sistema),
    check(
      "categorias_financeiras_sistema",
      sql`${t.sistema} IS NULL OR ${t.sistema} IN (${sql.raw(CATEGORIAS_SISTEMA.map((s) => `'${s}'`).join(", "))})`,
    ),
  ],
);

export const contasBancarias = pgTable(
  "contas_bancarias",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nome: text("nome").notNull(),
    banco: text("banco"),
    saldoInicial: centavos("saldo_inicial").notNull().default(sql`0`),
    saldoInicialEm: date("saldo_inicial_em").notNull(),
    ativa: boolean("ativa").notNull().default(true),
    excluidoEm: timestamp("excluido_em", { withTimezone: true }),
  },
  (t) => [uniqueIndex("contas_bancarias_nome_ativa_unico").on(t.nome).where(sql`${t.ativa} AND ${t.excluidoEm} IS NULL`)],
);

export const lancamentos = pgTable(
  "lancamentos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lado: ladoFinanceiroEnum("lado").notNull(),
    descricao: text("descricao").notNull(),
    fornecedorId: uuid("fornecedor_id").references(() => fornecedores.id, { onDelete: "restrict" }),
    clienteId: uuid("cliente_id").references(() => clientes.id, { onDelete: "restrict" }),
    pessoaTexto: text("pessoa_texto"),
    categoriaId: uuid("categoria_id")
      .notNull()
      .references(() => categoriasFinanceiras.id, { onDelete: "restrict" }),
    centro: centroCustoEnum("centro").notNull(),
    /** `AAAA-MM`. */
    competencia: text("competencia").notNull(),
    emissao: date("emissao").notNull(),
    vencimento: date("vencimento").notNull(),
    valor: centavos("valor").notNull(),
    forma: formaFinanceiroEnum("forma").notNull(),
    contaBancariaId: uuid("conta_bancaria_id").references(() => contasBancarias.id, { onDelete: "restrict" }),
    observacao: text("observacao"),
    /** Id comum às linhas de um parcelamento ou recorrência. */
    grupoId: uuid("grupo_id"),
    parcelaNumero: integer("parcela_numero"),
    parcelaTotal: integer("parcela_total"),
    status: statusLancamentoEnum("status").notNull().default("em_aberto"),
    baixadoEm: date("baixado_em"),
    valorPago: centavos("valor_pago"),
    juros: centavos("juros"),
    desconto: centavos("desconto"),
    baixaContaBancariaId: uuid("baixa_conta_bancaria_id").references(() => contasBancarias.id, { onDelete: "restrict" }),
    motivoCancelamento: text("motivo_cancelamento"),
    /** Compra no cartão corporativo (forma `cartao_credito`, lado pagar); fica registrado mesmo cancelada. */
    cartaoId: uuid("cartao_id").references((): AnyPgColumn => cartoesCorporativos.id, { onDelete: "restrict" }),
    /** Fatura do ciclo da compra (pelo vencimento = data da compra); nula se cancelada ou fora do cartão. */
    faturaCartaoId: uuid("fatura_cartao_id"),
    /** Entrada de estoque que originou a conta (fatia 5b): na lista única só se baixa, não se edita nem cancela. */
    estoqueMovimentoId: uuid("estoque_movimento_id").references((): AnyPgColumn => estoqueMovimentos.id, { onDelete: "restrict" }),
    /** Caso de reembolso que originou a conta (fatia 5b): na lista única só se baixa. */
    reembolsoId: uuid("reembolso_id").references((): AnyPgColumn => reembolsos.id, { onDelete: "restrict" }),
    criadoPor: uuid("criado_por")
      .notNull()
      .references(() => usuarios.id),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("lancamentos_uma_pessoa", sql`num_nonnulls(${t.fornecedorId}, ${t.clienteId}, ${t.pessoaTexto}) <= 1`),
    check("lancamentos_competencia", sql`${t.competencia} ~ '^\\d{4}-(0[1-9]|1[0-2])$'`),
    check("lancamentos_valor", sql`${t.valor} > 0`),
    check(
      "lancamentos_valores_baixa",
      sql`(${t.valorPago} IS NULL OR ${t.valorPago} >= 0) AND (${t.juros} IS NULL OR ${t.juros} >= 0) AND (${t.desconto} IS NULL OR ${t.desconto} >= 0)`,
    ),
    // Baixado ⇔ data, valor pago e conta da baixa preenchidos (e nenhum deles fora da baixa).
    check(
      "lancamentos_baixa",
      sql`(${t.status} = 'baixado' AND ${t.baixadoEm} IS NOT NULL AND ${t.valorPago} IS NOT NULL AND ${t.baixaContaBancariaId} IS NOT NULL)
        OR (${t.status} <> 'baixado' AND ${t.baixadoEm} IS NULL AND ${t.valorPago} IS NULL AND ${t.baixaContaBancariaId} IS NULL)`,
    ),
    check(
      "lancamentos_parcela",
      // num_nonnulls: o par meio-nulo (só número ou só total) é recusado (num CHECK, NULL passaria).
      sql`num_nonnulls(${t.parcelaNumero}, ${t.parcelaTotal}) IN (0, 2) AND (${t.parcelaNumero} IS NULL OR (${t.parcelaNumero} >= 1 AND ${t.parcelaTotal} >= ${t.parcelaNumero}))`,
    ),
    check("lancamentos_fatura_com_cartao", sql`${t.faturaCartaoId} IS NULL OR ${t.cartaoId} IS NOT NULL`),
    // A fatura é do mesmo cartão da compra (FK composta; sem fatura, nada a conferir).
    foreignKey({ name: "lancamentos_fatura_cartao_fk", columns: [t.faturaCartaoId, t.cartaoId], foreignColumns: [faturasCartao.id, faturasCartao.cartaoId] }).onDelete("restrict"),
    index("lancamentos_fatura_cartao_idx").on(t.faturaCartaoId),
    index("lancamentos_estoque_movimento_idx").on(t.estoqueMovimentoId),
    index("lancamentos_reembolso_idx").on(t.reembolsoId),
    index("lancamentos_em_aberto_vencimento_idx").on(t.vencimento).where(sql`${t.status} = 'em_aberto'`),
    index("lancamentos_grupo_idx").on(t.grupoId),
    index("lancamentos_categoria_idx").on(t.categoriaId),
  ],
);

/** Uma linha só (id = 1): o próximo número de fatura, lido com `for update` na transação que emite. */
export const faturasContador = pgTable(
  "faturas_contador",
  {
    id: smallint("id").primaryKey(),
    proximo: integer("proximo").notNull(),
  },
  (t) => [check("faturas_contador_uma_linha", sql`${t.id} = 1`), check("faturas_contador_proximo", sql`${t.proximo} >= 1`)],
);

export const faturas = pgTable(
  "faturas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    vendaId: uuid("venda_id")
      .notNull()
      .references(() => vendas.id, { onDelete: "restrict" }),
    numero: integer("numero").notNull(),
    emitidaEm: timestamp("emitida_em", { withTimezone: true }).notNull().defaultNow(),
    emitidaPor: uuid("emitida_por")
      .notNull()
      .references(() => usuarios.id),
  },
  (t) => [unique("faturas_venda_unico").on(t.vendaId), unique("faturas_numero_unico").on(t.numero)],
);

/** Retrato fixo de cada emissão (centavos como string). */
export type DadosFatura = {
  nome: string;
  documento: string;
  codigoViagem: string;
  destino: string;
  inicio: string;
  fim: string;
  total: string;
  forma: string;
  parcelas: { numero: number; total: number; vencimento: string; valor: string }[];
  /** Parcelas canceladas (fora de `parcelas`): soma em centavos e os números (n/N). Ausente nas versões antigas = nenhuma. */
  canceladas?: string;
  parcelasCanceladas?: { numero: number; total: number }[];
};

export const faturasVersoes = pgTable(
  "faturas_versoes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    faturaId: uuid("fatura_id")
      .notNull()
      .references(() => faturas.id, { onDelete: "restrict" }),
    versao: integer("versao").notNull(),
    emitidaEm: timestamp("emitida_em", { withTimezone: true }).notNull().defaultNow(),
    emitidaPor: uuid("emitida_por")
      .notNull()
      .references(() => usuarios.id),
    dados: jsonb("dados").$type<DadosFatura>().notNull(),
  },
  (t) => [unique("faturas_versoes_fatura_versao_unico").on(t.faturaId, t.versao)],
);

/**
 * Lista única (spec §6.1): lançamentos manuais, parcelas, pagamentos a fornecedor, comissões e faturas do cartão
 * corporativo, normalizados. Criada na migração custom 0021_view_lancamentos.sql; a versão vigente é a
 * 0051_view_vinculos.sql. `forma` vem em slug (o rótulo é mapeado em TS).
 */
export const lancamentosFinanceiros = pgView("lancamentos_financeiros", {
  origem: text("origem").$type<Origem>().notNull(),
  id: uuid("id").notNull(),
  lado: ladoFinanceiroEnum("lado").notNull(),
  vencimento: date("vencimento").notNull(),
  competencia: text("competencia").notNull(),
  valorPrevisto: centavos("valor_previsto").notNull(),
  valorBaixado: centavos("valor_baixado"),
  baixadoEm: date("baixado_em"),
  statusBase: statusLancamentoEnum("status_base").notNull(),
  categoriaId: uuid("categoria_id").notNull(),
  centro: centroCustoEnum("centro").notNull(),
  contaBancariaId: uuid("conta_bancaria_id"),
  pessoa: text("pessoa").notNull(),
  descricao: text("descricao").notNull(),
  parcelaNumero: integer("parcela_numero"),
  parcelaTotal: integer("parcela_total"),
  viagemId: uuid("viagem_id"),
  viagemCodigo: text("viagem_codigo"),
  faturaNumero: integer("fatura_numero"),
  transitaCaixa: boolean("transita_caixa").notNull(),
  taxa: centavos("taxa").notNull(),
  forma: text("forma").notNull(),
  exigeIndividual: boolean("exige_individual").notNull(),
  repasse: boolean("repasse").notNull(),
  /** Caixa (fatia 4b): o que entra/sai do banco. Crédito e boleto pelo líquido da taxa; repasse já é líquido. */
  valorCaixaPrevisto: centavos("valor_caixa_previsto").notNull(),
  /** Nulo se não baixado. */
  valorCaixaBaixado: centavos("valor_caixa_baixado"),
  /** Data em que entra/sai do caixa (crédito com antecipação: o primeiro vencimento em aberto do cartão da venda). */
  dataCaixa: date("data_caixa").notNull(),
  /**
   * Fatura do cartão corporativo da compra (manual ou pagamento de viagem; fora do caixa e escondida da lista, que
   * mostra a fatura). Nulo nas demais linhas e na própria linha da fatura (0033).
   */
  faturaCartaoId: uuid("fatura_cartao_id"),
  /** Vínculo da conta manual (0051): entrada de estoque ou caso de reembolso; nulos nas outras origens. */
  estoqueMovimentoId: uuid("estoque_movimento_id"),
  reembolsoId: uuid("reembolso_id"),
}).existing();
