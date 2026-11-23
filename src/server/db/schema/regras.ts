import { sql } from "drizzle-orm";
import { bigserial, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Regras } from "@/domain/regras";
import { usuarios } from "./usuarios";

/** Cada salvamento é uma nova linha; nada é atualizado. A mais recente por (vigente_desde, seq) vale. */
export const regrasVersoes = pgTable("regras_versoes", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Desempate determinístico quando duas versões têm o mesmo vigente_desde.
  seq: bigserial("seq", { mode: "number" }).notNull(),
  vigenteDesde: timestamp("vigente_desde", { withTimezone: true })
    .notNull()
    .default(sql`clock_timestamp()`),
  criadoPor: uuid("criado_por").references(() => usuarios.id),
  valores: jsonb("valores").$type<Regras>().notNull(),
});
