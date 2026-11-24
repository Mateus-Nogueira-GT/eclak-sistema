"use server";

import { and, asc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { chaveRoteiro, chaveVenda } from "@/domain/trello";
import { comPerfil, ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import type { Transacao } from "@/server/db/client";
import { integracaoEnvios, roteiros, tarefas, viagens } from "@/server/db/schema";
import { estadoIntegracao } from "@/server/integracoes/config";
import { agendarEnvios, eventoCartaoDaViagem, eventoChecklistDoRoteiro } from "@/server/integracoes/eventos";
import { inserirEnvio, reenviarNaTransacao } from "@/server/integracoes/fila";

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

/** Itens (não excluídos, na ordem da lista) das tarefas automáticas da viagem com essa origem. */
async function itensDe(tx: Transacao, viagemId: string, origem: "venda" | "roteiro"): Promise<string[]> {
  const linhas = await tx
    .select({ item: tarefas.item })
    .from(tarefas)
    .where(and(eq(tarefas.viagemId, viagemId), eq(tarefas.origem, origem), isNull(tarefas.excluidoEm)))
    .orderBy(asc(tarefas.ordem));
  return linhas.map((l) => l.item);
}

/**
 * Com o roteiro aprovado, o checklist "Tarefas do roteiro" vai junto: entra na fila com as tarefas do roteiro de
 * agora; se já estava na fila (`pendente`) ou falhou esperando o cartão (`falhou`), volta para agora com as
 * tentativas zeradas (como Reenviar). `enviado` e `enviando` ficam.
 */
async function checklistDoRoteiroJunto(tx: Transacao, viagemId: string, usuarioId: string): Promise<void> {
  const [r] = await tx.select({ status: roteiros.status }).from(roteiros).where(eq(roteiros.viagemId, viagemId));
  if (r?.status !== "aprovado") return;
  const [existente] = await tx
    .select({ id: integracaoEnvios.id })
    .from(integracaoEnvios)
    .where(and(eq(integracaoEnvios.integracao, "trello"), eq(integracaoEnvios.chave, chaveRoteiro(viagemId))));
  if (existente) {
    await reenviarNaTransacao(tx, existente.id, usuarioId);
    return;
  }
  const id = await inserirEnvio(tx, eventoChecklistDoRoteiro(viagemId, await itensDe(tx, viagemId, "roteiro")));
  if (id) await auditarCriacao(tx, usuarioId, id, "checklist_roteiro", chaveRoteiro(viagemId));
}

function auditarCriacao(tx: Transacao, usuarioId: string, id: string, tipo: string, chave: string) {
  return registrarAuditoria(tx, {
    usuarioId,
    tabela: "integracao_envios",
    registroId: id,
    acao: "criar",
    depois: { integracao: "trello", tipo, chave, situacao: "pendente" },
  });
}

/**
 * Viagem vendida antes de o Trello ser ligado (nada acumula enquanto desligado, R-C1): põe na fila o cartão com as
 * tarefas da venda que a viagem tem agora (não excluídas, na ordem da lista) e, se o roteiro já está aprovado, o
 * checklist do roteiro. Uma vez por viagem: se o envio do cartão já existe (enviado, pendente ou com falha), recusa;
 * a falha se reenvia em Admin › Integrações. A configuração é conferida uma vez só, dentro da transação.
 */
export async function enviarViagemAoTrello(viagemId: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    let r: { ok: true } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        if (!estadoIntegracao("trello").configurada) return TRELLO_DESLIGADO;
        const [v] = await tx
          .select({ status: viagens.status })
          .from(viagens)
          .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
        if (!v) return VIAGEM_NAO_ENCONTRADA;
        if (v.status !== "vendida") return NAO_VENDIDA;
        const evento = await eventoCartaoDaViagem(tx, viagemId, await itensDe(tx, viagemId, "venda"));
        const id = evento ? await inserirEnvio(tx, evento) : null;
        if (!id) return JA_NO_TRELLO;
        await auditarCriacao(tx, usuario.id, id, "cartao_viagem", chaveVenda(viagemId));
        await checklistDoRoteiroJunto(tx, viagemId, usuario.id);
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
