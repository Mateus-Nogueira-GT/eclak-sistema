-- Fatia 5b: quatro categorias da 0020 viram de sistema (renomeáveis; não desativam nem trocam de lado): o reembolso a
-- cliente e o de fornecedor (reembolsos) e a caixa de experiência e a papelaria (compras do estoque).
ALTER TABLE "categorias_financeiras" DROP CONSTRAINT "categorias_financeiras_sistema";--> statement-breakpoint
ALTER TABLE "categorias_financeiras" ADD CONSTRAINT "categorias_financeiras_sistema" CHECK ("categorias_financeiras"."sistema" IS NULL OR "categorias_financeiras"."sistema" IN ('vendas_viagem', 'fornecedores_viagem', 'comissoes_hotel', 'comissoes_operadora', 'cartao_corporativo', 'reembolso_cliente', 'reembolso_fornecedor', 'caixa_experiencia', 'papelaria'));--> statement-breakpoint
-- Banco já populado: marca as linhas da 0020 pela chave (lado, grupo, nome).
UPDATE "categorias_financeiras" SET "sistema" = 'reembolso_cliente'
WHERE "lado" = 'pagar' AND "grupo" = 'Viagens' AND "nome" = 'Reembolso a cliente' AND "sistema" IS NULL;--> statement-breakpoint
UPDATE "categorias_financeiras" SET "sistema" = 'caixa_experiencia'
WHERE "lado" = 'pagar' AND "grupo" = 'Viagens' AND "nome" = 'Caixa de experiência' AND "sistema" IS NULL;--> statement-breakpoint
UPDATE "categorias_financeiras" SET "sistema" = 'papelaria'
WHERE "lado" = 'pagar' AND "grupo" = 'Administrativo' AND "nome" = 'Papelaria' AND "sistema" IS NULL;--> statement-breakpoint
UPDATE "categorias_financeiras" SET "sistema" = 'reembolso_fornecedor'
WHERE "lado" = 'receber' AND "grupo" = 'Outros' AND "nome" = 'Reembolso de fornecedor' AND "sistema" IS NULL;--> statement-breakpoint
-- Se a linha foi renomeada (ou apagada), cria a categoria que falta; onde o UPDATE acertou, o conflito (sistema único) não faz nada.
INSERT INTO "categorias_financeiras" ("lado", "grupo", "nome", "sistema") VALUES
  ('pagar', 'Viagens', 'Reembolso a cliente', 'reembolso_cliente'),
  ('pagar', 'Viagens', 'Caixa de experiência', 'caixa_experiencia'),
  ('pagar', 'Administrativo', 'Papelaria', 'papelaria'),
  ('receber', 'Outros', 'Reembolso de fornecedor', 'reembolso_fornecedor')
ON CONFLICT DO NOTHING;
