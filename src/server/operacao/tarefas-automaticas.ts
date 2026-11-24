import "server-only";
import { eq, sql } from "drizzle-orm";
import type { TarefaAutomatica } from "@/domain/tarefas";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import { tarefas } from "@/server/db/schema";

/** Colunas do prazo a partir do `Prazo` do domínio. */
export function colunasDoPrazo(prazo: TarefaAutomatica["prazo"]) {
  return {
    prazoTipo: prazo?.tipo ?? null,
    prazoData: prazo?.tipo === "data" ? prazo.data : null,
    prazoDias: prazo?.tipo === "dias_antes" ? prazo.dias : null,
  };
}

/**
 * Insere as tarefas automáticas da `lista` na viagem, com o consultor como responsável, `ordem` depois da última e
 * `ON CONFLICT (viagem_id, chave) DO NOTHING` (o índice único é parcial e inclui as excluídas: a automática excluída
 * não renasce). Audita só as inseridas e devolve quantas foram. Roda dentro da transação de quem chama.
 */
export async function criarTarefasAutomaticas(
  tx: Transacao,
  usuarioId: string,
  viagem: { id: string; consultorId: string },
  lista: TarefaAutomatica[],
  origem: "venda" | "roteiro",
): Promise<number> {
  if (lista.length === 0) return 0;
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${tarefas.ordem}), 0)::int` })
    .from(tarefas)
    .where(eq(tarefas.viagemId, viagem.id));
  const agora = new Date();
  const inseridas = await tx
    .insert(tarefas)
    .values(
      lista.map((t, i) => ({
        viagemId: viagem.id,
        categoria: t.categoria,
        item: t.item,
        fazer: t.fazer,
        ...colunasDoPrazo(t.prazo),
        responsavelId: viagem.consultorId,
        ordem: max.n + 1 + i,
        origem,
        chave: t.chave,
        criadoPor: usuarioId,
        criadoEm: agora,
        atualizadoEm: agora,
      })),
    )
    .onConflictDoNothing({ target: [tarefas.viagemId, tarefas.chave], where: sql`chave is not null` })
    .returning();
  for (const l of inseridas) {
    const { id, ...depois } = l;
    await registrarAuditoria(tx, { usuarioId, tabela: "tarefas", registroId: id, acao: "criar", depois });
  }
  return inseridas.length;
}
