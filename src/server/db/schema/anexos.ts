import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { DONOS_ANEXO, TAMANHO_MAXIMO_ANEXO, type DonoAnexo } from "@/domain/anexos";
import { usuarios } from "./usuarios";

// Anexos de qualquer linha da lista e das notas fiscais. Sem FK para o dono (`dono_tipo` + `dono_id` apontam para
// tabelas diferentes): a existência é conferida na action. O arquivo fica no bucket privado `anexos` do Supabase
// Storage em `caminho`; removido = `excluido_em` (o objeto fica). RLS e bucket na migração custom 0028.
export const anexos = pgTable(
  "anexos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    donoTipo: text("dono_tipo").$type<DonoAnexo>().notNull(),
    donoId: uuid("dono_id").notNull(),
    caminho: text("caminho").notNull().unique(),
    nome: text("nome").notNull(),
    mime: text("mime").notNull(),
    tamanho: integer("tamanho").notNull(),
    enviadoPor: uuid("enviado_por")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    enviadoEm: timestamp("enviado_em", { withTimezone: true }).notNull().defaultNow(),
    excluidoEm: timestamp("excluido_em", { withTimezone: true }),
  },
  (t) => [
    check("anexos_dono_tipo", sql`${t.donoTipo} IN (${sql.raw(DONOS_ANEXO.map((d) => `'${d}'`).join(", "))})`),
    check("anexos_tamanho", sql`${t.tamanho} BETWEEN 1 AND ${sql.raw(String(TAMANHO_MAXIMO_ANEXO))}`),
    index("anexos_dono_idx").on(t.donoTipo, t.donoId).where(sql`${t.excluidoEm} IS NULL`),
  ],
);
