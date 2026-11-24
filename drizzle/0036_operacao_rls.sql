-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "tarefas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "roteiros" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "dailies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Uma automática por (viagem, chave), mesmo excluída: a excluída não renasce.
CREATE UNIQUE INDEX "tarefas_viagem_chave_unica" ON "tarefas" ("viagem_id", "chave") WHERE "chave" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tarefas_abertas_responsavel_idx" ON "tarefas" ("responsavel_id") WHERE "excluido_em" IS NULL AND "concluida_em" IS NULL;--> statement-breakpoint
CREATE INDEX "tarefas_viagem_idx" ON "tarefas" ("viagem_id") WHERE "excluido_em" IS NULL;--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_prazo_coerente" CHECK (
  ("prazo_tipo" IS NULL AND "prazo_data" IS NULL AND "prazo_dias" IS NULL)
  OR ("prazo_tipo" = 'data' AND "prazo_data" IS NOT NULL AND "prazo_dias" IS NULL)
  OR ("prazo_tipo" = 'dias_antes' AND "prazo_data" IS NULL AND "prazo_dias" BETWEEN 0 AND 365)
);--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_um_responsavel" CHECK (NOT ("responsavel_id" IS NOT NULL AND "customer_care"));--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_conclusao_par" CHECK (("concluida_em" IS NULL) = ("concluida_por" IS NULL));--> statement-breakpoint
ALTER TABLE "dailies" ADD CONSTRAINT "dailies_texto_se_gerado" CHECK ("estado" = 'pendente' OR "texto" IS NOT NULL);
