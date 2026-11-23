// Domínio do caixa e do cartão corporativo. Funções puras, sem I/O.
// Dinheiro em bigint centavos; datas ISO 'AAAA-MM-DD'; semana começa na segunda-feira.
import type { Origem } from "@/domain/financeiro";
import { diasNoMes, lerData, somarMeses } from "@/domain/venda";

export const TIPOS_CAIXA = ["clientes", "fornecedores", "comissoes", "empresa", "cartao"] as const;
export type TipoCaixa = (typeof TIPOS_CAIXA)[number];

export const ROTULO_TIPO_CAIXA: Record<TipoCaixa, string> = {
  clientes: "Clientes",
  fornecedores: "Fornecedores",
  comissoes: "Comissões",
  empresa: "Empresa",
  cartao: "Cartão",
};

/**
 * Tipo da linha da lista única no fluxo de caixa (ruling 3): parcelas = Clientes, pagamentos de viagem =
 * Fornecedores, comissões = Comissões, manuais = Empresa (mesmo numa categoria das viagens; a categoria do sistema
 * não muda o tipo). A fatura do cartão entra como Cartão (as compras dela não passam pelo caixa).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- assinatura do plano: o tipo sai só da origem
export function tipoCaixaDaLinha(origem: Origem, categoriaSistema: string | null): TipoCaixa {
  switch (origem) {
    case "parcela":
      return "clientes";
    case "pagamento":
      return "fornecedores";
    case "comissao":
      return "comissoes";
    case "manual":
      return "empresa";
    case "fatura_cartao":
      return "cartao";
  }
}

export type MovimentoCaixa = {
  data: string;
  valor: bigint;
  lado: "pagar" | "receber";
  vencida: boolean;
  tipo: TipoCaixa;
};

export type PeriodoCaixa = {
  inicio: string;
  fim: string;
  rotulo: string;
  entradas: bigint;
  saidas: bigint;
  saldoFinal: bigint;
  vencidas: bigint;
};

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

const dois = (n: number) => String(n).padStart(2, "0");
const iso = (a: number, m: number, d: number) => `${String(a).padStart(4, "0")}-${dois(m)}-${dois(d)}`;

function somarDias(data: string, dias: number): string {
  const [a, m, d] = lerData(data);
  const t = new Date(Date.UTC(a, m - 1, d + dias));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Segunda-feira da semana de `data`. */
export function inicioDaSemana(data: string): string {
  const [a, m, d] = lerData(data);
  const dow = new Date(Date.UTC(a, m - 1, d)).getUTCDay(); // 0 = domingo
  return somarDias(data, -((dow + 6) % 7));
}

function rotuloDia(data: string): string {
  const [, m, d] = lerData(data);
  return `${dois(d)}/${dois(m)}`;
}

type Janela = { inicio: string; fim: string; rotulo: string };

function acumular(saldoInicial: bigint, movimentos: MovimentoCaixa[], janelas: Janela[]): PeriodoCaixa[] {
  const periodos: PeriodoCaixa[] = janelas.map((j) => ({
    ...j,
    entradas: 0n,
    saidas: 0n,
    saldoFinal: 0n,
    vencidas: 0n,
  }));
  const ultimo = janelas.length - 1;
  for (const mov of movimentos) {
    lerData(mov.data);
    let idx: number;
    if (mov.vencida || mov.data < janelas[0]!.inicio) idx = 0;
    else {
      idx = janelas.findIndex((j) => mov.data >= j.inicio && mov.data <= j.fim);
      if (idx < 0 || idx > ultimo) continue;
    }
    const p = periodos[idx]!;
    if (mov.lado === "receber") p.entradas += mov.valor;
    else p.saidas += mov.valor;
    if (mov.vencida) p.vencidas += mov.valor;
  }
  let saldo = saldoInicial;
  for (const p of periodos) {
    saldo += p.entradas - p.saidas;
    p.saldoFinal = saldo;
  }
  return periodos;
}

/** Projeção semanal (segunda a domingo). Vencidas e atrasos caem na primeira semana. */
export function projetarSemanas(
  saldoInicial: bigint,
  movimentos: MovimentoCaixa[],
  hoje: string,
  semanas = 8,
): PeriodoCaixa[] {
  const base = inicioDaSemana(hoje);
  const janelas: Janela[] = [];
  for (let i = 0; i < semanas; i++) {
    const inicio = somarDias(base, 7 * i);
    const fim = somarDias(inicio, 6);
    janelas.push({ inicio, fim, rotulo: `${rotuloDia(inicio)} a ${rotuloDia(fim)}` });
  }
  return acumular(saldoInicial, movimentos, janelas);
}

/** Projeção mensal a partir do mês de `hoje`. Vencidas e atrasos caem no primeiro mês. */
export function projetarMeses(
  saldoInicial: bigint,
  movimentos: MovimentoCaixa[],
  hoje: string,
  meses = 12,
): PeriodoCaixa[] {
  const [a0, m0] = lerData(hoje);
  const base = iso(a0, m0, 1);
  const janelas: Janela[] = [];
  for (let i = 0; i < meses; i++) {
    const inicio = somarMeses(base, i);
    const [a, m] = lerData(inicio);
    janelas.push({ inicio, fim: iso(a, m, diasNoMes(a, m)), rotulo: `${MESES[m - 1]}/${a}` });
  }
  return acumular(saldoInicial, movimentos, janelas);
}

export function metaReserva(custoFixoMensal: bigint, meses = 6): bigint {
  return custoFixoMensal * BigInt(meses);
}

export function situacaoReserva(
  saldoAtual: bigint,
  custoFixoMensal: bigint,
  projecaoMensal: PeriodoCaixa[],
): { meta: bigint; temos: bigint; falta: bigint; atingidaEm: string | null } {
  const meta = metaReserva(custoFixoMensal);
  const atingido = projecaoMensal.find((p) => p.saldoFinal >= meta);
  return {
    meta,
    temos: saldoAtual,
    falta: saldoAtual >= meta ? 0n : meta - saldoAtual,
    atingidaEm: atingido ? atingido.rotulo : null,
  };
}

/**
 * Fatura em que a compra cai: compra até o dia de fechamento entra na fatura do mês;
 * depois, na do mês seguinte. Vencimento: mês do fechamento se o dia de vencimento
 * for maior que o de fechamento, senão o mês seguinte.
 */
export function cicloDoCartao(
  dataCompra: string,
  diaFechamento: number,
  diaVencimento: number,
): { fechamento: string; vencimento: string } {
  for (const dia of [diaFechamento, diaVencimento]) {
    if (!Number.isInteger(dia) || dia < 1 || dia > 28) throw new Error("Dia deve estar entre 1 e 28.");
  }
  const [a, m, d] = lerData(dataCompra);
  const mesFech = d <= diaFechamento ? iso(a, m, 1) : somarMeses(iso(a, m, 1), 1);
  const mesVenc = diaVencimento > diaFechamento ? mesFech : somarMeses(mesFech, 1);
  const com = (mes: string, dia: number) => `${mes.slice(0, 8)}${dois(dia)}`;
  return { fechamento: com(mesFech, diaFechamento), vencimento: com(mesVenc, diaVencimento) };
}
