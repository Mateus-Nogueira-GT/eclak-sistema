ALTER TABLE "lancamentos" ADD COLUMN "reembolso_id" uuid;--> statement-breakpoint
CREATE INDEX "lancamentos_reembolso_idx" ON "lancamentos" USING btree ("reembolso_id");