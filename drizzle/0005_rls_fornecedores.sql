-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "fornecedores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "fornecedores" ADD CONSTRAINT "fornecedores_tipos_nao_vazio" CHECK (cardinality("tipos") > 0);--> statement-breakpoint
-- Busca sem acento (nome e cidade).
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;--> statement-breakpoint
CREATE INDEX "fornecedores_nome_idx" ON "fornecedores" ("nome") WHERE "excluido_em" IS NULL;
