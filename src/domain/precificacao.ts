import { arredondar, lerDecimal } from "./decimal";
import type { Regras } from "./regras";

// Fórmulas de precificação do terrestre (sem I/O).
//
// Formatos:
//  - dinheiro: `bigint` em centavos de real;
//  - percentuais de entrada: string decimal ("19.000", "7.7367"), até 4 casas;
//  - `taxaPct` / `pct` de forma de pagamento: string com 4 casas ("3.4700");
//  - margens e percentuais de resultado (`...Pct`): string com 1 casa, meio para cima ("19.0", "-20.0");
//  - `diasCobertos`: string com 1 casa ("18.4").
// Contas de percentual em aritmética racional sobre `bigint` (multiplica antes, divide no fim),
// com um único arredondamento meio para cima por valor de linha (`arredondar`).

export const TIPOS_ITEM = [
  "Hotelaria",
  "Trem",
  "Transfer",
  "Carro",
  "Passeio",
  "Ingresso",
  "Seguro",
  "Outro",
  "Taxa",
  "Aéreo",
] as const;
export type TipoItem = (typeof TIPOS_ITEM)[number];

/** Item da precificação. `valorFornecedor` em centavos de real; `Taxa` = taxa de roteiro; `Aéreo` nunca entra no cálculo. */
export type ItemCalc = {
  id: string;
  tipo: TipoItem;
  nome: string;
  diarias: number | null;
  valorFornecedor: bigint;
  comissaoPct: string;
  descontoAVistaPct: string | null;
};

export type FormaPagamento = {
  tipo: "pix" | "cartao_fornecedor" | "boleto" | "credito";
  parcelas: number;
  antecipado?: boolean;
};

export const FORMAS_SIMULADOR: { rotulo: string; forma: FormaPagamento }[] = [
  { rotulo: "Pix / cartão direto no fornecedor", forma: { tipo: "pix", parcelas: 1 } },
  { rotulo: "Crédito 1x", forma: { tipo: "credito", parcelas: 1 } },
  { rotulo: "Crédito 2x a 6x (referência)", forma: { tipo: "credito", parcelas: 6 } },
  { rotulo: "Crédito 7x a 10x", forma: { tipo: "credito", parcelas: 10 } },
  { rotulo: "6x com antecipação", forma: { tipo: "credito", parcelas: 6, antecipado: true } },
];

/** Índice em `FORMAS_SIMULADOR` da forma de referência (2x a 6x): é a que define `compensacao` e `valorFinal` dos itens. */
export const FORMA_REFERENCIA = 2;

/** 1 (100%) na escala dos percentuais: 1 unidade = 0,0001% = 10⁻⁶. */
const E = 1_000_000n;

/** Percentual em string → unidades de 10⁻⁶ (E = 100%). */
const pct = (p: string) => lerDecimal(p, 4);

/** Percentual de item (comissão, desconto à vista): de 0 a 100, até 4 casas. */
function pctItem(p: string): bigint {
  let u: bigint;
  try {
    u = pct(p);
  } catch {
    throw new Error("Percentual inválido");
  }
  if (u > E) throw new Error("Percentual inválido");
  return u;
}

/** Valida diárias (inteiro ≥ 0 ou nulo) e percentuais do item; lança com mensagem clara. */
function validarItem(i: ItemCalc): void {
  if (i.diarias !== null && !(Number.isInteger(i.diarias) && i.diarias >= 0)) throw new Error("Diárias inválidas");
  pctItem(i.comissaoPct);
  if (i.descontoAVistaPct !== null) pctItem(i.descontoAVistaPct);
}

function validarDias(dias: number): void {
  if (!Number.isInteger(dias) || dias < 1) throw new Error("Dias inválidos");
}

function formatarEscala(v: bigint, casas: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(casas);
  const dec = casas > 0 ? "." + (abs % base).toString().padStart(casas, "0") : "";
  return `${neg ? "-" : ""}${abs / base}${dec}`;
}

/** Percentual de numerador/denominador com 1 casa ("19.0"). */
function pct1(numerador: bigint, denominador: bigint): string {
  if (denominador === 0n) return "0.0";
  return formatarEscala(arredondar(numerador * 1000n, denominador), 1);
}

const formatarPct4 = (unidades: bigint) => formatarEscala(unidades, 4);

/** Taxa da forma de pagamento: `pct` com 4 casas; `fixo` em centavos. */
export function taxaDaForma(f: FormaPagamento, r: Regras): { pct: string; fixo: bigint } {
  const t = r.taxas;
  switch (f.tipo) {
    case "pix":
      return { pct: formatarPct4(pct(t.pix)), fixo: 0n };
    case "cartao_fornecedor":
      return { pct: formatarPct4(pct(t.cartaoDiretoFornecedor)), fixo: 0n };
    case "boleto":
      if (!Number.isInteger(f.parcelas) || f.parcelas < 1) throw new Error("Parcelas inválidas");
      return { pct: formatarPct4(0n), fixo: BigInt(t.boletoPorBoleto) * BigInt(f.parcelas) };
    case "credito": {
      const n = f.parcelas;
      if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error("Parcelas inválidas");
      let u = pct(n === 1 ? t.credito1x : n <= 6 ? t.credito2a6x : t.credito7a10x);
      if (f.antecipado) {
        // Interpolação linear entre 1 e 10 parcelas, arredondada a 4 casas do percentual.
        const a1 = pct(t.antecipacao1Parcela);
        const a10 = pct(t.antecipacao10Parcelas);
        u += a1 + arredondar((a10 - a1) * BigInt(n - 1), 9n);
      }
      return { pct: formatarPct4(u), fixo: 0n };
    }
  }
}

/** valor × (1 − comissão), em centavos. */
export function custoLiquido(i: ItemCalc): bigint {
  validarItem(i);
  return arredondar(i.valorFornecedor * (E - pctItem(i.comissaoPct)), E);
}

/** custo líquido × (1 − desconto à vista); sem desconto = custo líquido. */
export function custoAVista(i: ItemCalc): bigint {
  const cl = custoLiquido(i);
  if (i.descontoAVistaPct === null) return cl;
  return arredondar(cl * (E - pctItem(i.descontoAVistaPct)), E);
}

/** Venda do item pelas regras por item. Lança para `Aéreo`, que fica fora da precificação. */
export function vendaDoItem(i: ItemCalc, r: Regras): bigint {
  validarItem(i);
  const v = i.valorFornecedor;
  switch (i.tipo) {
    case "Aéreo":
      throw new Error("Aéreo fica fora da precificação do terrestre");
    case "Taxa":
      return v;
    case "Hotelaria":
      if (i.diarias && v > BigInt(r.limiteDiariaSemReajuste) * BigInt(i.diarias)) return v;
      return arredondar(custoLiquido(i) * E, E - pct(r.ganhoMinimoHotelPct));
    case "Trem":
      return arredondar(v * (E + pct(r.markupTremPct)), E);
    default: {
      const m = r.markupServicos;
      const markup = pct(v <= BigInt(m.ate) ? m.pctAte : m.pctAcima);
      return arredondar(v * (E + markup), E);
    }
  }
}

/**
 * Preço P do pacote que deixa a margem líquida `margemPct` sobre P:
 * P = ((1 − imposto)·C + fixo) / ((1 − imposto) − taxa% − margem), arredondado a centavo.
 */
export function precoDoPacote(custo: bigint, f: FormaPagamento, r: Regras, margemPct: string = r.margemAlvoPct): bigint {
  const t = pct(r.impostoSobreMargemPct);
  const taxa = taxaDaForma(f, r);
  const den = E - t - pct(taxa.pct) - pct(margemPct);
  if (den <= 0n) throw new Error("Taxas e margem somam 100% ou mais");
  return arredondar((E - t) * custo + taxa.fixo * E, den);
}

/** Imposto (sobre max(P − C, 0)), taxas financeiras e margem líquida de um preço. */
export function resultadoDoPreco(
  precoP: bigint,
  custo: bigint,
  f: FormaPagamento,
  r: Regras,
): { imposto: bigint; taxas: bigint; margemLiquida: bigint; margemLiquidaPct: string } {
  const lucro = precoP - custo;
  const imposto = arredondar(pct(r.impostoSobreMargemPct) * (lucro > 0n ? lucro : 0n), E);
  const taxa = taxaDaForma(f, r);
  const taxas = arredondar(pct(taxa.pct) * precoP, E) + taxa.fixo;
  const margemLiquida = lucro - imposto - taxas;
  return { imposto, taxas, margemLiquida, margemLiquidaPct: pct1(margemLiquida, precoP) };
}

export type PrecificacaoForma = {
  rotulo: string;
  /** 4 casas ("3.4700"). */
  taxaPct: string;
  /** preço − soma das vendas (inclui a Taxa). */
  compensacao: bigint;
  preco: bigint;
  imposto: bigint;
  taxas: bigint;
  margemLiquida: bigint;
  /** 1 casa. */
  margemLiquidaPct: string;
  taxaServico: bigint;
  precoCliente: bigint;
  /** Margem líquida sobre o preço ao cliente quando a taxa de serviço é cobrada (ela também paga imposto e taxa da forma). 1 casa. */
  margemSemTaxaServicoPct: string;
};

export type PrecificacaoItem = {
  id: string;
  custoLiquido: bigint;
  custoAVista: bigint;
  venda: bigint;
  /** Na forma de referência (`FORMA_REFERENCIA`); 0 para `Taxa`. */
  compensacao: bigint;
  /** venda + compensacao. */
  valorFinal: bigint;
  /** Preço do item em cada forma de `FORMAS_SIMULADOR`, na mesma ordem; soma = preço da forma. */
  precoPorForma: bigint[];
};

export type Precificacao = {
  custo: bigint;
  custoAVista: bigint;
  /** Soma das vendas de todos os itens, inclusive a Taxa. */
  somaVendas: bigint;
  porForma: PrecificacaoForma[];
  /** Itens na ordem recebida, sem os `Aéreo`. */
  itens: PrecificacaoItem[];
  avista: {
    custoNoPrazo: bigint;
    desconto: bigint;
    custoAVista: bigint;
    /** Margem mantendo o preço e pagando à vista, por forma (1 casa). */
    opcaoAMargemPct: string[];
    /** Preço que mantém a margem alvo com o custo à vista, por forma. */
    opcaoBPreco: bigint[];
    /** preço da forma − opcaoBPreco. */
    opcaoBReducao: bigint[];
  };
};

/**
 * Divide `total` proporcionalmente a `pesos` (cada parte arredondada meio para cima);
 * o resto de centavos vai para o maior peso. Sem peso algum, tudo vai para o índice `seNenhum`.
 */
function distribuir(total: bigint, pesos: bigint[], seNenhum: number): bigint[] {
  const soma = pesos.reduce((a, p) => a + p, 0n);
  if (pesos.length === 0) return [];
  if (soma === 0n) return pesos.map((_, i) => (i === seNenhum ? total : 0n));
  const partes = pesos.map((p) => arredondar(total * p, soma));
  let maior = 0;
  pesos.forEach((p, i) => {
    if (p > pesos[maior]) maior = i;
  });
  partes[maior] += total - partes.reduce((a, p) => a + p, 0n);
  return partes;
}

export function precificar(itens: ItemCalc[], dias: number, r: Regras): Precificacao {
  validarDias(dias);
  const lista = itens.filter((i) => i.tipo !== "Aéreo");
  const base = lista.map((i) => ({
    id: i.id,
    taxa: i.tipo === "Taxa",
    custoLiquido: custoLiquido(i),
    custoAVista: custoAVista(i),
    venda: vendaDoItem(i, r),
  }));
  const custo = base.reduce((a, b) => a + b.custoLiquido, 0n);
  const custoAV = base.reduce((a, b) => a + b.custoAVista, 0n);
  const somaVendas = base.reduce((a, b) => a + b.venda, 0n);
  const taxaServico = BigInt(dias) * BigInt(r.taxaServicoPorDia);
  const pesos = base.map((b) => (b.taxa ? 0n : b.venda));
  let maiorVenda = 0;
  base.forEach((b, i) => {
    if (b.venda > base[maiorVenda].venda) maiorVenda = i;
  });

  const porForma: PrecificacaoForma[] = [];
  const partesPorForma: bigint[][] = [];
  const opcaoAMargemPct: string[] = [];
  const opcaoBPreco: bigint[] = [];
  const opcaoBReducao: bigint[] = [];

  for (const { rotulo, forma } of FORMAS_SIMULADOR) {
    const preco = precoDoPacote(custo, forma, r);
    const res = resultadoDoPreco(preco, custo, forma, r);
    const compensacao = preco - somaVendas;
    const precoCliente = preco + taxaServico;
    porForma.push({
      rotulo,
      taxaPct: taxaDaForma(forma, r).pct,
      compensacao,
      preco,
      ...res,
      taxaServico,
      precoCliente,
      margemSemTaxaServicoPct: resultadoDoPreco(precoCliente, custo, forma, r).margemLiquidaPct,
    });
    partesPorForma.push(distribuir(compensacao, pesos, maiorVenda));
    opcaoAMargemPct.push(resultadoDoPreco(preco, custoAV, forma, r).margemLiquidaPct);
    const b = precoDoPacote(custoAV, forma, r);
    opcaoBPreco.push(b);
    opcaoBReducao.push(preco - b);
  }

  return {
    custo,
    custoAVista: custoAV,
    somaVendas,
    porForma,
    itens: base.map((b, i) => {
      const comp = partesPorForma[FORMA_REFERENCIA][i];
      return {
        id: b.id,
        custoLiquido: b.custoLiquido,
        custoAVista: b.custoAVista,
        venda: b.venda,
        compensacao: comp,
        valorFinal: b.venda + comp,
        precoPorForma: partesPorForma.map((partes) => b.venda + partes[i]),
      };
    }),
    avista: {
      custoNoPrazo: custo,
      desconto: custo - custoAV,
      custoAVista: custoAV,
      opcaoAMargemPct,
      opcaoBPreco,
      opcaoBReducao,
    },
  };
}

export type Rateio = "por_dia" | "por_faturamento" | "por_viagem";

/**
 * Margem do pedido de aprovação: antes e depois do rateio do custo fixo.
 * `por_dia` arredonda o custo fixo por dia a centavo antes de multiplicar pelos dias
 * (R$ 230,29 × dias, como a tela mostra). `antesPct`, `finalPct` e `diasCobertos` com 1 casa.
 */
export function margemDaAprovacao(
  precoP: bigint,
  custo: bigint,
  f: FormaPagamento,
  dias: number,
  rateio: Rateio,
  r: Regras,
): {
  custo: bigint;
  imposto: bigint;
  taxa: bigint;
  antes: bigint;
  antesPct: string;
  fixo: bigint;
  final: bigint;
  finalPct: string;
  diasCobertos: string;
} {
  validarDias(dias);
  const res = resultadoDoPreco(precoP, custo, f, r);
  const mensal = BigInt(r.custoFixoMensal);
  const fixo =
    rateio === "por_dia"
      ? arredondar(mensal, BigInt(r.rateio.diasViagemMes)) * BigInt(dias)
      : rateio === "por_faturamento"
        ? arredondar(precoP * pct(r.rateio.pctFaturamento), E)
        : arredondar(mensal, BigInt(r.rateio.viagensMes));
  const antes = res.margemLiquida;
  const final = antes - fixo;
  return {
    custo,
    imposto: res.imposto,
    taxa: res.taxas,
    antes,
    antesPct: res.margemLiquidaPct,
    fixo,
    final,
    finalPct: pct1(final, precoP),
    diasCobertos: mensal === 0n ? "0.0" : formatarEscala(arredondar(antes * 300n, mensal), 1),
  };
}
