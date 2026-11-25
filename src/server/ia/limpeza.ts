import "server-only";
import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/server/db/client";
import { chatAcoes, chatAnexos } from "@/server/db/schema";
import { removerObjeto } from "@/server/storage";

// Limpeza periódica do agente do chat (chamada pelo cron `/api/cron/integracoes` depois da fila):
// marca propostas pendentes vencidas como `expirada` e remove anexos vencidos do bucket e da tabela.
export async function limparChat(agora: Date = new Date()): Promise<{ expiradas: number; anexosRemovidos: number }> {
  const expiradas = await db
    .update(chatAcoes)
    .set({ situacao: "expirada" })
    .where(and(eq(chatAcoes.situacao, "pendente"), lte(chatAcoes.expiraEm, agora)))
    .returning({ id: chatAcoes.id });

  const vencidos = await db
    .select({ id: chatAnexos.id, caminho: chatAnexos.caminho, usadoEm: chatAnexos.usadoEm })
    .from(chatAnexos)
    .where(lte(chatAnexos.expiraEm, agora));

  for (const a of vencidos) {
    // Anexos já usados tiveram o objeto removido no upload; remove do bucket os que venceram sem uso.
    if (!a.usadoEm) await removerObjeto(a.caminho);
  }
  if (vencidos.length > 0) {
    await db
      .delete(chatAnexos)
      .where(
        inArray(
          chatAnexos.id,
          vencidos.map((a) => a.id),
        ),
      );
  }

  return { expiradas: expiradas.length, anexosRemovidos: vencidos.length };
}
