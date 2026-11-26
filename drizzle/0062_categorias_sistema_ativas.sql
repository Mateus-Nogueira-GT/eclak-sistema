-- Fatia 5b: a 0049 marcou as quatro categorias como de sistema sem reativá-las. Categoria de sistema não desativa;
-- se alguma estava desativada, a entrada de estoque e o reembolso daquela categoria seriam recusados.
UPDATE "categorias_financeiras" SET "ativa" = true
WHERE "sistema" IN ('reembolso_cliente', 'reembolso_fornecedor', 'caixa_experiencia', 'papelaria') AND "ativa" = false;
