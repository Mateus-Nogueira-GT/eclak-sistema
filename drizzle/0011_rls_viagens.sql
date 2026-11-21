-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "viagens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "viagem_passageiros" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "itens_viagem" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cotacoes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "versoes_precificacao" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- FK circular: criada depois das duas tabelas.
ALTER TABLE "viagens" ADD CONSTRAINT "viagens_versao_aprovada_id_fk" FOREIGN KEY ("versao_aprovada_id") REFERENCES "public"."versoes_precificacao"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "viagens_cliente_idx" ON "viagens" ("cliente_id") WHERE "excluido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "itens_viagem_viagem_idx" ON "itens_viagem" ("viagem_id") WHERE "excluido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "cotacoes_item_idx" ON "cotacoes" ("item_id") WHERE "excluido_em" IS NULL;--> statement-breakpoint
-- Uma cotação escolhida por item.
CREATE UNIQUE INDEX "cotacoes_uma_escolhida" ON "cotacoes" ("item_id") WHERE "escolhida" AND "excluido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "versoes_viagem_idx" ON "versoes_precificacao" ("viagem_id");
