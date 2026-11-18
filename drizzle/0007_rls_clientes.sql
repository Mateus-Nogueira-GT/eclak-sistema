-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "clientes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pessoas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_telefone_digitos" CHECK ("telefone" ~ '^\d{10,11}$');--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_cpf_digitos" CHECK ("cpf" ~ '^\d{11}$');--> statement-breakpoint
-- Uma única pessoa titular por cliente.
CREATE UNIQUE INDEX "pessoas_um_titular" ON "pessoas" ("cliente_id") WHERE "titular";--> statement-breakpoint
CREATE INDEX "pessoas_cpf_idx" ON "pessoas" ("cpf") WHERE "cpf" IS NOT NULL;
