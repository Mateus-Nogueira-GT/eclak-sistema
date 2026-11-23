-- Restrições da venda e índices do fluxo de caixa (Fatia 3b, revisão final).
-- Únicos: uma comissão por conta; parcela por (venda, número); pagamento por (conta, número); uma conta ativa por
-- item da viagem. Parciais: o que ainda vai entrar/sair por vencimento e as comissões previstas por data.
CREATE INDEX "comissoes_prevista_para_idx" ON "comissoes" USING btree ("prevista_para") WHERE "comissoes"."status" = 'prevista';--> statement-breakpoint
CREATE UNIQUE INDEX "contas_pagar_viagem_item_ativa_unico" ON "contas_pagar" USING btree ("viagem_id","item_id") WHERE "contas_pagar"."excluido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "pagamentos_fornecedor_a_pagar_vencimento_idx" ON "pagamentos_fornecedor" USING btree ("vencimento") WHERE "pagamentos_fornecedor"."status" = 'a_pagar';--> statement-breakpoint
CREATE INDEX "parcelas_receber_a_receber_vencimento_idx" ON "parcelas_receber" USING btree ("vencimento") WHERE "parcelas_receber"."status" = 'a_receber';--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_conta_unico" UNIQUE("conta_id");--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD CONSTRAINT "pagamentos_fornecedor_conta_numero_unico" UNIQUE("conta_id","numero");--> statement-breakpoint
ALTER TABLE "parcelas_receber" ADD CONSTRAINT "parcelas_receber_venda_numero_unico" UNIQUE("venda_id","numero");