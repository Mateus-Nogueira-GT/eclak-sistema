-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "vendas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "parcelas_receber" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contas_pagar" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "comissoes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "parcelas_receber_viagem_idx" ON "parcelas_receber" ("viagem_id");--> statement-breakpoint
CREATE INDEX "contas_pagar_viagem_idx" ON "contas_pagar" ("viagem_id") WHERE "excluido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "comissoes_viagem_idx" ON "comissoes" ("viagem_id");--> statement-breakpoint
CREATE INDEX "pagamentos_fornecedor_conta_idx" ON "pagamentos_fornecedor" ("conta_id");--> statement-breakpoint
CREATE INDEX "comissoes_conta_idx" ON "comissoes" ("conta_id");
