import "server-only";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { rotuloForma } from "@/domain/aprovacoes";
import { parcelasMudaram } from "@/domain/faturas";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import type { FormaPagamento } from "@/domain/precificacao";
import type { StatusParcela } from "@/domain/venda";
import { formatarCodigoViagem } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, faturas, faturasContador, faturasVersoes, parcelasReceber, usuarios, vendas, viagens, type DadosFatura } from "@/server/db/schema";
import { parcelasAtuais } from "@/server/financeiro/faturas";

// Leituras das faturas (só Diretor e financeiros). "Desatualizada" é calculada aqui: retrato da última versão ×
// parcelas atuais não canceladas (`parcelasMudaram`, a mesma regra que a reemissão usa para recusar).

export type VendaParaFaturar = {
  vendaId: string;
  viagemId: string;
  codigoViagem: string;
  destino: string;
  /** Cliente (grupo) e nome da fatura. */
  cliente: string;
  faturaNome: string;
  /** "Boleto em 2x". */
  forma: string;
  parcelas: number;
  primeiroVencimento: string;
  total: bigint;
  /** Data da venda (aceite do cliente). */
  aceiteEm: string;
};

/** Vendas ainda sem fatura, da mais antiga para a mais nova. */
export async function vendasParaFaturar(): Promise<VendaParaFaturar[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const linhas = await db
    .select({
      vendaId: vendas.id,
      viagemId: viagens.id,
      seq: viagens.seq,
      codigoCliente: clientes.codigo,
      destino: viagens.destino,
      cliente: clientes.grupo,
      faturaNome: vendas.faturaNome,
      forma: vendas.forma,
      parcelas: vendas.parcelas,
      primeiroVencimento: vendas.primeiroVencimento,
      total: vendas.total,
      aceiteEm: vendas.aceiteEm,
    })
    .from(vendas)
    .innerJoin(viagens, eq(viagens.id, vendas.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .leftJoin(faturas, eq(faturas.vendaId, vendas.id))
    .where(and(isNull(faturas.id), isNull(viagens.excluidoEm)))
    .orderBy(asc(vendas.aceiteEm), asc(vendas.criadoEm));
  return linhas.map(({ seq, codigoCliente, forma, ...l }) => ({
    ...l,
    codigoViagem: formatarCodigoViagem(codigoCliente, seq),
    forma: rotuloForma(forma as FormaPagamento),
  }));
}

export type FaturaLista = {
  id: string;
  numero: number;
  viagemId: string;
  cliente: string;
  /** Do retrato da última versão. */
  nome: string;
  codigoViagem: string;
  destino: string;
  forma: string;
  total: bigint;
  /** Primeira emissão (versão 1). */
  emitidaEm: Date;
  versao: number;
  /** Emissão da última versão. */
  versaoEmitidaEm: Date;
  /** Σ das parcelas recebidas (valor recebido). */
  recebido: bigint;
  desatualizada: boolean;
};

const ultimaVersao = sql`${faturasVersoes.versao} = (select max(v2.versao) from faturas_versoes v2 where v2.fatura_id = ${faturasVersoes.faturaId})`;

/** Faturas emitidas, da mais nova (maior número) para a mais antiga. */
export async function listarFaturas(): Promise<FaturaLista[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const linhas = await db
    .select({
      id: faturas.id,
      numero: faturas.numero,
      vendaId: faturas.vendaId,
      viagemId: vendas.viagemId,
      cliente: clientes.grupo,
      emitidaEm: faturas.emitidaEm,
      versao: faturasVersoes.versao,
      versaoEmitidaEm: faturasVersoes.emitidaEm,
      dados: faturasVersoes.dados,
      recebido: sql<string>`(select coalesce(sum(coalesce(p.valor_recebido, p.valor)), 0)::text from parcelas_receber p
        where p.venda_id = ${faturas.vendaId} and p.status = 'recebida')`,
    })
    .from(faturas)
    .innerJoin(faturasVersoes, and(eq(faturasVersoes.faturaId, faturas.id), ultimaVersao))
    .innerJoin(vendas, eq(vendas.id, faturas.vendaId))
    .innerJoin(viagens, eq(viagens.id, vendas.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .orderBy(desc(faturas.numero));
  const atuais = await parcelasAtuais(db, linhas.map((l) => l.vendaId));
  return linhas.map((l) => ({
    id: l.id,
    numero: l.numero,
    viagemId: l.viagemId,
    cliente: l.cliente,
    nome: l.dados.nome,
    codigoViagem: l.dados.codigoViagem,
    destino: l.dados.destino,
    forma: l.dados.forma,
    total: BigInt(l.dados.total),
    emitidaEm: l.emitidaEm,
    versao: l.versao,
    versaoEmitidaEm: l.versaoEmitidaEm,
    recebido: BigInt(l.recebido),
    desatualizada: parcelasMudaram(l.dados.parcelas, atuais.get(l.vendaId)!),
  }));
}

export type ParcelaDaFatura = {
  id: string;
  numero: number;
  total: number;
  vencimento: string;
  valor: bigint;
  status: StatusParcela;
  recebidaEm: string | null;
  valorRecebido: bigint | null;
};

export type FaturaDetalhe = {
  id: string;
  numero: number;
  viagemId: string;
  cliente: string;
  /** Versão mostrada (padrão: a última) e o retrato dela. */
  versao: number;
  emitidaEm: Date;
  emitidaPor: string;
  dados: DadosFatura;
  /** Todas as versões, em ordem. */
  versoes: number[];
  /** A última versão difere das parcelas atuais? */
  desatualizada: boolean;
  /** Situação atual das parcelas da venda (inclusive canceladas), por número. */
  parcelas: ParcelaDaFatura[];
  recebido: bigint;
};

/** Fatura com o retrato da versão pedida (padrão: a última); `null` se a fatura ou a versão não existe. */
export async function obterFatura(id: string, versao?: number): Promise<FaturaDetalhe | null> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  if (!ehUuid(id)) return null;
  const [f] = await db
    .select({ id: faturas.id, numero: faturas.numero, vendaId: faturas.vendaId, viagemId: vendas.viagemId, cliente: clientes.grupo })
    .from(faturas)
    .innerJoin(vendas, eq(vendas.id, faturas.vendaId))
    .innerJoin(viagens, eq(viagens.id, vendas.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(faturas.id, id));
  if (!f) return null;
  const versoes = await db
    .select({ versao: faturasVersoes.versao, emitidaEm: faturasVersoes.emitidaEm, emitidaPor: usuarios.nome, dados: faturasVersoes.dados })
    .from(faturasVersoes)
    .innerJoin(usuarios, eq(usuarios.id, faturasVersoes.emitidaPor))
    .where(eq(faturasVersoes.faturaId, id))
    .orderBy(asc(faturasVersoes.versao));
  const ultima = versoes.at(-1)!;
  const escolhida = versao === undefined ? ultima : versoes.find((v) => v.versao === versao);
  if (!escolhida) return null;
  const parcelas = await db
    .select({
      id: parcelasReceber.id,
      numero: parcelasReceber.numero,
      total: parcelasReceber.totalParcelas,
      vencimento: parcelasReceber.vencimento,
      valor: parcelasReceber.valor,
      status: parcelasReceber.status,
      recebidaEm: parcelasReceber.recebidaEm,
      valorRecebido: parcelasReceber.valorRecebido,
    })
    .from(parcelasReceber)
    .where(eq(parcelasReceber.vendaId, f.vendaId))
    .orderBy(asc(parcelasReceber.numero));
  const naoCanceladas = parcelas
    .filter((p) => p.status !== "cancelada")
    .map((p) => ({ numero: p.numero, total: p.total, vencimento: p.vencimento, valor: p.valor.toString() }));
  return {
    id: f.id,
    numero: f.numero,
    viagemId: f.viagemId,
    cliente: f.cliente,
    versao: escolhida.versao,
    emitidaEm: escolhida.emitidaEm,
    emitidaPor: escolhida.emitidaPor,
    dados: escolhida.dados,
    versoes: versoes.map((v) => v.versao),
    desatualizada: parcelasMudaram(ultima.dados.parcelas, naoCanceladas),
    parcelas,
    recebido: parcelas.filter((p) => p.status === "recebida").reduce((s, p) => s + (p.valorRecebido ?? p.valor), 0n),
  };
}

/** Próximo número de fatura e se já há alguma emitida (aí a numeração só avança). */
export async function proximoNumeroFatura(): Promise<{ proximo: number; haFaturas: boolean }> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const [c] = await db.select({ proximo: faturasContador.proximo }).from(faturasContador).where(eq(faturasContador.id, 1));
  const [alguma] = await db.select({ id: faturas.id }).from(faturas).limit(1);
  return { proximo: c?.proximo ?? 0, haFaturas: Boolean(alguma) };
}
