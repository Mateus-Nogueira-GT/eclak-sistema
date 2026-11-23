import "server-only";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { rotuloForma } from "@/domain/aprovacoes";
import { MSG_JA_ATUALIZADA, msgJaTemFatura, parcelasMudaram, type ParcelaRetrato } from "@/domain/faturas";
import type { FormaPagamento } from "@/domain/precificacao";
import { formatarCodigoViagem } from "@/domain/viagens";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { clientes, faturas, faturasContador, faturasVersoes, parcelasReceber, vendas, viagens, type DadosFatura } from "@/server/db/schema";
import { travarViagem } from "@/server/trava-viagem";
import { falha, type Falha } from "./baixas-viagem";

// Fora dos arquivos "use server" de propósito: nada aqui vira endpoint. Núcleo da emissão e da reemissão de
// faturas, na transação de quem chama. Ordem das travas: viagem (`travarViagem`, a mesma das baixas e do
// cancelamento de parcela) → fatura/contador `for update`. O número vem da linha única `faturas_contador`, lida
// com `for update` e avançada na mesma transação: rollback não consome número (nunca uma `sequence`).

export const VENDA_NAO_ENCONTRADA = falha("Venda não encontrada");
export const FATURA_NAO_ENCONTRADA = falha("Fatura não encontrada");

type Leitor = Transacao | typeof db;

/** Parcelas não canceladas das vendas, por número (centavos como texto). */
export async function parcelasAtuais(leitor: Leitor, vendaIds: string[]): Promise<Map<string, ParcelaRetrato[]>> {
  const mapa = new Map<string, ParcelaRetrato[]>(vendaIds.map((id) => [id, []]));
  if (vendaIds.length === 0) return mapa;
  const linhas = await leitor
    .select({ vendaId: parcelasReceber.vendaId, numero: parcelasReceber.numero, total: parcelasReceber.totalParcelas, vencimento: parcelasReceber.vencimento, valor: parcelasReceber.valor })
    .from(parcelasReceber)
    .where(and(inArray(parcelasReceber.vendaId, vendaIds), ne(parcelasReceber.status, "cancelada")))
    .orderBy(asc(parcelasReceber.numero));
  for (const l of linhas) mapa.get(l.vendaId)!.push({ numero: l.numero, total: l.total, vencimento: l.vencimento, valor: l.valor.toString() });
  return mapa;
}

/** Retrato atual da venda: nome e documento da fatura, viagem, total, forma (rótulo) e parcelas não canceladas. */
async function retratoDaVenda(tx: Transacao, vendaId: string): Promise<DadosFatura> {
  const [v] = await tx
    .select({
      nome: vendas.faturaNome,
      documento: vendas.faturaDocumento,
      total: vendas.total,
      forma: vendas.forma,
      seq: viagens.seq,
      destino: viagens.destino,
      inicio: viagens.inicio,
      fim: viagens.fim,
      codigoCliente: clientes.codigo,
    })
    .from(vendas)
    .innerJoin(viagens, eq(viagens.id, vendas.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(vendas.id, vendaId));
  const parcelas = (await parcelasAtuais(tx, [vendaId])).get(vendaId)!;
  return {
    nome: v.nome,
    documento: v.documento,
    codigoViagem: formatarCodigoViagem(v.codigoCliente, v.seq),
    destino: v.destino,
    inicio: v.inicio,
    fim: v.fim,
    total: v.total.toString(),
    forma: rotuloForma(v.forma as FormaPagamento),
    parcelas,
  };
}

export type Emitida = { ok: true; numero: number; viagemId: string };

/**
 * Emite a fatura da venda: trava a viagem, recusa se a venda já tem fatura, lê o contador `for update`, grava a
 * fatura com esse número e a versão 1 (retrato), avança o contador e audita. Recusas voltam como `Falha` antes de
 * qualquer escrita.
 */
export async function emitirFaturaNa(tx: Transacao, usuarioId: string, vendaId: string): Promise<Emitida | Falha> {
  const [venda] = await tx.select({ viagemId: vendas.viagemId }).from(vendas).where(eq(vendas.id, vendaId));
  if (!venda) return VENDA_NAO_ENCONTRADA;
  if (!(await travarViagem(tx, venda.viagemId))) return VENDA_NAO_ENCONTRADA;
  const [existente] = await tx.select({ numero: faturas.numero }).from(faturas).where(eq(faturas.vendaId, vendaId));
  if (existente) return falha(msgJaTemFatura(existente.numero));
  const dados = await retratoDaVenda(tx, vendaId);

  const [c] = await tx.select({ proximo: faturasContador.proximo }).from(faturasContador).where(eq(faturasContador.id, 1)).for("update");
  if (!c) throw new Error("Contador de faturas ausente");
  const [f] = await tx.insert(faturas).values({ vendaId, numero: c.proximo, emitidaPor: usuarioId }).returning();
  const [v] = await tx.insert(faturasVersoes).values({ faturaId: f.id, versao: 1, emitidaPor: usuarioId, dados }).returning();
  await tx.update(faturasContador).set({ proximo: sql`${faturasContador.proximo} + 1` }).where(eq(faturasContador.id, 1));

  await registrarAuditoria(tx, { usuarioId, tabela: "faturas", registroId: f.id, acao: "criar", depois: { vendaId, numero: f.numero } });
  await registrarAuditoria(tx, { usuarioId, tabela: "faturas_versoes", registroId: v.id, acao: "criar", depois: { faturaId: f.id, versao: 1, dados } });
  return { ok: true, numero: f.numero, viagemId: venda.viagemId };
}

export type Reemitida = { ok: true; numero: number; versao: number; viagemId: string };

/** Nova versão (`max + 1`) com o retrato atual e o mesmo número; recusa se o retrato da última já está em dia. */
export async function reemitirFaturaNa(tx: Transacao, usuarioId: string, faturaId: string): Promise<Reemitida | Falha> {
  const [achada] = await tx
    .select({ viagemId: vendas.viagemId })
    .from(faturas)
    .innerJoin(vendas, eq(vendas.id, faturas.vendaId))
    .where(eq(faturas.id, faturaId));
  if (!achada) return FATURA_NAO_ENCONTRADA;
  if (!(await travarViagem(tx, achada.viagemId))) return FATURA_NAO_ENCONTRADA;
  const [f] = await tx.select().from(faturas).where(eq(faturas.id, faturaId)).for("update");
  const [ultima] = await tx
    .select({ versao: faturasVersoes.versao, dados: faturasVersoes.dados })
    .from(faturasVersoes)
    .where(eq(faturasVersoes.faturaId, faturaId))
    .orderBy(desc(faturasVersoes.versao))
    .limit(1);
  const dados = await retratoDaVenda(tx, f.vendaId);
  if (!parcelasMudaram(ultima.dados.parcelas, dados.parcelas)) return falha(MSG_JA_ATUALIZADA);
  const versao = ultima.versao + 1;
  const [v] = await tx.insert(faturasVersoes).values({ faturaId, versao, emitidaPor: usuarioId, dados }).returning();
  await registrarAuditoria(tx, { usuarioId, tabela: "faturas_versoes", registroId: v.id, acao: "criar", depois: { faturaId, versao, dados } });
  return { ok: true, numero: f.numero, versao, viagemId: achada.viagemId };
}
