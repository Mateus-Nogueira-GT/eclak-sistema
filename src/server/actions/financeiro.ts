"use server";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { ZodError } from "zod";
import { hojeEmCuiaba } from "@/domain/clientes";
import { dividirEmParcelas, datasRecorrentes, ORIGENS, ROTULO_FORMA_FINANCEIRO, type FormaFinanceiroSlug, type Origem } from "@/domain/financeiro";
import {
  MSG_FORMA,
  MSG_LOTE_LADOS,
  MSG_LOTE_RECUSADO,
  baixaLancamentoSchema,
  categoriaSchema,
  contaBancariaSchema,
  lancamentoSchema,
  loteSchema,
  motivoForaDoLote,
  repasseSchema,
} from "@/domain/financeiro-entrada";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import {
  MSG_FORNECEDOR_CARTAO,
  MSG_MOTIVO,
  baixaPagamentoSchema,
  baixaParcelaSchema,
  comissaoRecebidaSchema,
  obrigatorio,
} from "@/domain/venda-entrada";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { revalidatePath } from "next/cache";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import {
  categoriasFinanceiras,
  clientes,
  contasBancarias,
  fornecedores,
  lancamentos,
  lancamentosFinanceiros,
  pagamentosFornecedor,
} from "@/server/db/schema";
import {
  baixarPagamentoNa,
  baixarParcelaNa,
  baixarRepasseNa,
  contaBancariaAtiva,
  definirFornecedorCartaoNa,
  Desfazer as DesfazerNaViagem,
  desfazerBaixaPagamentoNa,
  desfazerBaixaParcelaNa,
  desfazerComissaoNa,
  desfazerRepasseNa,
  ehFalha,
  registrarComissaoNa,
  type Feito,
} from "@/server/financeiro/baixas-viagem";
import { travarFaturasNa, type EntradaFatura, type SemCartao, type Vinculo } from "@/server/financeiro/cartoes";
import { travarViagem } from "@/server/trava-viagem";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Cadastros do financeiro (categorias, contas bancárias) e lançamentos manuais: criar (única, parcelada,
// recorrente), editar, baixar, desfazer a baixa e cancelar. Só Diretor e financeiros. Lançamento nunca é apagado
// (cancelado); linhas alteradas são travadas com `for update`; toda escrita audita na mesma transação.

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
type Ok = { ok: true; id?: string; ids?: string[] };

const falha = (erro: string, campo?: string): Falha => (campo ? { ok: false, erro, campos: { [campo]: erro } } : { ok: false, erro });
const LANCAMENTO_NAO_ENCONTRADO = falha("Lançamento não encontrado");
const CATEGORIA_NAO_ENCONTRADA = falha("Categoria não encontrada");
const CONTA_NAO_ENCONTRADA = falha("Conta bancária não encontrada");
const msgCategoriaSistema = (sistema: string, acao: string) =>
  `Categoria usada ${sistema === "cartao_corporativo" ? "pelo cartão corporativo" : "pelas viagens"}: não pode ${acao}`;
const MSG_DESFACA_BAIXA = "Desfaça a baixa para editar";
const MSG_DIFERENCA_PAGO = "Explique a diferença do valor pago";

/** Recusa dentro da transação que precisa desfazer o que já foi gravado; vira a `falha` fora dela. */
class Desfazer extends Error {
  constructor(readonly falha: Falha) {
    super(falha.erro);
  }
}

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

const codigoDe = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.cause?.code ?? x?.code;
};

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Transação com `Desfazer` e erro genérico; `unico` traduz a violação de unicidade (23505), se houver. */
async function transacao(mensagemErro: string, fn: (tx: Transacao) => Promise<Ok | Falha>, unico?: Falha): Promise<Ok | Falha> {
  try {
    return await db.transaction(fn);
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    if (unico && codigoDe(x) === "23505") return unico;
    throw erroDeBanco(mensagemErro, x);
  }
}

function revalidar() {
  revalidatePath("/financeiro", "layout");
}

/** Auditoria de alteração: `antes` só com as chaves alteradas. */
async function auditarAlteracao<T extends { id: string }>(tx: Transacao, usuarioId: string, tabela: string, linha: T, depois: Partial<T>, acao: "alterar" | "desativar" = "alterar"): Promise<void> {
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, linha[k as keyof T]]));
  await registrarAuditoria(tx, { usuarioId, tabela, registroId: linha.id, acao, antes, depois });
}

const FINANCEIRO = [...PERFIS_FINANCEIRO];

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

const CATEGORIA_REPETIDA = falha("Já existe uma categoria com este nome neste grupo", "nome");

export async function salvarCategoria(dados: unknown, id?: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = categoriaSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    if (id !== undefined && !ehUuid(id)) return CATEGORIA_NAO_ENCONTRADA;
    const r = await transacao(
      "Falha ao salvar a categoria",
      async (tx) => {
        if (id === undefined) {
          const [nova] = await tx.insert(categoriasFinanceiras).values(v).returning();
          await registrarAuditoria(tx, { usuarioId: u.id, tabela: "categorias_financeiras", registroId: nova.id, acao: "criar", depois: v });
          return { ok: true, id: nova.id };
        }
        const [cat] = await tx.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.id, id)).for("update");
        if (!cat) return CATEGORIA_NAO_ENCONTRADA;
        if (cat.lado !== v.lado) {
          if (cat.sistema) return falha(msgCategoriaSistema(cat.sistema, "trocar de lado"), "lado");
          const [uso] = await tx.select({ id: lancamentos.id }).from(lancamentos).where(eq(lancamentos.categoriaId, id)).limit(1);
          if (uso) return falha("Categoria com lançamentos: não pode trocar de lado", "lado");
        }
        const depois = { lado: v.lado, grupo: v.grupo, nome: v.nome };
        const mudou = (Object.keys(depois) as (keyof typeof depois)[]).filter((k) => cat[k] !== depois[k]);
        if (mudou.length > 0) {
          const parcial = Object.fromEntries(mudou.map((k) => [k, depois[k]]));
          await tx.update(categoriasFinanceiras).set(parcial).where(eq(categoriasFinanceiras.id, id));
          await auditarAlteracao(tx, u.id, "categorias_financeiras", cat, parcial);
        }
        return { ok: true, id };
      },
      CATEGORIA_REPETIDA,
    );
    if (r.ok) revalidar();
    return r;
  });
}

export async function alternarCategoria(id: string, ativa: boolean) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (!ehUuid(id)) return CATEGORIA_NAO_ENCONTRADA;
    const r = await transacao("Falha ao alterar a categoria", async (tx) => {
      const [cat] = await tx.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.id, id)).for("update");
      if (!cat) return CATEGORIA_NAO_ENCONTRADA;
      if (!ativa && cat.sistema) return falha(msgCategoriaSistema(cat.sistema, "ser desativada"));
      if (cat.ativa !== ativa) {
        await tx.update(categoriasFinanceiras).set({ ativa }).where(eq(categoriasFinanceiras.id, id));
        await auditarAlteracao(tx, u.id, "categorias_financeiras", cat, { ativa }, ativa ? "alterar" : "desativar");
      }
      return { ok: true, id };
    });
    if (r.ok) revalidar();
    return r;
  });
}

// ---------------------------------------------------------------------------
// Contas bancárias
// ---------------------------------------------------------------------------

const CONTA_REPETIDA = falha("Já existe uma conta ativa com este nome", "nome");

export async function salvarContaBancaria(dados: unknown, id?: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = contaBancariaSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    if (id !== undefined && !ehUuid(id)) return CONTA_NAO_ENCONTRADA;
    const r = await transacao(
      "Falha ao salvar a conta bancária",
      async (tx) => {
        if (id === undefined) {
          const [nova] = await tx.insert(contasBancarias).values(v).returning();
          await registrarAuditoria(tx, { usuarioId: u.id, tabela: "contas_bancarias", registroId: nova.id, acao: "criar", depois: v });
          return { ok: true, id: nova.id };
        }
        const [conta] = await tx.select().from(contasBancarias).where(and(eq(contasBancarias.id, id), isNull(contasBancarias.excluidoEm))).for("update");
        if (!conta) return CONTA_NAO_ENCONTRADA;
        const mudou = (Object.keys(v) as (keyof typeof v)[]).filter((k) => conta[k] !== v[k]);
        if (mudou.length > 0) {
          const parcial = Object.fromEntries(mudou.map((k) => [k, v[k]]));
          await tx.update(contasBancarias).set(parcial).where(eq(contasBancarias.id, id));
          await auditarAlteracao(tx, u.id, "contas_bancarias", conta, parcial);
        }
        return { ok: true, id };
      },
      CONTA_REPETIDA,
    );
    if (r.ok) revalidar();
    return r;
  });
}

export async function desativarContaBancaria(id: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (!ehUuid(id)) return CONTA_NAO_ENCONTRADA;
    const r = await transacao("Falha ao desativar a conta bancária", async (tx) => {
      const [conta] = await tx.select().from(contasBancarias).where(and(eq(contasBancarias.id, id), isNull(contasBancarias.excluidoEm))).for("update");
      if (!conta) return CONTA_NAO_ENCONTRADA;
      if (conta.ativa) {
        await tx.update(contasBancarias).set({ ativa: false }).where(eq(contasBancarias.id, id));
        await auditarAlteracao(tx, u.id, "contas_bancarias", conta, { ativa: false }, "desativar");
      }
      return { ok: true, id };
    });
    if (r.ok) revalidar();
    return r;
  });
}

// ---------------------------------------------------------------------------
// Lançamentos manuais
// ---------------------------------------------------------------------------

type LancamentoLinha = typeof lancamentos.$inferSelect;
type Entrada = ReturnType<typeof lancamentoSchema.parse>;

/** Soma `n` meses a `AAAA-MM`. */
function somarMesesCompetencia(competencia: string, n: number): string {
  const [a, m] = competencia.split("-").map(Number);
  const t = a * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

const mesesDe = (data: string) => Number(data.slice(0, 4)) * 12 + Number(data.slice(5, 7));

/** Categoria ativa do lado certo, conta bancária ativa e pessoa existentes; senão recusa dentro da transação. */
async function conferirReferencias(tx: Transacao, v: Entrada): Promise<void> {
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
async function contaAtiva(tx: Transacao, id: string, campo: string): Promise<void> {
  if (!(await contaBancariaAtiva(tx, id))) throw new Desfazer(falha("Conta bancária não encontrada ou desativada", campo));
}

/** O slug do enum a partir do rótulo da forma (o schema entrega o rótulo). */
function slugDaForma(rotulo: string): FormaFinanceiroSlug {
  const par = (Object.entries(ROTULO_FORMA_FINANCEIRO) as [FormaFinanceiroSlug, string][]).find(([, r]) => r === rotulo);
  if (!par) throw new Desfazer(falha(MSG_FORMA, "forma"));
  return par[0];
}

const SEM_CARTAO: SemCartao = { cartaoId: null, faturaCartaoId: null };

/**
 * Trava todas as faturas que a transação mexe, numa passada só e em ordem única (`travarFaturasNa`), antes de
 * qualquer escrita nas compras; recusa desfazendo a transação. Devolve o vínculo de cada entrada, na ordem.
 */
async function travarFaturas(tx: Transacao, usuarioId: string, sair: (string | null)[], entrar: EntradaFatura[]): Promise<Vinculo[]> {
  const r = await travarFaturasNa(tx, usuarioId, sair, entrar);
  if (ehFalha(r)) throw new Desfazer(r);
  return r;
}

/**
 * O que muda no cartão da linha `l` editada (compra na data `dataCompra`): mesma compra (mesmo cartão, mesma data, já
 * vinculada) fica na fatura em que está (`fica`); senão sai da fatura atual (se houver) e, com cartão, entra na do
 * ciclo da data (cartão desativado só é aceito se já era o da compra).
 */
function planoDoCartao(l: LancamentoLinha, cartaoId: string | null, dataCompra: string): { fica: Vinculo } | { sai: string | null; entra: EntradaFatura | null } {
  if (cartaoId && cartaoId === l.cartaoId && l.faturaCartaoId && dataCompra === l.vencimento) return { fica: { cartaoId, faturaCartaoId: l.faturaCartaoId } };
  return { sai: l.faturaCartaoId, entra: cartaoId ? { cartaoId, dataCompra, exigeAtivo: cartaoId !== l.cartaoId } : null };
}

/** Campos editáveis comuns (sem as datas, que cada linha mantém nas "próximas"). */
function camposComuns(v: Entrada) {
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

export async function criarLancamento(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<(Ok & { ids: string[] }) | Falha> => {
    const p = lancamentoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    const r = await transacao("Falha ao criar o lançamento", async (tx) => {
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
        ? await travarFaturas(tx, u.id, [], itens.map((x) => ({ cartaoId, dataCompra: x.vencimento, exigeAtivo: true })))
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
            criadoPor: u.id,
          })),
        )
        .returning();
      for (const l of linhas) {
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "lancamentos", registroId: l.id, acao: "criar", depois: l });
      }
      return { ok: true, ids: linhas.map((l) => l.id) };
    });
    if (r.ok) revalidar();
    return r as (Ok & { ids: string[] }) | Falha;
  });
}

type Alcance = "esta" | "proximas";
const ehAlcance = (a: unknown): a is Alcance => a === "esta" || a === "proximas";

/**
 * Trava (`for update`, por id) a linha e, em "proximas", as em aberto do mesmo grupo de número maior ou igual.
 * Devolve a linha alvo e as linhas afetadas (a alvo sempre inclusa).
 */
async function travarAlcance(tx: Transacao, id: string, alcance: Alcance): Promise<{ alvo: LancamentoLinha; afetadas: LancamentoLinha[] } | null> {
  const [achado] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id));
  if (!achado) return null;
  const idsDoGrupo =
    alcance === "proximas" && achado.grupoId && achado.parcelaNumero !== null
      ? (
          await tx
            .select({ id: lancamentos.id })
            .from(lancamentos)
            .where(and(eq(lancamentos.grupoId, achado.grupoId), sql`${lancamentos.parcelaNumero} >= ${achado.parcelaNumero}`))
        ).map((x) => x.id)
      : [];
  const todos = await tx
    .select()
    .from(lancamentos)
    .where(inArray(lancamentos.id, [id, ...idsDoGrupo]))
    .orderBy(asc(lancamentos.id))
    .for("update");
  const alvo = todos.find((l) => l.id === id);
  if (!alvo) return null;
  return { alvo, afetadas: todos.filter((l) => l.id === id || l.status === "em_aberto") };
}

export async function editarLancamento(id: string, dados: unknown, alcance: Alcance) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = lancamentoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    if (!ehUuid(id) || !ehAlcance(alcance)) return LANCAMENTO_NAO_ENCONTRADO;
    const r = await transacao("Falha ao editar o lançamento", async (tx) => {
      const t = await travarAlcance(tx, id, alcance);
      if (!t) return LANCAMENTO_NAO_ENCONTRADO;
      if (t.alvo.status === "baixado") return falha(MSG_DESFACA_BAIXA);
      if (t.alvo.status === "cancelado") return falha("Lançamento cancelado não pode ser editado");
      await conferirReferencias(tx, v);
      const { valor, ...semValor } = camposComuns(v);
      // "repeticao" não se aplica à edição. As datas só mudam na linha escolhida: cada parcela mantém as suas. O
      // valor só vai às próximas quando foi mudado na escolhida (senão a última parcela perderia o resto da divisão).
      const nasOutras = valor === t.alvo.valor ? semValor : { ...semValor, valor };
      // Compra no cartão: cada linha pela sua data (a da escolhida pode ter mudado). Todas as faturas de saída e de
      // entrada são travadas juntas, em ordem única, antes das escritas.
      const planos = t.afetadas.map((l) => planoDoCartao(l, v.cartaoId, l.id === id ? v.vencimento : l.vencimento));
      const entradas = planos.flatMap((x) => ("entra" in x && x.entra ? [x.entra] : []));
      const novos = await travarFaturas(tx, u.id, planos.map((x) => ("sai" in x ? x.sai : null)), entradas);
      let n = 0;
      const cartaoDe = planos.map((x) => ("fica" in x ? x.fica : x.entra ? novos[n++] : SEM_CARTAO));
      for (const [i, l] of t.afetadas.entries()) {
        const depois: Record<string, unknown> = {
          ...(l.id === id ? { ...semValor, valor, competencia: v.competencia, emissao: v.emissao, vencimento: v.vencimento } : { ...nasOutras }),
          ...cartaoDe[i],
        };
        const mudou = Object.keys(depois).filter((k) => l[k as keyof LancamentoLinha] !== depois[k]);
        if (mudou.length === 0) continue;
        const parcial = Object.fromEntries(mudou.map((k) => [k, depois[k]]));
        await tx.update(lancamentos).set(parcial).where(eq(lancamentos.id, l.id));
        await auditarAlteracao(tx, u.id, "lancamentos", l, parcial as Partial<LancamentoLinha>);
      }
      return { ok: true, ids: t.afetadas.map((l) => l.id) };
    });
    if (r.ok) revalidar();
    return r;
  });
}

type BaixaLancamentoValidada = ReturnType<ReturnType<typeof baixaLancamentoSchema>["parse"]>;

/** Baixa do lançamento manual na transação `tx` (a mesma da baixa individual e do lote). */
async function baixarLancamentoNa(tx: Transacao, usuarioId: string, id: string, v: BaixaLancamentoValidada): Promise<Ok | Falha> {
  const [l] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id)).for("update");
  if (!l) return LANCAMENTO_NAO_ENCONTRADO;
  if (l.status === "baixado") return falha(l.lado === "pagar" ? "Lançamento já pago" : "Lançamento já recebido");
  if (l.status === "cancelado") return falha("Lançamento cancelado");
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

/** Desfaz a baixa do lançamento manual na transação `tx`. */
async function desfazerBaixaLancamentoNa(tx: Transacao, usuarioId: string, id: string): Promise<Ok | Falha> {
  const [l] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id)).for("update");
  if (!l) return LANCAMENTO_NAO_ENCONTRADO;
  if (l.status !== "baixado") return falha("Este lançamento não foi baixado");
  const depois = { status: "em_aberto" as const, baixadoEm: null, valorPago: null, juros: null, desconto: null, baixaContaBancariaId: null };
  await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, id));
  await auditarAlteracao(tx, usuarioId, "lancamentos", l, depois);
  return { ok: true, id };
}

export async function baixarLancamento(id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = baixaLancamentoSchema(hojeEmCuiaba()).safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    if (!ehUuid(id)) return LANCAMENTO_NAO_ENCONTRADO;
    const r = await transacao("Falha ao baixar o lançamento", (tx) => baixarLancamentoNa(tx, u.id, id, p.data));
    if (r.ok) revalidar();
    return r;
  });
}

export async function desfazerBaixaLancamento(id: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (!ehUuid(id)) return LANCAMENTO_NAO_ENCONTRADO;
    const r = await transacao("Falha ao desfazer a baixa", (tx) => desfazerBaixaLancamentoNa(tx, u.id, id));
    if (r.ok) revalidar();
    return r;
  });
}

export async function cancelarLancamento(id: string, motivo: unknown, alcance: Alcance) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const m = obrigatorio(MSG_MOTIVO, 500).safeParse(motivo);
    if (!m.success) return falha(m.error.issues[0].message, "motivo");
    if (!ehUuid(id) || !ehAlcance(alcance)) return LANCAMENTO_NAO_ENCONTRADO;
    const r = await transacao("Falha ao cancelar o lançamento", async (tx) => {
      const t = await travarAlcance(tx, id, alcance);
      if (!t) return LANCAMENTO_NAO_ENCONTRADO;
      if (t.alvo.status === "baixado") return falha("Desfaça a baixa para cancelar");
      if (t.alvo.status === "cancelado") return falha("Lançamento já cancelado");
      // Compra no cartão sai da fatura (o cartão fica registrado na linha); as faturas travadas juntas, em ordem única.
      await travarFaturas(tx, u.id, t.afetadas.map((l) => l.faturaCartaoId), []);
      for (const l of t.afetadas) {
        const depois = { status: "cancelado" as const, motivoCancelamento: m.data, ...(l.faturaCartaoId ? { faturaCartaoId: null } : {}) };
        await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, l.id));
        await auditarAlteracao(tx, u.id, "lancamentos", l, depois);
      }
      return { ok: true, ids: t.afetadas.map((l) => l.id) };
    });
    if (r.ok) revalidar();
    return r;
  });
}

// ---------------------------------------------------------------------------
// Cartão direto no fornecedor (regra a): repasse e fornecedor do cartão (núcleo em `@/server/financeiro/baixas-viagem`)
// ---------------------------------------------------------------------------

const PARCELA_NAO_ENCONTRADA = falha("Parcela não encontrada");
const VIAGEM_NAO_ENCONTRADA = falha("Viagem não encontrada");

/** Núcleo da viagem numa transação nova; no sucesso revalida as telas da viagem e do financeiro. */
async function naViagem(mensagemErro: string, fn: (tx: Transacao) => Promise<Feito | Falha>): Promise<{ ok: true } | Falha> {
  let r: Feito | Falha;
  try {
    r = await db.transaction(fn);
  } catch (x) {
    if (x instanceof DesfazerNaViagem || x instanceof Desfazer) return x.falha;
    throw erroDeBanco(mensagemErro, x);
  }
  if (ehFalha(r)) return r;
  revalidatePath("/viagens");
  revalidatePath(`/viagens/${r.viagemId}`);
  revalidatePath("/vendas");
  revalidar();
  return { ok: true };
}

export type RepasseEntrada = { data: string; valorRepassado: string; contaBancariaId: string };

/**
 * Repasse do fornecedor que recebeu no cartão: baixa a parcela pelo valor (taxa efetiva = repasse esperado − valor
 * repassado) e quita os pagamentos em aberto desse fornecedor na viagem pelo previsto, sem conta bancária.
 */
export async function baixarRepasse(parcelaId: string, dados: RepasseEntrada) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true } | Falha> => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    const p = repasseSchema().safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    return naViagem("Erro ao registrar o repasse", (tx) => baixarRepasseNa(tx, u.id, parcelaId, p.data));
  });
}

/** Desfaz o repasse: a parcela e os pagamentos quitados por ele voltam a ficar em aberto. */
export async function desfazerRepasse(parcelaId: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true } | Falha> => {
    if (!ehUuid(parcelaId)) return PARCELA_NAO_ENCONTRADA;
    return naViagem("Erro ao desfazer o repasse", (tx) => desfazerRepasseNa(tx, u.id, parcelaId));
  });
}

/** Fornecedor que recebeu no cartão (vendas antigas, sem ele): com conta ativa na viagem; antes do repasse. */
export async function definirFornecedorCartao(viagemId: string, fornecedorId: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true } | Falha> => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    if (!ehUuid(fornecedorId)) return falha(MSG_FORNECEDOR_CARTAO, "fornecedorCartaoId");
    return naViagem("Erro ao escolher o fornecedor do cartão", (tx) => definirFornecedorCartaoNa(tx, u.id, viagemId, fornecedorId));
  });
}

// ---------------------------------------------------------------------------
// Lista única: baixa por linha (o mesmo núcleo da tela da viagem) e em lote
// ---------------------------------------------------------------------------

const ehOrigem = (o: unknown): o is Origem => typeof o === "string" && (ORIGENS as readonly string[]).includes(o);
const ORIGEM_INVALIDA = falha("Origem inválida");
const NAO_ENCONTRADO: Record<Origem, Falha> = {
  manual: LANCAMENTO_NAO_ENCONTRADO,
  parcela: PARCELA_NAO_ENCONTRADA,
  pagamento: falha("Pagamento não encontrado"),
  comissao: falha("Comissão não encontrada"),
};

/** Resultado do lançamento manual como a lista responde (sem ids), revalidando o financeiro. */
async function noManual(mensagemErro: string, fn: (tx: Transacao) => Promise<Ok | Falha>): Promise<{ ok: true } | Falha> {
  const r = await transacao(mensagemErro, fn);
  if (!r.ok) return r;
  revalidar();
  return { ok: true };
}

/**
 * Baixa de uma linha da lista, pela origem: manual → baixa do lançamento; parcela, pagamento e comissão → o
 * núcleo da viagem (`@/server/financeiro/baixas-viagem`), o mesmo da tela da viagem. `dados` tem os campos da
 * baixa daquela origem (os mesmos da viagem). A parcela de repasse do cartão é recusada pelo núcleo ("Use o
 * repasse do fornecedor"): a tela chama `baixarRepasse`.
 */
export async function baixarLinha(origem: Origem, id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true } | Falha> => {
    if (!ehOrigem(origem)) return ORIGEM_INVALIDA;
    if (!ehUuid(id)) return NAO_ENCONTRADO[origem];
    switch (origem) {
      case "manual": {
        const p = baixaLancamentoSchema().safeParse(dados);
        if (!p.success) return falhaDeValidacao(p.error);
        return noManual("Falha ao baixar o lançamento", (tx) => baixarLancamentoNa(tx, u.id, id, p.data));
      }
      case "parcela": {
        const p = baixaParcelaSchema().safeParse(dados);
        if (!p.success) return falhaDeValidacao(p.error);
        return naViagem("Erro ao baixar a parcela", (tx) => baixarParcelaNa(tx, u.id, id, p.data));
      }
      case "pagamento": {
        const p = baixaPagamentoSchema().safeParse(dados);
        if (!p.success) return falhaDeValidacao(p.error);
        return naViagem("Erro ao baixar o pagamento", (tx) => baixarPagamentoNa(tx, u.id, id, p.data));
      }
      case "comissao": {
        const p = comissaoRecebidaSchema().safeParse(dados);
        if (!p.success) return falhaDeValidacao(p.error);
        return naViagem("Erro ao registrar a comissão", (tx) => registrarComissaoNa(tx, u.id, id, p.data));
      }
    }
  });
}

/** Desfaz a baixa de uma linha da lista, pela origem (o repasse do cartão volta por `desfazerRepasse`). */
export async function desfazerBaixaLinha(origem: Origem, id: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true } | Falha> => {
    if (!ehOrigem(origem)) return ORIGEM_INVALIDA;
    if (!ehUuid(id)) return NAO_ENCONTRADO[origem];
    switch (origem) {
      case "manual":
        return noManual("Falha ao desfazer a baixa", (tx) => desfazerBaixaLancamentoNa(tx, u.id, id));
      case "parcela":
        return naViagem("Erro ao desfazer a baixa da parcela", (tx) => desfazerBaixaParcelaNa(tx, u.id, id));
      case "pagamento":
        return naViagem("Erro ao desfazer a baixa do pagamento", (tx) => desfazerBaixaPagamentoNa(tx, u.id, id));
      case "comissao":
        return naViagem("Erro ao desfazer a comissão", (tx) => desfazerComissaoNa(tx, u.id, id));
    }
  });
}

type ItemLote = { origem: Origem; id: string };
type LinhaRecusada = ItemLote & { motivo: string };
type FalhaLote = Falha & { linhas?: LinhaRecusada[] };

/** Recusa do lote dentro da transação: desfaz tudo o que já foi gravado e vira a falha fora dela. */
class RecusaLote extends Error {
  constructor(readonly falha: FalhaLote) {
    super(falha.erro);
  }
}

/** As linhas do lote na view, no estado atual (relidas depois das travas). */
function linhasDoLote(tx: Transacao, itens: ItemLote[]) {
  return tx
    .select({
      origem: lancamentosFinanceiros.origem,
      id: lancamentosFinanceiros.id,
      lado: lancamentosFinanceiros.lado,
      statusBase: lancamentosFinanceiros.statusBase,
      exigeIndividual: lancamentosFinanceiros.exigeIndividual,
      repasse: lancamentosFinanceiros.repasse,
      transitaCaixa: lancamentosFinanceiros.transitaCaixa,
      viagemId: lancamentosFinanceiros.viagemId,
      valorPrevisto: lancamentosFinanceiros.valorPrevisto,
      taxa: lancamentosFinanceiros.taxa,
    })
    .from(lancamentosFinanceiros)
    .where(or(...itens.map((i) => and(eq(lancamentosFinanceiros.origem, i.origem), eq(lancamentosFinanceiros.id, i.id)))));
}
type LinhaLote = Awaited<ReturnType<typeof linhasDoLote>>[number];

/**
 * Confere o lote inteiro: toda linha existe, está em aberto e não exige dado individual (moeda estrangeira,
 * repasse do cartão, fora do caixa), e todas são do mesmo lado. Devolve a recusa com as linhas a tirar, ou `null`.
 */
function recusaDoLote(itens: ItemLote[], linhas: LinhaLote[]): FalhaLote | null {
  const achar = (i: ItemLote) => linhas.find((l) => l.origem === i.origem && l.id === i.id);
  const recusadas: LinhaRecusada[] = [];
  for (const i of itens) {
    const l = achar(i);
    const motivo = l ? motivoForaDoLote(l) : "Linha não encontrada";
    if (motivo) recusadas.push({ ...i, motivo });
  }
  if (recusadas.length > 0) return { ok: false, erro: MSG_LOTE_RECUSADO, linhas: recusadas };
  const lado = achar(itens[0])!.lado;
  const outroLado = itens.filter((i) => achar(i)!.lado !== lado).map((i) => ({ ...i, motivo: MSG_LOTE_LADOS }));
  return outroLado.length > 0 ? { ok: false, erro: MSG_LOTE_LADOS, linhas: outroLado } : null;
}

/** Baixa uma linha do lote pelo valor previsto, com a data e a conta do lote (o mesmo código da baixa individual). */
async function baixarPeloPrevisto(tx: Transacao, usuarioId: string, l: LinhaLote, data: string, contaBancariaId: string): Promise<{ ok: true } | Falha> {
  switch (l.origem) {
    case "manual":
      return baixarLancamentoNa(tx, usuarioId, l.id, { data, valorPago: l.valorPrevisto, juros: 0n, desconto: 0n, contaBancariaId, observacao: null });
    case "parcela":
      // Taxa prevista como efetiva (cartão e boleto); valor recebido = o da parcela.
      return baixarParcelaNa(tx, usuarioId, l.id, { recebidaEm: data, valorRecebido: l.valorPrevisto, taxaEfetiva: l.taxa, observacao: null, contaBancariaId });
    case "pagamento": {
      // Só BRL chega aqui (moeda estrangeira exige baixa individual): o valor pago é o valor original da linha.
      const [p] = await tx.select({ valorOriginal: pagamentosFornecedor.valorOriginal }).from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, l.id));
      if (!p) return NAO_ENCONTRADO.pagamento;
      return baixarPagamentoNa(tx, usuarioId, l.id, { pagoEm: data, valorOriginalPago: p.valorOriginal, cambioEfetivo: null, contaBancariaId });
    }
    case "comissao":
      return registrarComissaoNa(tx, usuarioId, l.id, { recebidaEm: data, valorRecebido: l.valorPrevisto, contaBancariaId });
  }
}

/**
 * Baixa em lote: as linhas marcadas (em aberto, do mesmo lado) baixadas pelo valor previsto, com a data e a conta
 * do lote, numa transação só. Recusa o lote inteiro, dizendo as linhas a tirar, se alguma exige dado individual,
 * não está em aberto ou é do outro lado. Trava as viagens envolvidas em ordem crescente de id antes de qualquer
 * escrita, relê as linhas depois das travas e grava (manuais por id, depois as de viagem por viagem e id);
 * qualquer recusa no meio desfaz tudo.
 */
export async function baixarEmLote(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true } | FalhaLote> => {
    const p = loteSchema().safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const { itens, data, contaBancariaId } = p.data;
    let viagensAlteradas: string[];
    try {
      viagensAlteradas = await db.transaction(async (tx) => {
        const lidas = await linhasDoLote(tx, itens);
        const recusaAntes = recusaDoLote(itens, lidas);
        if (recusaAntes) throw new RecusaLote(recusaAntes);
        const ids = [...new Set(lidas.map((l) => l.viagemId).filter((v): v is string => v !== null))].sort();
        for (const v of ids) await travarViagem(tx, v);
        // Depois das travas: o estado pode ter mudado entre a leitura e a escrita.
        const linhas = await linhasDoLote(tx, itens);
        const recusa = recusaDoLote(itens, linhas);
        if (recusa) throw new RecusaLote(recusa);
        const ordem = (l: LinhaLote) => `${l.viagemId ?? ""}|${l.origem}|${l.id}`;
        for (const l of [...linhas].sort((a, b) => (ordem(a) < ordem(b) ? -1 : ordem(a) > ordem(b) ? 1 : 0))) {
          const r = await baixarPeloPrevisto(tx, u.id, l, data, contaBancariaId);
          if (ehFalha(r)) throw new RecusaLote({ ...r, linhas: [{ origem: l.origem, id: l.id, motivo: r.erro }] });
        }
        return ids;
      });
    } catch (x) {
      if (x instanceof RecusaLote || x instanceof Desfazer || x instanceof DesfazerNaViagem) return x.falha;
      throw erroDeBanco("Falha ao baixar o lote", x);
    }
    revalidar();
    if (viagensAlteradas.length > 0) {
      revalidatePath("/viagens");
      revalidatePath("/vendas");
      for (const v of viagensAlteradas) revalidatePath(`/viagens/${v}`);
    }
    return { ok: true };
  });
}
