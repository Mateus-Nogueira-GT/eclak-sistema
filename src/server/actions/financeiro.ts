"use server";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ZodError } from "zod";
import { hojeEmCuiaba } from "@/domain/clientes";
import { dividirEmParcelas, datasRecorrentes, ROTULO_FORMA_FINANCEIRO, type FormaFinanceiroSlug } from "@/domain/financeiro";
import { MSG_FORMA, baixaLancamentoSchema, categoriaSchema, contaBancariaSchema, lancamentoSchema } from "@/domain/financeiro-entrada";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { MSG_MOTIVO, obrigatorio } from "@/domain/venda-entrada";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { revalidatePath } from "next/cache";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { categoriasFinanceiras, clientes, contasBancarias, fornecedores, lancamentos } from "@/server/db/schema";

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
const MSG_CATEGORIA_SISTEMA = "Categoria usada pelas viagens: não pode ser desativada";
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
          if (cat.sistema) return falha("Categoria usada pelas viagens: não pode trocar de lado", "lado");
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
      if (!ativa && cat.sistema) return falha(MSG_CATEGORIA_SISTEMA);
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

async function contaAtiva(tx: Transacao, id: string, campo: string): Promise<void> {
  const [conta] = await tx
    .select({ id: contasBancarias.id })
    .from(contasBancarias)
    .where(and(eq(contasBancarias.id, id), eq(contasBancarias.ativa, true), isNull(contasBancarias.excluidoEm)));
  if (!conta) throw new Desfazer(falha("Conta bancária não encontrada ou desativada", campo));
}

/** O slug do enum a partir do rótulo da forma (o schema entrega o rótulo). */
function slugDaForma(rotulo: string): FormaFinanceiroSlug {
  const par = (Object.entries(ROTULO_FORMA_FINANCEIRO) as [FormaFinanceiroSlug, string][]).find(([, r]) => r === rotulo);
  if (!par) throw new Desfazer(falha(MSG_FORMA, "forma"));
  return par[0];
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
      const linhas = await tx
        .insert(lancamentos)
        .values(
          itens.map((x) => ({
            ...base,
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
      const comuns = camposComuns(v);
      // "repeticao" não se aplica à edição. As datas só mudam na linha escolhida: cada parcela mantém as suas.
      for (const l of t.afetadas) {
        const depois: Record<string, unknown> =
          l.id === id ? { ...comuns, competencia: v.competencia, emissao: v.emissao, vencimento: v.vencimento } : { ...comuns };
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

export async function baixarLancamento(id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = baixaLancamentoSchema(hojeEmCuiaba()).safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    if (!ehUuid(id)) return LANCAMENTO_NAO_ENCONTRADO;
    const r = await transacao("Falha ao baixar o lançamento", async (tx) => {
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
      };
      await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, id));
      // A observação da baixa não tem coluna: fica na auditoria.
      const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, l[k as keyof LancamentoLinha]]));
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "lancamentos", registroId: id, acao: "alterar", antes, depois: { ...depois, observacao: v.observacao } });
      return { ok: true, id };
    });
    if (r.ok) revalidar();
    return r;
  });
}

export async function desfazerBaixaLancamento(id: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (!ehUuid(id)) return LANCAMENTO_NAO_ENCONTRADO;
    const r = await transacao("Falha ao desfazer a baixa", async (tx) => {
      const [l] = await tx.select().from(lancamentos).where(eq(lancamentos.id, id)).for("update");
      if (!l) return LANCAMENTO_NAO_ENCONTRADO;
      if (l.status !== "baixado") return falha("Este lançamento não foi baixado");
      const depois = { status: "em_aberto" as const, baixadoEm: null, valorPago: null, juros: null, desconto: null, baixaContaBancariaId: null };
      await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, id));
      await auditarAlteracao(tx, u.id, "lancamentos", l, depois);
      return { ok: true, id };
    });
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
      const depois = { status: "cancelado" as const, motivoCancelamento: m.data };
      for (const l of t.afetadas) {
        await tx.update(lancamentos).set(depois).where(eq(lancamentos.id, l.id));
        await auditarAlteracao(tx, u.id, "lancamentos", l, depois);
      }
      return { ok: true, ids: t.afetadas.map((l) => l.id) };
    });
    if (r.ok) revalidar();
    return r;
  });
}
