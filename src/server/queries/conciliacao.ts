import "server-only";
import { and, asc, between, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  DIAS_AVISO,
  DIAS_ESCOLHA,
  opcoesDeEscolha,
  situacaoExibida,
  sugerirPar,
  type Candidata,
  type SituacaoConciliacao,
  type SituacaoExtrato,
} from "@/domain/conciliacao";
import type { Origem } from "@/domain/financeiro";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { lerData, somarDias } from "@/domain/venda";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { contasBancarias, extratoTransacoes, extratos, usuarios } from "@/server/db/schema";
import { chave, lerCandidatas } from "@/server/financeiro/conciliacao";

// Leitura da conciliação de uma conta num período: as transações do extrato com a situação exibida, a baixa
// conciliada como está hoje, a sugestão e as opções de escolha (candidatas lidas da view numa consulta só).

export type SituacaoExibida = ReturnType<typeof situacaoExibida>;

export const SITUACOES_CONCILIACAO: SituacaoConciliacao[] = ["confere", "diferenca", "nao_conciliado", "ignorado", "baixa_mudou"];

export type TransacaoDoExtrato = {
  id: string;
  extratoId: string;
  fitid: string;
  data: string;
  /** Centavos com sinal: entrada +, saída −. */
  valor: bigint;
  tipo: string | null;
  descricao: string;
  situacao: SituacaoExtrato;
  linhaOrigem: Origem | null;
  linhaId: string | null;
  ignoradaMotivo: string | null;
};

export type LinhaConciliacao = {
  transacao: TransacaoDoExtrato;
  situacao: SituacaoExibida;
  /** A baixa conciliada como está hoje; `null` se pendente, ignorada ou se a baixa já não vale ("A baixa mudou"). */
  linha: Candidata | null;
  sugestao: Candidata | null;
  opcoes: Candidata[];
};

export type Importacao = {
  id: string;
  arquivoNome: string;
  bancoOfx: string | null;
  contaOfx: string | null;
  inicio: string | null;
  fim: string | null;
  transacoes: number;
  repetidas: number;
  importadoEm: Date;
  importadoPorNome: string;
};

export type Conciliacao = {
  conta: { id: string; nome: string; ativa: boolean };
  importacoes: Importacao[];
  linhas: LinhaConciliacao[];
  /** Do período inteiro (antes do filtro de situação); `valor` = soma dos valores com sinal do extrato. */
  totais: Record<SituacaoConciliacao, { qtd: number; valor: bigint }>;
};

export type FiltroConciliacao = { contaBancariaId: string; de: string; ate: string; situacao?: SituacaoConciliacao | null };

/** Data ISO de calendário real (rejeita 2026-13-45). */
function dataValida(v: string): boolean {
  try {
    lerData(v);
    return true;
  } catch {
    return false;
  }
}

/** Conciliação da conta no período (datas da transação). Conta inexistente ou excluída → `null`. */
export async function obterConciliacao(filtro: FiltroConciliacao): Promise<Conciliacao | null> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const { contaBancariaId, de, ate } = filtro;
  if (!dataValida(de) || !dataValida(ate) || de > ate) throw new Error("Período inválido");
  if (!ehUuid(contaBancariaId)) return null;
  const [conta] = await db
    .select({ id: contasBancarias.id, nome: contasBancarias.nome, ativa: contasBancarias.ativa })
    .from(contasBancarias)
    .where(and(eq(contasBancarias.id, contaBancariaId), isNull(contasBancarias.excluidoEm)));
  if (!conta) return null;

  const [importacoes, transacoes] = await Promise.all([
    db
      .select({
        id: extratos.id,
        arquivoNome: extratos.arquivoNome,
        bancoOfx: extratos.bancoOfx,
        contaOfx: extratos.contaOfx,
        inicio: extratos.inicio,
        fim: extratos.fim,
        transacoes: extratos.transacoes,
        repetidas: extratos.repetidas,
        importadoEm: extratos.importadoEm,
        importadoPorNome: usuarios.nome,
      })
      .from(extratos)
      .innerJoin(usuarios, eq(usuarios.id, extratos.importadoPor))
      .where(eq(extratos.contaBancariaId, conta.id))
      .orderBy(desc(extratos.importadoEm)),
    db
      .select({
        id: extratoTransacoes.id,
        extratoId: extratoTransacoes.extratoId,
        fitid: extratoTransacoes.fitid,
        data: extratoTransacoes.data,
        valor: extratoTransacoes.valor,
        tipo: extratoTransacoes.tipo,
        descricao: extratoTransacoes.descricao,
        situacao: extratoTransacoes.situacao,
        linhaOrigem: extratoTransacoes.linhaOrigem,
        linhaId: extratoTransacoes.linhaId,
        ignoradaMotivo: extratoTransacoes.ignoradaMotivo,
      })
      .from(extratoTransacoes)
      .where(and(eq(extratoTransacoes.contaBancariaId, conta.id), between(extratoTransacoes.data, de, ate)))
      .orderBy(asc(extratoTransacoes.data), asc(extratoTransacoes.fitid)),
  ]);

  const pares = transacoes.flatMap((t) => (t.situacao === "conciliada" && t.linhaOrigem && t.linhaId ? [{ origem: t.linhaOrigem, id: t.linhaId }] : []));
  const { candidatas, linhas: conciliadas } = await lerCandidatas(conta.id, somarDias(de, -DIAS_ESCOLHA), somarDias(ate, DIAS_ESCOLHA), pares);

  // Situação desconhecida: sem filtro.
  const situacao = SITUACOES_CONCILIACAO.find((s) => s === filtro.situacao) ?? null;
  const totais = Object.fromEntries(SITUACOES_CONCILIACAO.map((s) => [s, { qtd: 0, valor: 0n }])) as Conciliacao["totais"];
  const todas: LinhaConciliacao[] = transacoes.map((t) => {
    const linha = t.situacao === "conciliada" && t.linhaOrigem && t.linhaId ? (conciliadas.get(chave(t.linhaOrigem, t.linhaId)) ?? null) : null;
    const situacao = situacaoExibida(t, linha);
    const total = totais[situacao.tipo];
    total.qtd += 1;
    total.valor += t.valor;
    const pendente = t.situacao === "pendente";
    return {
      transacao: t,
      situacao,
      linha: situacao.tipo === "baixa_mudou" ? null : linha,
      sugestao: pendente ? sugerirPar(t, candidatas) : null,
      opcoes: pendente ? opcoesDeEscolha(t, candidatas) : [],
    };
  });

  return {
    conta,
    importacoes,
    linhas: situacao ? todas.filter((l) => l.situacao.tipo === situacao) : todas,
    totais,
  };
}

/**
 * Transações pendentes com data de mais de `DIAS_AVISO` dias (o aviso "sem par no sistema") das contas ativas e não
 * excluídas; `valor` = soma dos valores em módulo. Sem checagem de acesso: chamada por `obterVisaoGeral`, que já checa.
 */
export async function pendentesParaAviso(hoje: string): Promise<{ qtd: number; valor: bigint }> {
  const [r] = await db
    .select({
      qtd: sql<number>`count(*)::int`,
      valor: sql<string>`coalesce(sum(abs(${extratoTransacoes.valor})), 0)::bigint`,
    })
    .from(extratoTransacoes)
    .innerJoin(contasBancarias, eq(contasBancarias.id, extratoTransacoes.contaBancariaId))
    .where(
      and(
        eq(extratoTransacoes.situacao, "pendente"),
        lt(extratoTransacoes.data, somarDias(hoje, -DIAS_AVISO)),
        eq(contasBancarias.ativa, true),
        isNull(contasBancarias.excluidoEm),
      ),
    );
  return { qtd: r.qtd, valor: BigInt(r.valor) };
}
