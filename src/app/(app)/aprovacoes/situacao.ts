import { MOTIVO_SUBSTITUIDA } from "@/domain/aprovacoes";
import type { StatusVersao } from "@/domain/viagens";

type Parte = { status: StatusVersao; comentario: string | null };

/** Versão devolvida só porque o Diretor aprovou uma versão ajustada no lugar dela. */
export const foiSubstituida = (p: Parte) => p.status === "devolvida" && p.comentario === MOTIVO_SUBSTITUIDA;

export function rotuloSituacao(p: Parte): string {
  if (foiSubstituida(p)) return "Substituída por ajuste";
  switch (p.status) {
    case "aguardando":
      return "Aguardando";
    case "aprovada":
      return "Aprovada";
    case "aprovada_com_ajuste":
      return "Aprovada com ajuste";
    case "devolvida":
      return "Devolvida";
  }
}

export function tomSituacao(p: Parte): "ouro" | "agua" | "cinza" {
  return p.status === "aguardando" ? "ouro" : p.status === "aprovada" || p.status === "aprovada_com_ajuste" ? "agua" : "cinza";
}
