import { boolean, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const PERFIS = [
  "diretor",
  "consultor",
  "operacional",
  "fin_operacional",
  "fin_estrategico",
] as const;
export const FILIAIS = ["Rondonópolis", "RS"] as const;

export type Perfil = (typeof PERFIS)[number];
export type Filial = (typeof FILIAIS)[number];

export const perfilUsuario = pgEnum("perfil_usuario", PERFIS);
export const filialEnum = pgEnum("filial", FILIAIS);

export const usuarios = pgTable("usuarios", {
  id: uuid("id").primaryKey(), // = auth.users.id
  nome: text("nome").notNull(),
  email: text("email").notNull().unique(),
  perfil: perfilUsuario("perfil").notNull(),
  filial: filialEnum("filial").notNull(),
  ativo: boolean("ativo").notNull().default(true),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
});
