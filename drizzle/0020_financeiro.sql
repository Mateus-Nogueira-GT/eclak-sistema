-- Fatia 4a: RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "categorias_financeiras" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "contas_bancarias" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "lancamentos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "faturas_contador" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "faturas" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "faturas_versoes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Dados iniciais (vão para produção). Réplica literal de src/server/db/seed-financeiro-inicial.ts, que limparBanco
-- reinsere nos testes; tests/integracao/financeiro-schema.test.ts executa estes INSERTs e compara com o módulo.
-- Categorias: `categoriasIniciais` do protótipo; `sistema` marca as fixas das linhas de viagem.
INSERT INTO "categorias_financeiras" ("lado", "grupo", "nome", "sistema") VALUES
  ('pagar', 'Viagens', 'Fornecedores de viagem', 'fornecedores_viagem'),
  ('pagar', 'Viagens', 'Reembolso a cliente', NULL),
  ('pagar', 'Viagens', 'Caixa de experiência', NULL),
  ('pagar', 'Pessoal', 'Salários', NULL),
  ('pagar', 'Pessoal', '13º salário', NULL),
  ('pagar', 'Pessoal', 'Férias', NULL),
  ('pagar', 'Pessoal', 'Vale alimentação', NULL),
  ('pagar', 'Pessoal', 'Vale transporte', NULL),
  ('pagar', 'Pessoal', 'Plano de saúde', NULL),
  ('pagar', 'Pessoal', 'Pró-labore', NULL),
  ('pagar', 'Pessoal', 'Treinamentos e cursos', NULL),
  ('pagar', 'Administrativo', 'Aluguel', NULL),
  ('pagar', 'Administrativo', 'Telefone', NULL),
  ('pagar', 'Administrativo', 'Internet', NULL),
  ('pagar', 'Administrativo', 'Seguros', NULL),
  ('pagar', 'Administrativo', 'Serviços contratados', NULL),
  ('pagar', 'Administrativo', 'Papelaria', NULL),
  ('pagar', 'Administrativo', 'Cartão corporativo', NULL),
  ('pagar', 'Impostos e encargos', 'Impostos federais', NULL),
  ('pagar', 'Impostos e encargos', 'FGTS', NULL),
  ('pagar', 'Impostos e encargos', 'Tarifas bancárias', NULL),
  ('pagar', 'Sócios', 'Distribuição de lucros', NULL),
  ('receber', 'Vendas', 'Vendas de viagem', 'vendas_viagem'),
  ('receber', 'Vendas', 'Comissões de hotel', 'comissoes_hotel'),
  ('receber', 'Vendas', 'Comissões de operadora', 'comissoes_operadora'),
  ('receber', 'Outros', 'Reembolso de fornecedor', NULL),
  ('receber', 'Outros', 'Rendimentos', NULL);--> statement-breakpoint
-- Contador de faturas (uma linha): a primeira fatura emitida recebe 1405.
INSERT INTO "faturas_contador" ("id", "proximo") VALUES (1, 1405);
