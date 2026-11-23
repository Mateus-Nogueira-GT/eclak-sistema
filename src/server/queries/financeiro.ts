import "server-only";
import { asc, eq, sql } from "drizzle-orm";
import type { Lado } from "@/domain/financeiro";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, contasBancarias, lancamentos } from "@/server/db/schema";
import { isNull } from "drizzle-orm";

export type CategoriaItem = {
  id: string;
  nome: string;
  ativa: boolean;
  sistema: string | null;
  /** Lançamentos manuais que usam a categoria. */
  usos: number;
};
export type GrupoCategorias = { lado: Lado; grupo: string; categorias: CategoriaItem[] };

/** Categorias agrupadas por lado e grupo (alfabético; dentro do grupo, por nome). */
export async function listarCategorias(lado?: Lado): Promise<GrupoCategorias[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const linhas = await db
    .select({
      id: categoriasFinanceiras.id,
      lado: categoriasFinanceiras.lado,
      grupo: categoriasFinanceiras.grupo,
      nome: categoriasFinanceiras.nome,
      ativa: categoriasFinanceiras.ativa,
      sistema: categoriasFinanceiras.sistema,
      usos: sql<number>`(select count(*)::int from ${lancamentos} where ${lancamentos.categoriaId} = ${categoriasFinanceiras.id})`,
    })
    .from(categoriasFinanceiras)
    .where(lado ? eq(categoriasFinanceiras.lado, lado) : undefined)
    .orderBy(asc(categoriasFinanceiras.lado), asc(categoriasFinanceiras.grupo), asc(categoriasFinanceiras.nome));
  const grupos: GrupoCategorias[] = [];
  for (const l of linhas) {
    let g = grupos.find((x) => x.lado === l.lado && x.grupo === l.grupo);
    if (!g) grupos.push((g = { lado: l.lado, grupo: l.grupo, categorias: [] }));
    g.categorias.push({ id: l.id, nome: l.nome, ativa: l.ativa, sistema: l.sistema, usos: l.usos });
  }
  return grupos;
}

export type ContaBancariaItem = typeof contasBancarias.$inferSelect;

/** Contas bancárias não excluídas, por nome; `ativas: true` só as ativas. */
export async function listarContasBancarias(filtro: { ativas?: boolean } = {}): Promise<ContaBancariaItem[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const sem = isNull(contasBancarias.excluidoEm);
  return db
    .select()
    .from(contasBancarias)
    .where(filtro.ativas ? sql`${sem} and ${contasBancarias.ativa}` : sem)
    .orderBy(asc(contasBancarias.nome));
}
