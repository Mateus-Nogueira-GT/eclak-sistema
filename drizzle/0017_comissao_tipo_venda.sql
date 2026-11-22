-- Tipo de comissão como vendido (fixo): contas existentes recebem o tipo atual.
ALTER TABLE "contas_pagar" ADD COLUMN "comissao_tipo_venda" "comissao_tipo";--> statement-breakpoint
UPDATE "contas_pagar" SET "comissao_tipo_venda" = "comissao_tipo";--> statement-breakpoint
ALTER TABLE "contas_pagar" ALTER COLUMN "comissao_tipo_venda" SET NOT NULL;
