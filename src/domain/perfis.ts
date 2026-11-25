export const PERFIS_VALORES = [
  "diretor",
  "consultor",
  "operacional",
  "fin_operacional",
  "fin_estrategico",
] as const;
/** Quem usa as telas e actions do financeiro (fatia 4). */
export const PERFIS_FINANCEIRO = ["diretor", "fin_operacional", "fin_estrategico"] as const;
export const FILIAIS = ["Rondonópolis", "RS"] as const;

export type Perfil = (typeof PERFIS_VALORES)[number];
export type Filial = (typeof FILIAIS)[number];

export const PERFIS: Record<Perfil, { nome: string }> = {
  diretor: { nome: "Diretor" },
  consultor: { nome: "Consultor" },
  operacional: { nome: "Operacional" },
  fin_operacional: { nome: "Financeiro operacional" },
  fin_estrategico: { nome: "Financeiro estratégico" },
};

/** Tarefas, roteiros e dailies (fatia 5): os cinco perfis. */
const OPERACAO = ["/tarefas", "/roteiros", "/dailies"];
/** Central de avisos (fatia 5b): os cinco perfis, cada um com os seus setores. Nunca a primeira tela. */
const AVISOS = "/avisos";

// Fatias seguintes acrescentam rotas aqui.
export const ROTAS_POR_PERFIL: Record<Perfil, string[]> = {
  diretor: ["/visao-geral", "/clientes", "/viagens", "/fornecedores", "/vendas", "/aprovacoes", "/admin/usuarios", "/admin/parametros", "/admin/integracoes", "/financeiro", ...OPERACAO, AVISOS],
  consultor: ["/clientes", "/viagens", "/fornecedores", "/vendas", ...OPERACAO, AVISOS],
  operacional: ["/clientes", "/viagens", "/fornecedores", "/vendas", ...OPERACAO, AVISOS],
  fin_operacional: ["/clientes", "/viagens", "/fornecedores", "/financeiro", ...OPERACAO, AVISOS],
  fin_estrategico: ["/visao-geral", "/clientes", "/viagens", "/fornecedores", "/financeiro", ...OPERACAO, AVISOS],
};

export function podeAcessar(perfil: Perfil, caminho: string): boolean {
  return ROTAS_POR_PERFIL[perfil].some(
    (rota) => caminho === rota || caminho.startsWith(rota + "/"),
  );
}

export function veCamadaEstrategica(perfil: Perfil): boolean {
  return perfil === "diretor" || perfil === "fin_operacional" || perfil === "fin_estrategico";
}
