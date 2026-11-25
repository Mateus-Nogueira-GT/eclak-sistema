"use server";

import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { Snapshot } from "@/domain/aprovacoes";
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
  MSG_COMISSAO_REGISTRADA,
  MSG_JA_BAIXADO_NA_CONTA,
  MSG_NAO_CONCILIADA,
  MSG_DESFACA_FATURA_CARTAO,
  MSG_NAO_USE_CARTAO_CORPORATIVO,
  MSG_SEM_FORNECEDOR,
  valorReaisSchema,
} from "@/domain/venda-entrada";
import { MSG_NAO_CALCULA } from "@/domain/aprovacoes";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import {
  anexos,
  caixasExperiencia,
  comissoes,
  faturasCartao,
  contasPagar,
  fornecedores,
  itensViagem,
  pagamentosFornecedor,
  parcelasReceber,
  vendas,
  versoesPrecificacao,
  viagens,
} from "@/server/db/schema";
import {
  auditarAlteracao,
  baixarPagamentoNa,
  baixarParcelaNa,
  cancelarParcelaNa,
  comissaoNaoRecebidaNa,
  contaTravada,
  COMISSAO_NAO_ENCONTRADA,
  Desfazer,
  desfazerBaixaPagamentoNa,
  desfazerBaixaParcelaNa,
  desfazerComissaoNa,
  ehFalha,
  falha,
  linhasDaConta,
  naViagemVendidaNa,
  pagoNoCartao,
  OK,
  PAGAMENTO_NAO_ENCONTRADO,
  PARCELA_NAO_ENCONTRADA,
  registrarComissaoNa,
  vendaCartaoDireto,
  type ContaLinha,
  type Falha,
  type Feito,
  type Ok,
  type PagamentoLinha,
  type ViagemLinha,
} from "@/server/financeiro/baixas-viagem";
import { travarFaturasNa } from "@/server/financeiro/cartoes";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Financeiro da viagem vendida: forma de pagamento ao fornecedor, tipo de comissão, previsto atualizado,
// contestação, baixas (parcelas, pagamentos, comissões) e conciliação. Só Diretor e financeiro. Toda escrita
// passa pela trava da viagem (lock consultivo → viagem `for update`, a mesma da 3a) e depois trava a linha
// alterada pela cadeia de dono (pagamento → conta → viagem; comissão → conta → viagem; parcela → viagem).
// Viagem conciliada não muda até o Diretor desfazer a conciliação. Respostas só `{ ok }`.

const VIAGEM_NAO_ENCONTRADA = falha("Viagem não encontrada");
const CONTA_NAO_ENCONTRADA = falha("Conta não encontrada");
const JA_BAIXADO = falha(MSG_JA_BAIXADO_NA_CONTA);
const NAO_CALCULA = falha(MSG_NAO_CALCULA);
const MSG_CAIXA_EM_RASCUNHO = "Confirme ou cancele a caixa de experiência antes";

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

function revalidar(viagemId: string) {
  revalidatePath("/viagens");
  revalidatePath(`/viagens/${viagemId}`);
  revalidatePath("/vendas");
  revalidatePath("/financeiro", "layout");
  revalidatePath("/visao-geral");
}

/**
 * Transação da action: roda o núcleo (`fn`) numa transação nova; `Desfazer` vira a falha e desfaz tudo, outro
 * erro é logado só com o código. No sucesso revalida as telas da viagem e responde só `{ ok: true }`.
 */
async function naTransacao(mensagemErro: string, fn: (tx: Transacao) => Promise<Feito | Falha>): Promise<Ok | Falha> {
  let r: Feito | Falha;
  try {
    r = await db.transaction(fn);
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    throw erroDeBanco(mensagemErro, x);
  }
  if (ehFalha(r)) return r;
  revalidar(r.viagemId);
  return OK;
}

/**
 * Esqueleto das actions: descobre a viagem do registro (`viagemDe`, sem trava), trava a viagem, exige `vendida`
 * e não conciliada (salvo `aceitaConciliada`), e roda `fn` na mesma transação. `Desfazer` desfaz tudo.
 */
function naViagemVendida(
  viagemDe: (tx: Transacao) => Promise<string | null>,
  naoEncontrado: Falha,
  mensagemErro: string,
  fn: (tx: Transacao, v: ViagemLinha) => Promise<Ok | Falha>,
  aceitaConciliada = false,
): Promise<Ok | Falha> {
  return naTransacao(mensagemErro, (tx) => naViagemVendidaNa(tx, viagemDe, naoEncontrado, fn, aceitaConciliada));
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
  | { tipo: "cartao_corporativo"; vencimento: string; cartaoId: string };

/**
 * Forma de pagamento ao fornecedor: refaz as linhas de pagamento (à vista com o desconto da cotação; parcelado
 * somando o previsto na moeda; cartão corporativo numa linha na data da compra, no cartão escolhido e na fatura do
 * ciclo dessa data). Só sem pagamento baixado na conta e sem pagamento em fatura do cartão já paga (ruling 12); as
 * linhas antigas saem da fatura em aberto em que estavam (a fatura fica, sem elas). À vista sem data mantém o
 * vencimento atual.
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
        // Antes do "já baixado": o pagamento quitado pela fatura do cartão pede desfazer a baixa da fatura (ruling 12).
        // Leitura sem trava (a baixa da fatura trava as compras antes da fatura, e as linhas já estão travadas); a
        // conferência travada vem em `travarFaturasNa`, junto com as outras faturas.
        const faturasAntigas = linhas.map((l) => l.faturaCartaoId).filter((x): x is string => x !== null);
        if (faturasAntigas.length > 0) {
          const pagas = await tx
            .select({ id: faturasCartao.id })
            .from(faturasCartao)
            .where(and(inArray(faturasCartao.id, faturasAntigas), eq(faturasCartao.status, "baixado")));
          if (pagas.length > 0) return falha(MSG_DESFACA_FATURA_CARTAO);
        }
        if (linhas.some((l) => l.status === "pago")) return JA_BAIXADO;
        // Conta do fornecedor que recebeu no cartão direto (venda com parcela `cartao_fornecedor` não cancelada):
        // quitada pelo repasse, e o custo dela já sai do repasse esperado. Na fatura do cartão sairia duas vezes.
        if (f.tipo === "cartao_corporativo" && pagoNoCartao(await vendaCartaoDireto(tx, v.id), conta)) return falha(MSG_NAO_USE_CARTAO_CORPORATIVO);
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
        // Cartão corporativo: cada linha na fatura do ciclo da sua data (a data informada é a da compra).
        if (linhas.length > 0) {
          const [comAnexo] = await tx
            .select({ id: anexos.id })
            .from(anexos)
            .where(and(eq(anexos.donoTipo, "pagamento"), inArray(anexos.donoId, linhas.map((l) => l.id)), isNull(anexos.excluidoEm)))
            .limit(1);
          if (comAnexo) return falha("Remova os anexos dos pagamentos antes de trocar a forma de pagamento");
        }
        // As faturas de saída (das linhas antigas) e de entrada são travadas juntas, em ordem única, antes das escritas.
        const entradas = f.tipo === "cartao_corporativo" ? novas.map((l) => ({
                cartaoId: f.cartaoId,
                dataCompra: l.vencimento ?? vencimentoAtual!,
                // Cartão desativado só se já era o da conta (como na edição do lançamento manual).
                exigeAtivo: !linhas.some((x) => x.cartaoId === f.cartaoId),
              })) : [];
        const travadas = await travarFaturasNa(tx, usuario.id, faturasAntigas, entradas);
        if (ehFalha(travadas)) throw new Desfazer(travadas);
        const vinculos: { cartaoId: string | null; faturaCartaoId: string | null }[] =
          f.tipo === "cartao_corporativo" ? travadas : novas.map(() => ({ cartaoId: null, faturaCartaoId: null }));

        for (const l of linhas) {
          await tx.delete(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, l.id));
          await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "pagamentos_fornecedor", registroId: l.id, acao: "excluir", antes: semId(l) });
        }
        const criadas = await tx
          .insert(pagamentosFornecedor)
          .values(
            novas.map((l, i) => ({
              contaId: conta.id,
              numero: l.numero,
              vencimento: l.vencimento ?? vencimentoAtual!,
              valorOriginal: l.valorOriginal,
              valorBrlPrevisto: l.valorBrlPrevisto,
              ...vinculos[i],
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
 * vira uma linha nova (vence hoje) e a conta volta a `a_pagar`; na conta paga no cartão corporativo, essa linha é
 * compra nova no mesmo cartão, na fatura do ciclo de hoje (recusada se essa fatura já foi paga). O previsto na venda
 * não muda.
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
        if (complemento > 0n && linhas.some((l) => l.repasseParcelaId !== null)) {
          return falha("Conta quitada pelo repasse do cartão: desfaça o repasse antes de aumentar o previsto");
        }
        if (complemento > 0n) {
          const hoje = hojeEmCuiaba();
          // Conta paga no cartão corporativo: o complemento é compra nova no mesmo cartão, na fatura do ciclo de hoje
          // (fatura já paga: recusa). Ordem das travas de `cartoes.ts`: viagem → conta e linhas (acima) → cartão e fatura.
          const cartaoId = conta.forma === "cartao_corporativo" ? ([...linhas].reverse().find((l) => l.cartaoId)?.cartaoId ?? null) : null;
          let vinculo: { cartaoId: string | null; faturaCartaoId: string | null } = { cartaoId: null, faturaCartaoId: null };
          if (cartaoId) {
            const travadas = await travarFaturasNa(tx, usuario.id, [], [{ cartaoId, dataCompra: hoje, exigeAtivo: false }]);
            if (ehFalha(travadas)) throw new Desfazer(travadas);
            vinculo = travadas[0];
          }
          const valorOriginal =
            conta.moeda === "BRL" || !conta.cambioAplicado
              ? complemento
              : arredondar(complemento * 10_000n, lerDecimal(conta.cambioAplicado, 4));
          const [linha] = await tx
            .insert(pagamentosFornecedor)
            .values({
              contaId: conta.id,
              numero: linhas.reduce((n, l) => Math.max(n, l.numero), 0) + 1,
              vencimento: hoje,
              valorOriginal,
              valorBrlPrevisto: complemento,
              ...vinculo,
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
// Parcelas a receber, pagamentos e comissões: o núcleo (`@/server/financeiro/baixas-viagem`) numa transação nova
// ---------------------------------------------------------------------------

export type BaixaParcelaEntrada = {
  recebidaEm: string;
  valorRecebido: string;
  taxaEfetiva?: string | null;
  observacao?: string | null;
  contaBancariaId: string;
};

/**
 * Baixa da parcela: data, valor recebido, taxa efetiva (vazia = a prevista), conta bancária ativa e observação,
 * obrigatória quando o valor recebido é diferente do valor da parcela (a diferença entra na margem real).
 */
export async function baixarParcela(parcelaId: string, dados: BaixaParcelaEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    const b = baixaParcelaSchema().safeParse(dados);
    if (!b.success) return falhaDeValidacao(b.error);
    return naTransacao("Erro ao baixar a parcela", (tx) => baixarParcelaNa(tx, usuario.id, parcelaId, b.data));
  });
}

/** Desfaz a baixa ou o cancelamento da parcela: volta a `a_receber`. */
export async function desfazerBaixaParcela(parcelaId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    return naTransacao("Erro ao desfazer a baixa da parcela", (tx) => desfazerBaixaParcelaNa(tx, usuario.id, parcelaId));
  });
}

/** Cancela a parcela em aberto, com motivo (fica na observação). */
export async function cancelarParcela(parcelaId: string, motivo: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    const m = texto(motivoSchema, motivo, "motivo");
    if (ehFalha(m)) return m;
    return naTransacao("Erro ao cancelar a parcela", (tx) => cancelarParcelaNa(tx, usuario.id, parcelaId, m));
  });
}

export type BaixaPagamentoEntrada = { pagoEm: string; valorOriginalPago: string; cambioEfetivo?: string | null; contaBancariaId: string };

/**
 * Baixa do pagamento: data e valor pago na moeda da conta; fora do real, câmbio efetivo obrigatório e o valor em
 * reais é a conversão (meio para cima). A conta fica `paga` quando todas as linhas estão pagas.
 */
export async function baixarPagamento(pagamentoId: string, dados: BaixaPagamentoEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(pagamentoId)) return PAGAMENTO_NAO_ENCONTRADO;
    const b = baixaPagamentoSchema().safeParse(dados);
    if (!b.success) return falhaDeValidacao(b.error);
    return naTransacao("Erro ao baixar o pagamento", (tx) => baixarPagamentoNa(tx, usuario.id, pagamentoId, b.data));
  });
}

/** Desfaz a baixa do pagamento; a conta volta a `a_pagar`. */
export async function desfazerBaixaPagamento(pagamentoId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(pagamentoId)) return PAGAMENTO_NAO_ENCONTRADO;
    return naTransacao("Erro ao desfazer a baixa do pagamento", (tx) => desfazerBaixaPagamentoNa(tx, usuario.id, pagamentoId));
  });
}

export type ComissaoRecebidaEntrada = { recebidaEm: string; valorRecebido: string; contaBancariaId: string };

/** Comissão recebida: data e valor. */
export async function registrarComissao(comissaoId: string, dados: ComissaoRecebidaEntrada): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(comissaoId)) return COMISSAO_NAO_ENCONTRADA;
    const b = comissaoRecebidaSchema().safeParse(dados);
    if (!b.success) return falhaDeValidacao(b.error);
    return naTransacao("Erro ao registrar a comissão", (tx) => registrarComissaoNa(tx, usuario.id, comissaoId, b.data));
  });
}

/** Comissão que não será recebida, com motivo. */
export async function comissaoNaoRecebida(comissaoId: string, motivo: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(comissaoId)) return COMISSAO_NAO_ENCONTRADA;
    const m = texto(motivoSchema, motivo, "motivo");
    if (ehFalha(m)) return m;
    return naTransacao("Erro ao registrar a comissão", (tx) => comissaoNaoRecebidaNa(tx, usuario.id, comissaoId, m));
  });
}

/** Desfaz o registro da comissão (recebida ou não recebida): volta a `prevista`. */
export async function desfazerComissao(comissaoId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(comissaoId)) return COMISSAO_NAO_ENCONTRADA;
    return naTransacao("Erro ao desfazer a comissão", (tx) => desfazerComissaoNa(tx, usuario.id, comissaoId));
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
 * ou marcadas "não será recebida"); grava `conciliada_em`. Senão, "Ainda há valores em aberto: …". Recusada com a
 * caixa de experiência em rascunho (a caixa trava a mesma viagem: a leitura com a viagem travada vale).
 */
export async function conciliar(viagemId: string): Promise<Ok | Falha> {
  return comPerfil([...PERFIS_FINANCEIRO], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    return naViagemVendida(
      async () => viagemId,
      VIAGEM_NAO_ENCONTRADA,
      "Erro ao conciliar a viagem",
      async (tx, v) => {
        const [rascunho] = await tx
          .select({ id: caixasExperiencia.id })
          .from(caixasExperiencia)
          .where(and(eq(caixasExperiencia.viagemId, v.id), eq(caixasExperiencia.situacao, "rascunho")));
        if (rascunho) return falha(MSG_CAIXA_EM_RASCUNHO);
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
