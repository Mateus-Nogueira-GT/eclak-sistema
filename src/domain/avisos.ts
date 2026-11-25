import type { Aviso } from "./paineis";
import type { Perfil } from "./perfis";

// Domínio puro da central de avisos (spec 5b §8): setores, quem recebe cada um e a forma do aviso.

export const SETORES = ["Gestão", "Financeiro", "Comercial", "Operacional", "Geral"] as const;
export type Setor = (typeof SETORES)[number];

/** Spec §8.2. */
export const SETORES_DO_PERFIL: Record<Perfil, Setor[]> = {
  diretor: ["Gestão", "Financeiro", "Comercial", "Operacional", "Geral"],
  fin_estrategico: ["Gestão", "Financeiro", "Geral"],
  fin_operacional: ["Financeiro", "Geral"],
  consultor: ["Comercial", "Operacional", "Geral"],
  operacional: ["Operacional", "Geral"],
};

export function recebe(perfil: Perfil, setor: Setor): boolean {
  return SETORES_DO_PERFIL[perfil].includes(setor);
}

export type TipoAviso = Aviso["tipo"];

/** Próximo passo dos sete avisos da Visão geral (só a central mostra; decisão do coordenador, spec §14). */
export const PASSO_AVISO: Record<Aviso["tipo"], string> = {
  caixa: "Rever o fluxo de caixa",
  margem: "Rever os custos lançados na viagem",
  parcela: "Cobrar o cliente",
  comissao: "Cobrar a comissão do fornecedor",
  pagar: "Pagar ou reprogramar as contas",
  conciliacao: "Conciliar o extrato",
  aprovacao: "Aprovar ou devolver os pedidos",
};

/**
 * Aviso da central. `chave` estável: `tipo:id` para aviso de um alvo (`margem:<viagem>`); só o `tipo` para os que
 * resumem vários (parcela, comissão, pagar, conciliação, aprovação) e para o caixa.
 */
export type AvisoCentral = {
  chave: string;
  tipo: TipoAviso;
  titulo: string;
  detalhe: string;
  passo: string;
  setor: Setor;
  href: string;
  dispensavel: boolean;
};
