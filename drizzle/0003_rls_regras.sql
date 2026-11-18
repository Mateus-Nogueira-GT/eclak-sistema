-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "regras_versoes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "regras_versoes_vigencia_idx" ON "regras_versoes" ("vigente_desde" DESC, "seq" DESC);
