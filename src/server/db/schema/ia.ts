import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { usuarios } from "./usuarios";

// Uso da IA (o custo é pago pela ECLAK direto ao provedor): quem, quando, recurso (ex.: "reescrever:dica"), modelo e
// tokens. Nunca o texto enviado ou recebido. RLS na migração custom.
export const iaUsos = pgTable(
  "ia_usos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    em: timestamp("em", { withTimezone: true }).notNull().defaultNow(),
    recurso: text("recurso").notNull(),
    modelo: text("modelo").notNull(),
    tokensEntrada: integer("tokens_entrada").notNull(),
    tokensSaida: integer("tokens_saida").notNull(),
  },
  (t) => [
    index("ia_usos_em_idx").on(t.em),
    check("ia_usos_tokens", sql`${t.tokensEntrada} >= 0 AND ${t.tokensSaida} >= 0`),
  ],
);
