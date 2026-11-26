import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { SETORES } from "@/domain/avisos";
import { usuarios } from "./usuarios";

// Central de avisos (fatia 5b, spec §8.4). Os avisos automáticos são calculados na hora; só a dispensa e os comunicados
// são gravados. RLS (só service role) na migração custom 0061.

const listaSetores = sql.raw(SETORES.map((s) => `'${s}'`).join(", "));

/**
 * Dispensa de um aviso automático: `tipo`, `titulo` e `detalhe` como estavam. Vale enquanto o detalhe for o mesmo, por
 * no máximo 30 dias (`dispensaVale`). Desfazer apaga a linha (a auditoria guarda).
 */
export const avisosDispensados = pgTable(
  "avisos_dispensados",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chave: text("chave").notNull(),
    tipo: text("tipo").notNull(),
    titulo: text("titulo").notNull(),
    detalhe: text("detalhe").notNull(),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    justificativa: text("justificativa").notNull(),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("avisos_dispensados_justificativa", sql`char_length(${t.justificativa}) BETWEEN 10 AND 500`),
    index("avisos_dispensados_criado_idx").on(t.criadoEm),
  ],
);

/** Comunicado escrito para um setor (ou Geral); fica até alguém do destino (ou quem criou) resolver. */
export const avisosComunicados = pgTable(
  "avisos_comunicados",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    setor: text("setor").notNull(),
    texto: text("texto").notNull(),
    passo: text("passo"),
    criadoPor: uuid("criado_por")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    resolvidoPor: uuid("resolvido_por").references(() => usuarios.id, { onDelete: "restrict" }),
    resolvidoEm: timestamp("resolvido_em", { withTimezone: true }),
  },
  (t) => [
    check("avisos_comunicados_setor", sql`${t.setor} IN (${listaSetores})`),
    check("avisos_comunicados_texto", sql`char_length(${t.texto}) BETWEEN 5 AND 500`),
    check("avisos_comunicados_passo", sql`${t.passo} IS NULL OR char_length(${t.passo}) <= 200`),
    check("avisos_comunicados_resolucao", sql`(${t.resolvidoEm} IS NULL) = (${t.resolvidoPor} IS NULL)`),
    index("avisos_comunicados_abertos_idx").on(t.setor).where(sql`${t.resolvidoEm} IS NULL`),
  ],
);
