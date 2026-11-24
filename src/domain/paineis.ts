import { arredondar } from "./decimal";
import { formatarPercentual } from "./dinheiro";
import { pct1 } from "./precificacao";
import { diasNoMes, lerData, somarDias, somarMeses } from "./venda";

// Domínio puro dos painéis (Visão geral e Relatórios): períodos, DRE, avisos e CSV.

export const PERIODOS_PAINEL = ["30d", "90d", "mes", "mes_anterior", "ano"] as const;
export type PeriodoPainel = (typeof PERIODOS_PAINEL)[number];

export const ROTULO_PERIODO: Record<PeriodoPainel, string> = {
  "30d": "Últimos 30 dias",
  "90d": "Últimos 90 dias",
  mes: "Este mês",
  mes_anterior: "Mês anterior",
  ano: "Este ano",
};

export const RELATORIOS_TIPOS = ["dre", "pagar", "receber", "bancos", "margens", "consultores", "conciliacao"] as const;
export type Relatorio = (typeof RELATORIOS_TIPOS)[number];

/** Nome e descrição de cada relatório (texto do protótipo). */
export const RELATORIOS: Record<Relatorio, { nome: string; descricao: string }> = {
  dre: { nome: "DRE", descricao: "Resultado do período" },
  pagar: { nome: "Contas a pagar", descricao: "Fornecedores e custos da empresa" },
  receber: { nome: "Contas a receber", descricao: "Parcelas de clientes" },
  bancos: { nome: "Volume por banco", descricao: "Entradas e saídas por conta" },
  margens: { nome: "Margem por viagem", descricao: "Planejada e real" },
  consultores: { nome: "Vendas por consultor", descricao: "Valor vendido e margem" },
  conciliacao: { nome: "Conciliação extrato x sistema", descricao: "Extrato OFX conferido com as baixas do sistema" },
};

/** Datas ISO (AAAA-MM-DD), ambas inclusivas. */
export type Intervalo = { de: string; ate: string };

const MSG_PERIODO = "Período inválido";
const dois = (n: number) => String(n).padStart(2, "0");
const primeiroDoMes = (data: string) => `${data.slice(0, 7)}-01`;

function ultimoDoMes(data: string): string {
  const [a, m] = lerData(data);
  return `${data.slice(0, 7)}-${dois(diasNoMes(a, m))}`;
}

export function intervaloDoPeriodo(p: PeriodoPainel, hoje: string): Intervalo {
  lerData(hoje);
  switch (p) {
    case "30d":
      return { de: somarDias(hoje, -29), ate: hoje };
    case "90d":
      return { de: somarDias(hoje, -89), ate: hoje };
    case "mes":
      return { de: primeiroDoMes(hoje), ate: hoje };
    case "mes_anterior": {
      const de = somarMeses(primeiroDoMes(hoje), -1);
      return { de, ate: ultimoDoMes(de) };
    }
    case "ano":
      return { de: `${hoje.slice(0, 4)}-01-01`, ate: hoje };
  }
}

/**
 * Período de comparação, de mesma duração (spec §5.1): 30d/90d, os dias logo antes; `mes`, o mesmo trecho do mês
 * anterior (1–23/11 → 1–23/10, o dia limitado ao fim do mês); `ano`, o mesmo trecho do ano anterior; `mes_anterior`,
 * o mês inteiro antes dele.
 */
export function intervaloAnterior(p: PeriodoPainel, atual: Intervalo): Intervalo {
  switch (p) {
    case "30d":
    case "90d": {
      const ate = somarDias(atual.de, -1);
      const [a, m, d] = lerData(atual.de);
      const [a2, m2, d2] = lerData(atual.ate);
      const dias = Math.round((Date.UTC(a2, m2 - 1, d2) - Date.UTC(a, m - 1, d)) / 86_400_000);
      return { de: somarDias(ate, -dias), ate };
    }
    case "mes":
      return { de: somarMeses(primeiroDoMes(atual.de), -1), ate: somarMeses(atual.ate, -1) };
    case "mes_anterior": {
      const de = somarMeses(primeiroDoMes(atual.de), -1);
      return { de, ate: ultimoDoMes(de) };
    }
    case "ano":
      return { de: `${Number(atual.de.slice(0, 4)) - 1}-01-01`, ate: somarMeses(atual.ate, -12) };
  }
}

function lerMes(texto: string): [number, number] {
  const r = /^(\d{4})-(\d{2})$/.exec(texto);
  if (!r || Number(r[2]) < 1 || Number(r[2]) > 12) throw new Error(MSG_PERIODO);
  return [Number(r[1]), Number(r[2])];
}

/** De `AAAA-MM` a `AAAA-MM`, do dia 1 ao último dia; no máximo 24 meses. */
export function intervaloDeMeses(de: string, ate: string): Intervalo {
  const [a1, m1] = lerMes(de);
  const [a2, m2] = lerMes(ate);
  const meses = (a2 * 12 + m2) - (a1 * 12 + m1) + 1;
  if (meses < 1 || meses > 24) throw new Error(MSG_PERIODO);
  return { de: `${de}-01`, ate: ultimoDoMes(`${ate}-01`) };
}

/** Variação percentual com uma casa ("12.5"); null sem base de comparação. */
export function variacaoPct(atual: bigint, anterior: bigint): string | null {
  if (anterior === 0n) return null;
  const base = anterior < 0n ? -anterior : anterior;
  return pct1(atual - anterior, base);
}

/** Margem ponderada pela receita (Σ final ÷ Σ receita); null se não há receita. */
export function margemPonderada(itens: { final: bigint; receita: bigint }[]): string | null {
  let final = 0n;
  let receita = 0n;
  for (const i of itens) {
    final += i.final;
    receita += i.receita;
  }
  return receita === 0n ? null : pct1(final, receita);
}

/** Percentual em texto com sinal ("-5.3", "19.000") → milésimos de ponto (inteiro). */
function milesimosPct(p: string): bigint {
  const r = /^(-?)(\d+)(?:\.(\d{1,3}))?$/.exec(p.trim());
  if (!r) throw new Error("Percentual inválido");
  const v = BigInt(r[2]) * 1000n + BigInt((r[3] ?? "").padEnd(3, "0"));
  return r[1] ? -v : v;
}

/** Diferença `a − b` em pontos percentuais, com uma casa ("-2.5"). */
export function diferencaPp(a: string, b: string): string {
  const d = arredondar(milesimosPct(a) - milesimosPct(b), 100n);
  const abs = d < 0n ? -d : d;
  return `${d < 0n ? "-" : ""}${abs / 10n}.${abs % 10n}`;
}

/** `a` < `b`, comparando percentuais em texto ("12.5" < "19.000"). */
export function pctAbaixoDe(a: string, b: string): boolean {
  return milesimosPct(a) < milesimosPct(b);
}

export type LinhaEmpresaDre = { lado: "pagar" | "receber"; grupo: string; categoria: string; categoriaId: string; valor: bigint };
export type BlocoViagensDre = { receita: bigint; custo: bigint; imposto: bigint; taxas: bigint; semMargem: number };
export type LinhaDre = { rotulo: string; valor: bigint; nivel: "total" | "grupo" | "categoria"; categoriaId?: string };

const comparar = (a: string, b: string) => a.localeCompare(b, "pt-BR");
export const ROTULO_RECEITA_VIAGENS = "Receita de viagens";

export function montarDre(viagens: BlocoViagensDre, empresa: LinhaEmpresaDre[]): { linhas: LinhaDre[]; resultado: bigint } {
  const margemBruta = viagens.receita - viagens.custo;
  const margemViagens = margemBruta - viagens.imposto - viagens.taxas;
  const linhas: LinhaDre[] = [
    { rotulo: ROTULO_RECEITA_VIAGENS, valor: viagens.receita, nivel: "total" },
    { rotulo: "(-) Custo dos fornecedores", valor: -viagens.custo, nivel: "total" },
    { rotulo: "(=) Margem bruta", valor: margemBruta, nivel: "total" },
    { rotulo: "(-) Imposto sobre a margem", valor: -viagens.imposto, nivel: "total" },
    { rotulo: "(-) Taxas financeiras", valor: -viagens.taxas, nivel: "total" },
    { rotulo: "(=) Margem das viagens", valor: margemViagens, nivel: "total" },
  ];
  let resultado = margemViagens;

  for (const lado of ["receber", "pagar"] as const) {
    const sinal = lado === "receber" ? 1n : -1n;
    const grupos = new Map<string, LinhaEmpresaDre[]>();
    for (const l of empresa) {
      if (l.lado !== lado) continue;
      grupos.set(l.grupo, [...(grupos.get(l.grupo) ?? []), l]);
    }
    for (const nome of [...grupos.keys()].sort(comparar)) {
      const itens = [...grupos.get(nome)!].sort((x, y) => comparar(x.categoria, y.categoria));
      const total = itens.reduce((s, i) => s + i.valor, 0n) * sinal;
      resultado += total;
      linhas.push({ rotulo: nome, valor: total, nivel: "grupo" });
      for (const i of itens) {
        linhas.push({ rotulo: i.categoria, valor: i.valor * sinal, nivel: "categoria", categoriaId: i.categoriaId });
      }
    }
  }

  linhas.push({ rotulo: "(=) Resultado do período", valor: resultado, nivel: "total" });
  return { linhas, resultado };
}

export type Aviso = {
  tipo: "caixa" | "margem" | "parcela" | "comissao" | "pagar" | "conciliacao" | "aprovacao";
  titulo: string;
  detalhe: string;
  href: string;
  responsavel: "Gestão" | "Financeiro";
  /** A linha resume várias (parcelas, comissões, contas, pedidos, viagens além das 3): o link abre uma lista. */
  agregado: boolean;
};

const ORDEM_AVISO: Aviso["tipo"][] = ["caixa", "margem", "parcela", "comissao", "pagar", "conciliacao", "aprovacao"];

export const RESPONSAVEL_AVISO: Record<Aviso["tipo"], Aviso["responsavel"]> = {
  caixa: "Gestão",
  margem: "Gestão",
  aprovacao: "Gestão",
  parcela: "Financeiro",
  comissao: "Financeiro",
  pagar: "Financeiro",
  conciliacao: "Financeiro",
};

/** Caixa, margem, parcela, comissão, pagar, conciliação, aprovação; estável dentro do tipo. */
export function ordenarAvisos(avisos: Aviso[]): Aviso[] {
  return [...avisos].sort((a, b) => ORDEM_AVISO.indexOf(a.tipo) - ORDEM_AVISO.indexOf(b.tipo));
}

function reaisCsv(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? "-" : ""}${abs / 100n},${(abs % 100n).toString().padStart(2, "0")}`;
}

/** Número em texto ("-2,5", "16,5%"): o Excel lê como número, não como fórmula. */
const NUMERO_CSV = /^-?\d+(,\d+)?%?$/;

function celulaCsv(v: string | bigint | null): string {
  if (v === null) return "";
  if (typeof v === "bigint") return reaisCsv(v);
  // Texto que começa como fórmula (=, +, -, @) ganha um espaço na frente: o Excel não executa.
  const t = /^[=+\-@]/.test(v) && !NUMERO_CSV.test(v) ? ` ${v}` : v;
  return /[;"\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

/** CSV para Excel brasileiro: BOM, `;`, CRLF, decimal com vírgula e sem milhar. */
export function paraCsv(cabecalho: string[], linhas: (string | bigint | null)[][]): string {
  const todas = [cabecalho, ...linhas].map((l) => l.map(celulaCsv).join(";"));
  return "\uFEFF" + todas.join("\r\n");
}

// ---------------------------------------------------------------------------
// Relatórios: período da URL, cabeçalhos e linhas do CSV (as mesmas da tela)
// ---------------------------------------------------------------------------

export const AVISO_PERIODO_INVALIDO = "Período inválido: escolha meses em ordem e até 24 meses. Mostrando o mês atual.";

export type PeriodoRelatorio = { de: string; ate: string; intervalo: Intervalo; invalido: boolean };

/** Período `AAAA-MM` a `AAAA-MM` da URL; ausente ou inválido vale o mês de `hoje` (`invalido` só se veio e não valeu). */
export function periodoDosRelatorios(de: string | undefined, ate: string | undefined, hoje: string): PeriodoRelatorio {
  const mes = hoje.slice(0, 7);
  if (!de && !ate) return { de: mes, ate: mes, intervalo: intervaloDeMeses(mes, mes), invalido: false };
  try {
    const d = de || ate!;
    const a = ate || de!;
    return { de: d, ate: a, intervalo: intervaloDeMeses(d, a), invalido: false };
  } catch {
    return { de: mes, ate: mes, intervalo: intervaloDeMeses(mes, mes), invalido: true };
  }
}

/** `relatorio-{rel}-{de}[_{ate}][-consultor].csv` (`-consultor` quando só as viagens de um consultor). */
export function nomeArquivoRelatorio(rel: Relatorio, de: string, ate: string, porConsultor = false): string {
  return `relatorio-${rel}-${de}${ate === de ? "" : `_${ate}`}${porConsultor ? "-consultor" : ""}.csv`;
}

export const CABECALHOS: Record<Relatorio, string[]> = {
  dre: ["Linha", "Valor"],
  pagar: ["Vencimento", "Fornecedor", "Descrição", "Categoria", "Viagem", "Situação", "Valor"],
  receber: ["Vencimento", "Cliente", "Descrição", "Categoria", "Viagem", "Situação", "Valor"],
  bancos: ["Conta", "Entradas", "Saídas", "Saldo do período", "Saldo atual"],
  margens: ["Viagem", "Cliente", "Destino", "Valor vendido", "Planejada", "Real", "Diferença"],
  consultores: ["Consultor", "Viagens", "Valor vendido", "Margem real"],
  conciliacao: ["Data", "Conta", "Lançamento no extrato", "Extrato (R$)", "Sistema (R$)", "Situação"],
};

type LinhaContaCsv = { vencimento: string; pessoa: string; descricao: string; categoria: string; viagemCodigo: string | null; situacao: string; valor: bigint };
type LinhaMargemCsv = { codigo: string; cliente: string; destino: string; vendido: bigint; planejadaPct: string; realPct: string | null; diferencaPp: string | null };

export type LinhaConciliacaoRel = {
  data: string;
  conta: string;
  contaId: string;
  descricao: string;
  valorExtrato: bigint;
  /** Valor da baixa conciliada (com sinal); null sem par. */
  valorSistema: bigint | null;
  /** Rótulo exibido: "Confere", "Diferença de R$ x", "Não conciliado"... */
  situacao: string;
};
export type TotalConciliacaoRel = { tipo: "confere" | "diferenca" | "nao_conciliado" | "ignorado" | "baixa_mudou"; rotulo: string; qtd: number; valor: bigint };

/** Dados de cada relatório, como saem das leituras (só o que a tela e o CSV usam). */
export type DadosRelatorios = {
  dre: { linhas: LinhaDre[] };
  pagar: { linhas: LinhaContaCsv[]; totais: Record<string, bigint> };
  receber: { linhas: LinhaContaCsv[]; totais: Record<string, bigint> };
  bancos: {
    contas: { nome: string; entradas: bigint; saidas: bigint; saldoPeriodo: bigint; saldoAtual: bigint }[];
    total: { entradas: bigint; saidas: bigint; saldoPeriodo: bigint };
  };
  margens: LinhaMargemCsv[];
  consultores: {
    linhas: { nome: string; viagens: number; vendido: bigint; margemPct: string | null }[];
    total: { viagens: number; vendido: bigint; margemPct: string | null };
  };
  conciliacao: { linhas: LinhaConciliacaoRel[]; totais: TotalConciliacaoRel[] };
};

const dataBrCsv = (iso: string) => iso.split("-").reverse().join("/");
/** Diferença em pontos percentuais, como na tela: "-2,5 pontos". */
export const ppBr = (d: string) => `${d.startsWith("-") ? "" : "+"}${d.replace(".", ",")} pontos`;
export const SEM_CALCULO = "Sem cálculo";
export const SEM_MARGEM = "Sem margem";

/** Cabeçalho e linhas do CSV de um relatório: o mesmo conteúdo da tela, valores em reais (`paraCsv`). */
export function linhasCsv<R extends Relatorio>(rel: R, dados: DadosRelatorios[R]): { cabecalho: string[]; linhas: (string | bigint | null)[][] } {
  const cabecalho = CABECALHOS[rel];
  const d = dados as DadosRelatorios[Relatorio];
  switch (rel) {
    case "dre":
      return { cabecalho, linhas: (d as DadosRelatorios["dre"]).linhas.map((l) => [l.rotulo, l.valor]) };
    case "pagar":
    case "receber": {
      const { linhas, totais } = d as DadosRelatorios["pagar"];
      return {
        cabecalho,
        linhas: [
          ...linhas.map((l) => [dataBrCsv(l.vencimento), l.pessoa, l.descricao, l.categoria, l.viagemCodigo, l.situacao, l.valor]),
          ...Object.entries(totais).map(([situacao, v]) => ["Total", "", "", "", "", situacao, v]),
        ],
      };
    }
    case "bancos": {
      const { contas, total } = d as DadosRelatorios["bancos"];
      return {
        cabecalho,
        linhas: [
          ...contas.map((c) => [c.nome, c.entradas, c.saidas, c.saldoPeriodo, c.saldoAtual]),
          ["Total", total.entradas, total.saidas, total.saldoPeriodo, null],
        ],
      };
    }
    case "margens":
      return {
        // Na planilha a diferença é um número (em pontos), sem "+" nem "pontos", para o Excel somar.
        cabecalho: cabecalho.map((c) => (c === "Diferença" ? "Diferença (pontos)" : c)),
        linhas: (d as DadosRelatorios["margens"]).map((l) => [
          l.codigo,
          l.cliente,
          l.destino,
          l.vendido,
          formatarPercentual(l.planejadaPct),
          l.realPct === null ? SEM_CALCULO : formatarPercentual(l.realPct),
          l.diferencaPp === null ? null : l.diferencaPp.replace(".", ","),
        ]),
      };
    case "conciliacao": {
      const { linhas, totais } = d as DadosRelatorios["conciliacao"];
      return {
        cabecalho,
        linhas: [
          ...linhas.map((l) => [dataBrCsv(l.data), l.conta, l.descricao, l.valorExtrato, l.valorSistema, l.situacao]),
          ...totais.map((t) => ["Total", "", `${t.qtd} ${t.qtd === 1 ? "transação" : "transações"}`, t.valor, null, t.rotulo]),
        ],
      };
    }
    case "consultores": {
      const { linhas, total } = d as DadosRelatorios["consultores"];
      const m = (p: string | null) => (p === null ? SEM_MARGEM : formatarPercentual(p));
      return {
        cabecalho,
        linhas: [
          ...linhas.map((l) => [l.nome, String(l.viagens), l.vendido, m(l.margemPct)]),
          ["Total", String(total.viagens), total.vendido, m(total.margemPct)],
        ],
      };
    }
  }
}

const NOMES_MES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
/** "2026-11" -> "novembro de 2026"; um mês ou "janeiro de 2026 a março de 2026". */
export const rotuloMes = (m: string) => `${NOMES_MES[Number(m.slice(5)) - 1]} de ${m.slice(0, 4)}`;
export const rotuloPeriodoMeses = (de: string, ate: string) => (de === ate ? rotuloMes(de) : `${rotuloMes(de)} a ${rotuloMes(ate)}`);
