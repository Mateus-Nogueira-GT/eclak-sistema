import "server-only";
import { and, between, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Candidata } from "@/domain/conciliacao";
import type { Origem } from "@/domain/financeiro";
import { db, type Transacao } from "@/server/db/client";
import { extratoTransacoes, lancamentosFinanceiros as lf } from "@/server/db/schema";

// Leitura das baixas da view `lancamentos_financeiros` como candidatas à conciliação do extrato (usada pelas actions
// e pelas queries da conciliação). Candidata = linha baixada, que transita pelo caixa, na conta do extrato e sem
// transação `conciliada` apontando para ela. Valor com sinal: receber +, pagar −; data = `baixado_em`.

export type TransacaoExtratoLinha = typeof extratoTransacoes.$inferSelect;

const colunas = {
  origem: lf.origem,
  id: lf.id,
  lado: lf.lado,
  baixadoEm: lf.baixadoEm,
  statusBase: lf.statusBase,
  contaBancariaId: lf.contaBancariaId,
  transitaCaixa: lf.transitaCaixa,
  valorCaixaBaixado: lf.valorCaixaBaixado,
  pessoa: lf.pessoa,
  descricao: lf.descricao,
};

type LinhaView = {
  origem: Origem;
  id: string;
  lado: "pagar" | "receber";
  baixadoEm: string | null;
  statusBase: string;
  contaBancariaId: string | null;
  transitaCaixa: boolean;
  valorCaixaBaixado: bigint | null;
  pessoa: string;
  descricao: string;
};

/** A linha como candidata (valor com sinal, data da baixa); `null` se não está baixada no caixa da `contaId`. */
function comoCandidata(l: LinhaView, contaId: string): Candidata | null {
  if (l.statusBase !== "baixado" || !l.transitaCaixa || l.contaBancariaId !== contaId || l.baixadoEm === null || l.valorCaixaBaixado === null) return null;
  const valor = l.lado === "receber" ? l.valorCaixaBaixado : -l.valorCaixaBaixado;
  return { origem: l.origem, id: l.id, data: l.baixadoEm, valor, pessoa: l.pessoa, descricao: l.descricao };
}

/** Já há transação `conciliada` apontando para a linha da view. */
const jaConciliada = sql`EXISTS (SELECT 1 FROM ${extratoTransacoes} et WHERE et.situacao = 'conciliada' AND et.linha_origem = ${lf.origem} AND et.linha_id = ${lf.id})`;

function filtroCandidatas(contaId: string, de: string, ate: string): SQL {
  return and(
    eq(lf.contaBancariaId, contaId),
    eq(lf.statusBase, "baixado"),
    eq(lf.transitaCaixa, true),
    between(lf.baixadoEm, de, ate),
    sql`NOT ${jaConciliada}`,
  )!;
}

/**
 * Numa consulta: as candidatas da conta com baixa entre `de` e `ate` (sem par conciliado) e as linhas de `pares`
 * (as conciliadas, como estão hoje, onde estiverem). Em `linhas`, `null` = a linha já não é candidata válida
 * (não baixada, fora do caixa ou de outra conta) ou sumiu. `soPares`: só as linhas de `pares` (sem candidatas),
 * para quem precisa só da situação (o relatório).
 */
export async function lerCandidatas(
  contaId: string,
  de: string,
  ate: string,
  pares: { origem: Origem; id: string }[],
  { soPares = false }: { soPares?: boolean } = {},
): Promise<{ candidatas: Candidata[]; linhas: Map<string, Candidata | null> }> {
  const ids = [...new Set(pares.map((p) => p.id))];
  if (soPares && ids.length === 0) return { candidatas: [], linhas: new Map() };
  const filtro = soPares ? inArray(lf.id, ids) : ids.length > 0 ? or(filtroCandidatas(contaId, de, ate), inArray(lf.id, ids)) : filtroCandidatas(contaId, de, ate);
  const linhasView = (await db
    .select({ ...colunas, livre: sql<boolean>`NOT ${jaConciliada}` })
    .from(lf)
    .where(filtro)
    .orderBy(lf.baixadoEm, lf.origem, lf.id)) as (LinhaView & { livre: boolean })[];
  const candidatas: Candidata[] = [];
  const porChave = new Map<string, LinhaView>();
  for (const l of linhasView) {
    porChave.set(chave(l.origem, l.id), l);
    const c = comoCandidata(l, contaId);
    if (!soPares && c && l.livre && c.data >= de && c.data <= ate) candidatas.push(c);
  }
  const linhas = new Map<string, Candidata | null>();
  for (const p of pares) {
    const l = porChave.get(chave(p.origem, p.id));
    linhas.set(chave(p.origem, p.id), l ? comoCandidata(l, contaId) : null);
  }
  return { candidatas, linhas };
}

export const chave = (origem: string, id: string) => `${origem}:${id}`;

/** A linha da view (origem + id) como candidata da conta, lida na transação; `null` se não é. */
export async function candidataNa(tx: Transacao, contaId: string, origem: Origem, id: string): Promise<Candidata | null> {
  const [l] = (await tx
    .select(colunas)
    .from(lf)
    .where(and(eq(lf.origem, origem), eq(lf.id, id)))) as LinhaView[];
  return l ? comoCandidata(l, contaId) : null;
}

/** Trava (`for update`) a transação do extrato. */
export async function travarTransacaoExtrato(tx: Transacao, id: string): Promise<TransacaoExtratoLinha | null> {
  const [t] = await tx.select().from(extratoTransacoes).where(eq(extratoTransacoes.id, id)).for("update");
  return t ?? null;
}
