import { auditoria, type AcaoAuditoria } from "@/server/db/schema";
import type { Transacao } from "@/server/db/client";

/** Copia profunda JSON-segura: bigint vira string decimal, Date vira ISO. Não muta a entrada. */
function serializar(valor: unknown): unknown {
  if (typeof valor === "bigint") return valor.toString();
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.map(serializar);
  if (valor !== null && typeof valor === "object") {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, serializar(v)]));
  }
  return valor;
}

export type EntradaAuditoria = {
  usuarioId: string;
  tabela: string;
  registroId: string;
  acao: AcaoAuditoria;
  antes?: unknown;
  depois?: unknown;
};

/** Grava a auditoria dentro da mesma transação da alteração auditada. */
export async function registrarAuditoria(tx: Transacao, e: EntradaAuditoria): Promise<void> {
  await tx.insert(auditoria).values({
    usuarioId: e.usuarioId,
    tabela: e.tabela,
    registroId: e.registroId,
    acao: e.acao,
    antes: e.antes === undefined ? null : serializar(e.antes),
    depois: e.depois === undefined ? null : serializar(e.depois),
  });
}
