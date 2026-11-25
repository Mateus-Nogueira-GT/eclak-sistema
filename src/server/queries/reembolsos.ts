import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { ROTULO_FORMA_DEVOLUCAO, situacaoDoReembolso, type FormaDevolucao, type SituacaoReembolso } from "@/domain/reembolsos";
import { formatarCodigoViagem } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, contasPagar, fornecedores, itensViagem, lancamentos, reembolsos, viagens } from "@/server/db/schema";

// Leituras dos reembolsos (fatia 5b, spec §6 e §14). Só Diretor e financeiros. O estado de cada lado vem da conta
// ligada ao caso (`lancamentos.reembolso_id`), nunca de cópia no caso; nas formas sem conta (abatimento e crédito), o
// lado do cliente usa `reembolsado_em` do caso. Dinheiro em centavos.

export type LadoFornecedorCaso = {
  /** Valor a cobrar do fornecedor (0 = nada a cobrar: o lado nasce fechado). */
  valor: bigint;
  fornecedor: string | null;
  previsto: string | null;
  pedidoEm: string | null;
  protocolo: string | null;
  /** A conta a receber não cancelada do caso. */
  contaId: string | null;
  /** Baixa da conta a receber. */
  recebidoEm: string | null;
  valorRecebido: bigint | null;
};

export type LadoClienteCaso = {
  /** Valor a devolver ao cliente (0 = nada a devolver: o lado nasce fechado). */
  valor: bigint;
  prazo: string;
  /** A conta a pagar não cancelada do caso (só PIX e transferência). */
  contaId: string | null;
  /** Baixa da conta a pagar, ou a data do caso nas formas sem conta. */
  reembolsadoEm: string | null;
  /** Valor da baixa da conta a pagar (nulo nas formas sem conta). */
  valorDevolvido: bigint | null;
};

export type ReembolsoCaso = {
  id: string;
  viagemId: string;
  viagemCodigo: string;
  viagemDestino: string;
  clienteNome: string;
  contaPagarId: string | null;
  servico: string;
  ocorridoEm: string;
  ocorrido: string;
  formaDevolucao: FormaDevolucao;
  rotuloForma: string;
  situacao: SituacaoReembolso;
  ladoFornecedor: LadoFornecedorCaso;
  ladoCliente: LadoClienteCaso;
  canceladoEm: Date | null;
  motivoCancelamento: string | null;
  criadoEm: Date;
};

export type ResumoReembolsos = { abertos: number; aReceber: bigint; aDevolver: bigint };

const fechados: SituacaoReembolso[] = ["Concluído", "Cancelado"];

/** Os casos do filtro, montados com as contas ligadas (uma leitura para os casos e uma para as contas). */
async function casos(filtro: SQL | undefined, ordem: SQL[]): Promise<ReembolsoCaso[]> {
  const linhas = await db
    .select({
      r: reembolsos,
      seq: viagens.seq,
      destino: viagens.destino,
      clienteCodigo: clientes.codigo,
      clienteNome: clientes.grupo,
      fornecedor: fornecedores.nome,
    })
    .from(reembolsos)
    .innerJoin(viagens, eq(viagens.id, reembolsos.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .leftJoin(fornecedores, eq(fornecedores.id, reembolsos.fornecedorId))
    .where(filtro)
    .orderBy(...ordem);
  if (linhas.length === 0) return [];
  const contas = await db
    .select({ id: lancamentos.id, reembolsoId: lancamentos.reembolsoId, lado: lancamentos.lado, status: lancamentos.status, baixadoEm: lancamentos.baixadoEm, valorPago: lancamentos.valorPago })
    .from(lancamentos)
    .where(and(inArray(lancamentos.reembolsoId, linhas.map((l) => l.r.id)), ne(lancamentos.status, "cancelado")));
  return linhas.map(({ r, ...l }) => {
    const receber = contas.find((c) => c.reembolsoId === r.id && c.lado === "receber");
    const pagar = contas.find((c) => c.reembolsoId === r.id && c.lado === "pagar");
    const baixada = (c: typeof receber) => (c?.status === "baixado" ? c : undefined);
    const ladoFornecedor: LadoFornecedorCaso = {
      valor: r.valorCobrar,
      fornecedor: l.fornecedor,
      previsto: r.previstoFornecedor,
      pedidoEm: r.pedidoEm,
      protocolo: r.protocolo,
      contaId: receber?.id ?? null,
      recebidoEm: baixada(receber)?.baixadoEm ?? null,
      valorRecebido: baixada(receber)?.valorPago ?? null,
    };
    const ladoCliente: LadoClienteCaso = {
      valor: r.valorDevolver,
      prazo: r.prazoCliente,
      contaId: pagar?.id ?? null,
      reembolsadoEm: baixada(pagar)?.baixadoEm ?? r.reembolsadoEm,
      valorDevolvido: baixada(pagar)?.valorPago ?? null,
    };
    return {
      id: r.id,
      viagemId: r.viagemId,
      viagemCodigo: formatarCodigoViagem(l.clienteCodigo, l.seq),
      viagemDestino: l.destino,
      clienteNome: l.clienteNome,
      contaPagarId: r.contaPagarId,
      servico: r.servico,
      ocorridoEm: r.ocorridoEm,
      ocorrido: r.ocorrido,
      formaDevolucao: r.formaDevolucao,
      rotuloForma: ROTULO_FORMA_DEVOLUCAO[r.formaDevolucao],
      situacao: situacaoDoReembolso({
        canceladoEm: r.canceladoEm ? r.canceladoEm.toISOString() : null,
        fornecedor: { valor: r.valorCobrar, pedidoEm: r.pedidoEm, recebidoEm: ladoFornecedor.recebidoEm },
        cliente: { valor: r.valorDevolver, reembolsadoEm: ladoCliente.reembolsadoEm },
      }),
      ladoFornecedor,
      ladoCliente,
      canceladoEm: r.canceladoEm,
      motivoCancelamento: r.motivoCancelamento,
      criadoEm: r.criadoEm,
    };
  });
}

/**
 * Casos da aba: "abertos" (algum lado em aberto), pelo prazo do cliente; "concluidos" (os dois lados fechados e os
 * cancelados), os mais recentes primeiro. O resumo conta sempre todos os casos não cancelados: casos abertos, o que
 * falta receber dos fornecedores e o que falta devolver aos clientes (lados em aberto, pelo valor do caso).
 */
export async function listarReembolsos(aba: "abertos" | "concluidos"): Promise<{ casos: ReembolsoCaso[]; resumo: ResumoReembolsos }> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const todos = await casos(undefined, [asc(reembolsos.prazoCliente), desc(reembolsos.criadoEm), asc(reembolsos.id)]);
  const resumo: ResumoReembolsos = { abertos: 0, aReceber: 0n, aDevolver: 0n };
  for (const c of todos) {
    if (c.canceladoEm) continue;
    if (!fechados.includes(c.situacao)) resumo.abertos += 1;
    if (!c.ladoFornecedor.recebidoEm) resumo.aReceber += c.ladoFornecedor.valor;
    if (!c.ladoCliente.reembolsadoEm) resumo.aDevolver += c.ladoCliente.valor;
  }
  const daAba =
    aba === "abertos"
      ? todos.filter((c) => !fechados.includes(c.situacao))
      : todos.filter((c) => fechados.includes(c.situacao)).sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime());
  return { casos: daAba, resumo };
}

/** Todos os casos da viagem (inclusive os cancelados), os mais recentes primeiro. */
export async function reembolsosDaViagem(viagemId: string): Promise<ReembolsoCaso[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  if (!ehUuid(viagemId)) return [];
  return casos(eq(reembolsos.viagemId, viagemId), [desc(reembolsos.criadoEm), desc(reembolsos.id)]);
}

/**
 * Os serviços da viagem para escolher no registro: as contas de fornecedor ativas (as mesmas que o registro aceita),
 * na ordem dos itens. `leftJoin` nos itens para não depender deles: o rótulo é a descrição da conta.
 */
export async function servicosDaViagem(viagemId: string): Promise<{ contaId: string; servico: string; fornecedor: string | null }[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  if (!ehUuid(viagemId)) return [];
  return db
    .select({ contaId: contasPagar.id, servico: contasPagar.descricao, fornecedor: fornecedores.nome })
    .from(contasPagar)
    .leftJoin(itensViagem, eq(itensViagem.id, contasPagar.itemId))
    .leftJoin(fornecedores, eq(fornecedores.id, contasPagar.fornecedorId))
    .where(and(eq(contasPagar.viagemId, viagemId), isNull(contasPagar.excluidoEm)))
    .orderBy(asc(itensViagem.ordem), asc(contasPagar.id));
}

/** As viagens vendidas (conciliadas ou não) para escolher no registro, as de início mais recente primeiro. */
export async function viagensParaReembolso(): Promise<{ id: string; rotulo: string }[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const rs = await db
    .select({ id: viagens.id, seq: viagens.seq, destino: viagens.destino, codigoCliente: clientes.codigo, grupo: clientes.grupo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(eq(viagens.status, "vendida"), isNull(viagens.excluidoEm)))
    .orderBy(desc(viagens.inicio), asc(viagens.id))
    .limit(500);
  return rs.map((r) => ({ id: r.id, rotulo: `${formatarCodigoViagem(r.codigoCliente, r.seq)} · ${r.grupo} · ${r.destino}` }));
}
