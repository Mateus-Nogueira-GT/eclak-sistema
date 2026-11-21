import { z } from "zod";
import type { Moeda } from "./cambio";
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
export const MSG_MOTIVO = "Escreva o motivo da devolução";
export const MSG_PROPOSTA_INDISPONIVEL = "Proposta disponível só depois da aprovação do Diretor";
export const MSG_NAO_CALCULA = "Não foi possível calcular o preço com os Parâmetros vigentes";
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
  /** Cotação usada no preço: a de pior custo (maior custo líquido). */
  precificada: CotacaoSnapshot;
  /** Cotação escolhida (custo esperado); igual à precificada quando é a mesma. */
  escolhida: CotacaoSnapshot;
  /** Ajuste do Diretor, aplicado sobre as duas cotações no cálculo (valor em centavos de real, "10.000"). */
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

export type ItemLido = Omit<ItemSnapshot, "precificada" | "escolhida" | "ajuste"> & { cotacoes: CotacaoLida[] };

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

function calcDe(i: Omit<ItemSnapshot, "precificada" | "escolhida">, c: CotacaoSnapshot): ItemCalc {
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
    let pior = 0;
    let piorCusto = custoLiquido(calcDe(i, snaps[0]));
    for (let k = 1; k < snaps.length; k++) {
      const cl = custoLiquido(calcDe(i, snaps[k]));
      if (cl > piorCusto) [pior, piorCusto] = [k, cl];
    }
    const escolhida = cotacoes.findIndex((c) => c.escolhida);
    return { ...i, precificada: snaps[pior], escolhida: snaps[escolhida === -1 ? pior : escolhida] };
  });
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
          itemId: z.string({ error: "Item não encontrado" }).regex(UUID, "Item não encontrado"),
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
