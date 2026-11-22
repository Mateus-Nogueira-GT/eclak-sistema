import { calcDe, type ResultadoVersao, type Snapshot } from "./aprovacoes";
import { converter, type Moeda } from "./cambio";
import { cpfValido, formatarCpf } from "./clientes";
import { arredondar, lerDecimal } from "./decimal";
import { custoLiquido, impostoSobreMargem, pct1, type FormaPagamento, type TipoItem } from "./precificacao";

// Venda fechada (sem I/O): cronograma de recebimento, contas a pagar a partir do snapshot aprovado,
// margem real (mesma conta da aprovação), ponte da margem, status derivado da viagem e documento da fatura.
// Dinheiro em centavos (`bigint`), percentuais em string, datas ISO "AAAA-MM-DD" (aritmética sem fuso).

/** 1 (100%) na escala dos percentuais: 1 unidade = 0,0001% (como em `precificacao.ts`). */
const E = 1_000_000n;
const pct = (p: string) => lerDecimal(p, 4);

// ---------------------------------------------------------------------------
// Datas ISO
// ---------------------------------------------------------------------------

const MSG_DATA = "Data inválida";

function bissexto(a: number): boolean {
  return (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
}

function diasNoMes(a: number, m: number): number {
  return m === 2 ? (bissexto(a) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function lerData(iso: string): [number, number, number] {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!r) throw new Error(MSG_DATA);
  const [a, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  if (m < 1 || m > 12 || d < 1 || d > diasNoMes(a, m)) throw new Error(MSG_DATA);
  return [a, m, d];
}

const dois = (n: number) => String(n).padStart(2, "0");
const iso = (a: number, m: number, d: number) => `${String(a).padStart(4, "0")}-${dois(m)}-${dois(d)}`;

/** Mesma data `meses` depois; dia inexistente no mês de destino vira o último dia dele. */
function somarMeses(data: string, meses: number): string {
  const [a, m, d] = lerData(data);
  const indice = a * 12 + (m - 1) + meses;
  const an = Math.floor(indice / 12);
  const mn = (indice % 12) + 1;
  return iso(an, mn, Math.min(d, diasNoMes(an, mn)));
}

/** Dia 15 do mês seguinte ao de `data` (previsão padrão da comissão a receber). */
function dia15DoMesSeguinte(data: string): string {
  const [a, m] = lerData(data);
  return m === 12 ? iso(a + 1, 1, 15) : iso(a, m + 1, 15);
}

// ---------------------------------------------------------------------------
// Recebimento do cliente
// ---------------------------------------------------------------------------

export const MEIOS_RECEBIMENTO = ["pix", "boleto", "cartao_credito", "cartao_fornecedor"] as const;
export type MeioRecebimento = (typeof MEIOS_RECEBIMENTO)[number];
export const ROTULO_MEIO: Record<MeioRecebimento, string> = {
  pix: "Pix",
  boleto: "Boleto",
  cartao_credito: "Cartão de crédito",
  cartao_fornecedor: "Cartão direto no fornecedor",
};

export function meioDaForma(f: FormaPagamento): MeioRecebimento {
  switch (f.tipo) {
    case "pix":
      return "pix";
    case "boleto":
      return "boleto";
    case "credito":
      return "cartao_credito";
    case "cartao_fornecedor":
      return "cartao_fornecedor";
  }
}

export type ParcelaCronograma = { numero: number; vencimento: string; valor: bigint };

/**
 * Parcelas mensais a partir de `primeiro`, no mesmo dia (dia inexistente → último do mês). Valor = total ÷ n
 * truncado ao centavo; a última absorve a diferença, então a soma é sempre o total exato.
 */
export function cronogramaRecebimento(total: bigint, n: number, primeiro: string): ParcelaCronograma[] {
  if (!Number.isInteger(n) || n < 1) throw new Error("Parcelas inválidas");
  if (total < 0n) throw new Error("Valor inválido");
  lerData(primeiro);
  const base = total / BigInt(n);
  return Array.from({ length: n }, (_, i) => ({
    numero: i + 1,
    vencimento: somarMeses(primeiro, i),
    valor: i === n - 1 ? total - base * BigInt(n - 1) : base,
  }));
}

/**
 * Taxas financeiras previstas por parcela: a `taxa` do `resultado` da versão aprovada repartida na proporção do
 * valor de cada parcela sobre o total (truncado ao centavo); a última absorve o resto (nunca negativo), então a
 * soma é a taxa da aprovação.
 */
export function alocarTaxasPrevistas(resultadoTaxa: bigint, valoresParcelas: bigint[]): bigint[] {
  if (valoresParcelas.length === 0) return [];
  if (resultadoTaxa < 0n || valoresParcelas.some((v) => v < 0n)) throw new Error("Valor inválido");
  const total = valoresParcelas.reduce((a, v) => a + v, 0n);
  let acumulado = 0n;
  return valoresParcelas.map((v, i) => {
    const t = i === valoresParcelas.length - 1 ? resultadoTaxa - acumulado : total === 0n ? 0n : (resultadoTaxa * v) / total;
    acumulado += t;
    return t;
  });
}

// ---------------------------------------------------------------------------
// Documento da fatura (CPF ou CNPJ, só dígitos)
// ---------------------------------------------------------------------------

function cnpjValido(digitos: string): boolean {
  if (!/^\d{14}$/.test(digitos) || /^(\d)\1{13}$/.test(digitos)) return false;
  const dv = (tamanho: number) => {
    let soma = 0;
    let peso = tamanho - 7;
    for (let i = 0; i < tamanho; i++) {
      soma += Number(digitos[i]) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return dv(12) === Number(digitos[12]) && dv(13) === Number(digitos[13]);
}

/** CPF (11 dígitos) ou CNPJ (14 dígitos) com dígitos verificadores corretos; só dígitos. */
export function documentoValido(digitos: string): boolean {
  if (/^\d{11}$/.test(digitos)) return cpfValido(digitos);
  return cnpjValido(digitos);
}

/** "529.982.247-25" ou "11.222.333/0001-81"; outro tamanho volta como veio. */
export function formatarDocumento(digitos: string): string {
  if (digitos.length === 11) return formatarCpf(digitos);
  if (digitos.length === 14)
    return `${digitos.slice(0, 2)}.${digitos.slice(2, 5)}.${digitos.slice(5, 8)}/${digitos.slice(8, 12)}-${digitos.slice(12)}`;
  return digitos;
}

// ---------------------------------------------------------------------------
// Contas a pagar a partir do snapshot aprovado
// ---------------------------------------------------------------------------

export const COMISSAO_TIPOS = ["descontada", "a_receber"] as const;
export type ComissaoTipo = (typeof COMISSAO_TIPOS)[number];

export const FORMAS_PAGAMENTO_FORNECEDOR = ["a_vista", "parcelado", "cartao_corporativo"] as const;
export type FormaPagamentoFornecedorTipo = (typeof FORMAS_PAGAMENTO_FORNECEDOR)[number];

export const STATUS_PARCELA = ["a_receber", "recebida", "cancelada"] as const;
export type StatusParcela = (typeof STATUS_PARCELA)[number];

export const STATUS_CONTA = ["a_pagar", "paga", "cancelada"] as const;
export type StatusConta = (typeof STATUS_CONTA)[number];

export const STATUS_PAGAMENTO = ["a_pagar", "pago"] as const;
export type StatusPagamento = (typeof STATUS_PAGAMENTO)[number];

export const STATUS_COMISSAO = ["prevista", "recebida", "nao_recebida", "cancelada"] as const;
export type StatusComissao = (typeof STATUS_COMISSAO)[number];

export type ComissaoGerada = {
  /** Valor em reais da cotação (cheio). */
  baseBrl: bigint;
  pct: string;
  /** baseBrl − líquido: com o valor pago cheio, previsto − comissão = o custo líquido usado na aprovação. */
  valor: bigint;
  previstaPara: string;
};

export type ContaGerada = {
  itemId: string;
  cotacaoId: string;
  fornecedorId: string | null;
  fornecedor: string | null;
  tipo: TipoItem;
  cidade: string | null;
  /** Serviço do item. */
  descricao: string;
  /** Aéreo gera conta, mas fica fora da margem. */
  aereo: boolean;
  moeda: Moeda;
  valorOriginal: bigint;
  cambioAplicado: string | null;
  /** Valor cheio em reais da cotação. */
  valorBrl: bigint;
  comissaoPct: string;
  comissaoTipo: ComissaoTipo;
  descontoAVistaPct: string | null;
  /** O que se paga ao fornecedor, na moeda da cotação: líquido se `descontada`, cheio se `a_receber`. */
  previstoOriginal: bigint;
  /** O mesmo em reais. */
  previstoBrl: bigint;
  /** Só com `a_receber` e comissão > 0. */
  comissao: ComissaoGerada | null;
};

/**
 * Uma conta por item não-Taxa (a taxa de roteiro é receita), com a cotação **escolhida**. Fornecedor com
 * modalidade `comissionado` → `a_receber` (paga-se cheio; a comissão nasce prevista para o dia 15 do mês seguinte
 * ao fim da viagem); demais → `descontada` (paga-se o líquido, como na aprovação).
 */
export function contasDoSnapshot(
  s: Snapshot,
  modalidadePorFornecedor: Record<string, "net" | "comissionado">,
  fimViagem: string,
): ContaGerada[] {
  const previstaPara = dia15DoMesSeguinte(fimViagem);
  return s.itens
    .filter((i) => i.tipo !== "Taxa")
    .map((i) => {
      const c = i.escolhida;
      const calc = calcDe(i, c);
      const valorBrl = calc.valorFornecedor;
      const liquido = custoLiquido(calc);
      const p = pct(calc.comissaoPct);
      // Ajuste legado do item (`ajuste.valorFornecedor`, em reais): o original volta pelo câmbio aplicado.
      const valorOriginal =
        c.moeda === "BRL"
          ? valorBrl
          : i.ajuste?.valorFornecedor !== undefined && c.cambioAplicado
            ? arredondar(valorBrl * 10_000n, lerDecimal(c.cambioAplicado, 4))
            : BigInt(c.valorOriginal);
      const comissaoTipo: ComissaoTipo =
        c.fornecedorId !== null && modalidadePorFornecedor[c.fornecedorId] === "comissionado" ? "a_receber" : "descontada";
      const aReceber = comissaoTipo === "a_receber";
      const previstoBrl = aReceber ? valorBrl : liquido;
      const previstoOriginal = c.moeda === "BRL" ? previstoBrl : aReceber ? valorOriginal : arredondar(valorOriginal * (E - p), E);
      const valorComissao = valorBrl - liquido;
      return {
        itemId: i.id,
        cotacaoId: c.id,
        fornecedorId: c.fornecedorId,
        fornecedor: c.fornecedor,
        tipo: i.tipo,
        cidade: i.cidade,
        descricao: i.servico,
        aereo: i.tipo === "Aéreo",
        moeda: c.moeda,
        valorOriginal,
        cambioAplicado: c.cambioAplicado,
        valorBrl,
        comissaoPct: calc.comissaoPct,
        comissaoTipo,
        descontoAVistaPct: c.descontoAVistaPct,
        previstoOriginal,
        previstoBrl,
        comissao:
          aReceber && valorComissao > 0n
            ? { baseBrl: valorBrl, pct: calc.comissaoPct, valor: valorComissao, previstaPara }
            : null,
      };
    });
}

/** Custo da taxa de roteiro no snapshot (entra no custo da aprovação; a margem real conta igual). */
export function taxaRoteiroDoSnapshot(s: Snapshot): bigint {
  return s.itens.filter((i) => i.tipo === "Taxa").reduce((a, i) => a + custoLiquido(calcDe(i, i.escolhida)), 0n);
}

export type FormaFornecedor =
  | { tipo: "a_vista"; vencimento?: string }
  | { tipo: "parcelado"; parcelas: { vencimento: string; valorOriginal: bigint }[] }
  | { tipo: "cartao_corporativo"; vencimento: string };

export type LinhaPagamento = {
  numero: number;
  /** Nulo no à vista sem data informada. */
  vencimento: string | null;
  valorOriginal: bigint;
  valorBrlPrevisto: bigint;
};

/**
 * Linhas de pagamento ao fornecedor. À vista: uma linha com o desconto à vista da cotação (se houver) sobre o
 * previsto. Parcelado: as parcelas informadas, cuja soma tem de ser o previsto na moeda; os reais seguem a
 * proporção (truncada ao centavo) e a última absorve o resto, nunca negativo, somando o previsto em reais. Cartão corporativo: uma linha na
 * data da fatura, valor cheio.
 */
export function aplicarFormaFornecedor(
  conta: { moeda: Moeda; previstoOriginal: bigint; previstoBrl: bigint },
  forma: FormaFornecedor,
  descontoAVistaPct: string | null,
): LinhaPagamento[] {
  switch (forma.tipo) {
    case "a_vista": {
      if (forma.vencimento !== undefined) lerData(forma.vencimento);
      const d = descontoAVistaPct === null ? 0n : pct(descontoAVistaPct);
      if (d > E) throw new Error("Percentual inválido");
      return [
        {
          numero: 1,
          vencimento: forma.vencimento ?? null,
          valorOriginal: arredondar(conta.previstoOriginal * (E - d), E),
          valorBrlPrevisto: arredondar(conta.previstoBrl * (E - d), E),
        },
      ];
    }
    case "cartao_corporativo":
      lerData(forma.vencimento);
      return [{ numero: 1, vencimento: forma.vencimento, valorOriginal: conta.previstoOriginal, valorBrlPrevisto: conta.previstoBrl }];
    case "parcelado": {
      const ps = forma.parcelas;
      if (conta.previstoBrl < 0n) throw new Error("Valor inválido");
      if (ps.length === 0) throw new Error("Informe as parcelas");
      for (const p of ps) {
        lerData(p.vencimento);
        if (p.valorOriginal < 0n) throw new Error("Valor inválido");
      }
      const soma = ps.reduce((a, p) => a + p.valorOriginal, 0n);
      if (soma !== conta.previstoOriginal) throw new Error("A soma das parcelas deve ser igual ao valor previsto");
      let acumulado = 0n;
      return ps.map((p, i) => {
        const ultima = i === ps.length - 1;
        const brl = ultima ? conta.previstoBrl - acumulado : soma === 0n ? 0n : (conta.previstoBrl * p.valorOriginal) / soma;
        acumulado += brl;
        return { numero: i + 1, vencimento: p.vencimento, valorOriginal: p.valorOriginal, valorBrlPrevisto: brl };
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Margem real
// ---------------------------------------------------------------------------

export type ParcelaMargem = {
  valor: bigint;
  recebida: boolean;
  /** Taxa cobrada de fato (vale só com a parcela recebida); nula = usa a prevista. */
  taxaEfetiva: bigint | null;
  /** Parte da taxa da aprovação (`alocarTaxasPrevistas`). */
  taxaPrevista: bigint;
  /** Valor recebido de fato (só com a parcela recebida); omitido ou nulo = o valor da parcela. */
  valorRecebido?: bigint | null;
  /** Parcela cancelada: sai da receita (parte do pacote) e das taxas. */
  cancelada?: boolean;
  /** "n de N" no rótulo da ponte da parcela cancelada. */
  numero?: number;
  totalParcelas?: number;
};

export type EfeitoRecebimento = { tipo: "a_menos" | "a_mais" | "cancelada"; parcela: ParcelaMargem; valor: bigint };

/**
 * Efeito de cada parcela na receita do pacote (centavos, com sinal): recebida com valor diferente → (recebido −
 * valor); cancelada → −valor; cada um na parte do pacote (× preço ÷ total a receber, meio para cima), para a taxa
 * de serviço não contar como receita do pacote. Total a receber = Σ valor de todas as parcelas (canceladas
 * inclusive). Sem efeito fica de fora.
 */
export function efeitosDoRecebimento(preco: bigint, parcelas: ParcelaMargem[]): EfeitoRecebimento[] {
  const total = parcelas.reduce((a, p) => a + p.valor, 0n);
  if (total === 0n) return [];
  const parte = (x: bigint) => arredondar(x * preco, total);
  const efeitos: EfeitoRecebimento[] = [];
  for (const p of parcelas) {
    if (p.cancelada) {
      const valor = parte(-p.valor);
      if (valor !== 0n) efeitos.push({ tipo: "cancelada", parcela: p, valor });
    } else if (p.recebida && p.valorRecebido !== undefined && p.valorRecebido !== null && p.valorRecebido !== p.valor) {
      const valor = parte(p.valorRecebido - p.valor);
      if (valor !== 0n) efeitos.push({ tipo: valor < 0n ? "a_menos" : "a_mais", parcela: p, valor });
    }
  }
  return efeitos;
}

export type ContaMargem = { aereo: boolean; previstoBrl: bigint; pagoBrl: bigint | null };

export type EntradaMargemReal = {
  /** Preço do pacote da versão aprovada (sem a taxa de serviço). */
  preco: bigint;
  contas: ContaMargem[];
  /** Soma das comissões **recebidas** (sem as de Aéreo). */
  comissoesRecebidas: bigint;
  /** Todas as parcelas (as canceladas com `cancelada`). */
  parcelas: ParcelaMargem[];
  /** Custo fixo gravado no `resultado` da versão. */
  fixo: bigint;
  /** Imposto sobre a margem das regras da versão ("7.000"). */
  impostoPct: string;
  /** Custo da taxa de roteiro, como na aprovação (`taxaRoteiroDoSnapshot`). */
  taxaRoteiro: bigint;
};

export type MargemReal = {
  /** Receita do pacote realizada: preço da versão + efeitos do recebimento (`efeitosDoRecebimento`). */
  receita: bigint;
  custo: bigint;
  imposto: bigint;
  taxas: bigint;
  fixo: bigint;
  final: bigint;
  /** Sobre a receita realizada. */
  finalPct: string;
};

/**
 * Mesma conta de `margemDaAprovacao`, com o realizado: receita = P + efeitos do recebimento (recebido a menos ou a
 * mais e parcelas canceladas, na parte do pacote); custo = Σ contas não-Aéreo (pago em reais, senão o previsto
 * atual) − comissões recebidas + taxa de roteiro; imposto = imposto% × max(receita − custo, 0); taxas = Σ parcelas
 * não canceladas (efetiva se recebida e informada, senão a prevista alocada da aprovação) — com as previstas de
 * `alocarTaxasPrevistas`, é a taxa da aprovação + Σ (efetiva − prevista) das recebidas; fixo da versão.
 */
export function margemReal(e: EntradaMargemReal): MargemReal {
  const receita = e.preco + efeitosDoRecebimento(e.preco, e.parcelas).reduce((a, x) => a + x.valor, 0n);
  const contas = e.contas.filter((c) => !c.aereo).reduce((a, c) => a + (c.pagoBrl ?? c.previstoBrl), 0n);
  const custo = contas - e.comissoesRecebidas + e.taxaRoteiro;
  const imposto = impostoSobreMargem(receita, custo, e.impostoPct);
  const taxas = e.parcelas
    .filter((p) => !p.cancelada)
    .reduce((a, p) => a + (p.recebida && p.taxaEfetiva !== null ? p.taxaEfetiva : p.taxaPrevista), 0n);
  const final = receita - custo - imposto - taxas - e.fixo;
  return { receita, custo, imposto, taxas, fixo: e.fixo, final, finalPct: pct1(final, receita) };
}

export type MargemPlanejada = { custo: bigint; imposto: bigint; taxa: bigint; fixo: bigint; final: bigint; finalPct: string };

/** Margem planejada = o `resultado` gravado na versão aprovada, em bigint. */
export function planejadaDaVersao(r: ResultadoVersao): MargemPlanejada {
  return {
    custo: BigInt(r.custo),
    imposto: BigInt(r.imposto),
    taxa: BigInt(r.taxa),
    fixo: BigInt(r.fixo),
    final: BigInt(r.final),
    finalPct: r.finalPct,
  };
}

// ---------------------------------------------------------------------------
// Ponte da margem (planejada → real)
// ---------------------------------------------------------------------------

export type ContaPonte = ContaMargem & {
  /** Fornecedor ou, sem ele, o serviço. */
  rotulo: string;
  moeda: Moeda;
  /** Previsto gravado na venda (fixo, base da ponte). */
  previstoVendaBrl: bigint;
  /**
   * Linhas pagas (valor pago na moeda e em reais). Informadas, o pago diferente do previsto vira
   * "<rótulo>: valor pago diferente" e, fora do real, a parte do câmbio (pago em reais − pago na moeda pelo câmbio
   * da venda) vai para "Diferença de câmbio". Omitidas: o comportamento antigo (tudo em câmbio fora do real,
   * em "valor atualizado" no real).
   */
  pagos?: { valorOriginalPago: bigint; valorBrlPago: bigint }[];
  /** Câmbio da venda (o aplicado na cotação); nulo no real. */
  cambioVenda?: string | null;
  /**
   * Comissão a receber da conta como vendida (0 se vendida `descontada`). Informada em todas as contas, o custo na
   * venda sai das contas como vendidas (Σ previsto na venda − comissão na venda) e não das comissões de hoje, então
   * "Fornecedores escolhidos" não mexe depois da venda. Omitida: as comissões de hoje (comportamento antigo).
   */
  comissaoNaVenda?: bigint;
  /**
   * Tipo de comissão trocado depois da venda: o novo tipo, o previsto que a conta teria na venda com ele e a
   * comissão prevista hoje (0 sem comissão ativa). A troca vira uma linha só, com o efeito real na margem.
   */
  trocaDeTipo?: { para: ComissaoTipo; previstoNaVenda: bigint; comissaoPrevista: bigint };
};

export type ComissaoPonte = {
  fornecedor: string;
  aereo: boolean;
  valorPrevisto: bigint;
  /** Nulo = ainda não recebida (ou marcada "não será recebida"). */
  valorRecebido: bigint | null;
  /** Marcada "não será recebida" (rótulo próprio na ponte). */
  naoRecebida?: boolean;
};

export type EntradaPonte = {
  planejada: Omit<MargemPlanejada, "finalPct">;
  preco: bigint;
  impostoPct: string;
  taxaRoteiro: bigint;
  contas: ContaPonte[];
  comissoes: ComissaoPonte[];
  parcelas: ParcelaMargem[];
};

export type LinhaPonte = { rotulo: string; valor: bigint };

/**
 * Da margem planejada à real, em reais de margem (positivo = melhora). Linhas do meio sem efeito ficam de fora:
 * - "Fornecedores escolhidos": custo planejado (pelo pior) − custo das contas como vendidas (Σ previsto na venda −
 *   comissão na venda, com `comissaoNaVenda`; sem ele, as comissões de hoje). Não muda depois da venda.
 * - "Comissão: <rótulo> passou a ser descontada|a receber" (`trocaDeTipo`): efeito real da troca = −(previsto na
 *   venda no novo tipo − previsto na venda + comissão na venda − comissão prevista hoje); 0 (sem linha) quando a
 *   comissão de hoje é a diferença entre cheio e líquido.
 * - "<rótulo>: valor atualizado": previsto atual − previsto na venda (no tipo atual, se trocado). Sem `pagos`, inclui
 *   também o pago diferente do previsto nas contas em reais.
 * - Com `pagos`: "<rótulo>: valor pago diferente" (pago − previsto, sem a parte do câmbio: desconto à vista, preço
 *   do fornecedor) e, fora do real, "Diferença de câmbio" = Σ pago em reais − pago na moeda pelo câmbio da venda.
 *   Sem `pagos`, todo o pago diferente das contas em moeda estrangeira vai para "Diferença de câmbio".
 * - "Comissão pendente: <f>", "Comissão não recebida: <f>" (marcada "não será recebida"), "Comissão recebida: <f>"
 *   (recebida com valor diferente do previsto) — sobre as comissões ativas de hoje.
 * - "Recebido a menos", "Recebido a mais" (Σ das parcelas recebidas com valor diferente) e "Parcela cancelada: n de N",
 *   na parte do pacote (`efeitosDoRecebimento`).
 * - "Taxas financeiras" e "Imposto".
 * As linhas do meio somam exatamente real.final − planejada.final (conferido; senão lança).
 */
export function ponteDaMargem(e: EntradaPonte): { real: MargemReal; linhas: LinhaPonte[] } {
  const contas = e.contas.filter((c) => !c.aereo);
  const comissoes = e.comissoes.filter((c) => !c.aereo);
  const real = margemReal({
    preco: e.preco,
    contas,
    comissoesRecebidas: comissoes.reduce((a, c) => a + (c.valorRecebido ?? 0n), 0n),
    parcelas: e.parcelas,
    fixo: e.planejada.fixo,
    impostoPct: e.impostoPct,
    taxaRoteiro: e.taxaRoteiro,
  });

  const meio: LinhaPonte[] = [];
  const add = (rotulo: string, valor: bigint) => {
    if (valor !== 0n) meio.push({ rotulo, valor });
  };

  const comissaoNaVenda = contas.every((c) => c.comissaoNaVenda !== undefined)
    ? contas.reduce((a, c) => a + c.comissaoNaVenda!, 0n)
    : comissoes.reduce((a, c) => a + c.valorPrevisto, 0n);
  const custoNaVenda = contas.reduce((a, c) => a + c.previstoVendaBrl, 0n) - comissaoNaVenda + e.taxaRoteiro;
  add("Fornecedores escolhidos", e.planejada.custo - custoNaVenda);

  let cambio = 0n;
  for (const c of contas) {
    const pagoDiferente = c.pagoBrl === null ? 0n : c.pagoBrl - c.previstoBrl;
    const estrangeira = c.moeda !== "BRL";
    const t = c.trocaDeTipo;
    // Base do "valor atualizado": o previsto na venda no tipo atual.
    const previstoBase = t ? t.previstoNaVenda : c.previstoVendaBrl;
    if (t) {
      const efeito = t.previstoNaVenda - c.previstoVendaBrl + (c.comissaoNaVenda ?? 0n) - t.comissaoPrevista;
      add(`Comissão: ${c.rotulo} passou a ser ${t.para === "descontada" ? "descontada" : "a receber"}`, -efeito);
    }
    if (c.pagos !== undefined) {
      // Câmbio: só a diferença entre o pago em reais e o pago na moeda convertido pelo câmbio da venda; o resto
      // do pago diferente (desconto à vista, preço do fornecedor) é "valor pago diferente".
      const cambioVenda = c.cambioVenda;
      const daConta =
        estrangeira && cambioVenda
          ? c.pagos.reduce((a, x) => a + x.valorBrlPago - converter(x.valorOriginalPago, cambioVenda), 0n)
          : 0n;
      cambio += daConta;
      add(`${c.rotulo}: valor atualizado`, -(c.previstoBrl - previstoBase));
      add(`${c.rotulo}: valor pago diferente`, -(pagoDiferente - daConta));
      continue;
    }
    if (estrangeira) cambio += pagoDiferente;
    add(`${c.rotulo}: valor atualizado`, -(c.previstoBrl - previstoBase + (estrangeira ? 0n : pagoDiferente)));
  }
  add("Diferença de câmbio", -cambio);

  for (const c of comissoes) {
    if (c.naoRecebida) add(`Comissão não recebida: ${c.fornecedor}`, -c.valorPrevisto);
    else if (c.valorRecebido === null) add(`Comissão pendente: ${c.fornecedor}`, -c.valorPrevisto);
    else add(`Comissão recebida: ${c.fornecedor}`, c.valorRecebido - c.valorPrevisto);
  }

  const efeitos = efeitosDoRecebimento(e.preco, e.parcelas);
  const somaDe = (tipo: EfeitoRecebimento["tipo"]) => efeitos.filter((x) => x.tipo === tipo).reduce((a, x) => a + x.valor, 0n);
  add("Recebido a menos", somaDe("a_menos"));
  add("Recebido a mais", somaDe("a_mais"));
  for (const x of efeitos.filter((x) => x.tipo === "cancelada")) {
    const n = x.parcela.numero !== undefined && x.parcela.totalParcelas !== undefined ? `: ${x.parcela.numero} de ${x.parcela.totalParcelas}` : "";
    add(`Parcela cancelada${n}`, x.valor);
  }

  add("Taxas financeiras", -(real.taxas - e.planejada.taxa));
  add("Imposto", -(real.imposto - e.planejada.imposto));

  const soma = meio.reduce((a, l) => a + l.valor, 0n);
  if (soma !== real.final - e.planejada.final) throw new Error("Margem planejada não confere com o preço da versão");

  return {
    real,
    linhas: [{ rotulo: "Margem planejada", valor: e.planejada.final }, ...meio, { rotulo: "Margem real", valor: real.final }],
  };
}

// ---------------------------------------------------------------------------
// Status da viagem (exibição)
// ---------------------------------------------------------------------------

export const STATUS_VIAGEM = ["orcamento", "vendida", "em_viagem", "recebendo", "conciliada"] as const;
export type StatusViagem = (typeof STATUS_VIAGEM)[number];
export const ROTULO_STATUS_VIAGEM: Record<StatusViagem, string> = {
  orcamento: "Orçamento",
  vendida: "Vendida",
  em_viagem: "Em viagem",
  recebendo: "Recebendo",
  conciliada: "Conciliada",
};

/**
 * Status derivado: fora de `vendida` é orçamento; conciliada quando `conciliadaEm` está preenchido; antes do
 * início "Vendida", do início ao fim "Em viagem", depois do fim "Recebendo" até a conciliação.
 */
export function statusDaViagem(v: {
  status: string;
  inicio: string;
  fim: string;
  conciliadaEm: string | null;
  hoje: string;
}): StatusViagem {
  if (v.status !== "vendida") return "orcamento";
  if (v.conciliadaEm) return "conciliada";
  if (v.hoje < v.inicio) return "vendida";
  if (v.hoje <= v.fim) return "em_viagem";
  return "recebendo";
}

// ---------------------------------------------------------------------------
// Vencimento padrão do pagamento ao fornecedor
// ---------------------------------------------------------------------------

/** À vista padrão ao fechar a venda: 30 dias antes do início da viagem, nunca antes do aceite (o financeiro ajusta). */
export function vencimentoPadraoFornecedor(inicio: string, aceiteEm: string): string {
  const [a, m, d] = lerData(inicio);
  lerData(aceiteEm);
  const t = new Date(Date.UTC(a, m - 1, d - 30));
  const venc = iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
  return venc < aceiteEm ? aceiteEm : venc;
}

// ---------------------------------------------------------------------------
// Previsto da conta atualizado: linhas de pagamento em aberto
// ---------------------------------------------------------------------------

/** `alvo` repartido na proporção de `pesos` (truncado ao centavo); a última absorve o resto (nunca negativo). Pesos zerados: tudo na última. */
function repartir(pesos: bigint[], alvo: bigint): bigint[] {
  const soma = pesos.reduce((a, p) => a + p, 0n);
  let acumulado = 0n;
  return pesos.map((p, i) => {
    const v = i === pesos.length - 1 ? alvo - acumulado : soma === 0n ? 0n : (alvo * p) / soma;
    acumulado += v;
    return v;
  });
}

export type LinhaReprevisao = { valorOriginal: bigint; valorBrlPrevisto: bigint; pago: boolean };

/**
 * Novos valores das linhas de pagamento quando o previsto da conta muda de `antes` para `depois` (na moeda e em
 * reais). A diferença entra nas linhas em aberto na mesma razão linhas ÷ previsto (o desconto à vista se mantém),
 * repartida na proporção de cada linha em aberto (truncado; a última absorve; nunca negativo). Linhas pagas não
 * mudam. Mesma ordem e tamanho de `linhas`.
 */
export function reprevisarLinhas(
  linhas: LinhaReprevisao[],
  antes: { original: bigint; brl: bigint },
  depois: { original: bigint; brl: bigint },
): { valorOriginal: bigint; valorBrlPrevisto: bigint }[] {
  const abertas = linhas.map((l, i) => [l, i] as const).filter(([l]) => !l.pago);
  const novo = (campo: "valorOriginal" | "valorBrlPrevisto", a: bigint, d: bigint): bigint[] => {
    const total = linhas.reduce((s, l) => s + l[campo], 0n);
    const delta = a === 0n ? d - a : arredondar((d - a) * total, a);
    const emAberto = abertas.reduce((s, [l]) => s + l[campo], 0n);
    const alvo = emAberto + delta < 0n ? 0n : emAberto + delta;
    return repartir(abertas.map(([l]) => l[campo]), alvo);
  };
  const originais = novo("valorOriginal", antes.original, depois.original);
  const reais = novo("valorBrlPrevisto", antes.brl, depois.brl);
  const saida = linhas.map((l) => ({ valorOriginal: l.valorOriginal, valorBrlPrevisto: l.valorBrlPrevisto }));
  abertas.forEach(([, i], k) => (saida[i] = { valorOriginal: originais[k], valorBrlPrevisto: reais[k] }));
  return saida;
}
