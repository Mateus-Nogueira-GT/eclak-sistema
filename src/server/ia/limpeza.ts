import "server-only";
import { and, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/server/db/client";
import { chatAcoes, chatAnexos } from "@/server/db/schema";
import { removerObjeto } from "@/server/storage";

// Limpeza periódica do agente do chat (chamada pelo cron `/api/cron/integracoes` depois da fila):
// marca propostas pendentes vencidas como `expirada` e remove anexos vencidos do bucket e da tabela.
// Só apaga a linha do banco quando o Storage confirma a exclusão do objeto (inclusive de anexos já usados,
// cobrindo eventual falha na exclusão após o upload).
export async function limparChat(agora: Date = new Date()): Promise<{ expiradas: number; anexosRemovidos: number }> {
  const expiradas = await db
    .update(chatAcoes)
    .set({ situacao: "expirada" })
    .where(and(eq(chatAcoes.situacao, "pendente"), lte(chatAcoes.expiraEm, agora)))
    .returning({ id: chatAcoes.id });

  const vencidos = await db
    .select({ id: chatAnexos.id, caminho: chatAnexos.caminho })
    .from(chatAnexos)
    .where(lte(chatAnexos.expiraEm, agora));

  const removidosIds: string[] = [];
  for (const a of vencidos) {
    const rem = await removerObjeto(a.caminho);
    if (rem.ok) removidosIds.push(a.id);
  }
  if (removidosIds.length > 0) {
    await db.delete(chatAnexos).where(inArray(chatAnexos.id, removidosIds));
  }

  return { expiradas: expiradas.length, anexosRemovidos: removidosIds.length };
}
