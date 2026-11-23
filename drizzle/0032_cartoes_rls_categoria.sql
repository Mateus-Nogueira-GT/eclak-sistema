-- Fatia 4b: RLS ligado nas tabelas do cartão corporativo, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "cartoes_corporativos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "faturas_cartao" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- A categoria "Cartão corporativo" da 0020 vira de sistema (a das faturas do cartão): pode ser renomeada, não
-- desativada nem trocada de lado. O CHECK `categorias_financeiras_sistema` já aceita o valor (DROP + ADD na 0031).
UPDATE "categorias_financeiras" SET "sistema" = 'cartao_corporativo'
WHERE "lado" = 'pagar' AND "grupo" = 'Administrativo' AND "nome" = 'Cartão corporativo' AND "sistema" IS NULL;
