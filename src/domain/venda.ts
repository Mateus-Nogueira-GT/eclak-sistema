import { calcDe, type ResultadoVersao, type Snapshot } from "./aprovacoes";
import type { Moeda } from "./cambio";
import { cpfValido, formatarCpf } from "./clientes";
import { arredondar, lerDecimal } from "./decimal";
import { custoLiquido, impostoSobreMargem, pct1, taxaDaForma, type FormaPagamento, type TipoItem } from "./precificacao";
import type { Regras } from "./regras";

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

/** Taxa financeira prevista de uma parcela: % da forma × valor (meio para cima) + taxa por boleto, no boleto. */
export function taxaPrevistaParcela(valor: bigint, forma: FormaPagamento, regras: Regras): bigint {
  const t = taxaDaForma(forma, regras);
  const porBoleto = forma.tipo === "boleto" ? BigInt(regras.taxas.boletoPorBoleto) : 0n;
  return arredondar(pct(t.pct) * valor, E) + porBoleto;
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
 * proporção (meio para cima) e a última absorve, somando o previsto em reais. Cartão corporativo: uma linha na
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
        const brl = ultima ? conta.previstoBrl - acumulado : soma === 0n ? 0n : arredondar(conta.previstoBrl * p.valorOriginal, soma);
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
  taxaPrevista: bigint;
};

export type ContaMargem = { aereo: boolean; previstoBrl: bigint; pagoBrl: bigint | null };

export type EntradaMargemReal = {
  /** Preço do pacote da versão aprovada (sem a taxa de serviço). */
  preco: bigint;
  /** Total a receber do cliente (preço ao cliente da versão). */
  totalReceber: bigint;
  contas: ContaMargem[];
  /** Soma das comissões **recebidas** (sem as de Aéreo). */
  comissoesRecebidas: bigint;
  /** Parcelas não canceladas. */
  parcelas: ParcelaMargem[];
  /** Custo fixo gravado no `resultado` da versão. */
  fixo: bigint;
  /** Imposto sobre a margem das regras da versão ("7.000"). */
  impostoPct: string;
  /** Custo da taxa de roteiro, como na aprovação (`taxaRoteiroDoSnapshot`). */
  taxaRoteiro: bigint;
};

export type MargemReal = { custo: bigint; imposto: bigint; taxas: bigint; fixo: bigint; final: bigint; finalPct: string };

/**
 * Mesma conta de `margemDaAprovacao`, com o realizado: custo = Σ contas não-Aéreo (pago em reais, senão o
 * previsto atual) − comissões recebidas + taxa de roteiro; imposto = imposto% × max(P − custo, 0); taxas =
 * Σ parcelas (efetiva se recebida, senão prevista) × P ÷ total a receber (meio para cima); fixo da versão.
 */
export function margemReal(e: EntradaMargemReal): MargemReal {
  const contas = e.contas.filter((c) => !c.aereo).reduce((a, c) => a + (c.pagoBrl ?? c.previstoBrl), 0n);
  const custo = contas - e.comissoesRecebidas + e.taxaRoteiro;
  const imposto = impostoSobreMargem(e.preco, custo, e.impostoPct);
  const somaTaxas = e.parcelas.reduce((a, p) => a + (p.recebida && p.taxaEfetiva !== null ? p.taxaEfetiva : p.taxaPrevista), 0n);
  const taxas = e.totalReceber === 0n ? 0n : arredondar(somaTaxas * e.preco, e.totalReceber);
  const final = e.preco - custo - imposto - taxas - e.fixo;
  return { custo, imposto, taxas, fixo: e.fixo, final, finalPct: pct1(final, e.preco) };
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
};

export type ComissaoPonte = {
  fornecedor: string;
  aereo: boolean;
  valorPrevisto: bigint;
  /** Nulo = ainda não recebida (ou "não será recebida"). */
  valorRecebido: bigint | null;
};

export type EntradaPonte = {
  planejada: Omit<MargemPlanejada, "finalPct">;
  preco: bigint;
  totalReceber: bigint;
  impostoPct: string;
  taxaRoteiro: bigint;
  contas: ContaPonte[];
  comissoes: ComissaoPonte[];
  parcelas: ParcelaMargem[];
};

export type LinhaPonte = { rotulo: string; valor: bigint };

/**
 * Da margem planejada à real, em reais de margem (positivo = melhora). Linhas do meio sem efeito ficam de fora:
 * "Fornecedores escolhidos" (custo planejado pelo pior − custo das escolhidas na venda); por conta,
 * "<rótulo>: valor atualizado" (previsto atual − previsto na venda, e o pago diferente do previsto em reais);
 * "Diferença de câmbio" (pago − previsto nas contas pagas em moeda estrangeira); "Comissão pendente: <f>";
 * "Comissão recebida: <f>" (recebida com valor diferente do previsto); "Taxas financeiras"; "Imposto".
 * As linhas do meio somam exatamente real.final − planejada.final.
 */
export function ponteDaMargem(e: EntradaPonte): { real: MargemReal; linhas: LinhaPonte[] } {
  const contas = e.contas.filter((c) => !c.aereo);
  const comissoes = e.comissoes.filter((c) => !c.aereo);
  const real = margemReal({
    preco: e.preco,
    totalReceber: e.totalReceber,
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

  const custoNaVenda =
    contas.reduce((a, c) => a + c.previstoVendaBrl, 0n) - comissoes.reduce((a, c) => a + c.valorPrevisto, 0n) + e.taxaRoteiro;
  add("Fornecedores escolhidos", e.planejada.custo - custoNaVenda);

  let cambio = 0n;
  for (const c of contas) {
    const pagoDiferente = c.pagoBrl === null ? 0n : c.pagoBrl - c.previstoBrl;
    const estrangeira = c.moeda !== "BRL";
    if (estrangeira) cambio += pagoDiferente;
    add(`${c.rotulo}: valor atualizado`, -(c.previstoBrl - c.previstoVendaBrl + (estrangeira ? 0n : pagoDiferente)));
  }
  add("Diferença de câmbio", -cambio);

  for (const c of comissoes) {
    if (c.valorRecebido === null) add(`Comissão pendente: ${c.fornecedor}`, -c.valorPrevisto);
    else add(`Comissão recebida: ${c.fornecedor}`, c.valorRecebido - c.valorPrevisto);
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
 * início "Vendida", do início ao fim "Em viagem", depois do fim "Recebendo" se há algo em aberto (senão segue
 * "Vendida", à espera da conciliação).
 */
export function statusDaViagem(v: {
  status: string;
  inicio: string;
  fim: string;
  conciliadaEm: string | null;
  hoje: string;
  emAberto: boolean;
}): StatusViagem {
  if (v.status !== "vendida") return "orcamento";
  if (v.conciliadaEm) return "conciliada";
  if (v.hoje < v.inicio) return "vendida";
  if (v.hoje <= v.fim) return "em_viagem";
  return v.emAberto ? "recebendo" : "vendida";
}
