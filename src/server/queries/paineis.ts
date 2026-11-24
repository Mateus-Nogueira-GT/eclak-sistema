import "server-only";
import { and, asc, between, count, eq, inArray, isNull, lt, lte, min, or, sql, type SQL } from "drizzle-orm";
import type { PeriodoCaixa } from "@/domain/caixa";
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import {
  diferencaPp,
  intervaloAnterior,
  intervaloDoPeriodo,
  margemPonderada,
  ordenarAvisos,
  pctAbaixoDe,
  RESPONSAVEL_AVISO,
  variacaoPct,
  type Aviso,
  type Intervalo,
  type PeriodoPainel,
} from "@/domain/paineis";
import { somarDias, statusDaViagem } from "@/domain/venda";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import {
  categoriasFinanceiras,
  clientes,
  lancamentosFinanceiros as lf,
  usuarios,
  vendas,
  versoesPrecificacao,
  viagens,
} from "@/server/db/schema";
import { obterFluxoDeCaixa, type FluxoDeCaixa } from "@/server/queries/caixa";
import { regrasVigentes } from "@/server/queries/regras";
import { margensVendidas, type MargensVendida } from "@/server/queries/vendas";

const MAX_AVISOS = 8;
const MAX_PERDAS = 6;
const DIAS_A_PAGAR = 7;

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

/** Viagens vendidas (não excluídas), com a venda e a versão vendida, que atendem `filtro`. Sem checagem de acesso. */
async function linhasVendidas(filtro: SQL | undefined): Promise<LinhaVendida[]> {
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

const aceiteNo = (i: Intervalo) => between(vendas.aceiteEm, i.de, i.ate);

function comMargens(linhas: LinhaVendida[], margens: Map<string, MargensVendida>): ViagemVendidaDoPainel[] {
  return linhas
    .filter((l) => margens.has(l.viagemId))
    .map((l) => ({ ...l, margens: margens.get(l.viagemId)! }));
}

/**
 * Viagens vendidas com aceite no intervalo (R1), com o vendido, o preço planejado e as margens de `margensVendidas`
 * (uma leitura em lote). Uso interno, **sem checagem de acesso**: só chamar depois de `exigirPerfil`.
 */
export async function viagensVendidasNoIntervalo(i: Intervalo): Promise<ViagemVendidaDoPainel[]> {
  const linhas = await linhasVendidas(aceiteNo(i));
  return comMargens(linhas, await margensVendidas(linhas.map((l) => l.viagemId)));
}

export type PerdaDeMargem = {
  viagemId: string;
  codigo: string;
  cliente: string;
  destino: string;
  vendido: bigint;
  planejadaPct: string;
  realPct: string;
  /** Real − planejada, em pontos percentuais com uma casa. */
  diferencaPp: string;
};

export type VisaoGeral = {
  hoje: string;
  intervalo: Intervalo;
  vendido: bigint;
  viagensVendidas: number;
  variacaoVendidoPct: string | null;
  margemRealPct: string | null;
  margemPlanejadaPct: string | null;
  recebido: bigint;
  pago: bigint;
  resultadoCaixa: bigint;
  semanas: PeriodoCaixa[];
  primeiraNegativa: PeriodoCaixa | null;
  reserva: FluxoDeCaixa["reserva"];
  avisos: Aviso[];
  avisosRestantes: number;
  /** Até 6, só não conciliadas com margem real abaixo da planejada, maior perda primeiro. */
  perdas: PerdaDeMargem[];
  margemReferenciaPct: string;
};

const bigintSql = (expr: SQL) => sql<string>`coalesce(${expr}, 0)::bigint`.mapWith((v: string) => BigInt(v));

/** Recebido de clientes e pago a fornecedores (R2): baixas no intervalo que transitam pelo caixa, pelo valor de caixa. */
async function caixaDoIntervalo(i: Intervalo): Promise<{ recebido: bigint; pago: bigint }> {
  const [t] = await db
    .select({
      recebido: bigintSql(sql`sum(${lf.valorCaixaBaixado}) filter (where ${lf.origem} = 'parcela')`),
      pago: bigintSql(sql`sum(${lf.valorCaixaBaixado}) filter (where ${lf.origem} = 'pagamento')`),
    })
    .from(lf)
    .where(and(eq(lf.statusBase, "baixado"), eq(lf.transitaCaixa, true), between(lf.baixadoEm, i.de, i.ate)));
  return t ?? { recebido: 0n, pago: 0n };
}

async function vendidoNoIntervalo(i: Intervalo): Promise<bigint> {
  const [t] = await db
    .select({ total: bigintSql(sql`sum(${vendas.total})`) })
    .from(vendas)
    .innerJoin(viagens, eq(viagens.id, vendas.viagemId))
    .where(and(isNull(viagens.excluidoEm), eq(viagens.status, "vendida"), aceiteNo(i)));
  return t?.total ?? 0n;
}

type Agregado = { quantidade: number; total: bigint; desde: string | null };

/** Linhas em aberto da view que atendem `filtro`: quantidade, total previsto e o vencimento mais antigo. */
async function emAberto(filtro: SQL | undefined): Promise<Agregado> {
  const [t] = await db
    .select({ quantidade: count(), total: bigintSql(sql`sum(${lf.valorPrevisto})`), desde: min(lf.vencimento) })
    .from(lf)
    .where(and(eq(lf.statusBase, "em_aberto"), filtro));
  return t ?? { quantidade: 0, total: 0n, desde: null };
}

async function pedidosAguardando(): Promise<number> {
  const [t] = await db
    .select({ quantidade: count() })
    .from(versoesPrecificacao)
    .innerJoin(viagens, eq(viagens.id, versoesPrecificacao.viagemId))
    .where(and(isNull(viagens.excluidoEm), eq(versoesPrecificacao.status, "aguardando")));
  return t?.quantidade ?? 0;
}

const lista = (params: Record<string, string>) => `/financeiro/lancamentos?${new URLSearchParams(params).toString()}`;
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

function aviso(tipo: Aviso["tipo"], titulo: string, detalhe: string, href: string): Aviso {
  return { tipo, titulo, detalhe, href, responsavel: RESPONSAVEL_AVISO[tipo] };
}

/**
 * Visão geral do Diretor e da gestão financeira: vendido e margens do período (aceite, R1/R4), recebido e pago (baixas,
 * R2), caixa das 8 semanas e reserva (`obterFluxoDeCaixa`), avisos "Para decidir hoje" (R6) e as viagens não
 * conciliadas que mais perderam margem.
 */
export async function obterVisaoGeral(periodo: PeriodoPainel): Promise<VisaoGeral> {
  const usuario = await exigirPerfil("diretor", "fin_estrategico");
  const hoje = hojeEmCuiaba();
  const intervalo = intervaloDoPeriodo(periodo, hoje);
  const ontem = somarDias(hoje, -1);
  const limitePagar = somarDias(hoje, DIAS_A_PAGAR);

  const [linhas, vendidoAnterior, caixa, fluxo, regras, parcelas, comissoesVencidas, aPagar, categoriaVendas, aguardando] = await Promise.all([
    // Do período (vendido, margens) e as não conciliadas (avisos de margem, perdas), numa leitura.
    linhasVendidas(or(aceiteNo(intervalo), isNull(viagens.conciliadaEm))),
    vendidoNoIntervalo(intervaloAnterior(periodo, intervalo)),
    caixaDoIntervalo(intervalo),
    obterFluxoDeCaixa({}),
    regrasVigentes(),
    emAberto(and(eq(lf.origem, "parcela"), lt(lf.vencimento, hoje))),
    emAberto(and(eq(lf.origem, "comissao"), lt(lf.vencimento, hoje))),
    emAberto(and(eq(lf.lado, "pagar"), eq(lf.transitaCaixa, true), inArray(lf.origem, ["pagamento", "manual", "fatura_cartao"]), lte(lf.vencimento, limitePagar))),
    db.select({ id: categoriasFinanceiras.id }).from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, "vendas_viagem")),
    usuario.perfil === "diretor" ? pedidosAguardando() : Promise.resolve(0),
  ]);

  const margens = await margensVendidas(linhas.map((l) => l.viagemId));
  const doPeriodo = comMargens(
    linhas.filter((l) => l.aceiteEm >= intervalo.de && l.aceiteEm <= intervalo.ate),
    margens,
  );
  const naoConciliadas = comMargens(
    linhas.filter(
      (l) =>
        statusDaViagem({ status: "vendida", inicio: l.inicio, fim: l.fim, conciliadaEm: l.conciliadaEm?.toISOString() ?? null, hoje }) !== "conciliada",
    ),
    margens,
  );

  const vendido = doPeriodo.reduce((s, v) => s + v.vendido, 0n);
  // Mesmo conjunto (as viagens com margem real calculada) para a real e a planejada.
  const comReal = doPeriodo.flatMap((v) => ("erro" in v.margens.real ? [] : [{ v, real: v.margens.real }]));
  const margemRealPct = margemPonderada(comReal.map(({ real }) => ({ final: real.final, receita: real.receita })));
  const margemPlanejadaPct = margemPonderada(comReal.map(({ v }) => ({ final: v.margens.planejada.final, receita: v.preco })));

  const referencia = regras.valores.margemReferenciaPct;
  const avisos: Aviso[] = [];
  for (const s of fluxo.semanas) {
    if (s.saldoFinal < 0n) avisos.push(aviso("caixa", `Caixa negativo na semana de ${s.rotulo}`, `Saldo projetado de ${formatarReais(s.saldoFinal)}`, "/financeiro/caixa"));
  }
  const perdas: PerdaDeMargem[] = [];
  for (const v of naoConciliadas) {
    const real = v.margens.real;
    if ("erro" in real) continue;
    if (pctAbaixoDe(real.finalPct, referencia)) {
      avisos.push(
        aviso(
          "margem",
          `${v.codigo} abaixo da margem de referência`,
          `${v.cliente}: margem real de ${formatarPercentual(real.finalPct)}, referência de ${formatarPercentual(referencia)}`,
          `/viagens/${v.viagemId}`,
        ),
      );
    }
    const planejadaPct = v.margens.planejada.finalPct;
    if (pctAbaixoDe(real.finalPct, planejadaPct)) {
      perdas.push({
        viagemId: v.viagemId,
        codigo: v.codigo,
        cliente: v.cliente,
        destino: v.destino,
        vendido: v.vendido,
        planejadaPct,
        realPct: real.finalPct,
        diferencaPp: diferencaPp(real.finalPct, planejadaPct),
      });
    }
  }
  if (parcelas.quantidade > 0 && parcelas.desde) {
    const filtro: Record<string, string> = { lado: "receber", base: "vencimento", situacao: "vencida", origem: "viagem" };
    if (categoriaVendas[0]) filtro.categoriaId = categoriaVendas[0].id;
    avisos.push(
      aviso(
        "parcela",
        plural(parcelas.quantidade, "parcela de cliente vencida", "parcelas de cliente vencidas"),
        `${formatarReais(parcelas.total)} em aberto`,
        lista({ ...filtro, de: parcelas.desde, ate: ontem }),
      ),
    );
  }
  if (comissoesVencidas.quantidade > 0 && comissoesVencidas.desde) {
    avisos.push(
      aviso(
        "comissao",
        plural(comissoesVencidas.quantidade, "comissão de fornecedor vencida", "comissões de fornecedor vencidas"),
        `${formatarReais(comissoesVencidas.total)} a receber`,
        lista({ lado: "receber", base: "vencimento", situacao: "vencida", origem: "viagem", de: comissoesVencidas.desde, ate: ontem }),
      ),
    );
  }
  if (aPagar.quantidade > 0 && aPagar.desde) {
    avisos.push(
      aviso(
        "pagar",
        plural(aPagar.quantidade, "conta a pagar vencida ou vencendo em 7 dias", "contas a pagar vencidas ou vencendo em 7 dias"),
        `${formatarReais(aPagar.total)} em aberto`,
        lista({ lado: "pagar", base: "vencimento", situacao: "em_aberto", de: aPagar.desde, ate: limitePagar }),
      ),
    );
  }
  if (aguardando > 0) {
    avisos.push(aviso("aprovacao", plural(aguardando, "pedido aguardando aprovação", "pedidos aguardando aprovação"), "Decidir em Aprovações", "/aprovacoes"));
  }
  const ordenados = ordenarAvisos(avisos);

  perdas.sort((a, b) => Number(a.diferencaPp) - Number(b.diferencaPp) || a.codigo.localeCompare(b.codigo, "pt-BR"));

  return {
    hoje,
    intervalo,
    vendido,
    viagensVendidas: doPeriodo.length,
    variacaoVendidoPct: variacaoPct(vendido, vendidoAnterior),
    margemRealPct,
    margemPlanejadaPct,
    recebido: caixa.recebido,
    pago: caixa.pago,
    resultadoCaixa: caixa.recebido - caixa.pago,
    semanas: fluxo.semanas,
    primeiraNegativa: fluxo.semanas.find((s) => s.saldoFinal < 0n) ?? null,
    reserva: fluxo.reserva,
    avisos: ordenados.slice(0, MAX_AVISOS),
    avisosRestantes: Math.max(ordenados.length - MAX_AVISOS, 0),
    perdas: perdas.slice(0, MAX_PERDAS),
    margemReferenciaPct: referencia,
  };
}
