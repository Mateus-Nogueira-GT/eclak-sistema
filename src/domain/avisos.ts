import { z } from "zod";
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

/** Os sete avisos da Visão geral. */
export type TipoAvisoPainel = Aviso["tipo"];
/** Os oito avisos que só a central mostra (spec §8.3). */
export const TIPOS_AVISO_CENTRAL = [
  "tarefa_vencida",
  "daily_a_gerar",
  "aniversario",
  "estoque_minimo",
  "caixa_a_montar",
  "reembolso_pedir",
  "reembolso_fornecedor",
  "reembolso_cliente",
] as const;
export type TipoAvisoCentral = (typeof TIPOS_AVISO_CENTRAL)[number];
export type TipoAviso = TipoAvisoPainel | TipoAvisoCentral;

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

/** Próximo passo dos oito avisos novos (spec §8.3). */
export const PASSO_AVISO_CENTRAL: Record<TipoAvisoCentral, string> = {
  tarefa_vencida: "Abrir as tarefas da viagem",
  daily_a_gerar: "Gerar o daily",
  aniversario: "Combinar a surpresa e incluir no roteiro",
  estoque_minimo: "Repor o estoque",
  caixa_a_montar: "Montar a caixa na viagem",
  reembolso_pedir: "Pedir o reembolso ao fornecedor",
  reembolso_fornecedor: "Cobrar o fornecedor",
  reembolso_cliente: "Reembolsar o cliente",
};

/** Setor de cada tipo (spec §8.3): o que cita valor estratégico só em Gestão e Financeiro. */
export const SETOR_DO_TIPO: Record<TipoAviso, Setor> = {
  caixa: "Gestão",
  margem: "Gestão",
  aprovacao: "Gestão",
  parcela: "Financeiro",
  comissao: "Financeiro",
  pagar: "Financeiro",
  conciliacao: "Financeiro",
  estoque_minimo: "Financeiro",
  reembolso_pedir: "Financeiro",
  reembolso_fornecedor: "Financeiro",
  reembolso_cliente: "Financeiro",
  aniversario: "Comercial",
  tarefa_vencida: "Operacional",
  daily_a_gerar: "Operacional",
  caixa_a_montar: "Operacional",
};

/** Tipos cujo setor está em `setores`. */
export function tiposDosSetores(setores: readonly Setor[]): TipoAviso[] {
  return (Object.keys(SETOR_DO_TIPO) as TipoAviso[]).filter((t) => setores.includes(SETOR_DO_TIPO[t]));
}

/** Filtro da central: um setor ou "todos" (só o Diretor escolhe; para os outros vale sempre "para mim"). */
export type FiltroAvisos = { setor?: Setor | "todos" };

/** Setores que a central mostra: "para mim" por padrão; o Diretor pode escolher um setor ou "todos". */
export function setoresDaVisao(perfil: Perfil, filtro: FiltroAvisos): Setor[] {
  if (perfil !== "diretor" || !filtro.setor || filtro.setor === "todos") return SETORES_DO_PERFIL[perfil];
  return (SETORES as readonly string[]).includes(filtro.setor) ? [filtro.setor] : SETORES_DO_PERFIL[perfil];
}

/** Perfis que recebem `setor`, na ordem de `SETORES_DO_PERFIL`. */
export function perfisDoSetor(setor: Setor): Perfil[] {
  return (Object.keys(SETORES_DO_PERFIL) as Perfil[]).filter((p) => recebe(p, setor));
}

/** Uma dispensa vale por no máximo 30 dias. */
export const DIAS_VALIDADE_DISPENSA = 30;
/** A aba "Dispensados" mostra os últimos 90 dias. */
export const DIAS_DISPENSADOS = 90;
const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * A dispensa ainda esconde o aviso (spec §14): o `detalhe` atual é igual ao gravado e ela tem no máximo 30 dias. Mudou
 * o texto (de 3 para 4 parcelas vencidas) ou passou o prazo: o aviso volta.
 */
export function dispensaVale(d: { detalhe: string; criadoEm: Date }, atual: { detalhe: string }, agora: Date): boolean {
  return d.detalhe === atual.detalhe && agora.getTime() - d.criadoEm.getTime() <= DIAS_VALIDADE_DISPENSA * DIA_MS;
}

const MSG_JUSTIFICATIVA = "Escreva a justificativa (10 a 500 caracteres)";
export const justificativaSchema = z.string({ error: MSG_JUSTIFICATIVA }).trim().min(10, MSG_JUSTIFICATIVA).max(500, MSG_JUSTIFICATIVA);

const MSG_TEXTO = "Escreva o aviso (5 a 500 caracteres)";
const MSG_PASSO = "O próximo passo tem no máximo 200 caracteres";
export const comunicadoSchema = z.object({
  setor: z.enum(SETORES, { error: "Escolha o setor" }),
  texto: z.string({ error: MSG_TEXTO }).trim().min(5, MSG_TEXTO).max(500, MSG_TEXTO),
  passo: z
    .string({ error: MSG_PASSO })
    .trim()
    .max(200, MSG_PASSO)
    .optional()
    .transform((v) => v || null),
});
export type ComunicadoEntrada = z.input<typeof comunicadoSchema>;

/**
 * Aviso da central. `chave` estável: `tipo:id` para aviso de um alvo (`margem:<viagem>`); só o `tipo` para os que
 * resumem vários (parcela, comissão, pagar, conciliação, aprovação) e para o caixa.
 */
export type AvisoCentral<T extends TipoAviso = TipoAviso> = {
  chave: string;
  tipo: T;
  titulo: string;
  detalhe: string;
  passo: string;
  setor: Setor;
  href: string;
  dispensavel: boolean;
};
