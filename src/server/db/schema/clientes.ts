import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  integer,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { TIPOS_CLIENTE } from "@/domain/clientes";
import { filialEnum } from "./usuarios";

export const tipoCliente = pgEnum("tipo_cliente", TIPOS_CLIENTE);
export const clienteCodigoSeq = pgSequence("cliente_codigo_seq", { startWith: 1 });

// Os CHECKs (cpf, telefone), os índices parciais (pessoas_um_titular, cpf) e o RLS estão na migração custom 0007_rls_clientes.sql (o drizzle não os conhece).
export const clientes = pgTable("clientes", {
  id: uuid("id").primaryKey().defaultRandom(),
  codigo: integer("codigo").notNull().unique().default(sql`nextval('cliente_codigo_seq')`),
  grupo: text("grupo").notNull(),
  tipo: tipoCliente("tipo").notNull(),
  filial: filialEnum("filial").notNull(),
  telefone: text("telefone").notNull(), // só dígitos (10 ou 11)
  email: text("email"),
  prefQuarto: text("pref_quarto"),
  prefAlimentacao: text("pref_alimentacao"),
  prefAssento: text("pref_assento"),
  observacoes: text("observacoes"),
  clienteDesde: date("cliente_desde").notNull().default(sql`current_date`),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  excluidoEm: timestamp("excluido_em", { withTimezone: true }),
});

export const pessoas = pgTable("pessoas", {
  id: uuid("id").primaryKey().defaultRandom(),
  clienteId: uuid("cliente_id")
    .notNull()
    .references(() => clientes.id, { onDelete: "restrict" }),
  titular: boolean("titular").notNull().default(false),
  ordem: integer("ordem").notNull(),
  nome: text("nome").notNull(),
  parentesco: text("parentesco"),
  nascimento: date("nascimento"),
  cpf: text("cpf"), // só dígitos (11)
  passaporte: text("passaporte"),
  validadePassaporte: date("validade_passaporte"),
});
