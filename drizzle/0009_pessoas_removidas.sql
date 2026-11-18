-- Pessoas removidas do cadastro (removido_em preenchido) ficam fora dos índices parciais.
DROP INDEX "pessoas_um_titular";--> statement-breakpoint
CREATE UNIQUE INDEX "pessoas_um_titular" ON "pessoas" ("cliente_id") WHERE "titular" AND "removido_em" IS NULL;--> statement-breakpoint
DROP INDEX "pessoas_cpf_idx";--> statement-breakpoint
CREATE INDEX "pessoas_cpf_idx" ON "pessoas" ("cpf") WHERE "cpf" IS NOT NULL AND "removido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "pessoas_cliente_idx" ON "pessoas" ("cliente_id") WHERE "removido_em" IS NULL;
