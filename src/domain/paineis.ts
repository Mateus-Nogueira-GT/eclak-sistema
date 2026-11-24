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

/** Período de comparação: mesma duração em dias (30d/90d); mês ou ano anterior inteiro nos demais. */
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
    case "mes_anterior": {
      const de = somarMeses(primeiroDoMes(atual.de), -1);
      return { de, ate: ultimoDoMes(de) };
    }
    case "ano": {
      const ano = Number(atual.de.slice(0, 4)) - 1;
      return { de: `${ano}-01-01`, ate: `${ano}-12-31` };
    }
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

export type LinhaEmpresaDre = { lado: "pagar" | "receber"; grupo: string; categoria: string; categoriaId: string; valor: bigint };
export type BlocoViagensDre = { receita: bigint; custo: bigint; imposto: bigint; taxas: bigint; semMargem: number };
export type LinhaDre = { rotulo: string; valor: bigint; nivel: "total" | "grupo" | "categoria"; categoriaId?: string };

const comparar = (a: string, b: string) => a.localeCompare(b, "pt-BR");

export function montarDre(viagens: BlocoViagensDre, empresa: LinhaEmpresaDre[]): { linhas: LinhaDre[]; resultado: bigint } {
  const margemBruta = viagens.receita - viagens.custo;
  const margemViagens = margemBruta - viagens.imposto - viagens.taxas;
  const linhas: LinhaDre[] = [
    { rotulo: "Receita de viagens", valor: viagens.receita, nivel: "total" },
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
  tipo: "caixa" | "margem" | "parcela" | "comissao" | "pagar" | "aprovacao";
  titulo: string;
  detalhe: string;
  href: string;
  responsavel: "Gestão" | "Financeiro";
};

const ORDEM_AVISO: Aviso["tipo"][] = ["caixa", "margem", "parcela", "comissao", "pagar", "aprovacao"];

export const RESPONSAVEL_AVISO: Record<Aviso["tipo"], Aviso["responsavel"]> = {
  caixa: "Gestão",
  margem: "Gestão",
  aprovacao: "Gestão",
  parcela: "Financeiro",
  comissao: "Financeiro",
  pagar: "Financeiro",
};

/** Caixa, margem, parcela, comissão, pagar, aprovação; estável dentro do tipo. */
export function ordenarAvisos(avisos: Aviso[]): Aviso[] {
  return [...avisos].sort((a, b) => ORDEM_AVISO.indexOf(a.tipo) - ORDEM_AVISO.indexOf(b.tipo));
}

function reaisCsv(c: bigint): string {
  const neg = c < 0n;
  const abs = neg ? -c : c;
  return `${neg ? "-" : ""}${abs / 100n},${(abs % 100n).toString().padStart(2, "0")}`;
}

function celulaCsv(v: string | bigint | null): string {
  if (v === null) return "";
  if (typeof v === "bigint") return reaisCsv(v);
  return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV para Excel brasileiro: BOM, `;`, CRLF, decimal com vírgula e sem milhar. */
export function paraCsv(cabecalho: string[], linhas: (string | bigint | null)[][]): string {
  const todas = [cabecalho, ...linhas].map((l) => l.map(celulaCsv).join(";"));
  return "﻿" + todas.join("\r\n");
}
