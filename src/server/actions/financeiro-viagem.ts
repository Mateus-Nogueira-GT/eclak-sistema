"use server";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { Snapshot } from "@/domain/aprovacoes";
import { converter } from "@/domain/cambio";
import { hojeEmCuiaba } from "@/domain/clientes";
import { arredondar, lerDecimal } from "@/domain/decimal";
import { formatarReais } from "@/domain/dinheiro";
import { aplicarFormaFornecedor, contasDoSnapshot, reprevisarLinhas, type ComissaoTipo, type ContaGerada } from "@/domain/venda";
import {
  baixaPagamentoSchema,
  baixaParcelaSchema,
  comissaoRecebidaSchema,
  comissaoTipoSchema,
  contestacaoSchema,
  formaFornecedorSchema,
  motivoPrevistoSchema,
  motivoSchema,
  msgEmAberto,
  msgPrevistoAbaixoDoPago,
  MSG_CAMBIO_EFETIVO,
  MSG_COMISSAO_CANCELADA,
  MSG_COMISSAO_EM_ABERTO,
  MSG_COMISSAO_REGISTRADA,
  MSG_CONCILIADA,
  MSG_DIFERENCA_RECEBIDA,
  MSG_JA_BAIXADO_NA_CONTA,
  MSG_NAO_CONCILIADA,
  MSG_NAO_VENDIDA,
  MSG_PAGAMENTO_EM_ABERTO,
  MSG_PAGAMENTO_PAGO,
  MSG_PARCELA_CANCELADA,
  MSG_PARCELA_EM_ABERTO,
  MSG_PARCELA_RECEBIDA,
  MSG_SEM_FORNECEDOR,
  valorReaisSchema,
} from "@/domain/venda-entrada";
import { MSG_NAO_CALCULA } from "@/domain/aprovacoes";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import {
  comissoes,
  contasPagar,
  fornecedores,
  itensViagem,
  pagamentosFornecedor,
  parcelasReceber,
  vendas,
  versoesPrecificacao,
  viagens,
} from "@/server/db/schema";
import { travarViagem } from "@/server/trava-viagem";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Financeiro da viagem vendida: forma de pagamento ao fornecedor, tipo de comissão, previsto atualizado,
// contestação, baixas (parcelas, pagamentos, comissões) e conciliação. Só Diretor e financeiro. Toda escrita
// passa pela trava da viagem (lock consultivo → viagem `for update`, a mesma da 3a) e depois trava a linha
// alterada pela cadeia de dono (pagamento → conta → viagem; comissão → conta → viagem; parcela → viagem).
// Viagem conciliada não muda até o Diretor desfazer a conciliação. Respostas só `{ ok }`.

const PERFIS_FINANCEIRO = ["diretor", "fin_operacional", "fin_estrategico"] as const;

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
type Ok = { ok: true };
const OK: Ok = { ok: true };

const falha = (erro: string, campo?: string): Falha => (campo ? { ok: false, erro, campos: { [campo]: erro } } : { ok: false, erro });
const VIAGEM_NAO_ENCONTRADA = falha("Viagem não encontrada");
const CONTA_NAO_ENCONTRADA = falha("Conta não encontrada");
const PARCELA_NAO_ENCONTRADA = falha("Parcela não encontrada");
const PAGAMENTO_NAO_ENCONTRADO = falha("Pagamento não encontrado");
const COMISSAO_NAO_ENCONTRADA = falha("Comissão não encontrada");
const NAO_VENDIDA = falha(MSG_NAO_VENDIDA);
const CONCILIADA = falha(MSG_CONCILIADA);
const JA_BAIXADO = falha(MSG_JA_BAIXADO_NA_CONTA);
const NAO_CALCULA = falha(MSG_NAO_CALCULA);

type ViagemLinha = typeof viagens.$inferSelect;
type ContaLinha = typeof contasPagar.$inferSelect;
type PagamentoLinha = typeof pagamentosFornecedor.$inferSelect;

/** Recusa dentro da transação que precisa desfazer o que já foi gravado; vira a `falha` fora dela. */
class Desfazer extends Error {
  constructor(readonly falha: Falha) {
    super(falha.erro);
  }
}

const ehFalha = (x: unknown): x is Falha => typeof x === "object" && x !== null && "ok" in x && (x as Falha).ok === false;

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

function falhaDeValidacao(erro: import("zod").ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Texto obrigatório validado: a mensagem vai também no campo. */
function texto(schema: import("zod").ZodType<string>, valor: unknown, campo: string): string | Falha {
  const p = schema.safeParse(valor);
  return p.success ? p.data : falha(p.error.issues[0].message, campo);
}

const minimo = (a: bigint, b: bigint) => (a < b ? a : b);

const semId = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id"));

/** Auditoria de alteração: `antes` só com as chaves alteradas. */
async function auditarAlteracao<T extends { id: string }>(
  tx: Transacao,
  usuarioId: string,
  tabela: string,
  linha: T,
  depois: Partial<T>,
): Promise<void> {
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, linha[k as keyof T]]));
  await registrarAuditoria(tx, { usuarioId, tabela, registroId: linha.id, acao: "alterar", antes, depois });
}

function revalidar(viagemId: string) {
  revalidatePath("/viagens");
  revalidatePath(`/viagens/${viagemId}`);
  revalidatePath("/vendas");
}

/**
 * Esqueleto das actions: descobre a viagem do registro (`viagemDe`, sem trava), trava a viagem, exige `vendida`
 * e não conciliada (salvo `aceitaConciliada`), e roda `fn` na mesma transação. `Desfazer` desfaz tudo.
 */
async function naViagemVendida(
  viagemDe: (tx: Transacao) => Promise<string | null>,
  naoEncontrado: Falha,
  mensagemErro: string,
  fn: (tx: Transacao, v: ViagemLinha) => Promise<Ok | Falha>,
  aceitaConciliada = false,
): Promise<Ok | Falha> {
  const achada: { id: string | null } = { id: null };
  let r: Ok | Falha;
  try {
    r = await db.transaction(async (tx) => {
      achada.id = await viagemDe(tx);
      if (!achada.id) return naoEncontrado;
      const v = await travarViagem(tx, achada.id);
      if (!v) return naoEncontrado;
      if (v.status !== "vendida") return NAO_VENDIDA;
      if (v.conciliadaEm && !aceitaConciliada) return CONCILIADA;
      return fn(tx, v);
    });
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    throw erroDeBanco(mensagemErro, x);
  }
  if (ehFalha(r)) return r;
  if (achada.id) revalidar(achada.id);
  return r;
}

// ---------------------------------------------------------------------------
// Leituras pela cadeia de dono (sem trava: só para achar a viagem; depois, `for update`)
// ---------------------------------------------------------------------------

async function viagemDaConta(tx: Transacao, contaId: string): Promise<string | null> {
  const [c] = await tx
    .select({ viagemId: contasPagar.viagemId })
    .from(contasPagar)
    .where(and(eq(contasPagar.id, contaId), isNull(contasPagar.excluidoEm)));
  return c?.viagemId ?? null;
}

async function viagemDoPagamento(tx: Transacao, pagamentoId: string): Promise<string | null> {
  const [c] = await tx
    .select({ viagemId: contasPagar.viagemId })
    .from(pagamentosFornecedor)
    .innerJoin(contasPagar, eq(contasPagar.id, pagamentosFornecedor.contaId))
    .where(and(eq(pagamentosFornecedor.id, pagamentoId), isNull(contasPagar.excluidoEm)));
  return c?.viagemId ?? null;
}

async function viagemDaComissao(tx: Transacao, comissaoId: string): Promise<string | null> {
  const [c] = await tx
    .select({ viagemId: contasPagar.viagemId })
    .from(comissoes)
    .innerJoin(contasPagar, and(eq(contasPagar.id, comissoes.contaId), eq(contasPagar.viagemId, comissoes.viagemId)))
    .where(and(eq(comissoes.id, comissaoId), isNull(contasPagar.excluidoEm)));
  return c?.viagemId ?? null;
}

async function viagemDaParcela(tx: Transacao, parcelaId: string): Promise<string | null> {
  const [p] = await tx.select({ viagemId: parcelasReceber.viagemId }).from(parcelasReceber).where(eq(parcelasReceber.id, parcelaId));
  return p?.viagemId ?? null;
}

/** Conta ativa da viagem travada, `for update`. */
async function contaTravada(tx: Transacao, contaId: string, viagemId: string): Promise<ContaLinha | null> {
  const [c] = await tx
    .select()
    .from(contasPagar)
    .where(and(eq(contasPagar.id, contaId), eq(contasPagar.viagemId, viagemId), isNull(contasPagar.excluidoEm)))
    .for("update");
  return c ?? null;
}

async function linhasDaConta(tx: Transacao, contaId: string): Promise<PagamentoLinha[]> {
  return tx
    .select()
    .from(pagamentosFornecedor)
    .where(eq(pagamentosFornecedor.contaId, contaId))
    .orderBy(asc(pagamentosFornecedor.numero))
    .for("update");
}

// ---------------------------------------------------------------------------
// Previsto da conta na moeda (a partir do snapshot da versão vendida)
// ---------------------------------------------------------------------------

/** Snapshot da versão da venda da viagem. */
async function snapshotDaVenda(tx: Transacao, viagemId: string): Promise<Snapshot | null> {
  const [l] = await tx
    .select({ snapshot: versoesPrecificacao.snapshot })
    .from(vendas)
    .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, vendas.versaoId))
    .where(eq(vendas.viagemId, viagemId));
  return (l?.snapshot as Snapshot | undefined) ?? null;
}

/** A conta como nasceria na venda com o tipo de comissão `tipo` (previsto na moeda e em reais, comissão). */
function contaBase(snapshot: Snapshot, conta: ContaLinha, tipo: ComissaoTipo, fim: string): ContaGerada {
  const modalidade: Record<string, "net" | "comissionado"> = conta.fornecedorId
    ? { [conta.fornecedorId]: tipo === "a_receber" ? "comissionado" : "net" }
    : {};
  let gerada: ContaGerada | undefined;
  try {
    gerada = contasDoSnapshot(snapshot, modalidade, fim).find((c) => c.itemId === conta.itemId);
  } catch {
    throw new Desfazer(NAO_CALCULA);
  }
  if (!gerada) throw new Desfazer(NAO_CALCULA);
  return gerada;
}

/**
 * Previsto na moeda da conta para `previstoBrl` em reais: o da venda se não mudou; senão, na proporção do da
 * venda (sem base em reais, volta pelo câmbio aplicado).
 */
function previstoNaMoeda(base: ContaGerada, conta: ContaLinha, previstoBrl: bigint): bigint {
  if (previstoBrl === base.previstoBrl) return base.previstoOriginal;
  if (conta.moeda === "BRL") return previstoBrl;
  if (base.previstoBrl !== 0n) return arredondar(base.previstoOriginal * previstoBrl, base.previstoBrl);
  return conta.cambioAplicado ? arredondar(previstoBrl * 10_000n, lerDecimal(conta.cambioAplicado, 4)) : previstoBrl;
}

/** Linhas em aberto reescaladas para o novo previsto (`reprevisarLinhas`), com auditoria. */
async function reprevisar(
  tx: Transacao,
  usuarioId: string,
  linhas: PagamentoLinha[],
  antes: { original: bigint; brl: bigint },
  depois: { original: bigint; brl: bigint },
): Promise<void> {
  const novos = reprevisarLinhas(
    linhas.map((l) => ({ valorOriginal: l.valorOriginal, valorBrlPrevisto: l.valorBrlPrevisto, pago: l.status === "pago" })),
    antes,
    depois,
  );
  for (const [i, l] of linhas.entries()) {
    const n = novos[i];
    if (l.status === "pago" || (n.valorOriginal === l.valorOriginal && n.valorBrlPrevisto === l.valorBrlPrevisto)) continue;
    await tx.update(pagamentosFornecedor).set(n).where(eq(pagamentosFornecedor.id, l.id));
    await auditarAlteracao(tx, usuarioId, "pagamentos_fornecedor", l, n);
  }
}

// ---------------------------------------------------------------------------
// Contas a pagar
// ---------------------------------------------------------------------------

export type FormaFornecedorEntrada =
  | { tipo: "a_vista"; vencimento?: string }
  | { tipo: "parcelado"; parcelas: { vencimento: string; valor: string }[] }
  | { tipo: "cartao_corporativo"; vencimento: string };

/**
 * Forma de pagamento ao fornecedor: refaz as linhas de pagamento (à vista com o desconto da cotação; parcelado
 * somando o previsto na moeda; cartão corporativo na data da fatura). Só sem pagamento baixado na conta. À vista
 * sem data mantém o vencimento atual.
 */
export async function definirFormaFornecedor(contaId: string, forma: FormaFornecedorEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(contaId)) return CONTA_NAO_ENCONTRADA;
    const p = formaFornecedorSchema.safeParse(forma);
    if (!p.success) return falhaDeValidacao(p.error);
    const f = p.data;
    return naViagemVendida(
      (tx) => viagemDaConta(tx, contaId),
      CONTA_NAO_ENCONTRADA,
      "Erro ao definir a forma de pagamento",
      async (tx, v) => {
        const conta = await contaTravada(tx, contaId, v.id);
        if (!conta) return CONTA_NAO_ENCONTRADA;
        const linhas = await linhasDaConta(tx, conta.id);
        if (linhas.some((l) => l.status === "pago")) return JA_BAIXADO;
        const snapshot = await snapshotDaVenda(tx, v.id);
        if (!snapshot) return NAO_CALCULA;
        const base = contaBase(snapshot, conta, conta.comissaoTipo, v.fim);
        const vencimentoAtual = linhas[0]?.vencimento;
        const formaDominio =
          f.tipo === "a_vista" ? { tipo: "a_vista" as const, vencimento: f.vencimento ?? vencimentoAtual } : f;
        let novas;
        try {
          novas = aplicarFormaFornecedor(
            { moeda: conta.moeda, previstoOriginal: previstoNaMoeda(base, conta, conta.previstoBrl), previstoBrl: conta.previstoBrl },
            formaDominio,
            conta.descontoAVistaPct,
          );
        } catch (e) {
          return falha(e instanceof Error ? e.message : MSG_NAO_CALCULA, "parcelas");
        }
        if (novas.some((l) => l.vencimento === null) && !vencimentoAtual) return falha("Informe a data", "vencimento");

        for (const l of linhas) {
          await tx.delete(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, l.id));
          await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "pagamentos_fornecedor", registroId: l.id, acao: "excluir", antes: semId(l) });
        }
        const criadas = await tx
          .insert(pagamentosFornecedor)
          .values(
            novas.map((l) => ({
              contaId: conta.id,
              numero: l.numero,
              vencimento: l.vencimento ?? vencimentoAtual!,
              valorOriginal: l.valorOriginal,
              valorBrlPrevisto: l.valorBrlPrevisto,
            })),
          )
          .returning();
        for (const l of criadas)
          await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "pagamentos_fornecedor", registroId: l.id, acao: "criar", depois: semId(l) });
        if (conta.forma !== f.tipo) {
          await tx.update(contasPagar).set({ forma: f.tipo }).where(eq(contasPagar.id, conta.id));
          await auditarAlteracao(tx, usuario.id, "contas_pagar", conta, { forma: f.tipo });
        }
        return OK;
      },
    );
  });
}

export type ComissaoTipoEntrada = { tipo: ComissaoTipo; previstaPara?: string | null };

/**
 * Tipo de comissão da conta: `descontada` (paga-se o líquido) ou `a_receber` (paga-se cheio e nasce a comissão
 * prevista, para `previstaPara` ou o dia 15 do mês seguinte ao fim). Recalcula o previsto (mantendo um previsto
 * já atualizado pela mesma diferença) e reescala as linhas; cria ou exclui a comissão. O previsto na venda não
 * muda. Só sem pagamento baixado na conta.
 */
export async function definirComissaoTipo(contaId: string, dados: ComissaoTipoEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(contaId)) return CONTA_NAO_ENCONTRADA;
    const p = comissaoTipoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const { tipo, previstaPara } = p.data;
    return naViagemVendida(
      (tx) => viagemDaConta(tx, contaId),
      CONTA_NAO_ENCONTRADA,
      "Erro ao definir o tipo de comissão",
      async (tx, v) => {
        const conta = await contaTravada(tx, contaId, v.id);
        if (!conta) return CONTA_NAO_ENCONTRADA;
        const linhas = await linhasDaConta(tx, conta.id);
        if (linhas.some((l) => l.status === "pago")) return JA_BAIXADO;
        if (tipo === "a_receber" && !conta.fornecedorId) return falha(MSG_SEM_FORNECEDOR);
        const [existente] = await tx.select().from(comissoes).where(eq(comissoes.contaId, conta.id)).for("update");

        if (tipo !== conta.comissaoTipo) {
          if (existente && (existente.status === "recebida" || existente.status === "nao_recebida")) return falha(MSG_COMISSAO_REGISTRADA);
          const snapshot = await snapshotDaVenda(tx, v.id);
          if (!snapshot) return NAO_CALCULA;
          const atual = contaBase(snapshot, conta, conta.comissaoTipo, v.fim);
          const nova = contaBase(snapshot, conta, tipo, v.fim);
          const soma = nova.previstoBrl + conta.previstoBrl - atual.previstoBrl;
          const previstoBrl = soma < 0n ? 0n : soma;
          await reprevisar(
            tx,
            usuario.id,
            linhas,
            { original: previstoNaMoeda(atual, conta, conta.previstoBrl), brl: conta.previstoBrl },
            { original: previstoNaMoeda(nova, conta, previstoBrl), brl: previstoBrl },
          );
          const depois = { comissaoTipo: tipo, previstoBrl };
          await tx.update(contasPagar).set(depois).where(eq(contasPagar.id, conta.id));
          await auditarAlteracao(tx, usuario.id, "contas_pagar", conta, depois);

          // Registro financeiro nunca é apagado: a comissão fica `cancelada` e volta a `prevista` se a conta voltar a `a_receber`.
          if (tipo === "descontada" && existente && existente.status === "prevista") {
            const cancelada = { status: "cancelada" as const };
            await tx.update(comissoes).set(cancelada).where(eq(comissoes.id, existente.id));
            await auditarAlteracao(tx, usuario.id, "comissoes", existente, cancelada);
          }
          if (tipo === "a_receber" && existente?.status === "cancelada" && nova.comissao) {
            const reativada = {
              status: "prevista" as const,
              baseBrl: nova.comissao.baseBrl,
              pct: nova.comissao.pct,
              valorPrevisto: nova.comissao.valor,
              previstaPara: previstaPara ?? nova.comissao.previstaPara,
            };
            await tx.update(comissoes).set(reativada).where(eq(comissoes.id, existente.id));
            await auditarAlteracao(tx, usuario.id, "comissoes", existente, reativada);
          }
          if (tipo === "a_receber" && !existente && nova.comissao) {
            const [com] = await tx
              .insert(comissoes)
              .values({
                viagemId: v.id,
                contaId: conta.id,
                fornecedorId: conta.fornecedorId,
                baseBrl: nova.comissao.baseBrl,
                pct: nova.comissao.pct,
                valorPrevisto: nova.comissao.valor,
                previstaPara: previstaPara ?? nova.comissao.previstaPara,
              })
              .returning();
            await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "comissoes", registroId: com.id, acao: "criar", depois: semId(com) });
          }
        } else if (tipo === "a_receber" && existente && existente.status !== "cancelada" && previstaPara && previstaPara !== existente.previstaPara) {
          if (existente.status !== "prevista") return falha(MSG_COMISSAO_REGISTRADA);
          await tx.update(comissoes).set({ previstaPara }).where(eq(comissoes.id, existente.id));
          await auditarAlteracao(tx, usuario.id, "comissoes", existente, { previstaPara });
        }
        return OK;
      },
    );
  });
}

/**
 * Atualiza o previsto atual da conta em reais (o fornecedor cobrou diferente do orçado), com motivo obrigatório.
 * As linhas em aberto absorvem a diferença (`reprevisarLinhas`); sem linha em aberto, o aumento acima do já pago
 * vira uma linha nova (vence hoje) e a conta volta a `a_pagar`. O previsto na venda não muda.
 */
export async function atualizarPrevisto(contaId: string, valorBrl: string, motivo: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(contaId)) return CONTA_NAO_ENCONTRADA;
    const vp = valorReaisSchema.safeParse(valorBrl);
    if (!vp.success) return falha(vp.error.issues[0].message, "valorBrl");
    const m = texto(motivoPrevistoSchema, motivo, "motivo");
    if (ehFalha(m)) return m;
    const novo = vp.data;
    return naViagemVendida(
      (tx) => viagemDaConta(tx, contaId),
      CONTA_NAO_ENCONTRADA,
      "Erro ao atualizar o valor previsto",
      async (tx, v) => {
        const conta = await contaTravada(tx, contaId, v.id);
        if (!conta) return CONTA_NAO_ENCONTRADA;
        const linhas = await linhasDaConta(tx, conta.id);
        const jaPago = linhas.reduce((t, l) => t + (l.status === "pago" ? (l.valorBrlPago ?? 0n) : 0n), 0n);
        if (novo < jaPago) return falha(msgPrevistoAbaixoDoPago(formatarReais(jaPago)), "valorBrl");
        const snapshot = await snapshotDaVenda(tx, v.id);
        if (!snapshot) return NAO_CALCULA;
        const base = contaBase(snapshot, conta, conta.comissaoTipo, v.fim);
        await reprevisar(
          tx,
          usuario.id,
          linhas,
          { original: previstoNaMoeda(base, conta, conta.previstoBrl), brl: conta.previstoBrl },
          { original: previstoNaMoeda(base, conta, novo), brl: novo },
        );
        // Sem linha em aberto e o previsto subiu acima do já pago: o aumento vira uma linha nova em aberto
        // (vence hoje), sem passar do novo previsto; a conta volta a `a_pagar`.
        const complemento = linhas.some((l) => l.status !== "pago") ? 0n : minimo(novo - conta.previstoBrl, novo - jaPago);
        if (complemento > 0n) {
          const valorOriginal =
            conta.moeda === "BRL" || !conta.cambioAplicado
              ? complemento
              : arredondar(complemento * 10_000n, lerDecimal(conta.cambioAplicado, 4));
          const [linha] = await tx
            .insert(pagamentosFornecedor)
            .values({
              contaId: conta.id,
              numero: linhas.reduce((n, l) => Math.max(n, l.numero), 0) + 1,
              vencimento: hojeEmCuiaba(),
              valorOriginal,
              valorBrlPrevisto: complemento,
            })
            .returning();
          await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "pagamentos_fornecedor", registroId: linha.id, acao: "criar", depois: semId(linha) });
        }
        const depois = {
          previstoBrl: novo,
          motivoPrevisto: m,
          ...(complemento > 0n && conta.status === "paga" ? { status: "a_pagar" as const } : {}),
        };
        await tx.update(contasPagar).set(depois).where(eq(contasPagar.id, conta.id));
        await auditarAlteracao(tx, usuario.id, "contas_pagar", conta, depois);
        return OK;
      },
    );
  });
}

/** Contestação com o fornecedor: grava o texto e a data; a conta fica contestada. */
export async function contestar(contaId: string, textoContestacao: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(contaId)) return CONTA_NAO_ENCONTRADA;
    const t = texto(contestacaoSchema, textoContestacao, "texto");
    if (ehFalha(t)) return t;
    return naViagemVendida(
      (tx) => viagemDaConta(tx, contaId),
      CONTA_NAO_ENCONTRADA,
      "Erro ao contestar",
      async (tx, v) => {
        const conta = await contaTravada(tx, contaId, v.id);
        if (!conta) return CONTA_NAO_ENCONTRADA;
        const depois = { contestacao: t, contestadaEm: new Date() };
        await tx.update(contasPagar).set(depois).where(eq(contasPagar.id, conta.id));
        await auditarAlteracao(tx, usuario.id, "contas_pagar", conta, depois);
        return OK;
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Parcelas a receber
// ---------------------------------------------------------------------------

export type BaixaParcelaEntrada = { recebidaEm: string; valorRecebido: string; taxaEfetiva?: string | null; observacao?: string | null };

async function parcelaTravada(tx: Transacao, parcelaId: string, viagemId: string) {
  const [p] = await tx
    .select()
    .from(parcelasReceber)
    .where(and(eq(parcelasReceber.id, parcelaId), eq(parcelasReceber.viagemId, viagemId)))
    .for("update");
  return p ?? null;
}

type ParcelaLinha = typeof parcelasReceber.$inferSelect;

/** Roda `mudar` sobre a parcela travada da viagem e grava o resultado (ou recusa). */
function naParcela(
  parcelaId: string,
  mensagemErro: string,
  mudar: (p: ParcelaLinha) => Partial<ParcelaLinha> | Falha,
  usuarioId: string,
): Promise<Ok | Falha> {
  return naViagemVendida(
    (tx) => viagemDaParcela(tx, parcelaId),
    PARCELA_NAO_ENCONTRADA,
    mensagemErro,
    async (tx, v) => {
      const p = await parcelaTravada(tx, parcelaId, v.id);
      if (!p) return PARCELA_NAO_ENCONTRADA;
      const depois = mudar(p);
      if (ehFalha(depois)) return depois;
      await tx.update(parcelasReceber).set(depois).where(eq(parcelasReceber.id, p.id));
      await auditarAlteracao(tx, usuarioId, "parcelas_receber", p, depois);
      return OK;
    },
  );
}

const recusaParcelaFechada = (p: ParcelaLinha): Falha | null =>
  p.status === "recebida" ? falha(MSG_PARCELA_RECEBIDA) : p.status === "cancelada" ? falha(MSG_PARCELA_CANCELADA) : null;

/**
 * Baixa da parcela: data, valor recebido, taxa efetiva (vazia = a prevista) e observação, obrigatória quando o
 * valor recebido é diferente do valor da parcela (a diferença entra na margem real).
 */
export async function baixarParcela(parcelaId: string, dados: BaixaParcelaEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    const b = baixaParcelaSchema().safeParse(dados);
    if (!b.success) return falhaDeValidacao(b.error);
    return naParcela(
      parcelaId,
      "Erro ao baixar a parcela",
      (p) => {
        const recusa = recusaParcelaFechada(p);
        if (recusa) return recusa;
        if (b.data.valorRecebido !== p.valor && !b.data.observacao) return falha(MSG_DIFERENCA_RECEBIDA, "observacao");
        return {
          status: "recebida",
          recebidaEm: b.data.recebidaEm,
          valorRecebido: b.data.valorRecebido,
          taxaEfetiva: b.data.taxaEfetiva,
          observacao: b.data.observacao,
        };
      },
      usuario.id,
    );
  });
}

/** Desfaz a baixa ou o cancelamento da parcela: volta a `a_receber`. */
export async function desfazerBaixaParcela(parcelaId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    return naParcela(
      parcelaId,
      "Erro ao desfazer a baixa da parcela",
      (p) =>
        p.status === "a_receber"
          ? falha(MSG_PARCELA_EM_ABERTO)
          : { status: "a_receber", recebidaEm: null, valorRecebido: null, taxaEfetiva: null, observacao: null },
      usuario.id,
    );
  });
}

/** Cancela a parcela em aberto, com motivo (fica na observação). */
export async function cancelarParcela(parcelaId: string, motivo: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    const m = texto(motivoSchema, motivo, "motivo");
    if (ehFalha(m)) return m;
    return naParcela(parcelaId, "Erro ao cancelar a parcela", (p) => recusaParcelaFechada(p) ?? { status: "cancelada", observacao: m }, usuario.id);
  });
}

// ---------------------------------------------------------------------------
// Pagamentos ao fornecedor
// ---------------------------------------------------------------------------

export type BaixaPagamentoEntrada = { pagoEm: string; valorOriginalPago: string; cambioEfetivo?: string | null };

/** Roda `mudar` sobre o pagamento travado (com a conta travada) e acerta o status da conta. */
function noPagamento(
  pagamentoId: string,
  mensagemErro: string,
  mudar: (p: PagamentoLinha, conta: ContaLinha) => Partial<PagamentoLinha> | Falha,
  usuarioId: string,
): Promise<Ok | Falha> {
  return naViagemVendida(
    (tx) => viagemDoPagamento(tx, pagamentoId),
    PAGAMENTO_NAO_ENCONTRADO,
    mensagemErro,
    async (tx, v) => {
      const [dono] = await tx.select({ contaId: pagamentosFornecedor.contaId }).from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, pagamentoId));
      const conta = dono ? await contaTravada(tx, dono.contaId, v.id) : null;
      if (!conta) return PAGAMENTO_NAO_ENCONTRADO;
      const linhas = await linhasDaConta(tx, conta.id);
      const p = linhas.find((l) => l.id === pagamentoId);
      if (!p) return PAGAMENTO_NAO_ENCONTRADO;
      const depois = mudar(p, conta);
      if (ehFalha(depois)) return depois;
      await tx.update(pagamentosFornecedor).set(depois).where(eq(pagamentosFornecedor.id, p.id));
      await auditarAlteracao(tx, usuarioId, "pagamentos_fornecedor", p, depois);
      const todasPagas = linhas.every((l) => (l.id === p.id ? depois.status : l.status) === "pago");
      const status = todasPagas ? "paga" : "a_pagar";
      if (conta.status !== status && conta.status !== "cancelada") {
        await tx.update(contasPagar).set({ status }).where(eq(contasPagar.id, conta.id));
        await auditarAlteracao(tx, usuarioId, "contas_pagar", conta, { status });
      }
      return OK;
    },
  );
}

/**
 * Baixa do pagamento: data e valor pago na moeda da conta; fora do real, câmbio efetivo obrigatório e o valor em
 * reais é a conversão (meio para cima). A conta fica `paga` quando todas as linhas estão pagas.
 */
export async function baixarPagamento(pagamentoId: string, dados: BaixaPagamentoEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(pagamentoId)) return PAGAMENTO_NAO_ENCONTRADO;
    const b = baixaPagamentoSchema().safeParse(dados);
    if (!b.success) return falhaDeValidacao(b.error);
    const { pagoEm, valorOriginalPago, cambioEfetivo } = b.data;
    return noPagamento(
      pagamentoId,
      "Erro ao baixar o pagamento",
      (p, conta) => {
        if (p.status === "pago") return falha(MSG_PAGAMENTO_PAGO);
        if (conta.moeda === "BRL") return { status: "pago", pagoEm, valorOriginalPago, cambioEfetivo: null, valorBrlPago: valorOriginalPago };
        if (!cambioEfetivo) return falha(MSG_CAMBIO_EFETIVO, "cambioEfetivo");
        return { status: "pago", pagoEm, valorOriginalPago, cambioEfetivo, valorBrlPago: converter(valorOriginalPago, cambioEfetivo) };
      },
      usuario.id,
    );
  });
}

/** Desfaz a baixa do pagamento; a conta volta a `a_pagar`. */
export async function desfazerBaixaPagamento(pagamentoId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(pagamentoId)) return PAGAMENTO_NAO_ENCONTRADO;
    return noPagamento(
      pagamentoId,
      "Erro ao desfazer a baixa do pagamento",
      (p) =>
        p.status !== "pago"
          ? falha(MSG_PAGAMENTO_EM_ABERTO)
          : { status: "a_pagar", pagoEm: null, valorOriginalPago: null, cambioEfetivo: null, valorBrlPago: null },
      usuario.id,
    );
  });
}

// ---------------------------------------------------------------------------
// Comissões a receber
// ---------------------------------------------------------------------------

type ComissaoLinha = typeof comissoes.$inferSelect;

function naComissao(
  comissaoId: string,
  mensagemErro: string,
  mudar: (c: ComissaoLinha) => Partial<ComissaoLinha> | Falha,
  usuarioId: string,
): Promise<Ok | Falha> {
  return naViagemVendida(
    (tx) => viagemDaComissao(tx, comissaoId),
    COMISSAO_NAO_ENCONTRADA,
    mensagemErro,
    async (tx, v) => {
      const [c] = await tx
        .select({ c: comissoes })
        .from(comissoes)
        .innerJoin(contasPagar, eq(contasPagar.id, comissoes.contaId))
        .where(and(eq(comissoes.id, comissaoId), eq(comissoes.viagemId, v.id), eq(contasPagar.viagemId, v.id), isNull(contasPagar.excluidoEm)))
        .for("update");
      if (!c) return COMISSAO_NAO_ENCONTRADA;
      if (c.c.status === "cancelada") return falha(MSG_COMISSAO_CANCELADA);
      const depois = mudar(c.c);
      if (ehFalha(depois)) return depois;
      await tx.update(comissoes).set(depois).where(eq(comissoes.id, comissaoId));
      await auditarAlteracao(tx, usuarioId, "comissoes", c.c, depois);
      return OK;
    },
  );
}

export type ComissaoRecebidaEntrada = { recebidaEm: string; valorRecebido: string };

/** Comissão recebida: data e valor. */
export async function registrarComissao(comissaoId: string, dados: ComissaoRecebidaEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(comissaoId)) return COMISSAO_NAO_ENCONTRADA;
    const b = comissaoRecebidaSchema().safeParse(dados);
    if (!b.success) return falhaDeValidacao(b.error);
    return naComissao(
      comissaoId,
      "Erro ao registrar a comissão",
      (c) =>
        c.status !== "prevista"
          ? falha(MSG_COMISSAO_REGISTRADA)
          : { status: "recebida", recebidaEm: b.data.recebidaEm, valorRecebido: b.data.valorRecebido, motivo: null },
      usuario.id,
    );
  });
}

/** Comissão que não será recebida, com motivo. */
export async function comissaoNaoRecebida(comissaoId: string, motivo: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(comissaoId)) return COMISSAO_NAO_ENCONTRADA;
    const m = texto(motivoSchema, motivo, "motivo");
    if (ehFalha(m)) return m;
    return naComissao(
      comissaoId,
      "Erro ao registrar a comissão",
      (c) => (c.status !== "prevista" ? falha(MSG_COMISSAO_REGISTRADA) : { status: "nao_recebida", motivo: m }),
      usuario.id,
    );
  });
}

/** Desfaz o registro da comissão (recebida ou não recebida): volta a `prevista`. */
export async function desfazerComissao(comissaoId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(comissaoId)) return COMISSAO_NAO_ENCONTRADA;
    return naComissao(
      comissaoId,
      "Erro ao desfazer a comissão",
      (c) =>
        c.status === "prevista" ? falha(MSG_COMISSAO_EM_ABERTO) : { status: "prevista", recebidaEm: null, valorRecebido: null, motivo: null },
      usuario.id,
    );
  });
}

// ---------------------------------------------------------------------------
// Conciliação
// ---------------------------------------------------------------------------

/** O que ainda está em aberto na viagem, em rótulos curtos: parcelas, pagamentos, comissões. */
async function emAberto(tx: Transacao, viagemId: string): Promise<string[]> {
  const parcelas = await tx
    .select({ numero: parcelasReceber.numero, total: parcelasReceber.totalParcelas })
    .from(parcelasReceber)
    .where(and(eq(parcelasReceber.viagemId, viagemId), eq(parcelasReceber.status, "a_receber")))
    .orderBy(asc(parcelasReceber.numero));
  const contas = await tx
    .select({ id: contasPagar.id, descricao: contasPagar.descricao })
    .from(contasPagar)
    .innerJoin(itensViagem, eq(itensViagem.id, contasPagar.itemId))
    .where(and(eq(contasPagar.viagemId, viagemId), isNull(contasPagar.excluidoEm), inArray(contasPagar.status, ["a_pagar", "paga"])))
    .orderBy(asc(itensViagem.ordem), asc(contasPagar.id));
  const linhas =
    contas.length === 0
      ? []
      : await tx
          .select({ contaId: pagamentosFornecedor.contaId, numero: pagamentosFornecedor.numero, status: pagamentosFornecedor.status })
          .from(pagamentosFornecedor)
          .where(inArray(pagamentosFornecedor.contaId, contas.map((c) => c.id)))
          .orderBy(asc(pagamentosFornecedor.numero));
  const pagamentos = contas.flatMap((c) => {
    const daConta = linhas.filter((l) => l.contaId === c.id);
    return daConta.filter((l) => l.status !== "pago").map((l) => (daConta.length > 1 ? `${c.descricao} (${l.numero}/${daConta.length})` : c.descricao));
  });
  const pendentes = await tx
    .select({ fornecedor: fornecedores.nome, descricao: contasPagar.descricao })
    .from(comissoes)
    .innerJoin(contasPagar, eq(contasPagar.id, comissoes.contaId))
    .leftJoin(fornecedores, eq(fornecedores.id, comissoes.fornecedorId))
    .where(and(eq(comissoes.viagemId, viagemId), eq(comissoes.status, "prevista"), isNull(contasPagar.excluidoEm)))
    .orderBy(asc(comissoes.previstaPara));
  return [
    ...parcelas.map((p) => `Parcela ${p.numero}/${p.total}`),
    ...pagamentos,
    ...pendentes.map((c) => `Comissão ${c.fornecedor ?? c.descricao}`),
  ];
}

/**
 * Concilia a viagem: só com tudo baixado (parcelas recebidas ou canceladas, pagamentos pagos, comissões recebidas
 * ou marcadas "não será recebida"); grava `conciliada_em`. Senão, "Ainda há valores em aberto: …".
 */
export async function conciliar(viagemId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    return naViagemVendida(
      async () => viagemId,
      VIAGEM_NAO_ENCONTRADA,
      "Erro ao conciliar a viagem",
      async (tx, v) => {
        const abertos = await emAberto(tx, v.id);
        if (abertos.length > 0) return falha(msgEmAberto(abertos));
        const depois = { conciliadaEm: new Date() };
        await tx.update(viagens).set(depois).where(eq(viagens.id, v.id));
        await auditarAlteracao(tx, usuario.id, "viagens", v, depois);
        return OK;
      },
    );
  });
}

/** Desfaz a conciliação (só o Diretor): a viagem volta a aceitar baixas e ajustes. */
export async function desfazerConciliacao(viagemId: string): Promise<Ok | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    return naViagemVendida(
      async () => viagemId,
      VIAGEM_NAO_ENCONTRADA,
      "Erro ao desfazer a conciliação",
      async (tx, v) => {
        if (!v.conciliadaEm) return falha(MSG_NAO_CONCILIADA);
        const depois = { conciliadaEm: null };
        await tx.update(viagens).set(depois).where(eq(viagens.id, v.id));
        await auditarAlteracao(tx, usuario.id, "viagens", v, depois);
        return OK;
      },
      true,
    );
  });
}
