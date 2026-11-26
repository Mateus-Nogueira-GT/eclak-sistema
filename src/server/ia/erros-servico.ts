import "server-only";
import type { ClasseErro } from "@/domain/integracoes";

// Mensagens fixas para o modelo e a tela quando o Trello ou o Drive falham (spec §5 e §6.4).
export const ERRO_DO_SERVICO: Record<"trello" | "drive", Record<ClasseErro, string>> = {
  trello: {
    rede: "Sem conexão com o Trello agora. Tente de novo em instantes.",
    autenticacao: "O Trello recusou o acesso: avise o Diretor.",
    limite: "O Trello está no limite de uso: tente daqui a pouco.",
    recusado: "O Trello recusou este pedido.",
    servidor: "O Trello não respondeu agora. Tente de novo em instantes.",
  },
  drive: {
    rede: "Sem conexão com o Drive agora. Tente de novo em instantes.",
    autenticacao: "O Drive recusou o acesso: avise o Diretor.",
    limite: "O Drive está no limite de uso: tente daqui a pouco.",
    recusado: "O Drive recusou este pedido.",
    servidor: "O Drive não respondeu agora. Tente de novo em instantes.",
  },
};
