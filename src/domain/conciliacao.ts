// Regras puras da conciliação do extrato OFX com as baixas do sistema (fatia 6b). Valores em centavos com sinal
// (entrada +, saída −); datas ISO AAAA-MM-DD, em calendário puro.
import { formatarReais } from "./dinheiro";
import type { Origem } from "./financeiro";
import { lerData } from "./venda";

export const SITUACOES_EXTRATO = ["pendente", "conciliada", "ignorada"] as const;
export type SituacaoExtrato = (typeof SITUACOES_EXTRATO)[number];

export type SituacaoConciliacao = "confere" | "diferenca" | "nao_conciliado" | "ignorado" | "baixa_mudou";

export const DIAS_SUGESTAO = 3;
export const DIAS_ESCOLHA = 10;
export const DIAS_AVISO = 3;

export type Candidata = {
  origem: Origem;
  id: string;
  data: string;
  valor: bigint;
  pessoa: string;
  descricao: string;
};

const DIA_MS = 86_400_000;

function diasAbs(a: string, b: string): number {
  const [aa, am, ad] = lerData(a);
  const [ba, bm, bd] = lerData(b);
  return Math.abs(Math.round((Date.UTC(aa, am - 1, ad) - Date.UTC(ba, bm - 1, bd)) / DIA_MS));
}

const sinal = (v: bigint): number => (v > 0n ? 1 : v < 0n ? -1 : 0);
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

/** Mesmo valor (e sinal), a até `DIAS_SUGESTAO` dias; só a única mais próxima na data (empate: nenhuma). */
export function sugerirPar(t: { data: string; valor: bigint }, candidatas: Candidata[]): Candidata | null {
  let melhor: Candidata | null = null;
  let distancia = Infinity;
  let empate = false;
  for (const c of candidatas) {
    if (c.valor !== t.valor) continue;
    const d = diasAbs(c.data, t.data);
    if (d > DIAS_SUGESTAO) continue;
    if (d < distancia) {
      melhor = c;
      distancia = d;
      empate = false;
    } else if (d === distancia) {
      empate = true;
    }
  }
  return empate ? null : melhor;
}

/** Baixas da conta a até `DIAS_ESCOLHA` dias, do mesmo sinal, das mais parecidas em valor e depois em data. */
export function opcoesDeEscolha(t: { data: string; valor: bigint }, candidatas: Candidata[]): Candidata[] {
  return candidatas
    .filter((c) => sinal(c.valor) === sinal(t.valor) && diasAbs(c.data, t.data) <= DIAS_ESCOLHA)
    .map((c) => ({ c, dv: abs(c.valor - t.valor), dd: diasAbs(c.data, t.data) }))
    .sort((x, y) => (x.dv < y.dv ? -1 : x.dv > y.dv ? 1 : x.dd - y.dd))
    .map((x) => x.c);
}

/** `linha` = a baixa conciliada como ela está hoje; null = já não é candidata válida (não baixada, outra conta). */
export function situacaoExibida(
  t: { situacao: SituacaoExtrato; valor: bigint },
  linha: { valor: bigint } | null,
): { tipo: SituacaoConciliacao; rotulo: string; diferenca: bigint } {
  if (t.situacao === "pendente") return { tipo: "nao_conciliado", rotulo: "Não conciliado", diferenca: 0n };
  if (t.situacao === "ignorada") return { tipo: "ignorado", rotulo: "Ignorado", diferenca: 0n };
  if (linha === null || sinal(linha.valor) !== sinal(t.valor)) {
    return { tipo: "baixa_mudou", rotulo: "A baixa mudou: confira", diferenca: 0n };
  }
  const diferenca = abs(t.valor - linha.valor);
  if (diferenca === 0n) return { tipo: "confere", rotulo: "Confere", diferenca };
  return { tipo: "diferenca", rotulo: `Diferença de ${formatarReais(diferenca)}`, diferenca };
}
