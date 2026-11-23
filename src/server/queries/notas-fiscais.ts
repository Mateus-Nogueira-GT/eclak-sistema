import "server-only";
import { and, desc, eq, gte, lte, ne, sql, type SQL } from "drizzle-orm";
import { filtroNotasSchema, NOTAS_POR_PAGINA, type FiltroNotas } from "@/domain/notas-fiscais";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { formatarCodigoViagem } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, notasFiscais as nf, viagens } from "@/server/db/schema";
import { contarAnexosDe } from "@/server/queries/anexos";

export type NotaFiscalItem = typeof nf.$inferSelect & {
  /** Anexos não removidos (o PDF da nota). */
  anexos: number;
};

export type ListaNotasFiscais = {
  linhas: NotaFiscalItem[];
  /** Notas do período (emitidas e canceladas) e a soma das emitidas, em centavos. */
  totalLinhas: number;
  total: bigint;
  /** Emitidas no período (as canceladas ficam de fora). */
  emitidas: number;
};

const escaparLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Notas do período (pela data de emissão, pontas incluídas), da mais recente para a mais antiga, 50 por página.
 * O destinatário filtra sem acento e sem caixa, por trecho. Canceladas aparecem (marcadas) mas não entram no total.
 */
export async function listarNotasFiscais(filtro: FiltroNotas): Promise<ListaNotasFiscais> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const f = filtroNotasSchema.parse(filtro);
  const onde: SQL[] = [gte(nf.emitidaEm, f.de), lte(nf.emitidaEm, f.ate)];
  if (f.destinatario) onde.push(sql`extensions.unaccent(${nf.destinatario}) ilike extensions.unaccent(${`%${escaparLike(f.destinatario)}%`})`);
  const where = and(...onde);

  const [linhas, [soma]] = await Promise.all([
    db
      .select()
      .from(nf)
      .where(where)
      .orderBy(desc(nf.emitidaEm), desc(nf.criadoEm), desc(nf.id))
      .limit(NOTAS_POR_PAGINA)
      .offset((f.pagina - 1) * NOTAS_POR_PAGINA),
    db
      .select({
        totalLinhas: sql<number>`count(*)::int`,
        emitidas: sql<number>`(count(*) filter (where ${ne(nf.status, "cancelada")}))::int`,
        total: sql<string>`coalesce(sum(${nf.valor}) filter (where ${ne(nf.status, "cancelada")}), 0)::text`,
      })
      .from(nf)
      .where(where),
  ]);
  const contagem = await contarAnexosDe(linhas.map((l) => ({ donoTipo: "nota_fiscal" as const, donoId: l.id })));
  return {
    linhas: linhas.map((l) => ({ ...l, anexos: contagem.get(`nota_fiscal:${l.id}`) ?? 0 })),
    totalLinhas: soma.totalLinhas,
    emitidas: soma.emitidas,
    total: BigInt(soma.total),
  };
}

/** Uma nota (qualquer status) ou `null`. */
export async function obterNotaFiscal(id: string): Promise<(typeof nf.$inferSelect) | null> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  if (!ehUuid(id)) return null;
  const [n] = await db.select().from(nf).where(eq(nf.id, id));
  return n ?? null;
}

export type OpcaoViagem = { id: string; rotulo: string };

/** Viagens para ligar à nota: mais recentes primeiro, "ECL-0147-01 · Destino · Grupo". */
export async function opcoesDeViagem(): Promise<OpcaoViagem[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const rs = await db
    .select({ id: viagens.id, seq: viagens.seq, destino: viagens.destino, codigoCliente: clientes.codigo, grupo: clientes.grupo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(sql`${viagens.excluidoEm} is null`)
    .orderBy(desc(viagens.criadoEm))
    .limit(500);
  return rs.map((r) => ({ id: r.id, rotulo: `${formatarCodigoViagem(r.codigoCliente, r.seq)} · ${r.destino} · ${r.grupo}` }));
}
