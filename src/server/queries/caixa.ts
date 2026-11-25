import "server-only";
import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { projetarMeses, projetarSemanas, situacaoReserva, tipoCaixaDaLinha, type MovimentoCaixa, type PeriodoCaixa, type TipoCaixa } from "@/domain/caixa";
import { hojeEmCuiaba } from "@/domain/clientes";
import type { Centro } from "@/domain/financeiro";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, contasBancarias, lancamentosFinanceiros as lf } from "@/server/db/schema";
import { regrasVigentes } from "@/server/queries/regras";

/**
 * Saldo atual da conta (ruling 2): saldo inicial + entradas − saídas baixadas nela a partir da data do saldo
 * inicial, só o que transita pelo caixa, pelo valor de caixa (líquido de taxa). Subconsulta correlacionada em
 * `contas_bancarias`: usar num select dessa tabela.
 */
// Nomes qualificados à mão: num select de uma tabela só, o Drizzle escreve as colunas sem a tabela, e a
// subconsulta trocaria "id" da conta pelo da view.
export const saldoAtualSql = sql<string>`("contas_bancarias"."saldo_inicial" + coalesce((
  select sum(case when x.lado = 'receber' then x.valor_caixa_baixado else -x.valor_caixa_baixado end)
  from ${lf} x
  where x.conta_bancaria_id = "contas_bancarias"."id"
    and x.status_base = 'baixado'
    and x.transita_caixa
    and x.baixado_em >= "contas_bancarias"."saldo_inicial_em"
), 0))::bigint`.mapWith((v: string) => BigInt(v));

export type SaldoConta = { contaId: string; nome: string; saldoAtual: bigint };

async function saldosAtivas(): Promise<SaldoConta[]> {
  return db
    .select({ contaId: contasBancarias.id, nome: contasBancarias.nome, saldoAtual: saldoAtualSql })
    .from(contasBancarias)
    .where(and(isNull(contasBancarias.excluidoEm), eq(contasBancarias.ativa, true)))
    .orderBy(asc(contasBancarias.nome));
}

/** Saldo atual de cada conta bancária ativa, por nome. */
export async function saldosDasContas(): Promise<SaldoConta[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  return saldosAtivas();
}

export type FiltroCaixa = { centro?: Centro; viagemId?: string; tipo?: TipoCaixa };

export type FluxoDeCaixa = {
  hoje: string;
  saldoAtual: bigint;
  contas: SaldoConta[];
  semanas: PeriodoCaixa[];
  meses: PeriodoCaixa[];
  reserva: ReturnType<typeof situacaoReserva>;
};

/**
 * Fluxo de caixa (ruling 3): base = saldo atual de todas as contas ativas; movimentos = linhas em aberto que
 * transitam pelo caixa, pelo valor e na data de caixa (vencida = data de caixa antes de hoje: cai no primeiro
 * período, marcada). Os filtros mexem só nos movimentos. A reserva usa a projeção mensal sem filtro (o caixa da
 * empresa inteira), para "atingida em" não mudar com o filtro da tela.
 */
export async function obterFluxoDeCaixa(filtro: FiltroCaixa): Promise<FluxoDeCaixa> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const hoje = hojeEmCuiaba();
  const [contas, regras] = await Promise.all([saldosAtivas(), regrasVigentes()]);
  const horizonteMeses = regras.valores.horizonteProjecaoMeses;
  const reservaMeses = regras.valores.reservaCaixaMeses;
  // Último dia que a projeção mostra (fim do horizonte configurado ou das 8 semanas, o que for maior).
  const fimMeses = projetarMeses(0n, [], hoje, horizonteMeses).at(-1)!.fim;
  const fimSemanas = projetarSemanas(0n, [], hoje).at(-1)!.fim;
  const horizonte = fimMeses >= fimSemanas ? fimMeses : fimSemanas;

  const linhas = await db
    .select({
      data: lf.dataCaixa,
      lado: lf.lado,
      origem: lf.origem,
      sistema: categoriasFinanceiras.sistema,
      centro: lf.centro,
      viagemId: lf.viagemId,
      valor: sql<string>`sum(${lf.valorCaixaPrevisto})::bigint`.mapWith((v: string) => BigInt(v)),
    })
    .from(lf)
    .innerJoin(categoriasFinanceiras, eq(categoriasFinanceiras.id, lf.categoriaId))
    .where(and(eq(lf.statusBase, "em_aberto"), eq(lf.transitaCaixa, true), lte(lf.dataCaixa, horizonte)))
    .groupBy(lf.dataCaixa, lf.lado, lf.origem, categoriasFinanceiras.sistema, lf.centro, lf.viagemId);

  const todos = linhas.map((l) => ({
    centro: l.centro,
    viagemId: l.viagemId,
    mov: { data: l.data, valor: l.valor, lado: l.lado, vencida: l.data < hoje, tipo: tipoCaixaDaLinha(l.origem, l.sistema) } satisfies MovimentoCaixa,
  }));
  const filtrados = todos
    .filter(
      (l) =>
        (!filtro.centro || l.centro === filtro.centro) &&
        (!filtro.viagemId || l.viagemId === filtro.viagemId) &&
        (!filtro.tipo || l.mov.tipo === filtro.tipo),
    )
    .map((l) => l.mov);

  const saldoAtual = contas.reduce((s, c) => s + c.saldoAtual, 0n);
  const custoFixoMensal = BigInt(regras.valores.custoFixoMensal);
  const mesesSemFiltro = projetarMeses(
    saldoAtual,
    todos.map((l) => l.mov),
    hoje,
    horizonteMeses,
  );
  return {
    hoje,
    saldoAtual,
    contas,
    semanas: projetarSemanas(saldoAtual, filtrados, hoje),
    meses: projetarMeses(saldoAtual, filtrados, hoje, horizonteMeses),
    reserva: situacaoReserva(saldoAtual, custoFixoMensal, mesesSemFiltro, reservaMeses),
  };
}

export type ViagemDoCaixa = { id: string; codigo: string; cliente: string };

/** Viagens com movimento em aberto no caixa (para o filtro da tela), por código. */
export async function viagensDoCaixa(): Promise<ViagemDoCaixa[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const linhas = await db
    .select({
      id: lf.viagemId,
      codigo: sql<string>`min(${lf.viagemCodigo})`,
      cliente: sql<string>`coalesce(min(${lf.pessoa}) filter (where ${lf.origem} = 'parcela'), '')`,
    })
    .from(lf)
    .where(and(eq(lf.statusBase, "em_aberto"), eq(lf.transitaCaixa, true), isNotNull(lf.viagemId)))
    .groupBy(lf.viagemId)
    .orderBy(sql`min(${lf.viagemCodigo})`);
  return linhas.map((l) => ({ id: l.id!, codigo: l.codigo, cliente: l.cliente }));
}
