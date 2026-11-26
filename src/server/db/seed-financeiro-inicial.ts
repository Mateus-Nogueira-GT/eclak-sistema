import type { CategoriaSistema, Lado } from "@/domain/financeiro";

// Dados iniciais do financeiro: a migração drizzle/0020_financeiro.sql os insere em produção (replica esta lista, com
// `sistema` nulo nas linhas que as migrações 0032 e 0052 marcam depois) e `limparBanco` (tests/helpers/db.ts) os reinsere depois de truncar. O teste
// tests/integracao/financeiro-schema.test.ts executa os INSERTs da 0020 e confere que dão exatamente estes dados.

export type CategoriaInicial = { lado: Lado; grupo: string; nome: string; sistema: CategoriaSistema | null };

/** `categoriasIniciais` do protótipo (eclak-mockup, src/app/contas/page.tsx), na mesma ordem. */
export const CATEGORIAS_INICIAIS: CategoriaInicial[] = (
  [
    ["pagar", "Viagens", "Fornecedores de viagem", "fornecedores_viagem"],
    ["pagar", "Viagens", "Reembolso a cliente", "reembolso_cliente"],
    ["pagar", "Viagens", "Caixa de experiência", "caixa_experiencia"],
    ["pagar", "Pessoal", "Salários", null],
    ["pagar", "Pessoal", "13º salário", null],
    ["pagar", "Pessoal", "Férias", null],
    ["pagar", "Pessoal", "Vale alimentação", null],
    ["pagar", "Pessoal", "Vale transporte", null],
    ["pagar", "Pessoal", "Plano de saúde", null],
    ["pagar", "Pessoal", "Pró-labore", null],
    ["pagar", "Pessoal", "Treinamentos e cursos", null],
    ["pagar", "Administrativo", "Aluguel", null],
    ["pagar", "Administrativo", "Telefone", null],
    ["pagar", "Administrativo", "Internet", null],
    ["pagar", "Administrativo", "Seguros", null],
    ["pagar", "Administrativo", "Serviços contratados", null],
    ["pagar", "Administrativo", "Papelaria", "papelaria"],
    ["pagar", "Administrativo", "Cartão corporativo", "cartao_corporativo"],
    ["pagar", "Impostos e encargos", "Impostos federais", null],
    ["pagar", "Impostos e encargos", "FGTS", null],
    ["pagar", "Impostos e encargos", "Tarifas bancárias", null],
    ["pagar", "Sócios", "Distribuição de lucros", null],
    ["receber", "Vendas", "Vendas de viagem", "vendas_viagem"],
    ["receber", "Vendas", "Comissões de hotel", "comissoes_hotel"],
    ["receber", "Vendas", "Comissões de operadora", "comissoes_operadora"],
    ["receber", "Outros", "Reembolso de fornecedor", "reembolso_fornecedor"],
    ["receber", "Outros", "Rendimentos", null],
  ] as const
).map(([lado, grupo, nome, sistema]) => ({ lado, grupo, nome, sistema }));

/** Primeiro número de fatura (decisão do Mateus, 22/11/2026). */
export const PROXIMA_FATURA_INICIAL = 1405;
