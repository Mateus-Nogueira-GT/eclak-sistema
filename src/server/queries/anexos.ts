import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { DONOS_ANEXO, type DonoAnexo } from "@/domain/anexos";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { anexos, usuarios } from "@/server/db/schema";

export type AnexoItem = {
  id: string;
  nome: string;
  mime: string;
  tamanho: number;
  enviadoEm: Date;
  enviadoPorNome: string;
};

/** Anexos não removidos de um dono, do mais antigo ao mais novo. */
export async function listarAnexos(donoTipo: DonoAnexo, donoId: string): Promise<AnexoItem[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  if (!(DONOS_ANEXO as readonly string[]).includes(donoTipo) || !ehUuid(donoId)) return [];
  return db
    .select({
      id: anexos.id,
      nome: anexos.nome,
      mime: anexos.mime,
      tamanho: anexos.tamanho,
      enviadoEm: anexos.enviadoEm,
      enviadoPorNome: usuarios.nome,
    })
    .from(anexos)
    .innerJoin(usuarios, eq(usuarios.id, anexos.enviadoPor))
    .where(and(eq(anexos.donoTipo, donoTipo), eq(anexos.donoId, donoId), isNull(anexos.excluidoEm)))
    .orderBy(asc(anexos.enviadoEm), asc(anexos.id));
}

/**
 * Quantidade de anexos não removidos por dono, numa única consulta agrupada (a lista chama uma vez por página).
 * Chave `${donoTipo}:${donoId}`; quem não tem anexo não aparece. Sem checagem de perfil: só para queries que já
 * a fizeram.
 */
export async function contarAnexosDe(donos: { donoTipo: DonoAnexo; donoId: string }[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  if (donos.length === 0) return m;
  const pares = sql.join(
    donos.map((d) => sql`(${d.donoTipo}::text, ${d.donoId}::uuid)`),
    sql`, `,
  );
  const rs = await db
    .select({ donoTipo: anexos.donoTipo, donoId: anexos.donoId, n: sql<number>`count(*)::int` })
    .from(anexos)
    .where(and(isNull(anexos.excluidoEm), sql`(${anexos.donoTipo}, ${anexos.donoId}) in (${pares})`))
    .groupBy(anexos.donoTipo, anexos.donoId);
  for (const r of rs) m.set(`${r.donoTipo}:${r.donoId}`, r.n);
  return m;
}
