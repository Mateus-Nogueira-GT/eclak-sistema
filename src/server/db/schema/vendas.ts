import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import {
  COMISSAO_TIPOS,
  FORMAS_PAGAMENTO_FORNECEDOR,
  MEIOS_RECEBIMENTO,
  STATUS_COMISSAO,
  STATUS_CONTA,
  STATUS_PAGAMENTO,
  STATUS_PARCELA,
} from "@/domain/venda";
import { fornecedores } from "./fornecedores";
import { usuarios } from "./usuarios";
import { cotacoes, itensViagem, moedaEnum, versoesPrecificacao, viagens } from "./viagens";

export const meioRecebimentoEnum = pgEnum("meio_recebimento", MEIOS_RECEBIMENTO);
export const comissaoTipoEnum = pgEnum("comissao_tipo", COMISSAO_TIPOS);
export const formaPagamentoFornecedorEnum = pgEnum("forma_pagamento_fornecedor", FORMAS_PAGAMENTO_FORNECEDOR);
export const statusParcelaEnum = pgEnum("status_parcela", STATUS_PARCELA);
export const statusContaEnum = pgEnum("status_conta", STATUS_CONTA);
export const statusPagamentoEnum = pgEnum("status_pagamento", STATUS_PAGAMENTO);
export const statusComissaoEnum = pgEnum("status_comissao", STATUS_COMISSAO);

const centavos = (nome: string) => bigint(nome, { mode: "bigint" });

// RLS e índices (por viagem_id / conta_id) estão na migração custom 0015_venda.sql.
// O `ALTER TYPE status_orcamento ADD VALUE 'vendida'` está sozinho na 0013 (não pode ser usado na mesma transação).

export const vendas = pgTable(
  "vendas",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    versaoId: uuid("versao_id")
      .notNull()
      .references(() => versoesPrecificacao.id, { onDelete: "restrict" }),
    aceiteEm: date("aceite_em").notNull(),
    forma: jsonb("forma").notNull(),
    parcelas: integer("parcelas").notNull(),
    primeiroVencimento: date("primeiro_vencimento").notNull(),
    total: centavos("total").notNull(),
    faturaNome: text("fatura_nome").notNull(),
    /** CPF (11) ou CNPJ (14), só dígitos. */
    faturaDocumento: text("fatura_documento").notNull(),
    comprovante: text("comprovante"),
    observacao: text("observacao"),
    criadoPor: uuid("criado_por")
      .notNull()
      .references(() => usuarios.id),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("vendas_viagem_unico").on(t.viagemId),
    check("vendas_total_nao_negativo", sql`${t.total} >= 0`),
    check("vendas_parcelas_positivas", sql`${t.parcelas} >= 1`),
    check("vendas_fatura_documento", sql`${t.faturaDocumento} ~ '^(\\d{11}|\\d{14})$'`),
  ],
);

export const parcelasReceber = pgTable(
  "parcelas_receber",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    vendaId: uuid("venda_id")
      .notNull()
      .references(() => vendas.id, { onDelete: "restrict" }),
    numero: integer("numero").notNull(),
    totalParcelas: integer("total_parcelas").notNull(),
    vencimento: date("vencimento").notNull(),
    valor: centavos("valor").notNull(),
    meio: meioRecebimentoEnum("meio").notNull(),
    taxaPrevista: centavos("taxa_prevista").notNull().default(sql`0`),
    status: statusParcelaEnum("status").notNull().default("a_receber"),
    recebidaEm: date("recebida_em"),
    valorRecebido: centavos("valor_recebido"),
    taxaEfetiva: centavos("taxa_efetiva"),
    observacao: text("observacao"),
  },
  (t) => [
    check("parcelas_receber_valores", sql`${t.valor} >= 0 AND ${t.taxaPrevista} >= 0 AND (${t.valorRecebido} IS NULL OR ${t.valorRecebido} >= 0) AND (${t.taxaEfetiva} IS NULL OR ${t.taxaEfetiva} >= 0)`),
    unique("parcelas_receber_venda_numero_unico").on(t.vendaId, t.numero),
    // Fluxo de caixa: o que ainda vai entrar, por vencimento.
    index("parcelas_receber_a_receber_vencimento_idx").on(t.vencimento).where(sql`${t.status} = 'a_receber'`),
  ],
);

export const contasPagar = pgTable(
  "contas_pagar",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    itemId: uuid("item_id")
      .notNull()
      .references(() => itensViagem.id, { onDelete: "restrict" }),
    cotacaoId: uuid("cotacao_id")
      .notNull()
      .references(() => cotacoes.id, { onDelete: "restrict" }),
    fornecedorId: uuid("fornecedor_id").references(() => fornecedores.id, { onDelete: "restrict" }),
    descricao: text("descricao").notNull(),
    aereo: boolean("aereo").notNull().default(false),
    moeda: moedaEnum("moeda").notNull(),
    valorOriginal: centavos("valor_original").notNull(),
    cambioAplicado: numeric("cambio_aplicado", { precision: 10, scale: 4 }),
    /** Fixo: base da ponte da margem. */
    previstoVendaBrl: centavos("previsto_venda_brl").notNull(),
    /** Atual (atualizável pelo financeiro). */
    previstoBrl: centavos("previsto_brl").notNull(),
    comissaoPct: numeric("comissao_pct", { precision: 6, scale: 3 }).notNull().default(sql`0`),
    comissaoTipo: comissaoTipoEnum("comissao_tipo").notNull(),
    /** Tipo como vendido (fixo): base da ponte quando o tipo é trocado depois. */
    comissaoTipoVenda: comissaoTipoEnum("comissao_tipo_venda").notNull(),
    descontoAVistaPct: numeric("desconto_a_vista_pct", { precision: 6, scale: 3 }),
    forma: formaPagamentoFornecedorEnum("forma"),
    status: statusContaEnum("status").notNull().default("a_pagar"),
    contestacao: text("contestacao"),
    contestadaEm: timestamp("contestada_em", { withTimezone: true }),
    motivoPrevisto: text("motivo_previsto"),
    excluidoEm: timestamp("excluido_em", { withTimezone: true }),
  },
  (t) => [
    check("contas_pagar_valores", sql`${t.valorOriginal} >= 0 AND ${t.previstoVendaBrl} >= 0 AND ${t.previstoBrl} >= 0`),
    // Uma conta ativa por item da viagem.
    uniqueIndex("contas_pagar_viagem_item_ativa_unico").on(t.viagemId, t.itemId).where(sql`${t.excluidoEm} IS NULL`),
  ],
);

export const pagamentosFornecedor = pgTable(
  "pagamentos_fornecedor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contaId: uuid("conta_id")
      .notNull()
      .references(() => contasPagar.id, { onDelete: "restrict" }),
    numero: integer("numero").notNull(),
    vencimento: date("vencimento").notNull(),
    valorOriginal: centavos("valor_original").notNull(),
    valorBrlPrevisto: centavos("valor_brl_previsto").notNull(),
    status: statusPagamentoEnum("status").notNull().default("a_pagar"),
    pagoEm: date("pago_em"),
    valorOriginalPago: centavos("valor_original_pago"),
    cambioEfetivo: numeric("cambio_efetivo", { precision: 10, scale: 4 }),
    valorBrlPago: centavos("valor_brl_pago"),
  },
  (t) => [
    check("pagamentos_fornecedor_valores", sql`${t.valorOriginal} >= 0 AND ${t.valorBrlPrevisto} >= 0 AND (${t.valorOriginalPago} IS NULL OR ${t.valorOriginalPago} >= 0) AND (${t.valorBrlPago} IS NULL OR ${t.valorBrlPago} >= 0)`),
    unique("pagamentos_fornecedor_conta_numero_unico").on(t.contaId, t.numero),
    // Fluxo de caixa: o que ainda vai sair, por vencimento.
    index("pagamentos_fornecedor_a_pagar_vencimento_idx").on(t.vencimento).where(sql`${t.status} = 'a_pagar'`),
  ],
);

export const comissoes = pgTable(
  "comissoes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    contaId: uuid("conta_id")
      .notNull()
      .references(() => contasPagar.id, { onDelete: "restrict" }),
    fornecedorId: uuid("fornecedor_id").references(() => fornecedores.id, { onDelete: "restrict" }),
    baseBrl: centavos("base_brl").notNull(),
    pct: numeric("pct", { precision: 6, scale: 3 }).notNull(),
    valorPrevisto: centavos("valor_previsto").notNull(),
    previstaPara: date("prevista_para").notNull(),
    status: statusComissaoEnum("status").notNull().default("prevista"),
    recebidaEm: date("recebida_em"),
    valorRecebido: centavos("valor_recebido"),
    motivo: text("motivo"),
  },
  (t) => [
    check("comissoes_valores", sql`${t.baseBrl} >= 0 AND ${t.valorPrevisto} >= 0 AND (${t.valorRecebido} IS NULL OR ${t.valorRecebido} >= 0)`),
    // Uma comissão por conta (cancelada volta a prevista, nunca duplica).
    unique("comissoes_conta_unico").on(t.contaId),
    // Fluxo de caixa: comissões a receber, pela data prevista.
    index("comissoes_prevista_para_idx").on(t.previstaPara).where(sql`${t.status} = 'prevista'`),
  ],
);
