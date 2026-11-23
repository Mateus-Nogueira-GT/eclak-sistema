import "server-only";
import { and, asc, eq, getTableColumns, gte, inArray, isNull, lte, ne, not, or, sql, type SQL } from "drizzle-orm";
import type { Moeda } from "@/domain/cambio";
import { hojeEmCuiaba } from "@/domain/clientes";
import { LADOS, type Lado, type Origem, type Situacao } from "@/domain/financeiro";
import { filtroLancamentosSchema, type FiltroLancamentos } from "@/domain/financeiro-entrada";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { contarAnexosDe } from "@/server/queries/anexos";
import { saldoAtualSql } from "@/server/queries/caixa";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, contasBancarias, contasPagar, lancamentos, lancamentosFinanceiros as lf, pagamentosFornecedor } from "@/server/db/schema";

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

export type ContaBancariaItem = typeof contasBancarias.$inferSelect & { saldoAtual: bigint };

/** Contas bancárias não excluídas, por nome, com o saldo atual; `ativas: true` só as ativas. */
export async function listarContasBancarias(filtro: { ativas?: boolean } = {}): Promise<ContaBancariaItem[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const sem = isNull(contasBancarias.excluidoEm);
  return db
    .select({ ...getTableColumns(contasBancarias), saldoAtual: saldoAtualSql })
    .from(contasBancarias)
    .where(filtro.ativas ? sql`${sem} and ${contasBancarias.ativa}` : sem)
    .orderBy(asc(contasBancarias.nome));
}

// ---------------------------------------------------------------------------
// Lista única (view `lancamentos_financeiros`): filtros, situação, totais e paginação, tudo no SQL
// ---------------------------------------------------------------------------

export const LINHAS_POR_PAGINA = 50;

export type TotaisLado = { vencidos: bigint; venceHoje: bigint; aVencer: bigint; baixados: bigint };
export type TotaisLancamentos = Record<Lado, TotaisLado>;

/** Colunas da view + situação, categoria, conta bancária (nome) e, só nos pagamentos, moeda e valor original. */
export type LinhaLancamento = {
  origem: Origem;
  id: string;
  lado: Lado;
  vencimento: string;
  competencia: string;
  valorPrevisto: bigint;
  valorBaixado: bigint | null;
  baixadoEm: string | null;
  statusBase: "em_aberto" | "baixado" | "cancelado";
  categoriaId: string;
  centro: "MT" | "RS";
  contaBancariaId: string | null;
  pessoa: string;
  descricao: string;
  parcelaNumero: number | null;
  parcelaTotal: number | null;
  viagemId: string | null;
  viagemCodigo: string | null;
  faturaNumero: number | null;
  transitaCaixa: boolean;
  taxa: bigint;
  /** Slug (o rótulo sai de `rotuloForma`). */
  forma: string;
  exigeIndividual: boolean;
  repasse: boolean;
  /** Compra numa fatura do cartão corporativo (só aparece cancelada: a ativa sai pela linha da fatura). */
  faturaCartaoId: string | null;
  situacao: Situacao;
  categoria: { grupo: string; nome: string };
  contaBancaria: string | null;
  moeda: Moeda | null;
  valorOriginal: bigint | null;
  /** Anexos não removidos da linha. */
  anexos: number;
};

export type ListaLancamentos = { linhas: LinhaLancamento[]; totalLinhas: number; totais: TotaisLancamentos };

/** Situação derivada (nunca gravada): cancelada, baixada, vencida (< hoje), vence hoje, a vencer. */
const situacaoSql = (hoje: string) => sql<Situacao>`(case
  when ${lf.statusBase} = 'cancelado' then 'cancelada'
  when ${lf.statusBase} = 'baixado' then 'baixada'
  when ${lf.vencimento} < ${hoje}::date then 'vencida'
  when ${lf.vencimento} = ${hoje}::date then 'vence_hoje'
  else 'a_vencer' end)`;

/** O período na coluna da base escolhida (competência compara o mês `AAAA-MM`). */
function periodo(f: FiltroLancamentos): SQL {
  switch (f.base) {
    case "vencimento":
      return and(gte(lf.vencimento, f.de), lte(lf.vencimento, f.ate))!;
    case "competencia":
      return and(gte(lf.competencia, f.de.slice(0, 7)), lte(lf.competencia, f.ate.slice(0, 7)))!;
    case "baixa":
      return and(gte(lf.baixadoEm, f.de), lte(lf.baixadoEm, f.ate))!;
  }
}

const escaparLike = (t: string) => t.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Filtros comuns à lista, à contagem e aos totais (sem lado, situação e período). As compras de uma fatura do
 * cartão corporativo (`fatura_cartao_id`) não aparecem: a lista mostra a linha da fatura no lugar delas. A cancelada
 * (pagamento de conta cancelada, que não conta na fatura) continua visível no filtro Canceladas.
 * Origem "viagem" = parcelas, pagamentos e comissões; "manual" = o resto (lançamentos à mão e faturas do cartão).
 */
function filtrosComuns(f: FiltroLancamentos): SQL[] {
  const c: SQL[] = [or(isNull(lf.faturaCartaoId), eq(lf.statusBase, "cancelado"))!];
  if (f.categoriaId) c.push(eq(lf.categoriaId, f.categoriaId));
  if (f.grupo) c.push(eq(categoriasFinanceiras.grupo, f.grupo));
  if (f.centro) c.push(eq(lf.centro, f.centro));
  if (f.contaBancariaId) c.push(eq(lf.contaBancariaId, f.contaBancariaId));
  if (f.origem) {
    const daViagem = inArray(lf.origem, ["parcela", "pagamento", "comissao"]);
    c.push(f.origem === "viagem" ? daViagem : not(daViagem));
  }
  if (f.busca) {
    const p = `%${escaparLike(f.busca)}%`;
    // Sem acento e sem caixa em descrição e pessoa; código da viagem e número da fatura como texto.
    c.push(
      or(
        sql`extensions.unaccent(${lf.descricao}) ilike extensions.unaccent(${p})`,
        sql`extensions.unaccent(${lf.pessoa}) ilike extensions.unaccent(${p})`,
        sql`${lf.viagemCodigo} ilike ${p}`,
        sql`${lf.faturaNumero}::text ilike ${p}`,
      )!,
    );
  }
  return c;
}

/**
 * Lista única: linhas da página (50, por vencimento e id), total de linhas e totais por lado. Os totais trazem
 * sempre os dois lados, respeitam todos os filtros menos lado e situação, e só contam linhas que transitam pelo
 * caixa e não canceladas: vencidos/vence hoje/a vencer = previsto das em aberto com a base no período;
 * baixados = valor baixado com a data da baixa no período (qualquer base). Canceladas só com `situacao = "cancelada"`.
 */
export async function listarLancamentos(filtro: FiltroLancamentos): Promise<ListaLancamentos> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const f = filtroLancamentosSchema.parse(filtro);
  const hoje = hojeEmCuiaba();
  const situacao = situacaoSql(hoje);
  const comuns = filtrosComuns(f);
  const daLista = and(
    ...comuns,
    periodo(f),
    f.lado === "todos" ? undefined : eq(lf.lado, f.lado),
    f.situacao === "em_aberto" ? eq(lf.statusBase, "em_aberto") : f.situacao ? sql`${situacao} = ${f.situacao}` : ne(lf.statusBase, "cancelado"),
  );

  const [linhas, [contagem], totais] = await Promise.all([
    db
      .select({
        origem: lf.origem,
        id: lf.id,
        lado: lf.lado,
        vencimento: lf.vencimento,
        competencia: lf.competencia,
        valorPrevisto: lf.valorPrevisto,
        valorBaixado: lf.valorBaixado,
        baixadoEm: lf.baixadoEm,
        statusBase: lf.statusBase,
        categoriaId: lf.categoriaId,
        centro: lf.centro,
        contaBancariaId: lf.contaBancariaId,
        pessoa: lf.pessoa,
        descricao: lf.descricao,
        parcelaNumero: lf.parcelaNumero,
        parcelaTotal: lf.parcelaTotal,
        viagemId: lf.viagemId,
        viagemCodigo: lf.viagemCodigo,
        faturaNumero: lf.faturaNumero,
        transitaCaixa: lf.transitaCaixa,
        taxa: lf.taxa,
        forma: lf.forma,
        exigeIndividual: lf.exigeIndividual,
        repasse: lf.repasse,
        faturaCartaoId: lf.faturaCartaoId,
        situacao,
        grupo: categoriasFinanceiras.grupo,
        categoriaNome: categoriasFinanceiras.nome,
        contaBancaria: contasBancarias.nome,
        moeda: contasPagar.moeda,
        valorOriginal: pagamentosFornecedor.valorOriginal,
      })
      .from(lf)
      .innerJoin(categoriasFinanceiras, eq(categoriasFinanceiras.id, lf.categoriaId))
      .leftJoin(contasBancarias, eq(contasBancarias.id, lf.contaBancariaId))
      .leftJoin(pagamentosFornecedor, and(eq(lf.origem, "pagamento"), eq(pagamentosFornecedor.id, lf.id)))
      .leftJoin(contasPagar, eq(contasPagar.id, pagamentosFornecedor.contaId))
      .where(daLista)
      .orderBy(asc(lf.vencimento), asc(lf.id), asc(lf.origem))
      .limit(LINHAS_POR_PAGINA)
      .offset((f.pagina - 1) * LINHAS_POR_PAGINA),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(lf)
      .innerJoin(categoriasFinanceiras, eq(categoriasFinanceiras.id, lf.categoriaId))
      .where(daLista),
    db
      .select({
        lado: lf.lado,
        vencidos: sql<string>`coalesce(sum(${lf.valorPrevisto}) filter (where ${lf.statusBase} = 'em_aberto' and ${periodo(f)} and ${lf.vencimento} < ${hoje}::date), 0)::bigint`,
        venceHoje: sql<string>`coalesce(sum(${lf.valorPrevisto}) filter (where ${lf.statusBase} = 'em_aberto' and ${periodo(f)} and ${lf.vencimento} = ${hoje}::date), 0)::bigint`,
        aVencer: sql<string>`coalesce(sum(${lf.valorPrevisto}) filter (where ${lf.statusBase} = 'em_aberto' and ${periodo(f)} and ${lf.vencimento} > ${hoje}::date), 0)::bigint`,
        baixados: sql<string>`coalesce(sum(${lf.valorBaixado}) filter (where ${lf.statusBase} = 'baixado' and ${lf.baixadoEm} between ${f.de}::date and ${f.ate}::date), 0)::bigint`,
      })
      .from(lf)
      .innerJoin(categoriasFinanceiras, eq(categoriasFinanceiras.id, lf.categoriaId))
      .where(and(...comuns, eq(lf.transitaCaixa, true), ne(lf.statusBase, "cancelado")))
      .groupBy(lf.lado),
  ]);

  const zero = (): TotaisLado => ({ vencidos: 0n, venceHoje: 0n, aVencer: 0n, baixados: 0n });
  const porLado = Object.fromEntries(LADOS.map((l) => [l, zero()])) as TotaisLancamentos;
  for (const t of totais) {
    porLado[t.lado] = { vencidos: BigInt(t.vencidos), venceHoje: BigInt(t.venceHoje), aVencer: BigInt(t.aVencer), baixados: BigInt(t.baixados) };
  }
  // Anexos da página: uma consulta agrupada para as linhas mostradas.
  const anexosPorLinha = await contarAnexosDe(linhas.map((l) => ({ donoTipo: l.origem, donoId: l.id })));
  return {
    linhas: linhas.map(({ grupo, categoriaNome, ...l }) => ({
      ...l,
      categoria: { grupo, nome: categoriaNome },
      anexos: anexosPorLinha.get(`${l.origem}:${l.id}`) ?? 0,
    })),
    totalLinhas: contagem?.n ?? 0,
    totais: porLado,
  };
}

export type LancamentoEdicao = typeof lancamentos.$inferSelect;

/** Lançamento manual para o formulário de edição (a view não tem emissão, observação, pessoa por id...). */
export async function obterLancamento(id: string): Promise<LancamentoEdicao | null> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  if (!ehUuid(id)) return null;
  const [l] = await db.select().from(lancamentos).where(eq(lancamentos.id, id));
  return l ?? null;
}
