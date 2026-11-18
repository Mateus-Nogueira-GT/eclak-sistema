import { sql } from "drizzle-orm";
import { bigint, numeric, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { MODALIDADES, TIPOS_SERVICO } from "@/domain/fornecedores";

export const tipoServico = pgEnum("tipo_servico", TIPOS_SERVICO);
export const modalidadeFornecedor = pgEnum("modalidade_fornecedor", MODALIDADES);

// O CHECK (cardinality(tipos) > 0), o índice parcial por nome e o RLS estão na migração custom 0005_rls_fornecedores.sql (o drizzle não os conhece).
export const fornecedores = pgTable("fornecedores", {
  id: uuid("id").primaryKey().defaultRandom(),
  nome: text("nome").notNull(),
  tipos: tipoServico("tipos").array().notNull(),
  cidade: text("cidade"),
  modalidade: modalidadeFornecedor("modalidade").notNull(),
  comissaoPct: numeric("comissao_pct", { precision: 6, scale: 3 }).notNull().default(sql`0`),
  tarifaFixa: bigint("tarifa_fixa", { mode: "bigint" }).notNull().default(sql`0`), // centavos
  descontoAVista: text("desconto_a_vista"),
  operacaoFinanceiraOperadora: text("operacao_financeira_operadora"),
  contatoNome: text("contato_nome"),
  contatoTelefone: text("contato_telefone"),
  contatoEmail: text("contato_email"),
  plantao: text("plantao"),
  observacoes: text("observacoes"),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  excluidoEm: timestamp("excluido_em", { withTimezone: true }),
});
