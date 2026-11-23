import { z } from "zod";
import type { Moeda } from "./cambio";
import { arredondar, lerDecimal } from "./decimal";
import { lerPercentual, lerReais } from "./dinheiro";
import {
  custoLiquido,
  margemDaAprovacao,
  precoDoPacote,
  type FormaPagamento,
  type ItemCalc,
  type Rateio,
  type TipoItem,
} from "./precificacao";
import type { Regras } from "./regras";

// Versões de precificação (sem I/O): snapshot, resultado, forma de pagamento e entradas do envio/decisão.
// No snapshot e no resultado (JSON) o dinheiro vai como string de centavos ("330000").

export const MSG_SEM_ITEM_COTADO = "Inclua ao menos um item cotado";
export const msgSemCotacao = (servico: string) => `${servico} está sem cotação`;
export const MSG_JA_DECIDIDO = "Este pedido já foi decidido";
export const MOTIVO_SUBSTITUIDA = "Substituída por ajuste do Diretor";
export const MSG_MOTIVO = "Escreva o motivo da devolução";
export const MSG_PROPOSTA_INDISPONIVEL = "Proposta disponível só depois da aprovação do Diretor";
export const MSG_NAO_CALCULA = "Não foi possível calcular o preço com os Parâmetros vigentes";
export const MSG_ITEM_NAO_ENCONTRADO = "Item não encontrado";
export const MSG_COTACAO_NAO_ENCONTRADA = "Cotação não encontrada";
export const VALIDADE_PROPOSTA =
  "Orçamento sem caráter de reserva; os valores podem variar conforme as datas. Não inclui aéreo.";

export type CotacaoSnapshot = {
  id: string;
  fornecedorId: string | null;
  fornecedor: string | null;
  moeda: Moeda;
  valorOriginal: string;
  cambioComercial: string | null;
  cambioAplicado: string | null;
  cambioData: string | null;
  valorBrl: string;
  comissaoPct: string;
  descontoAVistaPct: string | null;
  tarifaFixa: string;
  /** Valor e/ou comissão trocados pelo Diretor na aprovação com ajuste (só no snapshot; a cotação não muda). */
  ajustadoPeloDiretor?: true;
};

export type ItemSnapshot = {
  id: string;
  ordem: number;
  tipo: TipoItem;
  cidade: string | null;
  servico: string;
  checkin: string | null;
  checkout: string | null;
  diarias: number | null;
  automatico: boolean;
  /** Todas as cotações ativas do item, mais antigas primeiro (criação, id). */
  cotacoes: CotacaoSnapshot[];
  /** Cotação usada no preço: a de pior custo (maior custo líquido, com o ajuste); empate fica com a mais antiga. */
  precificada: CotacaoSnapshot;
  /** Cotação escolhida (custo esperado); igual à precificada quando é a mesma. */
  escolhida: CotacaoSnapshot;
  /**
   * Legado (versões gravadas antes do ajuste por cotação): ajuste aplicado sobre todas as cotações do item.
   * O ajuste atual vai na própria cotação (`ajustadoPeloDiretor`); este campo não é mais gravado.
   */
  ajuste?: { valorFornecedor?: string; comissaoPct?: string };
};

/** O que foi precificado: cabeçalho da viagem e itens ativos (Taxa e Aéreo inclusos; Aéreo fica fora do cálculo). */
export type Snapshot = {
  destino: string;
  inicio: string;
  fim: string;
  passageiros: { id: string; nome: string }[];
  itens: ItemSnapshot[];
};

/**
 * Resultado gravado na versão: `margemDaAprovacao` (preço, pior custo, forma, dias, rateio, regras da versão)
 * serializada, mais `custoEscolhidas` (custo com as cotações escolhidas), `margemExtra` (pior − escolhidas) e
 * `precoCalculado` (preço da fórmula na forma; nulo se os Parâmetros não permitem calcular).
 */
export type ResultadoVersao = {
  custo: string;
  imposto: string;
  taxa: string;
  antes: string;
  antesPct: string;
  fixo: string;
  final: string;
  finalPct: string;
  diasCobertos: string;
  custoEscolhidas: string;
  margemExtra: string;
  precoCalculado: string | null;
  /**
   * Valores para o cliente, com as regras da versão: taxa de serviço (dias × taxa por dia), preço ao cliente
   * (preço + taxa de serviço), por pessoa (meio para cima) e o número de passageiros do snapshot. Ausentes em
   * versões gravadas antes deles (a proposta recalcula).
   */
  taxaServico?: string;
  precoCliente?: string;
  porPessoa?: string;
  numeroPassageiros?: number;
  /**
   * `nova_forma`: versão criada por `pedirNovaForma` (só a forma muda). Devolvida, a viagem volta a `aprovado`
   * com a versão aprovada anterior (a forma original continua valendo).
   */
  origem?: "nova_forma";
};

/** Cotação ativa como vem do banco (dinheiro em bigint). */
export type CotacaoLida = {
  id: string;
  fornecedorId: string | null;
  fornecedor: string | null;
  moeda: Moeda;
  valorOriginal: bigint;
  cambioComercial: string | null;
  cambioAplicado: string | null;
  cambioData: string | null;
  valorBrl: bigint;
  comissaoPct: string;
  descontoAVistaPct: string | null;
  tarifaFixa: bigint;
  escolhida: boolean;
};

export type ItemLido = Omit<ItemSnapshot, "cotacoes" | "precificada" | "escolhida" | "ajuste"> & { cotacoes: CotacaoLida[] };

function snapCotacao(c: CotacaoLida): CotacaoSnapshot {
  return {
    id: c.id,
    fornecedorId: c.fornecedorId,
    fornecedor: c.fornecedor,
    moeda: c.moeda,
    valorOriginal: c.valorOriginal.toString(),
    cambioComercial: c.cambioComercial,
    cambioAplicado: c.cambioAplicado,
    cambioData: c.cambioData,
    valorBrl: c.valorBrl.toString(),
    comissaoPct: c.comissaoPct,
    descontoAVistaPct: c.descontoAVistaPct,
    tarifaFixa: c.tarifaFixa.toString(),
  };
}

export function calcDe(i: Pick<ItemSnapshot, "id" | "tipo" | "servico" | "diarias" | "ajuste">, c: CotacaoSnapshot): ItemCalc {
  return {
    id: i.id,
    tipo: i.tipo,
    nome: i.servico,
    diarias: i.diarias,
    valorFornecedor: BigInt(i.ajuste?.valorFornecedor ?? c.valorBrl),
    comissaoPct: i.ajuste?.comissaoPct ?? c.comissaoPct,
    descontoAVistaPct: c.descontoAVistaPct,
  };
}

/**
 * Confere os itens (todo item com cotação; ≥ 1 cotado que não é Taxa nem Aéreo) e monta os itens do snapshot
 * com a cotação de pior custo e a escolhida. Devolve a mensagem de recusa quando não dá para enviar.
 */
export function itensDoSnapshot(itens: ItemLido[]): ItemSnapshot[] | { erro: string } {
  const semCotacao = itens.find((i) => i.cotacoes.length === 0);
  if (semCotacao) return { erro: msgSemCotacao(semCotacao.servico) };
  if (!itens.some((i) => i.tipo !== "Taxa" && i.tipo !== "Aéreo")) return { erro: MSG_SEM_ITEM_COTADO };
  return itens.map(({ cotacoes, ...i }) => {
    const snaps = cotacoes.map(snapCotacao);
    const pior = piorCotacao(i, snaps);
    const escolhida = cotacoes.findIndex((c) => c.escolhida);
    return { ...i, cotacoes: snaps, precificada: pior, escolhida: escolhida === -1 ? pior : snaps[escolhida] };
  });
}

/** Maior custo líquido (com o ajuste do item); empate fica com a primeira (a mais antiga). */
function piorCotacao(i: Pick<ItemSnapshot, "id" | "tipo" | "servico" | "diarias" | "ajuste">, cs: CotacaoSnapshot[]): CotacaoSnapshot {
  let pior = cs[0];
  let piorCusto = custoLiquido(calcDe(i, pior));
  for (const c of cs.slice(1)) {
    const cl = custoLiquido(calcDe(i, c));
    if (cl > piorCusto) [pior, piorCusto] = [c, cl];
  }
  return pior;
}

/** Ajuste do Diretor numa cotação do item (padrão: a precificada); valor em centavos de real, comissão "10.000". */
export type AjusteCotacao = { cotacaoId?: string; valorFornecedor?: string; comissaoPct?: string };

/**
 * Valor em reais trocado pelo Diretor: `valorBrl` = o valor; em moeda estrangeira, `valorOriginal` volta pelo
 * câmbio aplicado da cotação (centavos da moeda, meio para cima).
 */
function ajustarCotacao(c: CotacaoSnapshot, a: AjusteCotacao): CotacaoSnapshot {
  const nova: CotacaoSnapshot = { ...c, ajustadoPeloDiretor: true };
  if (a.valorFornecedor !== undefined) {
    const brl = BigInt(a.valorFornecedor);
    nova.valorBrl = brl.toString();
    nova.valorOriginal =
      c.moeda === "BRL" || !c.cambioAplicado ? brl.toString() : arredondar(brl * 10_000n, lerDecimal(c.cambioAplicado, 4)).toString();
  }
  if (a.comissaoPct !== undefined) nova.comissaoPct = a.comissaoPct;
  return nova;
}

/**
 * Aplica o ajuste do Diretor a uma cotação do item (cópia; padrão: a precificada no momento) e reescolhe a de
 * pior custo com os valores ajustados. A escolhida só muda se for a ajustada. Cotação que não é do item → erro.
 */
export function ajustarItem(i: ItemSnapshot, ajuste: AjusteCotacao): ItemSnapshot | { erro: string } {
  const todas = i.cotacoes?.length ? i.cotacoes : [i.precificada, ...(i.escolhida.id === i.precificada.id ? [] : [i.escolhida])];
  const alvoId = (ajuste.cotacaoId ?? i.precificada.id).toLowerCase();
  const k = todas.findIndex((c) => c.id === alvoId);
  if (k === -1) return { erro: MSG_COTACAO_NAO_ENCONTRADA };
  const nova = ajustarCotacao(todas[k], ajuste);
  const cotacoes = todas.map((c, j) => (j === k ? nova : c));
  return {
    ...i,
    cotacoes,
    escolhida: i.escolhida.id === nova.id ? nova : i.escolhida,
    precificada: piorCotacao(i, cotacoes),
  };
}

/** Ajuste do Diretor num item: cotação (padrão: a precificada), valor do fornecedor em centavos e/ou comissão ("10.500"). */
export type AjusteItem = { itemId: string; cotacaoId?: string; valorFornecedor?: bigint; comissaoPct?: string };

/** Cópia do snapshot com os ajustes por cotação; erro se o item não está no snapshot (ou é Aéreo) ou a cotação não é dele. */
export function ajustarSnapshot(s: Snapshot, ajustes: AjusteItem[]): Snapshot | { erro: string } {
  const itens: ItemSnapshot[] = [...s.itens];
  for (const a of ajustes) {
    const k = itens.findIndex((x) => x.id === a.itemId.toLowerCase());
    if (k === -1 || itens[k].tipo === "Aéreo") return { erro: MSG_ITEM_NAO_ENCONTRADO };
    const ajuste: AjusteCotacao = {};
    if (a.cotacaoId !== undefined) ajuste.cotacaoId = a.cotacaoId;
    if (a.valorFornecedor !== undefined) ajuste.valorFornecedor = a.valorFornecedor.toString();
    if (a.comissaoPct !== undefined) ajuste.comissaoPct = a.comissaoPct;
    const r = ajustarItem(itens[k], ajuste);
    if ("erro" in r) return r;
    itens[k] = r;
  }
  return { ...s, itens };
}

/** Itens para `precificar` (pior custo, Aéreo fora) e os custos pelo pior e pelas escolhidas. */
export function custosDoSnapshot(s: Snapshot): { itens: ItemCalc[]; custo: bigint; custoEscolhidas: bigint } {
  const terrestre = s.itens.filter((i) => i.tipo !== "Aéreo");
  const itens = terrestre.map((i) => calcDe(i, i.precificada));
  const custo = itens.reduce((a, i) => a + custoLiquido(i), 0n);
  const custoEscolhidas = terrestre.reduce((a, i) => a + custoLiquido(calcDe(i, i.escolhida)), 0n);
  return { itens, custo, custoEscolhidas };
}

/** Preço da fórmula na forma, pelo pior custo; `null` se os Parâmetros não permitem calcular. */
export function precoCalculado(custo: bigint, forma: FormaPagamento, regras: Regras): bigint | null {
  try {
    return precoDoPacote(custo, forma, regras);
  } catch {
    return null;
  }
}

const str = (x: bigint) => x.toString();

export function resultadoDaVersao(
  s: Snapshot,
  preco: bigint,
  forma: FormaPagamento,
  dias: number,
  rateio: Rateio,
  regras: Regras,
): ResultadoVersao {
  const { custo, custoEscolhidas } = custosDoSnapshot(s);
  const m = margemDaAprovacao(preco, custo, forma, dias, rateio, regras);
  const calc = precoCalculado(custo, forma, regras);
  const taxaServico = BigInt(dias) * BigInt(regras.taxaServicoPorDia);
  const precoCliente = preco + taxaServico;
  const numeroPassageiros = s.passageiros.length;
  return {
    custo: str(m.custo),
    imposto: str(m.imposto),
    taxa: str(m.taxa),
    antes: str(m.antes),
    antesPct: m.antesPct,
    fixo: str(m.fixo),
    final: str(m.final),
    finalPct: m.finalPct,
    diasCobertos: m.diasCobertos,
    custoEscolhidas: str(custoEscolhidas),
    margemExtra: str(custo - custoEscolhidas),
    precoCalculado: calc === null ? null : str(calc),
    taxaServico: str(taxaServico),
    precoCliente: str(precoCliente),
    porPessoa: str(arredondar(precoCliente, BigInt(Math.max(numeroPassageiros, 1)))),
    numeroPassageiros,
  };
}

/** Rótulo da forma para o cliente: "Pix", "Boleto em 4x", "Cartão em 6x com antecipação". */
export function rotuloForma(f: FormaPagamento): string {
  switch (f.tipo) {
    case "pix":
      return "Pix";
    case "cartao_fornecedor":
      return "Cartão direto no fornecedor";
    case "boleto":
      return `Boleto em ${f.parcelas}x`;
    case "credito":
      return `Cartão em ${f.parcelas}x${f.antecipado ? " com antecipação" : ""}`;
  }
}

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

const MAX_CENTAVOS = 999_999_999_999n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const RATEIOS = ["por_dia", "por_faturamento", "por_viagem"] as const satisfies readonly Rateio[];

/** Forma de pagamento: pix e cartão direto em 1x; boleto e crédito de 1 ao parcelamento máximo. */
export function formaSchema(parcelamentoMaximo: number) {
  return z
    .object(
      {
        tipo: z.enum(["pix", "cartao_fornecedor", "boleto", "credito"], { error: "Forma de pagamento inválida" }),
        parcelas: z.number({ error: "Parcelas inválidas" }).int("Parcelas inválidas"),
        antecipado: z.boolean({ error: "Forma de pagamento inválida" }).optional(),
      },
      { error: "Forma de pagamento inválida" },
    )
    .superRefine((f, ctx) => {
      const max = f.tipo === "pix" || f.tipo === "cartao_fornecedor" ? 1 : Math.min(parcelamentoMaximo, 10);
      if (f.parcelas < 1 || f.parcelas > max) ctx.addIssue({ code: "custom", message: "Parcelas inválidas", path: ["parcelas"] });
    })
    .transform((f): FormaPagamento =>
      f.tipo === "credito" && f.antecipado ? { tipo: "credito", parcelas: f.parcelas, antecipado: true } : { tipo: f.tipo, parcelas: f.parcelas },
    );
}

/** Reais em formato brasileiro; `positivo` recusa zero. */
const dinheiro = (positivo: boolean) => z.string({ error: "Valor inválido" }).transform((v, ctx) => {
  let c: bigint;
  try {
    c = lerReais(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Valor inválido" });
    return z.NEVER;
  }
  if (positivo && c <= 0n) {
    ctx.addIssue({ code: "custom", message: "Valor inválido" });
    return z.NEVER;
  }
  if (c > MAX_CENTAVOS) {
    ctx.addIssue({ code: "custom", message: "Valor muito alto" });
    return z.NEVER;
  }
  return c;
});
const reais = dinheiro(true);

const percentual = z.string({ error: "Percentual inválido" }).transform((v, ctx) => {
  let p: string;
  try {
    p = lerPercentual(v);
  } catch {
    ctx.addIssue({ code: "custom", message: "Percentual inválido" });
    return z.NEVER;
  }
  if (Number(p) > 100) {
    ctx.addIssue({ code: "custom", message: "Percentual inválido" });
    return z.NEVER;
  }
  return p;
});

/** Envio: preço opcional (padrão: o calculado), forma e "o que mudou". */
export function envioSchema(parcelamentoMaximo: number) {
  return z.strictObject({
    preco: z
      .string({ error: "Valor inválido" })
      .nullish()
      .transform((v) => (v && v.trim() ? v : null))
      .pipe(reais.nullable()),
    forma: formaSchema(parcelamentoMaximo),
    alteracao: z
      .string({ error: "Texto inválido" })
      .trim()
      .max(2000, "Texto muito longo")
      .nullish()
      .transform((v) => (v ? v : null)),
  });
}

/** Ajuste do Diretor: preço, forma, rateio e valores por item (só no snapshot da nova versão). */
export function ajusteSchema(parcelamentoMaximo: number) {
  return z.strictObject({
    preco: reais,
    forma: formaSchema(parcelamentoMaximo),
    rateio: z.enum(RATEIOS, { error: "Forma de rateio inválida" }).optional(),
    itens: z
      .array(
        z.strictObject({
          itemId: z.string({ error: MSG_ITEM_NAO_ENCONTRADO }).regex(UUID, MSG_ITEM_NAO_ENCONTRADO),
          cotacaoId: z.string({ error: MSG_COTACAO_NAO_ENCONTRADA }).regex(UUID, MSG_COTACAO_NAO_ENCONTRADA).optional(),
          valorFornecedor: dinheiro(false).optional(),
          comissaoPct: percentual.optional(),
        }),
        { error: "Itens inválidos" },
      )
      .max(500, "Itens demais")
      .optional(),
  });
}

export const motivoSchema = z.string({ error: MSG_MOTIVO }).trim().min(1, MSG_MOTIVO).max(4000, "Texto muito longo");
