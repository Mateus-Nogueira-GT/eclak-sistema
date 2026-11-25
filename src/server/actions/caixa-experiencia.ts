"use server";

import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { aposEntrada, aposSaida } from "@/domain/estoque";
import { caixaItensSchema } from "@/domain/estoque-entrada";
import { centroDaFilial } from "@/domain/financeiro";
import { PERFIS_VALORES } from "@/domain/perfis";
import { motivoSchema } from "@/domain/venda-entrada";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { caixaItens, caixasExperiencia, produtosEstoque } from "@/server/db/schema";
import { auditarAlteracao, gravarMovimento, gravarSaldo, saldoDe, travarSaldo } from "@/server/estoque/movimentos";
import { Desfazer, ehFalha, falha, naViagemVendidaNa, type Falha, type Ok, type ViagemLinha } from "@/server/financeiro/baixas-viagem";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Caixa de experiência da viagem vendida (fatia 5b, spec §5 e §14): montar o rascunho, confirmar (baixa do estoque da
// filial da viagem ao custo médio) e cancelar (o rascunho é apagado; a confirmada devolve ao estoque). Os cinco perfis.
// Só em viagem vendida e não conciliada. Travas na ordem viagem (lock consultivo → `for update`) → caixa (`for
// update`) → produtos (`for share`) e saldos (`for update`) em ordem crescente de `produto_id`. Toda escrita audita
// na mesma transação. Respostas só `{ ok }` ou a falha.

const TODOS = [...PERFIS_VALORES];
const VIAGEM_NAO_ENCONTRADA = falha("Viagem não encontrada");
const SEM_CAIXA = falha("Viagem sem caixa de experiência");
const JA_CONFIRMADA = falha("A caixa já foi confirmada");
const CONFIRMADA_NAO_EDITA = falha("Caixa confirmada: cancele e monte outra");
const SEM_ITENS = falha("Caixa sem itens não pode ser confirmada");
const PRODUTO_INVALIDO = falha("Escolha produtos ativos de caixa de experiência", "itens");

type Caixa = typeof caixasExperiencia.$inferSelect;
type Item = typeof caixaItens.$inferSelect;

function revalidar(viagemId: string) {
  revalidatePath(`/viagens/${viagemId}`);
  revalidatePath("/financeiro", "layout");
  revalidatePath("/visao-geral");
}

/**
 * Trava a viagem (vendida e não conciliada) e roda `fn` numa transação nova. `Desfazer` vira a falha e desfaz tudo;
 * outro erro loga só o código e relança genérico. No sucesso revalida as telas da viagem.
 */
async function naViagem(viagemId: string, mensagemErro: string, fn: (tx: Transacao, v: ViagemLinha) => Promise<Ok | Falha>): Promise<Ok | Falha> {
  if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
  let r;
  try {
    r = await db.transaction((tx) => naViagemVendidaNa(tx, async () => viagemId, VIAGEM_NAO_ENCONTRADA, fn));
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    const e = x as { code?: string; cause?: { code?: string } } | null;
    console.error(mensagemErro, { code: e?.cause?.code ?? e?.code });
    throw new Error(mensagemErro);
  }
  if (ehFalha(r)) return r;
  revalidar(r.viagemId);
  return { ok: true };
}

/** A caixa não cancelada da viagem, travada (`for update`). */
async function caixaTravada(tx: Transacao, viagemId: string): Promise<Caixa | undefined> {
  const [c] = await tx
    .select()
    .from(caixasExperiencia)
    .where(and(eq(caixasExperiencia.viagemId, viagemId), ne(caixasExperiencia.situacao, "cancelada")))
    .for("update");
  return c;
}

const itensDa = (tx: Transacao, caixaId: string): Promise<Item[]> =>
  tx.select().from(caixaItens).where(eq(caixaItens.caixaId, caixaId)).orderBy(asc(caixaItens.produtoId));

/** Os produtos dos itens, em ordem de `produto_id`, travados `for share` (desativar espera a confirmação). */
async function produtosTravados(tx: Transacao, ids: string[]) {
  if (ids.length === 0) return new Map<string, typeof produtosEstoque.$inferSelect>();
  const ps = await tx.select().from(produtosEstoque).where(inArray(produtosEstoque.id, ids)).orderBy(asc(produtosEstoque.id)).for("share");
  return new Map(ps.map((p) => [p.id, p]));
}

/** Cria o rascunho ou substitui os itens dele (lista vazia vale). Não mexe no estoque. */
export async function salvarCaixa(viagemId: string, itens: unknown): Promise<Ok | Falha> {
  return comPerfil(TODOS, async (u) => {
    const p = caixaItensSchema.safeParse(itens);
    if (!p.success) return { ok: false, erro: p.error.issues[0].message, campos: errosDeCampo(p.error) };
    const novos = p.data;
    return naViagem(viagemId, "Erro ao salvar a caixa de experiência", async (tx, v) => {
      let caixa = await caixaTravada(tx, v.id);
      if (caixa && caixa.situacao !== "rascunho") return CONFIRMADA_NAO_EDITA;
      const produtos = await produtosTravados(tx, novos.map((i) => i.produtoId));
      if (novos.some((i) => !produtos.get(i.produtoId)?.ativo || produtos.get(i.produtoId)?.uso !== "caixa_experiencia")) return PRODUTO_INVALIDO;
      if (!caixa) {
        [caixa] = await tx.insert(caixasExperiencia).values({ viagemId: v.id, filial: centroDaFilial(v.filial), criadoPor: u.id }).returning();
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "caixas_experiencia", registroId: caixa.id, acao: "criar", depois: caixa });
      } else {
        const antigos = await itensDa(tx, caixa.id);
        if (antigos.length > 0) await tx.delete(caixaItens).where(eq(caixaItens.caixaId, caixa.id));
        for (const i of antigos) await registrarAuditoria(tx, { usuarioId: u.id, tabela: "caixa_itens", registroId: i.id, acao: "excluir", antes: i });
        const depois = { atualizadoEm: new Date() };
        await tx.update(caixasExperiencia).set(depois).where(eq(caixasExperiencia.id, caixa.id));
        await auditarAlteracao(tx, u.id, "caixas_experiencia", caixa.id, caixa, depois);
      }
      if (novos.length > 0) {
        const gravados = await tx
          .insert(caixaItens)
          .values(novos.map((i) => ({ caixaId: caixa.id, produtoId: i.produtoId, quantidade: i.quantidade })))
          .returning();
        for (const i of gravados) await registrarAuditoria(tx, { usuarioId: u.id, tabela: "caixa_itens", registroId: i.id, acao: "criar", depois: i });
      }
      return { ok: true };
    });
  });
}

/**
 * Confirma o rascunho: trava os saldos da filial em ordem de `produto_id`, recusa (sem gravar nada) se algum item
 * passa do saldo e grava um movimento `caixa` por item ao custo médio do instante, o custo de cada item e o total.
 */
export async function confirmarCaixa(viagemId: string): Promise<Ok | Falha> {
  return comPerfil(TODOS, async (u) =>
    naViagem(viagemId, "Erro ao confirmar a caixa de experiência", async (tx, v) => {
      const caixa = await caixaTravada(tx, v.id);
      if (!caixa) return SEM_CAIXA;
      if (caixa.situacao === "confirmada") return JA_CONFIRMADA;
      const itens = await itensDa(tx, caixa.id);
      if (itens.length === 0) return SEM_ITENS;
      const produtos = await produtosTravados(tx, itens.map((i) => i.produtoId));
      // Trava e confere todos os saldos antes de gravar: a recusa sai por `Desfazer` (a trava pode ter criado a linha).
      const saldos = [];
      for (const i of itens) {
        const produto = produtos.get(i.produtoId)!;
        if (!produto.ativo) throw new Desfazer(falha(`Produto desativado: ${produto.nome}`));
        const s = await travarSaldo(tx, u.id, i.produtoId, caixa.filial);
        const novo = aposSaida(saldoDe(s), i.quantidade);
        if (!novo) throw new Desfazer(falha(`Estoque insuficiente de ${produto.nome} em ${caixa.filial}: há ${s.quantidade}`));
        saldos.push({ i, s, novo });
      }
      let total = 0n;
      for (const { i, s, novo } of saldos) {
        await gravarMovimento(tx, u.id, s, { tipo: "caixa", quantidade: -i.quantidade, custoUnitario: s.custoMedio, caixaId: caixa.id });
        await gravarSaldo(tx, u.id, s, novo);
        const depoisItem = { custoUnitario: s.custoMedio };
        await tx.update(caixaItens).set(depoisItem).where(eq(caixaItens.id, i.id));
        await auditarAlteracao(tx, u.id, "caixa_itens", i.id, i, depoisItem);
        total += BigInt(i.quantidade) * s.custoMedio;
      }
      // Um só UPDATE: o CHECK da confirmação exige custo, data e quem juntos.
      const depois = { situacao: "confirmada" as const, custoTotal: total, confirmadaEm: new Date(), confirmadaPor: u.id, atualizadoEm: new Date() };
      await tx.update(caixasExperiencia).set(depois).where(eq(caixasExperiencia.id, caixa.id));
      await auditarAlteracao(tx, u.id, "caixas_experiencia", caixa.id, caixa, depois);
      return { ok: true };
    }),
  );
}

/**
 * Cancela a caixa da viagem. Rascunho: apaga os itens e a caixa (nada saiu do estoque). Confirmada (motivo
 * obrigatório): devolve cada item ao estoque da filial com um movimento `devolucao_caixa` ao custo gravado no item
 * (o custo médio é recalculado como numa entrada) e marca a caixa cancelada; a viagem pode ganhar outra caixa.
 */
export async function cancelarCaixa(viagemId: string, motivo: string): Promise<Ok | Falha> {
  return comPerfil(TODOS, async (u) =>
    naViagem(viagemId, "Erro ao cancelar a caixa de experiência", async (tx, v) => {
      const caixa = await caixaTravada(tx, v.id);
      if (!caixa) return SEM_CAIXA;
      const itens = await itensDa(tx, caixa.id);
      if (caixa.situacao === "rascunho") {
        if (itens.length > 0) await tx.delete(caixaItens).where(eq(caixaItens.caixaId, caixa.id));
        for (const i of itens) await registrarAuditoria(tx, { usuarioId: u.id, tabela: "caixa_itens", registroId: i.id, acao: "excluir", antes: i });
        await tx.delete(caixasExperiencia).where(eq(caixasExperiencia.id, caixa.id));
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "caixas_experiencia", registroId: caixa.id, acao: "excluir", antes: caixa });
        return { ok: true };
      }
      const m = motivoSchema.safeParse(motivo);
      if (!m.success) return falha(m.error.issues[0].message, "motivo");
      await produtosTravados(tx, itens.map((i) => i.produtoId));
      for (const i of itens) {
        const s = await travarSaldo(tx, u.id, i.produtoId, caixa.filial);
        const custo = i.custoUnitario ?? 0n;
        await gravarMovimento(tx, u.id, s, { tipo: "devolucao_caixa", quantidade: i.quantidade, custoUnitario: custo, caixaId: caixa.id });
        await gravarSaldo(tx, u.id, s, aposEntrada(saldoDe(s), i.quantidade, custo));
      }
      // Um só UPDATE: o CHECK do cancelamento exige data, quem e motivo juntos.
      const depois = { situacao: "cancelada" as const, canceladaEm: new Date(), canceladaPor: u.id, motivoCancelamento: m.data, atualizadoEm: new Date() };
      await tx.update(caixasExperiencia).set(depois).where(eq(caixasExperiencia.id, caixa.id));
      await auditarAlteracao(tx, u.id, "caixas_experiencia", caixa.id, caixa, depois);
      return { ok: true };
    }),
  );
}
