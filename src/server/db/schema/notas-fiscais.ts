import { sql } from "drizzle-orm";
import { bigint, check, date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { STATUS_NOTA, type StatusNota } from "@/domain/notas-fiscais";
import { clientes } from "./clientes";
import { fornecedores } from "./fornecedores";
import { usuarios } from "./usuarios";
import { viagens } from "./viagens";

// Notas fiscais emitidas. O número é único entre as não canceladas (cancelar libera o número); nota nunca é
// apagada. Destinatário em texto, opcionalmente ligado a um fornecedor ou cliente (no máximo um). RLS na
// migração custom 0030; o PDF fica em `anexos` (dono_tipo = 'nota_fiscal').
export const notasFiscais = pgTable(
  "notas_fiscais",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    numero: text("numero").notNull(),
    emitidaEm: date("emitida_em", { mode: "string" }).notNull(),
    /** AAAA-MM. */
    competencia: text("competencia").notNull(),
    /** Centavos. */
    valor: bigint("valor", { mode: "bigint" }).notNull(),
    destinatario: text("destinatario").notNull(),
    /** CPF (11) ou CNPJ (14), só dígitos. */
    documento: text("documento"),
    fornecedorId: uuid("fornecedor_id").references(() => fornecedores.id, { onDelete: "restrict" }),
    clienteId: uuid("cliente_id").references(() => clientes.id, { onDelete: "restrict" }),
    viagemId: uuid("viagem_id").references(() => viagens.id, { onDelete: "restrict" }),
    observacao: text("observacao"),
    status: text("status").$type<StatusNota>().notNull().default("emitida"),
    motivoCancelamento: text("motivo_cancelamento"),
    criadoPor: uuid("criado_por")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("notas_fiscais_numero_unico").on(t.numero).where(sql`${t.status} <> 'cancelada'`),
    check("notas_fiscais_valor", sql`${t.valor} > 0`),
    check("notas_fiscais_documento", sql`${t.documento} IS NULL OR ${t.documento} ~ '^([0-9]{11}|[0-9]{14})$'`),
    check("notas_fiscais_competencia", sql`${t.competencia} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
    check("notas_fiscais_status", sql`${t.status} IN (${sql.raw(STATUS_NOTA.map((s) => `'${s}'`).join(", "))})`),
    check("notas_fiscais_pessoa", sql`${t.fornecedorId} IS NULL OR ${t.clienteId} IS NULL`),
    check("notas_fiscais_motivo", sql`(${t.status} = 'cancelada') = (${t.motivoCancelamento} IS NOT NULL)`),
    index("notas_fiscais_emitida_idx").on(t.emitidaEm),
  ],
);
