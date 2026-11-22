import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Transacao } from "@/server/db/client";
import { viagens } from "@/server/db/schema";

// Fora dos arquivos "use server" de propósito: nada aqui pode virar endpoint. Trava única da viagem para o
// envio/decisão da aprovação e para a venda (mesma chave e mesma ordem: lock consultivo → viagem `for update`).

/** Chave do lock consultivo da viagem (`hashtext` no banco). */
export function chaveTrava(viagemId: string): string {
  return `viagem:${viagemId}`;
}

/** Lock consultivo da viagem (até o fim da transação) e a viagem ativa `for update`; `null` se não existe. */
export async function travarViagem(tx: Transacao, viagemId: string): Promise<typeof viagens.$inferSelect | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${chaveTrava(viagemId)}))`);
  const [v] = await tx
    .select()
    .from(viagens)
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)))
    .for("update");
  return v ?? null;
}
