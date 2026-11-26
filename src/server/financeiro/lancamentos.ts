import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { dividirEmParcelas, datasRecorrentes, ROTULO_FORMA_FINANCEIRO, type FormaFinanceiroSlug } from "@/domain/financeiro";
import { MSG_FORMA, type baixaLancamentoSchema, type lancamentoSchema } from "@/domain/financeiro-entrada";
import { MSG_COMPRA_NO_CARTAO, MSG_DESFACA_FATURA_CARTAO } from "@/domain/venda-entrada";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import { categoriasFinanceiras, clientes, faturasCartao, fornecedores, lancamentos } from "@/server/db/schema";
import { contaBancariaAtiva, ehFalha } from "@/server/financeiro/baixas-viagem";
import { travarFaturasNa, type EntradaFatura, type SemCartao, type Vinculo } from "@/server/financeiro/cartoes";

// Núcleo dos lançamentos manuais (criar, baixar, desfazer a baixa, cancelar e alterar numa transação `tx` já aberta),
// usado pelas actions do financeiro (`@/server/actions/financeiro`), pela conciliação do extrato (criar o lançamento
// de uma transação do extrato, já baixado e conciliado na mesma transação) e pelo estoque e reembolsos (as contas
// ligadas a eles). Recusas que precisam desfazer o que já foi gravado lançam `Desfazer`.

export type Falha = { ok: false; erro: string; campos?: Record<string, string> };
export type Ok = { ok: true; id?: string; ids?: string[] };

export const falha = (erro: string, campo?: string): Falha => (campo ? { ok: false, erro, campos: { [campo]: erro } } : { ok: false, erro });
export const LANCAMENTO_NAO_ENCONTRADO = falha("Lançamento não encontrado");
const MSG_DIFERENCA_PAGO = "Explique a diferença do valor pago";
export const MSG_DESFACA_BAIXA = "Desfaça a baixa para editar";
export const MSG_LANCAMENTO_ESTOQUE = "Lançamento de entrada de estoque: desfaça a entrada no Estoque";
export const MSG_LANCAMENTO_REEMBOLSO = "Lançamento de reembolso: altere pelo caso em Reembolsos";

/** Recusa dentro da transação que precisa desfazer o que já foi gravado; vira a `falha` fora dela. */
export class Desfazer extends Error {
  constructor(readonly falha: Falha) {
    super(falha.erro);
  }
}

export type LancamentoLinha = typeof lancamentos.$inferSelect;
export type VinculoLancamento = "estoque" | "reembolso";
export type LancamentoValidado = ReturnType<typeof lancamentoSchema.parse>;
export type BaixaLancamentoValidada = ReturnType<ReturnType<typeof baixaLancamentoSchema>["parse"]>;

/** Soma `n` meses a `AAAA-MM`. */
function somarMesesCompetencia(competencia: string, n: number): string {
  const [a, m] = competencia.split("-").map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

const mesesDe = (data: string) => Number(data.slice(0, 4)) * 12 + Number(data.slice(5, 7));

/** Categoria ativa do lado certo, conta bancária ativa e pessoa existentes; senão recusa dentro da transação. */
export async function conferirReferencias(tx: Transacao, v: LancamentoValidado): Promise<void> {
  const [cat] = await tx.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.id, v.categoriaId));
  if (!cat) throw new Desfazer(falha("Categoria não encontrada", "categoriaId"));
  if (cat.lado !== v.lado) throw new Desfazer(falha("A categoria é do outro lado (pagar/receber)", "categoriaId"));
  if (!cat.ativa) throw new Desfazer(falha("Categoria desativada", "categoriaId"));
  if (v.contaBancariaId) await contaAtiva(tx, v.contaBancariaId, "contaBancariaId");
  if (v.fornecedorId) {
    const [f] = await tx.select({ id: fornecedores.id }).from(fornecedores).where(and(eq(fornecedores.id, v.fornecedorId), isNull(fornecedores.excluidoEm)));
    if (!f) throw new Desfazer(falha("Fornecedor não encontrado", "fornecedorId"));
  }
  if (v.clienteId) {
    const [cl] = await tx.select({ id: clientes.id }).from(clientes).where(and(eq(clientes.id, v.clienteId), isNull(clientes.excluidoEm)));
    if (!cl) throw new Desfazer(falha("Cliente não encontrado", "clienteId"));
  }
}

/** Conta bancária ativa (`for share`, a mesma leitura das baixas da viagem); senão recusa no `campo`. */
export async function contaAtiva(tx: Transacao, id: string, campo: string): Promise<void> {
  if (!(await contaBancariaAtiva(tx, id))) throw new Desfazer(falha("Conta bancária não encontrada ou desativada", campo));
}

/** O slug do enum a partir do rótulo da forma (o schema entrega o rótulo). */
function slugDaForma(rotulo: string): FormaFinanceiroSlug {
  const par = (Object.entries(ROTULO_FORMA_FINANCEIRO) as [FormaFinanceiroSlug, string][]).find(([, r]) => r === rotulo);
  if (!par) throw new Desfazer(falha(MSG_FORMA, "forma"));
  return par[0];
}

export const SEM_CARTAO: SemCartao = { cartaoId: null, faturaCartaoId: null };

/**
 * Trava todas as faturas que a transação mexe, numa passada só e em ordem única (`travarFaturasNa`), antes de
 * qualquer escrita nas compras; recusa desfazendo a transação. Devolve o vínculo de cada entrada, na ordem.
 */
export async function travarFaturas(tx: Transacao, usuarioId: string, sair: (string | null)[], entrar: EntradaFatura[]): Promise<Vinculo[]> {
  const r = await travarFaturasNa(tx, usuarioId, sair, entrar);
  if (ehFalha(r)) throw new Desfazer(r);
  return r;
}

/** Campos editáveis comuns (sem as datas, que cada linha mantém nas "próximas"). */
export function camposComuns(v: LancamentoValidado) {
  return {
    lado: v.lado,
    descricao: v.descricao,
    fornecedorId: v.fornecedorId,
    clienteId: v.clienteId,
    pessoaTexto: v.pessoaTexto,
    categoriaId: v.categoriaId,
    centro: v.centro,
    valor: v.valor,
    forma: slugDaForma(v.forma),
    contaBancariaId: v.contaBancariaId,
    observacao: v.observacao,
  };
}

/**
 * Cria o lançamento (única, parcelada ou recorrente) na transação `tx`, conferindo as referências e, na compra no
 * cartão, vinculando cada linha à fatura do ciclo da sua data; audita cada linha. Recusa lançando `Desfazer`.
 */
export async function criarLancamentosNa(tx: Transacao, usuarioId: string, v: LancamentoValidado): Promise<LancamentoLinha[]> {
  await conferirReferencias(tx, v);
  const rep = v.repeticao;
  const grupoId = rep.tipo === "unica" ? null : crypto.randomUUID();
  const itens: { vencimento: string; valor: bigint; numero: number | null; total: number | null }[] =
    rep.tipo === "unica"
      ? [{ vencimento: v.vencimento, valor: v.valor, numero: null, total: null }]
      : rep.tipo === "parcelado"
        ? dividirEmParcelas(v.valor, rep.parcelas, v.vencimento).map((x) => ({ vencimento: x.vencimento, valor: x.valor, numero: x.numero, total: x.total }))
        : datasRecorrentes(v.vencimento, rep.frequencia, rep.quantidade).map((d, i) => ({ vencimento: d, valor: v.valor, numero: i + 1, total: rep.quantidade }));
  const base = camposComuns(v);
  // Compra no cartão: cada linha na fatura do ciclo da sua data (as datas crescem: faturas travadas em ordem).
  const cartaoId = v.cartaoId;
  const vinculos: (Vinculo | SemCartao)[] = cartaoId
    ? await travarFaturas(tx, usuarioId, [], itens.map((x) => ({ cartaoId, dataCompra: x.vencimento, exigeAtivo: true })))
    : itens.map(() => SEM_CARTAO);
  const linhas = await tx
    .insert(lancamentos)
    .values(
      itens.map((x, i) => ({
        ...base,
        ...vinculos[i],
        competencia: somarMesesCompetencia(v.competencia, mesesDe(x.vencimento) - mesesDe(v.vencimento)),
        emissao: v.emissao,
        vencimento: x.vencimento,
        valor: x.valor,
        grupoId,
        parcelaNumero: x.numero,
        parcelaTotal: x.total,
        criadoPor: usuarioId,
      })),
    )
    .returning();
  for (const l of linhas) {
    await registrarAuditoria(tx, { usuarioId, tabela: "lancamentos", registroId: l.id, acao: "criar", depois: l });
  }
  return linhas;
}

/** Baixa do lançamento manual na transação `tx` (a mesma da baixa individual, do lote e da conciliação). */
export async function baixarLancamentoNa(tx: Transacao, usuarioId: string, id: string, v: BaixaLancamentoValidada): Promise<Ok | Falha> {
  const [l] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id)).for("update");
  if (!l) return LANCAMENTO_NAO_ENCONTRADO;
  if (l.status === "baixado") return falha(l.lado === "pagar" ? "Lançamento já pago" : "Lançamento já recebido");
  if (l.status === "cancelado") return falha("Lançamento cancelado");
  // Compra no cartão corporativo: sai do banco pela fatura (baixa da fatura do cartão), nunca direto.
  if (l.faturaCartaoId) return falha(MSG_COMPRA_NO_CARTAO);
  if (v.valorPago !== l.valor + v.juros - v.desconto && !v.observacao) return falha(MSG_DIFERENCA_PAGO, "observacao");
  await contaAtiva(tx, v.contaBancariaId, "contaBancariaId");
  const depois = {
    status: "baixado" as const,
    baixadoEm: v.data,
    valorPago: v.valorPago,
    juros: v.juros,
    desconto: v.desconto,
    baixaContaBancariaId: v.contaBancariaId,
    // A observação da baixa entra em nova linha no fim da observação do lançamento; desfazer a baixa não a remove.
    observacao: v.observacao ? (l.observacao ? `${l.observacao}\n${v.observacao}` : v.observacao) : l.observacao,
  };
  await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, id));
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, l[k as keyof LancamentoLinha]]));
  await registrarAuditoria(tx, { usuarioId, tabela: "lancamentos", registroId: id, acao: "alterar", antes, depois });
  return { ok: true, id };
}

/** Auditoria de alteração do lançamento: `antes` só com as chaves alteradas. */
async function auditarAlteracao(tx: Transacao, usuarioId: string, l: LancamentoLinha, depois: Partial<LancamentoLinha>): Promise<void> {
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, l[k as keyof LancamentoLinha]]));
  await registrarAuditoria(tx, { usuarioId, tabela: "lancamentos", registroId: l.id, acao: "alterar", antes, depois });
}

/** Desfaz a baixa do lançamento manual na transação `tx`. */
export async function desfazerBaixaLancamentoNa(tx: Transacao, usuarioId: string, id: string): Promise<Ok | Falha> {
  const [l] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id)).for("update");
  if (!l) return LANCAMENTO_NAO_ENCONTRADO;
  if (l.status !== "baixado") return falha("Este lançamento não foi baixado");
  // Baixada pela fatura do cartão: volta só desfazendo a baixa da fatura (a fatura é lida depois da trava da compra,
  // a mesma ordem da baixa da fatura).
  if (l.faturaCartaoId) {
    const [f] = await tx.select({ status: faturasCartao.status }).from(faturasCartao).where(eq(faturasCartao.id, l.faturaCartaoId));
    if (f?.status === "baixado") return falha(MSG_DESFACA_FATURA_CARTAO);
  }
  const depois = { status: "em_aberto" as const, baixadoEm: null, valorPago: null, juros: null, desconto: null, baixaContaBancariaId: null };
  await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, id));
  await auditarAlteracao(tx, usuarioId, l, depois);
  return { ok: true, id };
}

/** A conta é de uma entrada de estoque ou de um caso de reembolso (só se baixa pela lista única), ou de nenhum. */
export function vinculoDoLancamento(l: { estoqueMovimentoId: string | null; reembolsoId: string | null }): VinculoLancamento | null {
  if (l.estoqueMovimentoId) return "estoque";
  if (l.reembolsoId) return "reembolso";
  return null;
}

/** Recusa da lista única (editar e cancelar) para conta com vínculo; o estoque e os reembolsos mexem pelo núcleo. */
export function recusaDoVinculo(l: { estoqueMovimentoId: string | null; reembolsoId: string | null }): Falha | null {
  const v = vinculoDoLancamento(l);
  return v === "estoque" ? falha(MSG_LANCAMENTO_ESTOQUE) : v === "reembolso" ? falha(MSG_LANCAMENTO_REEMBOLSO) : null;
}

/** Só lançamento em aberto é editado. */
export function recusaDaEdicao(l: LancamentoLinha): Falha | null {
  if (l.status === "baixado") return falha(MSG_DESFACA_BAIXA);
  if (l.status === "cancelado") return falha("Lançamento cancelado não pode ser editado");
  return null;
}

/** Só lançamento em aberto é cancelado. */
export function recusaDoCancelamento(l: LancamentoLinha): Falha | null {
  if (l.status === "baixado") return falha("Desfaça a baixa para cancelar");
  if (l.status === "cancelado") return falha("Lançamento já cancelado");
  return null;
}

/**
 * Cancela as linhas `linhas`, já travadas (`for update`) e conferidas pelo chamador. Compra no cartão sai da fatura (o
 * cartão fica registrado na linha); as faturas são travadas juntas, em ordem única, antes de qualquer escrita, e a
 * recusa (fatura paga) volta antes de gravar. Audita cada linha.
 */
export async function cancelarLinhasNa(tx: Transacao, usuarioId: string, linhas: LancamentoLinha[], motivo: string): Promise<Ok | Falha> {
  const r = await travarFaturasNa(tx, usuarioId, linhas.map((l) => l.faturaCartaoId), []);
  if (ehFalha(r)) return r;
  for (const l of linhas) {
    const depois = { status: "cancelado" as const, motivoCancelamento: motivo, ...(l.faturaCartaoId ? { faturaCartaoId: null } : {}) };
    await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, l.id));
    await auditarAlteracao(tx, usuarioId, l, depois);
  }
  return { ok: true, ids: linhas.map((l) => l.id) };
}

/** Cancela um lançamento em aberto na transação `tx` (compra no cartão sai da fatura; recusada com a fatura paga). */
export async function cancelarLancamentoNa(tx: Transacao, usuarioId: string, id: string, motivo: string): Promise<Ok | Falha> {
  const [l] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id)).for("update");
  if (!l) return LANCAMENTO_NAO_ENCONTRADO;
  const recusa = recusaDoCancelamento(l);
  if (recusa) return recusa;
  const r = await cancelarLinhasNa(tx, usuarioId, [l], motivo);
  return r.ok ? { ok: true, id } : r;
}

/**
 * O que muda no cartão da linha `l` editada (compra na data `dataCompra`): mesma compra (mesmo cartão, mesma data, já
 * vinculada) fica na fatura em que está (`fica`); senão sai da fatura atual (se houver) e, com cartão, entra na do
 * ciclo da data (cartão desativado só é aceito se já era o da compra).
 */
export function planoDoCartao(l: LancamentoLinha, cartaoId: string | null, dataCompra: string): { fica: Vinculo } | { sai: string | null; entra: EntradaFatura | null } {
  if (cartaoId && cartaoId === l.cartaoId && l.faturaCartaoId && dataCompra === l.vencimento) return { fica: { cartaoId, faturaCartaoId: l.faturaCartaoId } };
  return { sai: l.faturaCartaoId, entra: cartaoId ? { cartaoId, dataCompra, exigeAtivo: cartaoId !== l.cartaoId } : null };
}

/**
 * Altera valor (> 0), vencimento e descrição de um lançamento em aberto na transação `tx` (competência, emissão e o
 * resto ficam). Compra no cartão com vencimento novo vai para a fatura do ciclo da nova data (recusa com a fatura de
 * saída ou de entrada paga, lançando `Desfazer`). Sem mudança, não grava nem audita.
 */
export async function alterarEmAbertoNa(
  tx: Transacao,
  usuarioId: string,
  id: string,
  m: { valor?: bigint; vencimento?: string; descricao?: string },
): Promise<Ok | Falha> {
  if (m.valor !== undefined && m.valor <= 0n) return falha("Informe um valor maior que zero", "valor");
  const [l] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id)).for("update");
  if (!l) return LANCAMENTO_NAO_ENCONTRADO;
  const recusa = recusaDaEdicao(l);
  if (recusa) return recusa;
  const depois: Partial<LancamentoLinha> = {};
  if (m.valor !== undefined && m.valor !== l.valor) depois.valor = m.valor;
  if (m.descricao !== undefined && m.descricao !== l.descricao) depois.descricao = m.descricao;
  if (m.vencimento !== undefined && m.vencimento !== l.vencimento) {
    depois.vencimento = m.vencimento;
    if (l.faturaCartaoId && l.cartaoId) {
      const plano = planoDoCartao(l, l.cartaoId, m.vencimento);
      if ("sai" in plano) {
        const [novo] = await travarFaturas(tx, usuarioId, [plano.sai], plano.entra ? [plano.entra] : []);
        if (novo.faturaCartaoId !== l.faturaCartaoId) depois.faturaCartaoId = novo.faturaCartaoId;
      }
    }
  }
  if (Object.keys(depois).length === 0) return { ok: true, id };
  await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, id));
  await auditarAlteracao(tx, usuarioId, l, depois);
  return { ok: true, id };
}
