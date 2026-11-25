"use server";

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { hojeEmCuiaba } from "@/domain/clientes";
import type { Centro } from "@/domain/financeiro";
import { aposEntrada, aposSaida, CATEGORIA_DO_USO, desfazerEntrada, type Saldo, type TipoMovimento } from "@/domain/estoque";
import { ajusteSchema, entradaSchema, produtoSchema, saidaSchema } from "@/domain/estoque-entrada";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { categoriasFinanceiras, estoqueMovimentos, estoqueSaldos, fornecedores, lancamentos, produtosEstoque } from "@/server/db/schema";
import { cancelarLancamentoNa, criarLancamentosNa, Desfazer, falha, type Falha, type Ok } from "@/server/financeiro/lancamentos";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Estoque por filial (fatia 5b, spec §4 e §14): produtos, entradas (com a conta a pagar pelo núcleo de lançamentos),
// desfazer entrada, saídas e ajustes. Só Diretor e financeiros. Travas na ordem produto (`for share` nas
// movimentações, `for update` no cadastro) → saldo (`for update`). Movimento nunca é alterado nem apagado; toda
// escrita audita na mesma transação.

const FINANCEIRO = [...PERFIS_FINANCEIRO];
const PRODUTO_NAO_ENCONTRADO = falha("Produto não encontrado");
const PRODUTO_REPETIDO = falha("Já existe um produto ativo com este nome", "nome");
const MSG_FACA_AJUSTE = "Faça um ajuste de estoque.";

type Produto = typeof produtosEstoque.$inferSelect;
type SaldoLinha = typeof estoqueSaldos.$inferSelect;
type Movimento = typeof estoqueMovimentos.$inferSelect;

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Transação com `Desfazer`; nome repetido entre os ativos (23505) vira a falha do campo; outro erro loga só o código. */
async function transacao(mensagemErro: string, fn: (tx: Transacao) => Promise<Ok | Falha>): Promise<Ok | Falha> {
  try {
    const r = await db.transaction(fn);
    if (r.ok) revalidatePath("/financeiro", "layout");
    return r;
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    const e = x as { code?: string; cause?: { code?: string } } | null;
    const codigo = e?.cause?.code ?? e?.code;
    if (codigo === "23505") return PRODUTO_REPETIDO;
    console.error(mensagemErro, { code: codigo });
    throw new Error(mensagemErro);
  }
}

/** Auditoria de alteração: `antes` só com as chaves alteradas. */
async function auditarAlteracao<T>(tx: Transacao, usuarioId: string, tabela: string, registroId: string, linha: T, depois: Partial<T>, acao: "alterar" | "desativar" = "alterar") {
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, linha[k as keyof T]]));
  await registrarAuditoria(tx, { usuarioId, tabela, registroId, acao, antes, depois });
}

const idDoSaldo = (produtoId: string, filial: Centro) => `${produtoId}:${filial}`;

/** Produto ativo, travado `for share` (desativar, que trava `for update`, espera as movimentações em curso). */
async function produtoAtivo(tx: Transacao, id: string): Promise<Produto> {
  const [p] = await tx.select().from(produtosEstoque).where(eq(produtosEstoque.id, id)).for("share");
  if (!p) throw new Desfazer(PRODUTO_NAO_ENCONTRADO);
  if (!p.ativo) throw new Desfazer(falha("Produto desativado"));
  return p;
}

/**
 * O saldo do par produto/filial travado (`for update`); a linha nasce zerada se não existe (`on conflict do nothing` e
 * releitura: duas primeiras movimentações ao mesmo tempo não criam duas linhas) e o nascimento é auditado.
 */
async function travarSaldo(tx: Transacao, usuarioId: string, produtoId: string, filial: Centro): Promise<SaldoLinha> {
  const [nova] = await tx.insert(estoqueSaldos).values({ produtoId, filial }).onConflictDoNothing().returning();
  if (nova) await registrarAuditoria(tx, { usuarioId, tabela: "estoque_saldos", registroId: idDoSaldo(produtoId, filial), acao: "criar", depois: nova });
  const [s] = await tx
    .select()
    .from(estoqueSaldos)
    .where(and(eq(estoqueSaldos.produtoId, produtoId), eq(estoqueSaldos.filial, filial)))
    .for("update");
  return s;
}

async function gravarSaldo(tx: Transacao, usuarioId: string, s: SaldoLinha, novo: Saldo): Promise<void> {
  const depois = { quantidade: novo.quantidade, custoMedio: novo.custoMedio };
  await tx.update(estoqueSaldos).set(depois).where(and(eq(estoqueSaldos.produtoId, s.produtoId), eq(estoqueSaldos.filial, s.filial)));
  await auditarAlteracao(tx, usuarioId, "estoque_saldos", idDoSaldo(s.produtoId, s.filial), s, depois);
}

/**
 * Grava o movimento (só inserção) com `custo_medio_antes` = o custo médio do saldo travado. `criado_em` vem de
 * `clock_timestamp()`, lido já com a trava do saldo: a ordem dos movimentos do par é a ordem das travas (o `now()`
 * padrão é o início da transação e poderia inverter duas transações concorrentes).
 */
async function gravarMovimento(
  tx: Transacao,
  usuarioId: string,
  s: SaldoLinha,
  m: { tipo: TipoMovimento; quantidade: number; custoUnitario: bigint; motivo?: string | null; fornecedorId?: string | null; fornecedorTexto?: string | null; lancamentoId?: string | null },
): Promise<Movimento> {
  const [mov] = await tx
    .insert(estoqueMovimentos)
    .values({
      produtoId: s.produtoId,
      filial: s.filial,
      tipo: m.tipo,
      quantidade: m.quantidade,
      custoUnitario: m.custoUnitario,
      custoMedioAntes: s.custoMedio,
      fornecedorId: m.fornecedorId ?? null,
      fornecedorTexto: m.fornecedorTexto ?? null,
      lancamentoId: m.lancamentoId ?? null,
      motivo: m.motivo ?? null,
      usuarioId,
      criadoEm: sql`clock_timestamp()`,
    })
    .returning();
  await registrarAuditoria(tx, { usuarioId, tabela: "estoque_movimentos", registroId: mov.id, acao: "criar", depois: mov });
  return mov;
}

const saldoDe = (s: SaldoLinha): Saldo => ({ quantidade: s.quantidade, custoMedio: s.custoMedio });
const semSaldo = (s: SaldoLinha): Falha => falha(`Só há ${s.quantidade} na filial`, "quantidade");

// ---------------------------------------------------------------------------
// Produtos
// ---------------------------------------------------------------------------

export async function salvarProduto(dados: unknown, id?: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = produtoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    if (id === undefined) {
      return transacao("Falha ao criar o produto", async (tx) => {
        const [novo] = await tx.insert(produtosEstoque).values(v).returning();
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "produtos_estoque", registroId: novo.id, acao: "criar", depois: novo });
        return { ok: true, id: novo.id };
      });
    }
    if (!ehUuid(id)) return PRODUTO_NAO_ENCONTRADO;
    return transacao("Falha ao editar o produto", async (tx) => {
      const [atual] = await tx.select().from(produtosEstoque).where(eq(produtosEstoque.id, id)).for("update");
      if (!atual) return PRODUTO_NAO_ENCONTRADO;
      if (!atual.ativo) return falha("Produto desativado não pode ser editado");
      const depois = Object.fromEntries(Object.entries(v).filter(([k, x]) => atual[k as keyof typeof v] !== x)) as Partial<Produto>;
      if (Object.keys(depois).length === 0) return { ok: true, id };
      await tx.update(produtosEstoque).set(depois).where(eq(produtosEstoque.id, id));
      await auditarAlteracao(tx, u.id, "produtos_estoque", id, atual, depois);
      return { ok: true, id };
    });
  });
}

/** Só com saldo 0 nas duas filiais; o produto some das escolhas e mantém o histórico. */
export async function desativarProduto(id: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (!ehUuid(id)) return PRODUTO_NAO_ENCONTRADO;
    return transacao("Falha ao desativar o produto", async (tx) => {
      const [atual] = await tx.select().from(produtosEstoque).where(eq(produtosEstoque.id, id)).for("update");
      if (!atual) return PRODUTO_NAO_ENCONTRADO;
      if (!atual.ativo) return falha("Produto já desativado");
      const saldos = await tx.select().from(estoqueSaldos).where(eq(estoqueSaldos.produtoId, id)).orderBy(asc(estoqueSaldos.filial)).for("update");
      if (saldos.some((s) => s.quantidade > 0)) return falha("Zere o saldo nas duas filiais antes de desativar");
      await tx.update(produtosEstoque).set({ ativo: false }).where(eq(produtosEstoque.id, id));
      await auditarAlteracao(tx, u.id, "produtos_estoque", id, atual, { ativo: false }, "desativar");
      return { ok: true, id };
    });
  });
}

// ---------------------------------------------------------------------------
// Movimentos
// ---------------------------------------------------------------------------

/** Compra: movimento, saldo pelo custo médio e, com valor > 0, uma conta a pagar ligada ao movimento. */
export async function registrarEntrada(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = entradaSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    return transacao("Falha ao registrar a entrada", async (tx) => {
      const produto = await produtoAtivo(tx, v.produtoId);
      if (v.fornecedorId) {
        const [f] = await tx.select({ id: fornecedores.id }).from(fornecedores).where(and(eq(fornecedores.id, v.fornecedorId), isNull(fornecedores.excluidoEm)));
        if (!f) return falha("Fornecedor não encontrado", "fornecedorId");
      }
      const s = await travarSaldo(tx, u.id, v.produtoId, v.filial);
      const valor = BigInt(v.quantidade) * v.valorUnitario;
      let conta: string | null = null;
      if (valor > 0n) {
        const sistema = CATEGORIA_DO_USO[produto.uso];
        const [cat] = await tx.select({ id: categoriasFinanceiras.id }).from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, sistema));
        if (!cat) throw new Error(`Categoria de sistema ausente: ${sistema}`);
        const hoje = hojeEmCuiaba();
        const [l] = await criarLancamentosNa(tx, u.id, {
          lado: "pagar",
          descricao: `Estoque: ${v.quantidade} × ${produto.nome}`,
          fornecedorId: v.fornecedorId,
          clienteId: null,
          pessoaTexto: v.fornecedorTexto,
          categoriaId: cat.id,
          centro: v.filial,
          competencia: hoje.slice(0, 7),
          emissao: hoje,
          vencimento: v.vencimento,
          valor,
          forma: v.forma,
          contaBancariaId: null,
          observacao: null,
          repeticao: { tipo: "unica" },
          cartaoId: v.cartaoId,
        });
        conta = l.id;
      }
      const mov = await gravarMovimento(tx, u.id, s, {
        tipo: "entrada",
        quantidade: v.quantidade,
        custoUnitario: v.valorUnitario,
        fornecedorId: v.fornecedorId,
        fornecedorTexto: v.fornecedorTexto,
        lancamentoId: conta,
      });
      if (conta) {
        await tx.update(lancamentos).set({ estoqueMovimentoId: mov.id }).where(eq(lancamentos.id, conta));
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "lancamentos", registroId: conta, acao: "alterar", antes: { estoqueMovimentoId: null }, depois: { estoqueMovimentoId: mov.id } });
      }
      await gravarSaldo(tx, u.id, s, aposEntrada(saldoDe(s), v.quantidade, v.valorUnitario));
      return { ok: true, id: mov.id };
    });
  });
}

/**
 * Desfaz a entrada que é o último movimento do par produto/filial (decidido com o saldo travado): cancela a conta
 * (compra no cartão sai da fatura; recusada com a conta baixada ou a fatura paga), grava um ajuste negativo ao custo
 * da entrada e volta o saldo ao `custo_medio_antes` dela.
 */
export async function desfazerEntradaDeEstoque(movimentoId: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const nao = falha("Movimento não encontrado");
    if (!ehUuid(movimentoId)) return nao;
    return transacao("Falha ao desfazer a entrada", async (tx) => {
      const [mov] = await tx.select().from(estoqueMovimentos).where(eq(estoqueMovimentos.id, movimentoId));
      if (!mov) return nao;
      if (mov.tipo !== "entrada") return falha("Só uma entrada pode ser desfeita");
      await tx.select({ id: produtosEstoque.id }).from(produtosEstoque).where(eq(produtosEstoque.id, mov.produtoId)).for("share");
      const s = await travarSaldo(tx, u.id, mov.produtoId, mov.filial);
      const [ultimo] = await tx
        .select({ id: estoqueMovimentos.id })
        .from(estoqueMovimentos)
        .where(and(eq(estoqueMovimentos.produtoId, mov.produtoId), eq(estoqueMovimentos.filial, mov.filial)))
        .orderBy(desc(estoqueMovimentos.criadoEm), desc(estoqueMovimentos.id))
        .limit(1);
      if (ultimo.id !== mov.id) throw new Desfazer(falha(MSG_FACA_AJUSTE));
      const novo = desfazerEntrada(saldoDe(s), mov.quantidade, mov.custoMedioAntes);
      if (!novo) throw new Desfazer(falha(MSG_FACA_AJUSTE));
      // A conta primeiro: a recusa do núcleo volta antes de qualquer escrita.
      if (mov.lancamentoId) {
        const r = await cancelarLancamentoNa(tx, u.id, mov.lancamentoId, "Entrada de estoque desfeita");
        if (!r.ok) throw new Desfazer(r);
      }
      await gravarMovimento(tx, u.id, s, { tipo: "ajuste", quantidade: -mov.quantidade, custoUnitario: mov.custoUnitario, motivo: "Entrada desfeita" });
      await gravarSaldo(tx, u.id, s, novo);
      return { ok: true, id: mov.id };
    });
  });
}

/** Saída manual (uso interno, brinde avulso, perda) ao custo médio; não gera lançamento. */
export async function registrarSaida(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = saidaSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    return transacao("Falha ao registrar a saída", async (tx) => {
      await produtoAtivo(tx, v.produtoId);
      const s = await travarSaldo(tx, u.id, v.produtoId, v.filial);
      const novo = aposSaida(saldoDe(s), v.quantidade);
      if (!novo) throw new Desfazer(semSaldo(s));
      const mov = await gravarMovimento(tx, u.id, s, { tipo: "saida", quantidade: -v.quantidade, custoUnitario: s.custoMedio, motivo: v.motivo });
      await gravarSaldo(tx, u.id, s, novo);
      return { ok: true, id: mov.id };
    });
  });
}

/** Contagem: a quantidade nova da filial; o movimento guarda a diferença ao custo médio; não gera lançamento. */
export async function ajustarEstoque(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = ajusteSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    return transacao("Falha ao ajustar o estoque", async (tx) => {
      await produtoAtivo(tx, v.produtoId);
      const s = await travarSaldo(tx, u.id, v.produtoId, v.filial);
      const diferenca = v.quantidadeNova - s.quantidade;
      if (diferenca === 0) throw new Desfazer(falha("A quantidade da filial já é essa", "quantidadeNova"));
      const mov = await gravarMovimento(tx, u.id, s, { tipo: "ajuste", quantidade: diferenca, custoUnitario: s.custoMedio, motivo: v.motivo });
      await gravarSaldo(tx, u.id, s, { quantidade: v.quantidadeNova, custoMedio: v.quantidadeNova === 0 ? 0n : s.custoMedio });
      return { ok: true, id: mov.id };
    });
  });
}
