import "server-only";
import { and, asc, between, count, eq, inArray, isNull, lt, lte, min, ne, or, sql, type SQL } from "drizzle-orm";
import type { PeriodoCaixa } from "@/domain/caixa";
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { rotuloSituacao, type Lado, type Origem } from "@/domain/financeiro";
import {
  diferencaPp,
  intervaloAnterior,
  intervaloDoPeriodo,
  margemPonderada,
  montarDre,
  ordenarAvisos,
  pctAbaixoDe,
  RESPONSAVEL_AVISO,
  variacaoPct,
  type Aviso,
  type Intervalo,
  type LinhaDre,
  type PeriodoPainel,
} from "@/domain/paineis";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { somarDias, statusDaViagem } from "@/domain/venda";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import {
  categoriasFinanceiras,
  clientes,
  contasBancarias,
  lancamentosFinanceiros as lf,
  usuarios,
  vendas,
  versoesPrecificacao,
  viagens,
} from "@/server/db/schema";
import { obterFluxoDeCaixa, saldoAtualSql, type FluxoDeCaixa } from "@/server/queries/caixa";
import { situacaoSql } from "@/server/queries/financeiro";
import { regrasVigentes } from "@/server/queries/regras";
import { margensVendidas, type MargensVendida } from "@/server/queries/vendas";

const MAX_AVISOS = 8;
/** Avisos de margem uma viagem por linha; as demais viram uma linha "e mais N viagens". */
const MAX_AVISOS_MARGEM = 3;
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
  /** Até 8, na ordem de R6. */
  avisos: Aviso[];
  /** Os que passaram do limite de 8 (a tela lista os títulos com link). */
  avisosOcultos: Aviso[];
  /** Até 6, só não conciliadas com margem real abaixo da planejada, maior perda primeiro. */
  perdas: PerdaDeMargem[];
  margemReferenciaPct: string;
  /** Viagens vendidas e não conciliadas com margem real abaixo da referência (os avisos mostram até 3 e um resumo). */
  viagensAbaixoReferencia: number;
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

/** Vendido com aceite no intervalo, pelas mesmas linhas (`linhasVendidas`) do vendido do período atual. */
async function vendidoNoIntervalo(i: Intervalo): Promise<bigint> {
  return (await linhasVendidas(aceiteNo(i))).reduce((s, l) => s + l.vendido, 0n);
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

/** `agregado`: a linha resume várias (o link abre uma lista, não um item). */
function aviso(tipo: Aviso["tipo"], titulo: string, detalhe: string, href: string, agregado = false): Aviso {
  return { tipo, titulo, detalhe, href, responsavel: RESPONSAVEL_AVISO[tipo], agregado };
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
  // Caixa: uma linha só, com quantas semanas ficam negativas, a primeira e a de menor saldo.
  const negativas = fluxo.semanas.filter((s) => s.saldoFinal < 0n);
  if (negativas.length > 0) {
    const menor = negativas.reduce((m, s) => (s.saldoFinal < m.saldoFinal ? s : m));
    avisos.push(
      aviso(
        "caixa",
        `Caixa negativo em ${negativas.length} das próximas ${fluxo.semanas.length} semanas, a partir da semana de ${negativas[0].rotulo}`,
        `Menor saldo projetado: ${formatarReais(menor.saldoFinal)}, na semana de ${menor.rotulo}`,
        "/financeiro/caixa",
      ),
    );
  }
  const perdas: PerdaDeMargem[] = [];
  const abaixo: { v: ViagemVendidaDoPainel; realPct: string }[] = [];
  for (const v of naoConciliadas) {
    const real = v.margens.real;
    if ("erro" in real) continue;
    if (pctAbaixoDe(real.finalPct, referencia)) abaixo.push({ v, realPct: real.finalPct });
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
  // Margem: a maior distância da referência (a menor margem real) primeiro; até 3 por viagem e um resumo do resto.
  abaixo.sort((a, b) => (pctAbaixoDe(a.realPct, b.realPct) ? -1 : pctAbaixoDe(b.realPct, a.realPct) ? 1 : a.v.codigo.localeCompare(b.v.codigo, "pt-BR")));
  for (const { v, realPct } of abaixo.slice(0, MAX_AVISOS_MARGEM)) {
    avisos.push(
      aviso(
        "margem",
        `${v.codigo} abaixo da margem de referência`,
        `${v.cliente}: margem real de ${formatarPercentual(realPct)}, referência de ${formatarPercentual(referencia)}`,
        `/viagens/${v.viagemId}`,
      ),
    );
  }
  if (abaixo.length > MAX_AVISOS_MARGEM) {
    avisos.push(
      aviso(
        "margem",
        `e mais ${plural(abaixo.length - MAX_AVISOS_MARGEM, "viagem", "viagens")} abaixo da margem de referência`,
        `Margem real abaixo de ${formatarPercentual(referencia)}; veja a margem por viagem nos relatórios`,
        "/financeiro/relatorios?rel=margens",
        true,
      ),
    );
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
        true,
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
        true,
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
        true,
      ),
    );
  }
  if (aguardando > 0) {
    avisos.push(aviso("aprovacao", plural(aguardando, "pedido aguardando aprovação", "pedidos aguardando aprovação"), "Decidir em Aprovações", "/aprovacoes", true));
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
    avisosOcultos: ordenados.slice(MAX_AVISOS),
    perdas: perdas.slice(0, MAX_PERDAS),
    margemReferenciaPct: referencia,
    viagensAbaixoReferencia: abaixo.length,
  };
}

// ---------------------------------------------------------------------------
// Relatórios (spec §5.4): todos para a gestão financeira, pelo intervalo de meses da tela
// ---------------------------------------------------------------------------

export type RelatorioDre = { linhas: LinhaDre[]; resultado: bigint; semMargem: { viagemId: string; codigo: string }[] };

/**
 * DRE por competência (R3): viagens com aceite no intervalo pelos valores de `margemReal` (sem o `fixo`); empresa =
 * lançamentos manuais não cancelados pela competência e pelo valor previsto, inclusive as compras no cartão
 * corporativo uma a uma. As linhas de viagem da view e a da fatura do cartão (o total das compras) ficam de fora.
 */
export async function relatorioDre(i: Intervalo): Promise<RelatorioDre> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const [vendidas, empresa] = await Promise.all([
    viagensVendidasNoIntervalo(i),
    db
      .select({
        lado: lf.lado,
        grupo: categoriasFinanceiras.grupo,
        categoria: categoriasFinanceiras.nome,
        categoriaId: lf.categoriaId,
        valor: bigintSql(sql`sum(${lf.valorPrevisto})`),
      })
      .from(lf)
      .innerJoin(categoriasFinanceiras, eq(categoriasFinanceiras.id, lf.categoriaId))
      .where(and(eq(lf.origem, "manual"), ne(lf.statusBase, "cancelado"), between(lf.competencia, i.de.slice(0, 7), i.ate.slice(0, 7))))
      .groupBy(lf.lado, categoriasFinanceiras.grupo, categoriasFinanceiras.nome, lf.categoriaId),
  ]);

  const bloco = { receita: 0n, custo: 0n, imposto: 0n, taxas: 0n, semMargem: 0 };
  const semMargem: RelatorioDre["semMargem"] = [];
  for (const v of vendidas) {
    const real = v.margens.real;
    if ("erro" in real) {
      semMargem.push({ viagemId: v.viagemId, codigo: v.codigo });
      continue;
    }
    bloco.receita += real.receita;
    bloco.custo += real.custo;
    bloco.imposto += real.imposto;
    bloco.taxas += real.taxas;
  }
  bloco.semMargem = semMargem.length;
  return { ...montarDre(bloco, empresa), semMargem };
}

export type LinhaConta = {
  origem: Origem;
  id: string;
  vencimento: string;
  pessoa: string;
  descricao: string;
  categoria: string;
  viagemId: string | null;
  viagemCodigo: string | null;
  /** Baixada: o valor baixado; senão o previsto (como a lista). */
  valor: bigint;
  /** Rótulo da lista única (Vencida, Vence hoje, A vencer, Paga/Recebida). */
  situacao: string;
};

export type RelatorioContas = { linhas: LinhaConta[]; totais: Record<string, bigint> };

/**
 * Contas a pagar ou a receber com vencimento no intervalo, não canceladas, por vencimento. Como a lista única, as
 * compras no cartão corporativo aparecem pela linha da fatura (não uma a uma). Totais pela situação (rótulo).
 */
export async function relatorioContas(lado: Lado, i: Intervalo): Promise<RelatorioContas> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const linhas = await db
    .select({
      origem: lf.origem,
      id: lf.id,
      vencimento: lf.vencimento,
      pessoa: lf.pessoa,
      descricao: lf.descricao,
      categoria: categoriasFinanceiras.nome,
      viagemId: lf.viagemId,
      viagemCodigo: lf.viagemCodigo,
      valor: bigintSql(sql`case when ${lf.statusBase} = 'baixado' then coalesce(${lf.valorBaixado}, ${lf.valorPrevisto}) else ${lf.valorPrevisto} end`),
      situacao: situacaoSql(hojeEmCuiaba()),
    })
    .from(lf)
    .innerJoin(categoriasFinanceiras, eq(categoriasFinanceiras.id, lf.categoriaId))
    .where(and(eq(lf.lado, lado), ne(lf.statusBase, "cancelado"), isNull(lf.faturaCartaoId), between(lf.vencimento, i.de, i.ate)))
    .orderBy(asc(lf.vencimento), asc(lf.id), asc(lf.origem));

  const totais: Record<string, bigint> = {};
  const comRotulo = linhas.map((l) => {
    const situacao = rotuloSituacao(l.situacao, lado);
    totais[situacao] = (totais[situacao] ?? 0n) + l.valor;
    return { ...l, situacao };
  });
  return { linhas: comRotulo, totais };
}

export type LinhaBanco = { contaId: string; nome: string; entradas: bigint; saidas: bigint; saldoPeriodo: bigint; saldoAtual: bigint };
export type RelatorioBancos = { contas: LinhaBanco[]; total: { entradas: bigint; saidas: bigint; saldoPeriodo: bigint } };

/**
 * Volume por banco (R2): baixas no intervalo que transitam pelo caixa, pelo valor de caixa, por conta, e o saldo
 * atual (`saldoAtualSql`). Contas ativas sempre; desativadas só se tiveram baixa no intervalo. Por nome.
 */
export async function relatorioBancos(i: Intervalo): Promise<RelatorioBancos> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const [contas, movimentos] = await Promise.all([
    db
      .select({ contaId: contasBancarias.id, nome: contasBancarias.nome, ativa: contasBancarias.ativa, saldoAtual: saldoAtualSql })
      .from(contasBancarias)
      .where(isNull(contasBancarias.excluidoEm))
      .orderBy(asc(contasBancarias.nome)),
    db
      .select({
        contaId: lf.contaBancariaId,
        entradas: bigintSql(sql`sum(${lf.valorCaixaBaixado}) filter (where ${lf.lado} = 'receber')`),
        saidas: bigintSql(sql`sum(${lf.valorCaixaBaixado}) filter (where ${lf.lado} = 'pagar')`),
      })
      .from(lf)
      .where(and(eq(lf.statusBase, "baixado"), eq(lf.transitaCaixa, true), between(lf.baixadoEm, i.de, i.ate)))
      .groupBy(lf.contaBancariaId),
  ]);

  const porConta = new Map(movimentos.map((m) => [m.contaId, m]));
  const linhas: LinhaBanco[] = contas
    .filter((c) => c.ativa || porConta.has(c.contaId))
    .map((c) => {
      const m = porConta.get(c.contaId);
      const entradas = m?.entradas ?? 0n;
      const saidas = m?.saidas ?? 0n;
      return { contaId: c.contaId, nome: c.nome, entradas, saidas, saldoPeriodo: entradas - saidas, saldoAtual: c.saldoAtual };
    });
  const entradas = linhas.reduce((s, c) => s + c.entradas, 0n);
  const saidas = linhas.reduce((s, c) => s + c.saidas, 0n);
  return { contas: linhas, total: { entradas, saidas, saldoPeriodo: entradas - saidas } };
}

export type LinhaMargem = {
  viagemId: string;
  codigo: string;
  cliente: string;
  destino: string;
  vendido: bigint;
  planejadaPct: string;
  realPct: string | null;
  /** Real − planejada, em pontos percentuais com uma casa; null sem margem real. */
  diferencaPp: string | null;
  erro: string | null;
};

/** Margem por viagem com aceite no intervalo (R1), por aceite; com `consultorId`, só as viagens dele. */
export async function relatorioMargens(i: Intervalo, consultorId?: string): Promise<LinhaMargem[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const vendidas = await viagensVendidasNoIntervalo(i);
  return vendidas
    .filter((v) => !consultorId || v.consultorId === consultorId)
    .map((v) => {
      const planejadaPct = v.margens.planejada.finalPct;
      const real = v.margens.real;
      const comErro = "erro" in real;
      return {
        viagemId: v.viagemId,
        codigo: v.codigo,
        cliente: v.cliente,
        destino: v.destino,
        vendido: v.vendido,
        planejadaPct,
        realPct: comErro ? null : real.finalPct,
        diferencaPp: comErro ? null : diferencaPp(real.finalPct, planejadaPct),
        erro: comErro ? real.erro : null,
      };
    });
}

/** Nome do consultor do filtro da margem por viagem (com ou sem vendas no período); `undefined` se não existe. */
export async function nomeDoConsultor(consultorId: string): Promise<string | undefined> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const [u] = await db.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, consultorId));
  return u?.nome;
}

export type LinhaConsultor = { consultorId: string; nome: string; viagens: number; vendido: bigint; margemPct: string | null };
export type RelatorioConsultores = { linhas: LinhaConsultor[]; total: { viagens: number; vendido: bigint; margemPct: string | null } };

/**
 * Vendas por consultor da viagem (R1): viagens fechadas e vendido no intervalo; margem real ponderada pela receita
 * (R4), só das viagens com margem calculada. Por nome.
 */
export async function relatorioConsultores(i: Intervalo): Promise<RelatorioConsultores> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const vendidas = await viagensVendidasNoIntervalo(i);
  type Acumulado = { nome: string; viagens: number; vendido: bigint; reais: { final: bigint; receita: bigint }[] };
  const porConsultor = new Map<string, Acumulado>();
  const todas: Acumulado["reais"] = [];
  for (const v of vendidas) {
    const a = porConsultor.get(v.consultorId) ?? { nome: v.consultorNome, viagens: 0, vendido: 0n, reais: [] };
    a.viagens++;
    a.vendido += v.vendido;
    const real = v.margens.real;
    if (!("erro" in real)) {
      a.reais.push({ final: real.final, receita: real.receita });
      todas.push({ final: real.final, receita: real.receita });
    }
    porConsultor.set(v.consultorId, a);
  }
  const linhas = [...porConsultor.entries()]
    .map(([consultorId, a]) => ({ consultorId, nome: a.nome, viagens: a.viagens, vendido: a.vendido, margemPct: margemPonderada(a.reais) }))
    .sort((x, y) => x.nome.localeCompare(y.nome, "pt-BR"));
  return {
    linhas,
    total: { viagens: vendidas.length, vendido: vendidas.reduce((s, v) => s + v.vendido, 0n), margemPct: margemPonderada(todas) },
  };
}
