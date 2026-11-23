import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, boolean, char, check, date, pgTable, smallint, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { contasBancarias } from "./financeiro";
import { centroCustoEnum, statusLancamentoEnum } from "./financeiro-enums";

// Cartão corporativo (fatia 4b): o cadastro e a fatura mensal de cada cartão. Compras (lançamentos manuais a pagar
// no cartão de crédito e pagamentos de viagem na forma "cartão corporativo") apontam para a fatura do ciclo
// (`lancamentos.fatura_cartao_id`, `pagamentos_fornecedor.fatura_cartao_id`). A fatura nasce na primeira compra do
// ciclo e nunca é apagada (sem compras, não aparece). RLS na migração custom.

export const cartoesCorporativos = pgTable(
  "cartoes_corporativos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nome: text("nome").notNull(),
    /** Os 4 últimos dígitos. */
    final: char("final", { length: 4 }).notNull(),
    diaFechamento: smallint("dia_fechamento").notNull(),
    diaVencimento: smallint("dia_vencimento").notNull(),
    /** Conta de onde a fatura é debitada. */
    contaBancariaId: uuid("conta_bancaria_id")
      .notNull()
      .references((): AnyPgColumn => contasBancarias.id, { onDelete: "restrict" }),
    centro: centroCustoEnum("centro").notNull(),
    ativo: boolean("ativo").notNull().default(true),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("cartoes_corporativos_final", sql`${t.final} ~ '^[0-9]{4}$'`),
    check("cartoes_corporativos_dias", sql`${t.diaFechamento} BETWEEN 1 AND 28 AND ${t.diaVencimento} BETWEEN 1 AND 28`),
    uniqueIndex("cartoes_corporativos_nome_ativo_unico").on(t.nome).where(sql`${t.ativo}`),
  ],
);

export const faturasCartao = pgTable(
  "faturas_cartao",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cartaoId: uuid("cartao_id")
      .notNull()
      .references((): AnyPgColumn => cartoesCorporativos.id, { onDelete: "restrict" }),
    fechamento: date("fechamento").notNull(),
    vencimento: date("vencimento").notNull(),
    status: statusLancamentoEnum("status").notNull().default("em_aberto"),
    pagoEm: date("pago_em"),
    valorPago: bigint("valor_pago", { mode: "bigint" }),
    /** Conta da baixa da fatura. */
    contaBancariaId: uuid("conta_bancaria_id").references((): AnyPgColumn => contasBancarias.id, { onDelete: "restrict" }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("faturas_cartao_cartao_fechamento_unico").on(t.cartaoId, t.fechamento),
    // Alvo das FKs compostas (fatura, cartão) das compras: a compra e a fatura são do mesmo cartão.
    unique("faturas_cartao_id_cartao_unico").on(t.id, t.cartaoId),
    check("faturas_cartao_valor_pago", sql`${t.valorPago} IS NULL OR ${t.valorPago} >= 0`),
    // Baixada ⇔ data, valor pago e conta preenchidos (e nenhum deles fora da baixa), como em `lancamentos`.
    check(
      "faturas_cartao_baixa",
      sql`(${t.status} = 'baixado' AND ${t.pagoEm} IS NOT NULL AND ${t.valorPago} IS NOT NULL AND ${t.contaBancariaId} IS NOT NULL)
        OR (${t.status} <> 'baixado' AND ${t.pagoEm} IS NULL AND ${t.valorPago} IS NULL AND ${t.contaBancariaId} IS NULL)`,
    ),
  ],
);
