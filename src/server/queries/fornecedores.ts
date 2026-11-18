import "server-only";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { TipoServico } from "@/domain/fornecedores";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { fornecedores } from "@/server/db/schema";

export type Fornecedor = typeof fornecedores.$inferSelect;
export type FornecedorLista = Pick<
  Fornecedor,
  "id" | "nome" | "tipos" | "cidade" | "modalidade" | "comissaoPct" | "tarifaFixa"
>;

/** Escapa curingas do LIKE para a busca ser literal. */
const literal = (t: string) => t.replace(/[\\%_]/g, "\\$&");

/** Fornecedores não excluídos, por nome. Busca sem acento e sem caixa em nome e cidade. Exige login. */
export async function listarFornecedores(
  filtro: { busca?: string; tipo?: TipoServico } = {},
): Promise<FornecedorLista[]> {
  await exigirPerfil();
  const condicoes = [isNull(fornecedores.excluidoEm)];
  const busca = filtro.busca?.trim();
  if (busca) {
    const padrao = `%${literal(busca)}%`;
    condicoes.push(
      sql`(unaccent(${fornecedores.nome}) ilike unaccent(${padrao}) or unaccent(coalesce(${fornecedores.cidade}, '')) ilike unaccent(${padrao}))`,
    );
  }
  if (filtro.tipo) condicoes.push(sql`${filtro.tipo} = any(${fornecedores.tipos})`);
  return db
    .select({
      id: fornecedores.id,
      nome: fornecedores.nome,
      tipos: fornecedores.tipos,
      cidade: fornecedores.cidade,
      modalidade: fornecedores.modalidade,
      comissaoPct: fornecedores.comissaoPct,
      tarifaFixa: fornecedores.tarifaFixa,
    })
    .from(fornecedores)
    .where(and(...condicoes))
    .orderBy(asc(fornecedores.nome));
}

/** Inclui excluídos (com `excluidoEm` preenchido). Exige login. */
export async function obterFornecedor(id: string): Promise<Fornecedor | null> {
  await exigirPerfil();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
  const [f] = await db.select().from(fornecedores).where(eq(fornecedores.id, id)).limit(1);
  return f ?? null;
}
