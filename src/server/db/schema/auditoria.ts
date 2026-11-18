import { bigserial, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const ACOES_AUDITORIA = ["criar", "alterar", "excluir", "desativar"] as const;
export type AcaoAuditoria = (typeof ACOES_AUDITORIA)[number];

export const auditoria = pgTable("auditoria", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  usuarioId: uuid("usuario_id"),
  em: timestamp("em", { withTimezone: true }).notNull().defaultNow(),
  tabela: text("tabela").notNull(),
  registroId: text("registro_id").notNull(),
  acao: text("acao", { enum: ACOES_AUDITORIA }).notNull(),
  antes: jsonb("antes"),
  depois: jsonb("depois"),
});
