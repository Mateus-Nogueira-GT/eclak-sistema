export const PERFIS_VALORES = [
  "diretor",
  "consultor",
  "operacional",
  "fin_operacional",
  "fin_estrategico",
] as const;
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

// Fatias seguintes acrescentam rotas aqui.
export const ROTAS_POR_PERFIL: Record<Perfil, string[]> = {
  diretor: ["/clientes", "/viagens", "/fornecedores", "/vendas", "/aprovacoes", "/admin/usuarios", "/admin/parametros"],
  consultor: ["/clientes", "/viagens", "/fornecedores", "/vendas"],
  operacional: ["/clientes", "/viagens", "/fornecedores", "/vendas"],
  fin_operacional: ["/clientes", "/viagens", "/fornecedores"],
  fin_estrategico: ["/clientes", "/viagens", "/fornecedores"],
};

export function podeAcessar(perfil: Perfil, caminho: string): boolean {
  return ROTAS_POR_PERFIL[perfil].some(
    (rota) => caminho === rota || caminho.startsWith(rota + "/"),
  );
}

export function veCamadaEstrategica(perfil: Perfil): boolean {
  return perfil === "diretor" || perfil === "fin_operacional" || perfil === "fin_estrategico";
}
