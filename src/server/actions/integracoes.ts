"use server";

import { and, asc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { chaveVenda } from "@/domain/trello";
import { comPerfil, ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { tarefas, viagens } from "@/server/db/schema";
import { estadoIntegracao } from "@/server/integracoes/config";
import { agendarEnvios, enfileirarCartaoDaViagem } from "@/server/integracoes/eventos";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint). Só o Diretor.

type Falha = { ok: false; erro: string };

const VIAGEM_NAO_ENCONTRADA: Falha = { ok: false, erro: "Viagem não encontrada" };
const NAO_VENDIDA: Falha = { ok: false, erro: "A viagem ainda não foi vendida" };
const TRELLO_DESLIGADO: Falha = { ok: false, erro: "O Trello não está configurado" };
const JA_NO_TRELLO: Falha = { ok: false, erro: "Esta viagem já foi enviada ao Trello" };

function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

/**
 * Viagem vendida antes de o Trello ser ligado (nada acumula enquanto desligado, R-C1): põe na fila o cartão com as
 * tarefas da venda que a viagem tem agora (não excluídas, na ordem da lista). Uma vez por viagem: se o envio já
 * existe (enviado, pendente ou com falha), recusa; a falha se reenvia em Admin › Integrações.
 */
export async function enviarViagemAoTrello(viagemId: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    if (!estadoIntegracao("trello").configurada) return TRELLO_DESLIGADO;
    let r: { ok: true } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const [v] = await tx
          .select({ status: viagens.status })
          .from(viagens)
          .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
        if (!v) return VIAGEM_NAO_ENCONTRADA;
        if (v.status !== "vendida") return NAO_VENDIDA;
        const daVenda = await tx
          .select({ item: tarefas.item })
          .from(tarefas)
          .where(and(eq(tarefas.viagemId, viagemId), eq(tarefas.origem, "venda"), isNull(tarefas.excluidoEm)))
          .orderBy(asc(tarefas.ordem));
        const id = await enfileirarCartaoDaViagem(tx, viagemId, daVenda.map((t) => t.item));
        if (!id) return JA_NO_TRELLO;
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "integracao_envios",
          registroId: id,
          acao: "criar",
          depois: { integracao: "trello", tipo: "cartao_viagem", chave: chaveVenda(viagemId), situacao: "pendente" },
        });
        return { ok: true as const };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao enviar a viagem ao Trello", x);
    }
    if (!r.ok) return r;
    revalidatePath(`/viagens/${viagemId}`);
    agendarEnvios();
    return r;
  });
}
