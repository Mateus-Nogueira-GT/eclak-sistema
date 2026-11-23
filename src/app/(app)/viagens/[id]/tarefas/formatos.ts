// Textos e formatos das tarefas usados na tela (cliente), na impressão e na lista (servidor).
import { rotuloDiaRoteiro } from "@/domain/roteiro";
import type { ResponsavelTarefa } from "@/server/queries/operacao";

export const SUBTITULO_TAREFAS =
  "Controle interno, não enviar ao cliente. As tarefas nascem da aprovação da proposta e do roteiro. Prazos sugeridos com folga, ajustáveis pela equipe.";

export function nomeDoResponsavel(r: ResponsavelTarefa): string {
  if (!r) return "Sem responsável";
  return r.tipo === "customer_care" ? "Customer care" : r.nome;
}

export const rotuloDia = (dia: string | null) => (dia ? rotuloDiaRoteiro(dia) : "Geral");
