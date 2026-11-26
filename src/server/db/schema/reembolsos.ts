import { sql } from "drizzle-orm";
import { bigint, check, date, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { FORMAS_DEVOLUCAO } from "@/domain/reembolsos";
import { fornecedores } from "./fornecedores";
import { usuarios } from "./usuarios";
import { contasPagar } from "./vendas";
import { viagens } from "./viagens";

export const formaDevolucaoEnum = pgEnum("forma_devolucao", FORMAS_DEVOLUCAO);

const centavos = (nome: string) => bigint(nome, { mode: "bigint" });

// Caso de reembolso (fatia 5b): a ECLAK cobra o fornecedor e devolve ao cliente. O caso lê as contas, não as copia
// (spec §14): não guarda situação, data nem valor das baixas; o estado vem das contas ligadas por
// `lancamentos.reembolso_id`. `reembolsado_em` só vale nas formas sem conta (abatimento e crédito). RLS na 0058.
export const reembolsos = pgTable(
  "reembolsos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    /** O serviço que falhou: uma conta de fornecedor da viagem (opcional). */
    contaPagarId: uuid("conta_pagar_id").references(() => contasPagar.id, { onDelete: "restrict" }),
    servico: text("servico").notNull(),
    fornecedorId: uuid("fornecedor_id").references(() => fornecedores.id, { onDelete: "restrict" }),
    ocorridoEm: date("ocorrido_em").notNull(),
    ocorrido: text("ocorrido").notNull(),
    valorCobrar: centavos("valor_cobrar").notNull(),
    valorDevolver: centavos("valor_devolver").notNull(),
    formaDevolucao: formaDevolucaoEnum("forma_devolucao").notNull(),
    prazoCliente: date("prazo_cliente").notNull(),
    previstoFornecedor: date("previsto_fornecedor"),
    pedidoEm: date("pedido_em"),
    protocolo: text("protocolo"),
    reembolsadoEm: date("reembolsado_em"),
    canceladoEm: timestamp("cancelado_em", { withTimezone: true }),
    canceladoPor: uuid("cancelado_por").references(() => usuarios.id, { onDelete: "restrict" }),
    motivoCancelamento: text("motivo_cancelamento"),
    criadoPor: uuid("criado_por")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("reembolsos_valores", sql`${t.valorCobrar} >= 0 AND ${t.valorDevolver} >= 0 AND (${t.valorCobrar} > 0 OR ${t.valorDevolver} > 0)`),
    check("reembolsos_previsto", sql`${t.valorCobrar} = 0 OR ${t.previstoFornecedor} IS NOT NULL`),
    check("reembolsos_ocorrido", sql`char_length(${t.ocorrido}) BETWEEN 10 AND 1000`),
    check(
      "reembolsos_cancelamento",
      sql`(${t.canceladoEm} IS NULL AND ${t.canceladoPor} IS NULL AND ${t.motivoCancelamento} IS NULL)
        OR (${t.canceladoEm} IS NOT NULL AND ${t.canceladoPor} IS NOT NULL AND ${t.motivoCancelamento} IS NOT NULL)`,
    ),
  ],
);
