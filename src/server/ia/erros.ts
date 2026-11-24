import "server-only";
import type { ErroIntegracao } from "@/server/integracoes/http";

/** Mensagem para a tela por classe de erro da IA (Reescrever e chat). */
export const ERRO_DA_CLASSE: Record<ErroIntegracao["classe"], string> = {
  rede: "Sem conexão com a IA agora. Tente de novo em instantes.",
  limite: "Limite de uso da IA atingido. Tente de novo em alguns minutos.",
  autenticacao: "A chave da IA foi recusada. Avise o Diretor.",
  recusado: "A IA recusou o pedido. Tente de novo.",
  servidor: "A IA não respondeu agora. Tente de novo em instantes.",
};
