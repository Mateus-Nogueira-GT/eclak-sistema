import "server-only";
import { and, asc, eq, getTableColumns, gte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { rotuloForma, type ResultadoVersao, type Snapshot } from "@/domain/aprovacoes";
import type { Moeda } from "@/domain/cambio";
import { hojeEmCuiaba } from "@/domain/clientes";
import { veCamadaEstrategica } from "@/domain/perfis";
import type { FormaPagamento } from "@/domain/precificacao";
import {
  contasDoSnapshot,
  formatarDocumento,
  margemReal,
  planejadaDaVersao,
  ponteDaMargem,
  ROTULO_MEIO,
  ROTULO_STATUS_VIAGEM,
  statusDaViagem,
  taxaRoteiroDoSnapshot,
  type ComissaoTipo,
  type FormaPagamentoFornecedorTipo,
  type LinhaPonte,
  type MargemPlanejada,
  type MargemReal,
  type MeioRecebimento,
  type StatusComissao,
  type StatusConta,
  type StatusPagamento,
  type StatusParcela,
  type StatusViagem,
} from "@/domain/venda";
import { normalizarRegras } from "@/domain/regras";
import { formatarCodigoViagem } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import {
  cartoesCorporativos,
  clientes,
  comissoes,
  contasPagar,
  faturasCartao,
  fornecedores,
  itensViagem,
  lancamentosFinanceiros,
  pagamentosFornecedor,
  pessoas,
  parcelasReceber,
  regrasVersoes,
  usuarios,
  vendas,
  versoesPrecificacao,
  viagens,
} from "@/server/db/schema";
import { regrasDaVersao } from "@/server/queries/regras";

/** Estado da proposta no Fechamento da venda. */
export type EstadoProposta = "aguardando" | "vendida" | "ajustes";

/** Só dados operacionais (o que o cliente viu): nada de custo, imposto ou margem. */
export type PropostaLista = {
  /** Id da viagem. */
  id: string;
  codigo: string;
  estado: EstadoProposta;
  numeroVersao: number;
  cliente: string;
  /** Destino, período e passageiros da versão aprovada (a proposta). */
  destino: string;
  inicio: string;
  fim: string;
  passageiros: string[];
  consultor: string;
  /** Preço ao cliente (pacote + taxa de serviço), centavos como texto. */
  precoCliente: string;
  /** "Boleto em 4x". */
  forma: string;
  aprovadoEm: Date | null;
  aprovadoPor: string | null;
  vendidaEm: Date | null;
  notaCliente: string | null;
  /** Forma aprovada (estrutura), para o seletor da forma acordada. */
  formaAprovada: FormaPagamento;
  /** Titular do cliente, para preencher "Fatura em nome de" (nome e CPF formatado; vazio se não há). */
  titularNome: string;
  titularDocumento: string;
  /**
   * Fornecedores com conta na viagem (itens não-Taxa da versão aprovada com fornecedor), por nome: o select de
   * quem recebeu no "Cartão direto no fornecedor".
   */
  fornecedores: { id: string; nome: string }[];
  /** Só `vendida`: cronograma lançado (valores em centavos como texto). */
  parcelasLancadas?: { numero: number; totalParcelas: number; vencimento: string; valor: string; meio: string }[];
};

const DIAS_VENDIDAS = 30;
const decisor = alias(usuarios, "decisor");

/**
 * Propostas: viagens `aprovado` (aguardando a resposta do cliente), `vendida` nos últimos 30 dias e
 * `em_edicao` com pedido de ajustes do cliente. Qualquer perfil logado. Mais recentes primeiro.
 */
export async function listarPropostas(): Promise<PropostaLista[]> {
  await exigirPerfil();
  const desde = new Date(Date.now() - DIAS_VENDIDAS * 86_400_000);
  const snap = versoesPrecificacao.snapshot;
  const linhas = await db
    .select({
      id: viagens.id,
      seq: viagens.seq,
      status: viagens.status,
      vendidaEm: viagens.vendidaEm,
      notaCliente: viagens.notaCliente,
      numeroVersao: versoesPrecificacao.numero,
      preco: versoesPrecificacao.preco,
      dias: versoesPrecificacao.dias,
      forma: versoesPrecificacao.forma,
      clienteId: viagens.clienteId,
      aprovadoEm: versoesPrecificacao.decididoEm,
      // Só os campos usados do snapshot e do resultado (nunca custo, imposto ou margem).
      destino: sql<string>`${snap}->>'destino'`,
      inicio: sql<string>`${snap}->>'inicio'`,
      fim: sql<string>`${snap}->>'fim'`,
      passageiros: sql<string[]>`(select coalesce(jsonb_agg(p.e->>'nome' order by p.n), '[]'::jsonb)
        from jsonb_array_elements(${snap}->'passageiros') with ordinality as p(e, n))`,
      precoCliente: sql<string | null>`${versoesPrecificacao.resultado}->>'precoCliente'`,
      fornecedorIds: sql<string[]>`(select coalesce(jsonb_agg(distinct i.e->'escolhida'->>'fornecedorId'), '[]'::jsonb)
        from jsonb_array_elements(${snap}->'itens') as i(e)
        where i.e->>'tipo' <> 'Taxa' and i.e->'escolhida'->>'fornecedorId' is not null)`,
      regrasVersaoId: versoesPrecificacao.regrasVersaoId,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      consultor: usuarios.nome,
      decisor: decisor.nome,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, viagens.versaoAprovadaId))
    .leftJoin(decisor, eq(decisor.id, versoesPrecificacao.decididoPor))
    .where(
      and(
        isNull(viagens.excluidoEm),
        or(
          eq(viagens.status, "aprovado"),
          and(eq(viagens.status, "vendida"), gte(viagens.vendidaEm, desde)),
          and(eq(viagens.status, "em_edicao"), isNotNull(viagens.notaCliente)),
        ),
      ),
    );

  // Versões antigas, sem o preço ao cliente gravado, recalculam com as regras da versão.
  const semPreco = [...new Set(linhas.filter((l) => l.precoCliente === null).map((l) => l.regrasVersaoId))];
  const taxaPorRegras = new Map<string, bigint>();
  for (const id of semPreco) taxaPorRegras.set(id, BigInt((await regrasDaVersao(id)).taxaServicoPorDia));

  const idsClientes = [...new Set(linhas.map((l) => l.clienteId))];
  const titulares =
    idsClientes.length === 0
      ? []
      : await db
          .select({ clienteId: pessoas.clienteId, nome: pessoas.nome, cpf: pessoas.cpf })
          .from(pessoas)
          .where(and(inArray(pessoas.clienteId, idsClientes), eq(pessoas.titular, true), isNull(pessoas.removidoEm)));
  const titularDe = new Map(titulares.map((t) => [t.clienteId, t]));

  const idsFornecedores = [...new Set(linhas.flatMap((l) => l.fornecedorIds))];
  const nomes =
    idsFornecedores.length === 0
      ? []
      : await db.select({ id: fornecedores.id, nome: fornecedores.nome }).from(fornecedores).where(inArray(fornecedores.id, idsFornecedores));
  const porNome = (a: { nome: string }, b: { nome: string }) => a.nome.localeCompare(b.nome, "pt-BR");

  const idsVendidas = linhas.filter((l) => l.status === "vendida").map((l) => l.id);
  const parcelas =
    idsVendidas.length === 0
      ? []
      : await db
          .select()
          .from(parcelasReceber)
          .where(inArray(parcelasReceber.viagemId, idsVendidas))
          .orderBy(asc(parcelasReceber.numero));

  const lista = linhas.map(
    (l): PropostaLista => ({
      id: l.id,
      codigo: formatarCodigoViagem(l.clienteCodigo, l.seq),
      estado: l.status === "vendida" ? "vendida" : l.status === "aprovado" ? "aguardando" : "ajustes",
      numeroVersao: l.numeroVersao,
      cliente: l.cliente,
      destino: l.destino,
      inicio: l.inicio,
      fim: l.fim,
      passageiros: l.passageiros,
      consultor: l.consultor,
      precoCliente: l.precoCliente ?? (l.preco + BigInt(l.dias) * taxaPorRegras.get(l.regrasVersaoId)!).toString(),
      forma: rotuloForma(l.forma as FormaPagamento),
      aprovadoEm: l.aprovadoEm,
      aprovadoPor: l.decisor ?? null,
      vendidaEm: l.vendidaEm,
      notaCliente: l.notaCliente,
      formaAprovada: l.forma as FormaPagamento,
      titularNome: titularDe.get(l.clienteId)?.nome ?? "",
      titularDocumento: titularDe.get(l.clienteId)?.cpf ? formatarDocumento(titularDe.get(l.clienteId)!.cpf!) : "",
      fornecedores: nomes.filter((f) => l.fornecedorIds.includes(f.id)).sort(porNome),
      ...(l.status === "vendida"
        ? {
            parcelasLancadas: parcelas
              .filter((p) => p.viagemId === l.id)
              .map((p) => ({
                numero: p.numero,
                totalParcelas: p.totalParcelas,
                vencimento: p.vencimento,
                valor: p.valor.toString(),
                meio: ROTULO_MEIO[p.meio],
              })),
          }
        : {}),
    }),
  );
  const t = (x: PropostaLista) => (x.vendidaEm ?? x.aprovadoEm)?.getTime() ?? 0;
  return lista.sort((a, b) => t(b) - t(a));
}

// ---------------------------------------------------------------------------
// Viagem vendida (Entradas, Saídas, Conciliação)
// ---------------------------------------------------------------------------

export type ParcelaVendida = {
  id: string;
  numero: number;
  totalParcelas: number;
  vencimento: string;
  valor: bigint;
  meio: MeioRecebimento;
  rotuloMeio: string;
  status: StatusParcela;
  recebidaEm: string | null;
  valorRecebido: bigint | null;
  observacao: string | null;
  /** Só na camada estratégica (taxas financeiras). */
  taxaPrevista?: bigint;
  taxaEfetiva?: bigint | null;
};

export type PagamentoVendido = {
  id: string;
  numero: number;
  vencimento: string;
  valorOriginal: bigint;
  valorBrlPrevisto: bigint;
  status: StatusPagamento;
  pagoEm: string | null;
  valorOriginalPago: bigint | null;
  cambioEfetivo: string | null;
  valorBrlPago: bigint | null;
  /** Quitado pelo repasse do cartão direto no fornecedor (desfaz-se pelo repasse). */
  peloRepasse: boolean;
  /** Cartão corporativo da compra (forma "cartão corporativo"). */
  cartaoId: string | null;
  /** Fatura do cartão corporativo em que a compra está: sem baixa direta, sai (e volta) pela fatura. */
  fatura: { id: string; cartao: string; fechamento: string } | null;
};

export type ComissaoVendida = {
  id: string;
  contaId: string;
  /** Fornecedor ou, sem ele, o serviço da conta. */
  fornecedor: string;
  aereo: boolean;
  baseBrl: bigint;
  pct: string;
  valorPrevisto: bigint;
  previstaPara: string;
  status: StatusComissao;
  recebidaEm: string | null;
  valorRecebido: bigint | null;
  motivo: string | null;
  /** Ainda `prevista`. */
  pendente: boolean;
};

export type ContaVendida = {
  id: string;
  itemId: string;
  descricao: string;
  fornecedorId: string | null;
  fornecedor: string | null;
  aereo: boolean;
  moeda: Moeda;
  valorOriginal: bigint;
  cambioAplicado: string | null;
  previstoVendaBrl: bigint;
  previstoBrl: bigint;
  comissaoPct: string;
  comissaoTipo: ComissaoTipo;
  /** Tipo como vendido. */
  comissaoTipoVenda: ComissaoTipo;
  descontoAVistaPct: string | null;
  forma: FormaPagamentoFornecedorTipo | null;
  status: StatusConta;
  contestacao: string | null;
  contestadaEm: Date | null;
  motivoPrevisto: string | null;
  /** Previsto atual diferente do previsto na venda. */
  divergente: boolean;
  contestada: boolean;
  pagamentos: PagamentoVendido[];
  comissao: ComissaoVendida | null;
};

export type ErroCalculo = { erro: string };
export const MSG_NAO_CALCULA_MARGEM = "Não foi possível calcular";

export type ViagemVendida = {
  id: string;
  codigo: string;
  cliente: string;
  destino: string;
  inicio: string;
  fim: string;
  passageiros: string[];
  consultor: string;
  status: StatusViagem;
  rotuloStatus: string;
  vendidaEm: Date | null;
  conciliadaEm: Date | null;
  venda: {
    id: string;
    aceiteEm: string;
    /** "Boleto em 2x". */
    forma: string;
    parcelas: number;
    primeiroVencimento: string;
    faturaNome: string;
    /** Formatado (CPF ou CNPJ). */
    faturaDocumento: string;
    comprovante: string | null;
    observacao: string | null;
  };
  /**
   * Centavos de real. `recebido` é o caixa; `diferencaRecebimento` = Σ (recebido − valor) das parcelas recebidas
   * (negativo = recebido a menos).
   */
  resumo: { valorVendido: bigint; recebido: bigint; aReceber: bigint; diferencaRecebimento: bigint; pagoFornecedores: bigint; aPagar: bigint };
  parcelas: ParcelaVendida[];
  contas: ContaVendida[];
  comissoes: ComissaoVendida[];
  /**
   * Só na venda "Cartão direto no fornecedor" com a parcela não cancelada: a parcela, o fornecedor que recebeu no cartão (nulo em venda antiga,
   * sem ele), as opções (fornecedores com conta ativa na viagem) e o repasse esperado da view
   * `lancamentos_financeiros` (fonte única; nulo sem fornecedor).
   */
  cartaoFornecedor: {
    parcelaId: string;
    fornecedorId: string | null;
    fornecedor: string | null;
    opcoes: { id: string; nome: string }[];
    repasseEsperado: bigint | null;
  } | null;
  /** Contas divergentes ou contestadas + comissões pendentes + parcelas recebidas com diferença ou canceladas. */
  divergencias: number;
  /** Só para quem vê a camada estratégica; montada só para esses perfis. */
  estrategico?: {
    planejada: MargemPlanejada;
    real: MargemReal | ErroCalculo;
    ponte: LinhaPonte[] | ErroCalculo;
  };
};

type ParcelaLinha = typeof parcelasReceber.$inferSelect;
type ContaLinha = { c: typeof contasPagar.$inferSelect; fornecedor: string | null };
type PagamentoLinha = typeof pagamentosFornecedor.$inferSelect & { faturaFechamento: string | null; cartaoNome: string | null };
type ComissaoLinha = typeof comissoes.$inferSelect;
type VersaoLinha = typeof versoesPrecificacao.$inferSelect;

const soma = (xs: bigint[]) => xs.reduce((a, x) => a + x, 0n);

/** Contas com pagamentos e comissão (as canceladas ficam de fora das comissões), na ordem das linhas dadas. */
function montarContas(cs: ContaLinha[], pags: PagamentoLinha[], coms: ComissaoLinha[]): { contas: ContaVendida[]; comissoes: ComissaoVendida[] } {
  const contaPorId = new Map(cs.map((x) => [x.c.id, x]));
  const comissoesVendidas = coms
    .filter((c) => c.status !== "cancelada" && contaPorId.has(c.contaId))
    .map((c): ComissaoVendida => {
      const conta = contaPorId.get(c.contaId)!;
      return {
        id: c.id,
        contaId: c.contaId,
        fornecedor: conta.fornecedor ?? conta.c.descricao,
        aereo: conta.c.aereo,
        baseBrl: c.baseBrl,
        pct: c.pct,
        valorPrevisto: c.valorPrevisto,
        previstaPara: c.previstaPara,
        status: c.status,
        recebidaEm: c.recebidaEm,
        valorRecebido: c.valorRecebido,
        motivo: c.motivo,
        pendente: c.status === "prevista",
      };
    });
  const contas = cs.map(({ c, fornecedor }): ContaVendida => ({
    id: c.id,
    itemId: c.itemId,
    descricao: c.descricao,
    fornecedorId: c.fornecedorId,
    fornecedor,
    aereo: c.aereo,
    moeda: c.moeda,
    valorOriginal: c.valorOriginal,
    cambioAplicado: c.cambioAplicado,
    previstoVendaBrl: c.previstoVendaBrl,
    previstoBrl: c.previstoBrl,
    comissaoPct: c.comissaoPct,
    comissaoTipo: c.comissaoTipo,
    comissaoTipoVenda: c.comissaoTipoVenda,
    descontoAVistaPct: c.descontoAVistaPct,
    forma: c.forma,
    status: c.status,
    contestacao: c.contestacao,
    contestadaEm: c.contestadaEm,
    motivoPrevisto: c.motivoPrevisto,
    divergente: c.previstoBrl !== c.previstoVendaBrl,
    contestada: c.contestacao !== null,
    pagamentos: pags
      .filter((p) => p.contaId === c.id)
      .map((p) => ({
        id: p.id,
        numero: p.numero,
        vencimento: p.vencimento,
        valorOriginal: p.valorOriginal,
        valorBrlPrevisto: p.valorBrlPrevisto,
        status: p.status,
        pagoEm: p.pagoEm,
        valorOriginalPago: p.valorOriginalPago,
        cambioEfetivo: p.cambioEfetivo,
        valorBrlPago: p.valorBrlPago,
        peloRepasse: p.repasseParcelaId !== null,
        cartaoId: p.cartaoId,
        fatura: p.faturaCartaoId && p.faturaFechamento && p.cartaoNome ? { id: p.faturaCartaoId, cartao: p.cartaoNome, fechamento: p.faturaFechamento } : null,
      })),
    comissao: comissoesVendidas.find((x) => x.contaId === c.id) ?? null,
  }));
  return { contas, comissoes: comissoesVendidas };
}

export type MargensVendida = NonNullable<ViagemVendida["estrategico"]>;

/**
 * Margem planejada (o `resultado` da versão), margem real e ponte de uma viagem vendida, sem I/O. `impostoPct`
 * nulo (regras da versão ilegíveis) ou cálculo impossível: real e ponte ficam com o erro.
 */
function calcularMargens(d: {
  versao: VersaoLinha;
  fim: string;
  impostoPct: string | null;
  parcelas: ParcelaLinha[];
  contas: ContaVendida[];
  comissoes: ComissaoVendida[];
}): MargensVendida {
  const { versao } = d;
  const planejada = planejadaDaVersao(versao.resultado as ResultadoVersao);
  const erro: ErroCalculo = { erro: MSG_NAO_CALCULA_MARGEM };
  let real: MargemReal | ErroCalculo = erro;
  let ponte: LinhaPonte[] | ErroCalculo = erro;
  if (d.impostoPct === null) return { planejada, real, ponte };
  const impostoPct = d.impostoPct;
  try {
    const snapshot = versao.snapshot as Snapshot;
    const taxaRoteiro = taxaRoteiroDoSnapshot(snapshot);
    const ativas = d.contas.filter((c) => c.status !== "cancelada");
    /** Em reais: pago nas linhas pagas + previsto nas em aberto; nenhuma paga = previsto atual da conta. */
    const pagoBrl = (c: ContaVendida) =>
      c.pagamentos.some((p) => p.status === "pago")
        ? soma(c.pagamentos.map((p) => (p.status === "pago" ? (p.valorBrlPago ?? 0n) : p.valorBrlPrevisto)))
        : null;
    /** Previsto e comissão que a conta teria na venda com o tipo `tipo` (snapshot da versão vendida). */
    const naVenda = (c: ContaVendida, tipo: ComissaoTipo) => {
      const modalidade: Record<string, "net" | "comissionado"> = c.fornecedorId
        ? { [c.fornecedorId]: tipo === "a_receber" ? "comissionado" : "net" }
        : {};
      const g = contasDoSnapshot(snapshot, modalidade, d.fim).find((x) => x.itemId === c.itemId);
      if (!g) throw new Error(MSG_NAO_CALCULA_MARGEM);
      return { previsto: g.previstoBrl, comissao: g.comissao?.valor ?? 0n };
    };
    const contasMargem = ativas.map((c) => ({
      aereo: c.aereo,
      previstoBrl: c.previstoBrl,
      pagoBrl: pagoBrl(c),
      rotulo: c.fornecedor ?? c.descricao,
      moeda: c.moeda,
      previstoVendaBrl: c.previstoVendaBrl,
      pagos: c.pagamentos
        .filter((p) => p.status === "pago")
        .map((p) => ({ valorOriginalPago: p.valorOriginalPago ?? 0n, valorBrlPago: p.valorBrlPago ?? 0n })),
      cambioVenda: c.cambioAplicado,
      comissaoNaVenda: c.comissaoTipoVenda === "a_receber" ? naVenda(c, "a_receber").comissao : 0n,
      trocaDeTipo:
        c.comissaoTipo === c.comissaoTipoVenda
          ? undefined
          : {
              para: c.comissaoTipo,
              previstoNaVenda: naVenda(c, c.comissaoTipo).previsto,
              comissaoPrevista: c.comissao?.valorPrevisto ?? 0n,
            },
    }));
    const parcelasMargem = d.parcelas.map((p) => ({
      valor: p.valor,
      recebida: p.status === "recebida",
      taxaEfetiva: p.taxaEfetiva,
      taxaPrevista: p.taxaPrevista,
      valorRecebido: p.valorRecebido,
      cancelada: p.status === "cancelada",
      numero: p.numero,
      totalParcelas: p.totalParcelas,
    }));
    const comissoesAtivas = d.comissoes.filter((c) => ativas.some((k) => k.id === c.contaId));
    try {
      real = margemReal({
        preco: versao.preco,
        contas: contasMargem,
        comissoesRecebidas: soma(comissoesAtivas.filter((c) => !c.aereo && c.status === "recebida").map((c) => c.valorRecebido ?? 0n)),
        parcelas: parcelasMargem,
        fixo: planejada.fixo,
        impostoPct,
        taxaRoteiro,
      });
    } catch {
      real = erro;
    }
    try {
      ponte = ponteDaMargem({
        planejada,
        preco: versao.preco,
        impostoPct,
        taxaRoteiro,
        contas: contasMargem,
        comissoes: comissoesAtivas.map((c) => ({
          fornecedor: c.fornecedor,
          aereo: c.aereo,
          valorPrevisto: c.valorPrevisto,
          valorRecebido: c.status === "recebida" ? c.valorRecebido : null,
          naoRecebida: c.status === "nao_recebida",
        })),
        parcelas: parcelasMargem,
      }).linhas;
    } catch {
      ponte = erro;
    }
  } catch {
    // snapshot ilegível: margem e ponte ficam com o erro
  }
  return { planejada, real, ponte };
}

/** Imposto sobre a margem por versão de regras (uma leitura por id; sem checagem de acesso). Ilegível: nulo. */
async function impostoPorRegras(ids: string[]): Promise<Map<string, string | null>> {
  const unicos = [...new Set(ids)];
  const linhas = unicos.length === 0 ? [] : await db.select({ id: regrasVersoes.id, valores: regrasVersoes.valores }).from(regrasVersoes).where(inArray(regrasVersoes.id, unicos));
  const porId = new Map<string, string | null>(unicos.map((id) => [id, null]));
  for (const l of linhas) {
    try {
      porId.set(l.id, normalizarRegras(l.valores).impostoSobreMargemPct);
    } catch {
      porId.set(l.id, null);
    }
  }
  return porId;
}

/** Contas ativas das viagens (com o fornecedor), na ordem dos itens. */
function contasDe(viagemIds: string[]) {
  return db
    .select({ c: contasPagar, fornecedor: fornecedores.nome })
    .from(contasPagar)
    .innerJoin(itensViagem, eq(itensViagem.id, contasPagar.itemId))
    .leftJoin(fornecedores, eq(fornecedores.id, contasPagar.fornecedorId))
    .where(and(inArray(contasPagar.viagemId, viagemIds), isNull(contasPagar.excluidoEm)))
    .orderBy(asc(itensViagem.ordem), asc(contasPagar.id));
}

/** Pagamentos das contas, com a fatura do cartão corporativo (fechamento e nome do cartão) quando estão numa. */
function pagamentosDe(contaIds: string[]): Promise<PagamentoLinha[]> {
  return contaIds.length === 0
    ? Promise.resolve([])
    : db
        .select({ ...getTableColumns(pagamentosFornecedor), faturaFechamento: faturasCartao.fechamento, cartaoNome: cartoesCorporativos.nome })
        .from(pagamentosFornecedor)
        .leftJoin(faturasCartao, eq(faturasCartao.id, pagamentosFornecedor.faturaCartaoId))
        .leftJoin(cartoesCorporativos, eq(cartoesCorporativos.id, faturasCartao.cartaoId))
        .where(inArray(pagamentosFornecedor.contaId, contaIds))
        .orderBy(asc(pagamentosFornecedor.numero));
}

function comissoesDe(viagemIds: string[]) {
  return db
    .select()
    .from(comissoes)
    // Canceladas (conta passou a `descontada`) ficam fora da ficha, da margem e da ponte.
    .where(and(inArray(comissoes.viagemId, viagemIds), ne(comissoes.status, "cancelada")))
    .orderBy(asc(comissoes.previstaPara));
}

/**
 * Margens (planejada, real, ponte) das viagens vendidas, em lote: versões, parcelas, contas, pagamentos e
 * comissões numa leitura cada, regras uma vez por versão. Uso interno, **sem checagem de acesso**: só chamar
 * depois de conferir `veCamadaEstrategica`. Id sem venda fica de fora.
 */
export async function margensVendidas(viagemIds: string[]): Promise<Map<string, MargensVendida>> {
  const resultado = new Map<string, MargensVendida>();
  const ids = [...new Set(viagemIds)];
  if (ids.length === 0) return resultado;
  const vs = await db
    .select({ viagemId: vendas.viagemId, fim: viagens.fim, versao: versoesPrecificacao })
    .from(vendas)
    .innerJoin(viagens, eq(viagens.id, vendas.viagemId))
    .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, vendas.versaoId))
    .where(inArray(vendas.viagemId, ids));
  if (vs.length === 0) return resultado;
  const comVenda = vs.map((v) => v.viagemId);
  const [ps, cs, coms, impostos] = await Promise.all([
    db.select().from(parcelasReceber).where(inArray(parcelasReceber.viagemId, comVenda)).orderBy(asc(parcelasReceber.numero)),
    contasDe(comVenda),
    comissoesDe(comVenda),
    impostoPorRegras(vs.map((v) => v.versao.regrasVersaoId)),
  ]);
  const pags = await pagamentosDe(cs.map((x) => x.c.id));
  for (const v of vs) {
    const csDa = cs.filter((x) => x.c.viagemId === v.viagemId);
    const { contas, comissoes: comissoesDa } = montarContas(csDa, pags, coms.filter((c) => c.viagemId === v.viagemId));
    resultado.set(
      v.viagemId,
      calcularMargens({
        versao: v.versao,
        fim: v.fim,
        impostoPct: impostos.get(v.versao.regrasVersaoId) ?? null,
        parcelas: ps.filter((p) => p.viagemId === v.viagemId),
        contas,
        comissoes: comissoesDa,
      }),
    );
  }
  return resultado;
}

/**
 * Viagem vendida: cabeçalho, status derivado (hoje em Cuiabá), resumo (vendido, recebido, a receber, pago a
 * fornecedores, a pagar), parcelas, contas com pagamentos e comissão, comissões e divergências. Qualquer perfil
 * logado; margem planejada × real e ponte só na camada estratégica. `null` se não existe ou não está vendida.
 */
export async function obterViagemVendida(viagemId: string): Promise<ViagemVendida | null> {
  const usuario = await exigirPerfil();
  if (!ehUuid(viagemId)) return null;
  const [l] = await db
    .select({
      v: viagens,
      venda: vendas,
      versao: versoesPrecificacao,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      consultor: usuarios.nome,
    })
    .from(viagens)
    .innerJoin(vendas, eq(vendas.viagemId, viagens.id))
    .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, vendas.versaoId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm), eq(viagens.status, "vendida")))
    .limit(1);
  if (!l) return null;
  const { v, venda, versao } = l;
  const estrategico = veCamadaEstrategica(usuario.perfil);
  const snapshot = versao.snapshot as Snapshot;

  const [ps, cs, coms] = await Promise.all([
    db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, v.id)).orderBy(asc(parcelasReceber.numero)),
    contasDe([v.id]),
    comissoesDe([v.id]),
  ]);
  const pags = await pagamentosDe(cs.map((x) => x.c.id));

  const parcelas = ps.map((p): ParcelaVendida => {
    const linha: ParcelaVendida = {
      id: p.id,
      numero: p.numero,
      totalParcelas: p.totalParcelas,
      vencimento: p.vencimento,
      valor: p.valor,
      meio: p.meio,
      rotuloMeio: ROTULO_MEIO[p.meio],
      status: p.status,
      recebidaEm: p.recebidaEm,
      valorRecebido: p.valorRecebido,
      observacao: p.observacao,
    };
    if (estrategico) {
      linha.taxaPrevista = p.taxaPrevista;
      linha.taxaEfetiva = p.taxaEfetiva;
    }
    return linha;
  });

  const { contas, comissoes: comissoesVendidas } = montarContas(cs, pags, coms);

  const ativas = contas.filter((c) => c.status !== "cancelada");
  const linhasAtivas = ativas.flatMap((c) => c.pagamentos);
  const recebidasComDiferenca = ps.filter((p) => p.status === "recebida" && p.valorRecebido !== null && p.valorRecebido !== p.valor);
  const resumo = {
    valorVendido: venda.total,
    recebido: soma(ps.filter((p) => p.status === "recebida").map((p) => p.valorRecebido ?? 0n)),
    aReceber: soma(ps.filter((p) => p.status === "a_receber").map((p) => p.valor)),
    diferencaRecebimento: soma(recebidasComDiferenca.map((p) => p.valorRecebido! - p.valor)),
    pagoFornecedores: soma(linhasAtivas.filter((p) => p.status === "pago").map((p) => p.valorBrlPago ?? 0n)),
    aPagar: soma(linhasAtivas.filter((p) => p.status !== "pago").map((p) => p.valorBrlPrevisto)),
  };

  // Cartão direto ativo: parcela `cartao_fornecedor` não cancelada (a mesma condição do `cartao_direto` da view e de
  // `vendaCartaoDireto`). Cancelada, a venda deixa de ser de cartão direto e as contas do fornecedor voltam à baixa.
  const parcelaCartao = ps.find((p) => p.meio === "cartao_fornecedor" && p.status !== "cancelada");
  let cartaoFornecedor: ViagemVendida["cartaoFornecedor"] = null;
  if (parcelaCartao) {
    const opcoes = new Map<string, string>();
    for (const c of contas) if (c.status !== "cancelada" && c.fornecedorId && c.fornecedor) opcoes.set(c.fornecedorId, c.fornecedor);
    const [linha] = venda.fornecedorCartaoId
      ? await db
          .select({ esperado: lancamentosFinanceiros.valorPrevisto })
          .from(lancamentosFinanceiros)
          .where(and(eq(lancamentosFinanceiros.origem, "parcela"), eq(lancamentosFinanceiros.id, parcelaCartao.id)))
      : [];
    const [nome] = venda.fornecedorCartaoId
      ? await db.select({ nome: fornecedores.nome }).from(fornecedores).where(eq(fornecedores.id, venda.fornecedorCartaoId))
      : [];
    cartaoFornecedor = {
      parcelaId: parcelaCartao.id,
      fornecedorId: venda.fornecedorCartaoId,
      fornecedor: nome?.nome ?? null,
      opcoes: [...opcoes].map(([id, nome]) => ({ id, nome })).sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR")),
      repasseEsperado: linha?.esperado ?? null,
    };
  }

  const status = statusDaViagem({
    status: v.status,
    inicio: v.inicio,
    fim: v.fim,
    conciliadaEm: v.conciliadaEm ? v.conciliadaEm.toISOString() : null,
    hoje: hojeEmCuiaba(),
  });

  const resposta: ViagemVendida = {
    id: v.id,
    codigo: formatarCodigoViagem(l.clienteCodigo, v.seq),
    cliente: l.cliente,
    destino: v.destino,
    inicio: v.inicio,
    fim: v.fim,
    passageiros: snapshot.passageiros.map((p) => p.nome),
    consultor: l.consultor,
    status,
    rotuloStatus: ROTULO_STATUS_VIAGEM[status],
    vendidaEm: v.vendidaEm,
    conciliadaEm: v.conciliadaEm,
    venda: {
      id: venda.id,
      aceiteEm: venda.aceiteEm,
      forma: rotuloForma(venda.forma as FormaPagamento),
      parcelas: venda.parcelas,
      primeiroVencimento: venda.primeiroVencimento,
      faturaNome: venda.faturaNome,
      faturaDocumento: formatarDocumento(venda.faturaDocumento),
      comprovante: venda.comprovante,
      observacao: venda.observacao,
    },
    resumo,
    parcelas,
    contas,
    comissoes: comissoesVendidas,
    cartaoFornecedor,
    divergencias:
      contas.filter((c) => c.divergente || c.contestada).length +
      comissoesVendidas.filter((c) => c.pendente).length +
      recebidasComDiferenca.length +
      ps.filter((p) => p.status === "cancelada").length,
  };

  if (estrategico) {
    const impostos = await impostoPorRegras([versao.regrasVersaoId]);
    resposta.estrategico = calcularMargens({
      versao,
      fim: v.fim,
      impostoPct: impostos.get(versao.regrasVersaoId) ?? null,
      parcelas: ps,
      contas,
      comissoes: comissoesVendidas,
    });
  }
  return resposta;
}
