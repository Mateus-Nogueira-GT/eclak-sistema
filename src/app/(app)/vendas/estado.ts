import type { EstadoProposta } from "@/server/queries/vendas";

export const ROTULO_ESTADO: Record<EstadoProposta, string> = {
  aguardando: "Aguardando resposta do cliente",
  vendida: "Venda confirmada, com o financeiro",
  ajustes: "Cliente pediu ajustes",
};

export const TOM_ESTADO: Record<EstadoProposta, "ouro" | "agua" | "cinza"> = {
  aguardando: "ouro",
  vendida: "agua",
  ajustes: "cinza",
};
