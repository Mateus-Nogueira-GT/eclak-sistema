import "server-only";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { statusDaViagem } from "@/domain/venda";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, usuarios, vendas, versoesPrecificacao, viagens } from "@/server/db/schema";
import { margensVendidas, type MargensVendida } from "@/server/queries/vendas";

// Viagens vendidas com as margens, para a Visão geral, os relatórios e os avisos de Gestão. Módulo interno: as leituras
// sem checagem de acesso não devolvem margem; a única que devolve (`viagensNaoConciliadas`) confere o perfil.

/** Soma em centavos (`bigint`), 0 quando não há linha. */
export const bigintSql = (expr: SQL) => sql<string>`coalesce(${expr}, 0)::bigint`.mapWith((v: string) => BigInt(v));

export type LinhaVendida = {
  viagemId: string;
  codigo: string;
  cliente: string;
  destino: string;
  consultorId: string;
  consultorNome: string;
  aceiteEm: string;
  /** O "Vendido" da tela da viagem (`vendas.total`, `resumo.valorVendido`). */
  vendido: bigint;
  /** Preço do pacote da versão vendida: a receita planejada (entrada `preco` de `margemReal`). */
  preco: bigint;
  inicio: string;
  fim: string;
  conciliadaEm: Date | null;
};

export type ViagemVendidaDoPainel = LinhaVendida & { margens: MargensVendida };

/**
 * Viagens vendidas (não excluídas), com a venda e a versão vendida, que atendem `filtro`. Sem margens. Uso interno,
 * **sem checagem de acesso**: quem chama já conferiu o perfil (`viagensNaoConciliadas` aqui; em `paineis.ts`,
 * `obterVisaoGeral`, direto e por `vendidoNoIntervalo`, e, por `viagensVendidasNoIntervalo`, `relatorioDre`,
 * `relatorioMargens` e `relatorioConsultores`). Exportada porque `paineis.ts` a usa.
 */
export async function linhasVendidas(filtro: SQL | undefined): Promise<LinhaVendida[]> {
  const linhas = await db
    .select({
      viagemId: viagens.id,
      seq: viagens.seq,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      destino: viagens.destino,
      consultorId: viagens.consultorId,
      consultorNome: usuarios.nome,
      aceiteEm: vendas.aceiteEm,
      vendido: vendas.total,
      preco: versoesPrecificacao.preco,
      inicio: viagens.inicio,
      fim: viagens.fim,
      conciliadaEm: viagens.conciliadaEm,
    })
    .from(viagens)
    .innerJoin(vendas, eq(vendas.viagemId, viagens.id))
    .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, vendas.versaoId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .where(and(isNull(viagens.excluidoEm), eq(viagens.status, "vendida"), filtro))
    .orderBy(asc(vendas.aceiteEm), asc(viagens.id));
  return linhas.map(({ seq, clienteCodigo, ...l }) => ({ ...l, codigo: formatarCodigoViagem(clienteCodigo, seq) }));
}

/** Junta às linhas as margens já lidas; linha sem margem fica de fora. */
export function comMargens(linhas: LinhaVendida[], margens: Map<string, MargensVendida>): ViagemVendidaDoPainel[] {
  return linhas
    .filter((l) => margens.has(l.viagemId))
    .map((l) => ({ ...l, margens: margens.get(l.viagemId)! }));
}

/** As linhas não conciliadas (pela situação da viagem), com as margens já lidas. */
export function naoConciliadasDe(linhas: LinhaVendida[], margens: Map<string, MargensVendida>, hoje: string): ViagemVendidaDoPainel[] {
  return comMargens(
    linhas.filter(
      (l) =>
        statusDaViagem({ status: "vendida", inicio: l.inicio, fim: l.fim, conciliadaEm: l.conciliadaEm?.toISOString() ?? null, hoje }) !== "conciliada",
    ),
    margens,
  );
}

/** Viagens vendidas e não conciliadas, com as margens (planejada e real): só Diretor e financeiro estratégico. */
export async function viagensNaoConciliadas(hoje: string): Promise<ViagemVendidaDoPainel[]> {
  await exigirPerfil("diretor", "fin_estrategico");
  const linhas = await linhasVendidas(isNull(viagens.conciliadaEm));
  return naoConciliadasDe(linhas, await margensVendidas(linhas.map((l) => l.viagemId)), hoje);
}
