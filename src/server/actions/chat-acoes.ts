"use server";

import { and, eq, gt } from "drizzle-orm";
import { EXECUTANDO_PRESO_MIN, resumoDaAcao, servicoDaAcao } from "@/domain/chat-acoes";
import { comPerfil, ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { chatAcoes, type ChatAcao, type ResultadoChatAcao } from "@/server/db/schema";
import { ErroAlcance, executarAcao, nomesDoAlvo, PERFIS_ACAO_CHAT } from "@/server/ia/acoes";
import { ERRO_DO_SERVICO } from "@/server/ia/erros-servico";
import { buscarDoChat } from "@/server/ia/ferramentas";
import { ErroIntegracao } from "@/server/integracoes/http";

// Só as Server Actions são exportadas. Confirmação e cancelamento de propostas gravadas em `chat_acoes`:
// nunca passam pelo modelo. A chamada externa roda fora de `db.transaction`, com fencing por `tomado_em`
// e auditoria na mesma transação do fechamento (sem texto de comentário, descrição ou arquivo).

type Falha = { ok: false; erro: string };
const NAO_ENCONTRADA: Falha = { ok: false, erro: "Ação não encontrada" };
const EXPIRADA: Falha = { ok: false, erro: "Esta ação expirou. Peça de novo." };

/** Confirma e executa uma ação proposta pelo agente (só quem pediu pode confirmar). */
export async function confirmarAcaoChat(
  id: string,
): Promise<{ ok: true; texto: string; link: string | null } | Falha> {
  return comPerfil([...PERFIS_ACAO_CHAT], async (usuario) => {
    if (typeof id !== "string" || !ehUuid(id)) return NAO_ENCONTRADA;

    const agora = new Date();
    const tomada = await db.transaction(async (tx): Promise<{ ok: true; acao: ChatAcao } | Falha> => {
      const [cap] = await tx
        .update(chatAcoes)
        .set({ situacao: "executando", tomadoEm: agora, decididoEm: agora })
        .where(
          and(
            eq(chatAcoes.id, id),
            eq(chatAcoes.usuarioId, usuario.id),
            eq(chatAcoes.situacao, "pendente"),
            gt(chatAcoes.expiraEm, agora),
          ),
        )
        .returning();
      if (cap) return { ok: true, acao: cap };

      const [atual] = await tx
        .select()
        .from(chatAcoes)
        .where(and(eq(chatAcoes.id, id), eq(chatAcoes.usuarioId, usuario.id)))
        .for("update");
      if (!atual) return NAO_ENCONTRADA;

      if (atual.situacao === "pendente") {
        await tx.update(chatAcoes).set({ situacao: "expirada" }).where(eq(chatAcoes.id, atual.id));
        return EXPIRADA;
      }
      if (atual.situacao === "expirada") return EXPIRADA;
      if (atual.situacao === "feita") return { ok: false, erro: "Esta ação já foi executada." };
      if (atual.situacao === "cancelada") return { ok: false, erro: "Esta ação foi cancelada." };
      if (atual.situacao === "falhou") return { ok: false, erro: "Esta ação falhou. Peça de novo." };

      // situacao === "executando"
      const preso = atual.tomadoEm && agora.getTime() - atual.tomadoEm.getTime() > EXECUTANDO_PRESO_MIN * 60_000;
      if (preso) {
        const resPreso: ResultadoChatAcao = { classe: "desconhecido" };
        await tx
          .update(chatAcoes)
          .set({ situacao: "falhou", resultado: resPreso })
          .where(and(eq(chatAcoes.id, atual.id), eq(chatAcoes.situacao, "executando"), eq(chatAcoes.tomadoEm, atual.tomadoEm!)));
        const onde = servicoDaAcao(atual.tipo) === "trello" ? "no Trello" : "no Drive";
        return { ok: false, erro: `Não sei se esta ação foi concluída. Confira ${onde} antes de pedir de novo.` };
      }
      return { ok: false, erro: "Esta ação está em execução." };
    });

    if (!tomada.ok) return tomada;

    const acao = tomada.acao;
    const servico = servicoDaAcao(acao.tipo);
    const alvoNomes = nomesDoAlvo((acao.alvo ?? {}) as Record<string, unknown>);
    let situacaoFinal: "feita" | "falhou" = "feita";
    let resultado: ResultadoChatAcao = { link: null };
    let erroTexto: string | null = null;

    // Chamada externa SEMPRE fora de `db.transaction`.
    try {
      const r = await executarAcao(acao, buscarDoChat(), usuario.nome);
      resultado = { link: r.link };
    } catch (e) {
      situacaoFinal = "falhou";
      if (e instanceof ErroIntegracao) {
        resultado = { classe: e.classe, status: e.status };
        erroTexto = ERRO_DO_SERVICO[servico][e.classe];
      } else if (e instanceof ErroAlcance) {
        resultado = { classe: "alcance", status: null };
        erroTexto = e.message;
      } else {
        resultado = { classe: "servidor", status: null };
        erroTexto = ERRO_DO_SERVICO[servico].servidor;
        console.error("Falha ao executar ação do chat", { tipo: acao.tipo, code: (e as { code?: string } | null)?.code });
      }
    }

    await db.transaction(async (tx) => {
      const [fechada] = await tx
        .update(chatAcoes)
        .set({ situacao: situacaoFinal, resultado })
        .where(
          and(
            eq(chatAcoes.id, acao.id),
            eq(chatAcoes.situacao, "executando"),
            eq(chatAcoes.tomadoEm, acao.tomadoEm!),
          ),
        )
        .returning({ id: chatAcoes.id });
      if (!fechada) return;
      await registrarAuditoria(tx, {
        usuarioId: usuario.id,
        tabela: "chat_acoes",
        registroId: acao.id,
        acao: "criar",
        depois: {
          tipo: acao.tipo,
          viagem: alvoNomes.viagem ?? null,
          alvo: alvoNomes,
          resultado,
        },
      });
    });

    if (situacaoFinal === "feita") {
      return {
        ok: true,
        texto: resumoDaAcao(acao.tipo, alvoNomes),
        link: "link" in resultado ? resultado.link : null,
      };
    }
    return { ok: false, erro: erroTexto ?? ERRO_DO_SERVICO[servico].servidor };
  });
}

/** Cancela uma ação proposta (só quem pediu; nenhuma chamada externa). */
export async function cancelarAcaoChat(id: string): Promise<{ ok: true } | Falha> {
  return comPerfil([...PERFIS_ACAO_CHAT], async (usuario) => {
    if (typeof id !== "string" || !ehUuid(id)) return NAO_ENCONTRADA;
    const agora = new Date();
    return db.transaction(async (tx): Promise<{ ok: true } | Falha> => {
      const [cancelada] = await tx
        .update(chatAcoes)
        .set({ situacao: "cancelada", decididoEm: agora })
        .where(
          and(
            eq(chatAcoes.id, id),
            eq(chatAcoes.usuarioId, usuario.id),
            eq(chatAcoes.situacao, "pendente"),
            gt(chatAcoes.expiraEm, agora),
          ),
        )
        .returning({ id: chatAcoes.id });
      if (cancelada) return { ok: true };

      const [atual] = await tx
        .select()
        .from(chatAcoes)
        .where(and(eq(chatAcoes.id, id), eq(chatAcoes.usuarioId, usuario.id)))
        .for("update");
      if (!atual) return NAO_ENCONTRADA;
      if (atual.situacao === "pendente") {
        await tx.update(chatAcoes).set({ situacao: "expirada" }).where(eq(chatAcoes.id, atual.id));
        return EXPIRADA;
      }
      if (atual.situacao === "expirada") return EXPIRADA;
      if (atual.situacao === "cancelada") return { ok: false, erro: "Esta ação foi cancelada." };
      if (atual.situacao === "feita") return { ok: false, erro: "Esta ação já foi executada." };
      if (atual.situacao === "executando") return { ok: false, erro: "Esta ação está em execução." };
      return { ok: false, erro: "Esta ação falhou. Peça de novo." };
    });
  });
}
