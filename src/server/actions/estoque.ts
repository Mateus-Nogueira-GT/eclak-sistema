"use server";

import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { hojeEmCuiaba } from "@/domain/clientes";
import type { Centro } from "@/domain/financeiro";
import { aposEntrada, aposSaida, CATEGORIA_DO_USO, desfazerEntrada } from "@/domain/estoque";
import { ajusteSchema, entradaSchema, produtoSchema, saidaSchema } from "@/domain/estoque-entrada";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { MSG_DESFACA_FATURA_CARTAO } from "@/domain/venda-entrada";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { categoriasFinanceiras, estoqueMovimentos, estoqueSaldos, fornecedores, lancamentos, produtosEstoque } from "@/server/db/schema";
import { auditarAlteracao, gravarMovimento, gravarSaldo, saldoDe, travarSaldo, type SaldoLinha } from "@/server/estoque/movimentos";
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

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Transação com `Desfazer`; `unico` traduz a violação de unicidade (23505), se houver; outro erro loga só o código. */
async function transacao(mensagemErro: string, fn: (tx: Transacao) => Promise<Ok | Falha>, unico?: Falha): Promise<Ok | Falha> {
  try {
    const r = await db.transaction(fn);
    if (r.ok) revalidatePath("/financeiro", "layout");
    return r;
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    const e = x as { code?: string; cause?: { code?: string } } | null;
    const codigo = e?.cause?.code ?? e?.code;
    if (unico && codigo === "23505") return unico;
    console.error(mensagemErro, { code: codigo });
    throw new Error(mensagemErro);
  }
}

/** Produto ativo, travado `for share` (desativar, que trava `for update`, espera as movimentações em curso). */
async function produtoAtivo(tx: Transacao, id: string): Promise<Produto> {
  const [p] = await tx.select().from(produtosEstoque).where(eq(produtosEstoque.id, id)).for("share");
  if (!p) throw new Desfazer(PRODUTO_NAO_ENCONTRADO);
  if (!p.ativo) throw new Desfazer(falha("Produto desativado"));
  return p;
}

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
      }, PRODUTO_REPETIDO);
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
    }, PRODUTO_REPETIDO);
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
        // Compra no cartão já paga pela fatura: volta só desfazendo a baixa da fatura. Lida com trava: uma baixa em
        // curso termina antes da conferência.
        const [conta] = await tx
          .select({ status: lancamentos.status, faturaCartaoId: lancamentos.faturaCartaoId })
          .from(lancamentos)
          .where(eq(lancamentos.id, mov.lancamentoId))
          .for("update");
        if (conta?.status === "baixado" && conta.faturaCartaoId) throw new Desfazer(falha(MSG_DESFACA_FATURA_CARTAO));
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

/**
 * Contagem: a quantidade nova da filial; o movimento guarda a diferença ao custo médio; não gera lançamento. Ajuste
 * positivo numa filial com saldo 0 entra ao custo médio da outra filial (se > 0; senão a 0): passar itens de uma
 * filial para a outra por dois ajustes não zera o custo. A outra filial só é lida (sem trava: dois ajustes cruzados
 * não se esperam).
 */
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
      let custo = s.custoMedio;
      if (s.quantidade === 0 && diferenca > 0) {
        const outra: Centro = v.filial === "MT" ? "RS" : "MT";
        const [o] = await tx
          .select({ custoMedio: estoqueSaldos.custoMedio })
          .from(estoqueSaldos)
          .where(and(eq(estoqueSaldos.produtoId, v.produtoId), eq(estoqueSaldos.filial, outra)));
        custo = o && o.custoMedio > 0n ? o.custoMedio : 0n;
      }
      const mov = await gravarMovimento(tx, u.id, s, { tipo: "ajuste", quantidade: diferenca, custoUnitario: custo, motivo: v.motivo });
      await gravarSaldo(tx, u.id, s, { quantidade: v.quantidadeNova, custoMedio: v.quantidadeNova === 0 ? 0n : custo });
      return { ok: true, id: mov.id };
    });
  });
}
