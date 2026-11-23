import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { cicloDoCartao } from "@/domain/caixa";
import { MSG_DESFACA_FATURA_CARTAO, MSG_FATURA_CARTAO_PAGA } from "@/domain/venda-entrada";
import { registrarAuditoria } from "@/server/auditoria";
import type { Transacao } from "@/server/db/client";
import { cartoesCorporativos, faturasCartao } from "@/server/db/schema";
import { falha, type Falha } from "@/server/financeiro/baixas-viagem";

// Fora dos arquivos "use server" de propósito: nada aqui pode virar endpoint. Núcleo das compras no cartão
// corporativo (lançamento manual a pagar no cartão de crédito e pagamento de viagem na forma "cartão corporativo"):
// achar/criar a fatura do ciclo e conferir se ela ainda aceita mudança. Sempre na transação da compra.
//
// Ordem das travas (a mesma em todo caminho, para não haver impasse):
//   1. a viagem (`travarViagem`; várias: ordem crescente de id), quando a compra é pagamento de viagem;
//   2. as compras (lançamentos ou pagamentos, `for update`);
//   3. os cartões das compras que entram (`for share`, ordem de id);
//   4. TODAS as faturas que a transação mexe (de saída e de entrada), numa passada só (`travarFaturasNa`), em ordem
//      `(cartao_id, fechamento)`, criando as que faltam nessa mesma passada;
//   5. só então as escritas nas compras.
// Nenhuma fatura é travada fora de `travarFaturasNa`. A baixa da fatura (Task 7) segue a mesma ordem: descobrir as
// compras e viagens da fatura sem trava, travar as viagens (crescente), as compras, e só então a(s) fatura(s), também
// em ordem `(cartao_id, fechamento)`; conferir de novo depois das travas.

export type Ciclo = { fechamento: string; vencimento: string };
export type FaturaCartaoLinha = typeof faturasCartao.$inferSelect;
export type Vinculo = { cartaoId: string; faturaCartaoId: string };
export type SemCartao = { cartaoId: null; faturaCartaoId: null };

const CARTAO_INVALIDO = falha("Cartão não encontrado ou desativado", "cartaoId");
const FATURA_PAGA = falha(MSG_FATURA_CARTAO_PAGA);
const DESFACA_FATURA = falha(MSG_DESFACA_FATURA_CARTAO);

/**
 * A fatura do cartão no ciclo, `for update`; só chamada por `travarFaturasNa` (a ordem das travas é dela); criada se ainda não existe (`on conflict do nothing` e releitura: duas
 * compras ao mesmo tempo no mesmo ciclo dão uma fatura só). `criada` diz se esta transação a criou.
 */
export async function faturaDoCicloNa(tx: Transacao, cartaoId: string, ciclo: Ciclo): Promise<{ fatura: FaturaCartaoLinha; criada: boolean }> {
  const ler = async () =>
    (
      await tx
        .select()
        .from(faturasCartao)
        .where(and(eq(faturasCartao.cartaoId, cartaoId), eq(faturasCartao.fechamento, ciclo.fechamento)))
        .for("update")
    )[0];
  const existente = await ler();
  if (existente) return { fatura: existente, criada: false };
  const [nova] = await tx
    .insert(faturasCartao)
    .values({ cartaoId, fechamento: ciclo.fechamento, vencimento: ciclo.vencimento })
    .onConflictDoNothing({ target: [faturasCartao.cartaoId, faturasCartao.fechamento] })
    .returning();
  if (nova) return { fatura: nova, criada: true };
  const outra = await ler();
  if (!outra) throw new Error("Fatura do cartão não encontrada depois do conflito");
  return { fatura: outra, criada: false };
}

/** Compra que entra numa fatura: o cartão, a data da compra e se o cartão precisa estar ativo (compra nova ou troca). */
export type EntradaFatura = { cartaoId: string; dataCompra: string; exigeAtivo: boolean };

const chave = (cartaoId: string, fechamento: string) => `${cartaoId}|${fechamento}`;

/**
 * Trava, numa passada só e em ordem única `(cartao_id, fechamento)`, todas as faturas que a transação vai mexer: as
 * de onde compras saem (`sair`, ids) e as do ciclo das compras que entram (`entrar`; criadas se faltam, sem corrida, e
 * auditadas). Antes, trava os cartões de `entrar` (`for share`, por id) e recusa cartão inexistente ou, com
 * `exigeAtivo`, desativado (campo `cartaoId`). Depois das travas recusa sair de fatura paga ("Desfaça a baixa da
 * fatura do cartão antes") e entrar em fatura paga ("A fatura do cartão deste período já foi paga"). Devolve o vínculo
 * de cada entrada, na ordem de `entrar`. Não grava nas compras: o chamador grava (só depois desta chamada) e audita.
 * Em recusa, o chamador desfaz a transação (a fatura criada aqui não pode ficar).
 */
export async function travarFaturasNa(tx: Transacao, usuarioId: string, sair: (string | null)[], entrar: EntradaFatura[]): Promise<Vinculo[] | Falha> {
  const idsCartao = [...new Set(entrar.map((e) => e.cartaoId))].sort();
  const cartoes =
    idsCartao.length === 0
      ? []
      : await tx.select().from(cartoesCorporativos).where(inArray(cartoesCorporativos.id, idsCartao)).orderBy(asc(cartoesCorporativos.id)).for("share");
  const cartao = new Map(cartoes.map((k) => [k.id, k]));
  for (const e of entrar) {
    const k = cartao.get(e.cartaoId);
    if (!k || (e.exigeAtivo && !k.ativo)) return CARTAO_INVALIDO;
  }
  const ciclos = entrar.map((e) => {
    const k = cartao.get(e.cartaoId)!;
    return { cartaoId: k.id, ...cicloDoCartao(e.dataCompra, k.diaFechamento, k.diaVencimento) };
  });
  // Cartão e fechamento das faturas de saída (fixos desde a criação: lidos sem trava, travados abaixo na ordem).
  const idsSair = [...new Set(sair.filter((x): x is string => x !== null))];
  const antigas =
    idsSair.length === 0
      ? []
      : await tx
          .select({ cartaoId: faturasCartao.cartaoId, fechamento: faturasCartao.fechamento, vencimento: faturasCartao.vencimento })
          .from(faturasCartao)
          .where(inArray(faturasCartao.id, idsSair));
  const alvos = new Map<string, { cartaoId: string; fechamento: string; vencimento: string }>();
  for (const a of [...antigas, ...ciclos]) if (!alvos.has(chave(a.cartaoId, a.fechamento))) alvos.set(chave(a.cartaoId, a.fechamento), a);
  const ordem = [...alvos.values()].sort((a, b) => (a.cartaoId !== b.cartaoId ? (a.cartaoId < b.cartaoId ? -1 : 1) : a.fechamento < b.fechamento ? -1 : a.fechamento > b.fechamento ? 1 : 0));
  const travadas = new Map<string, FaturaCartaoLinha>();
  for (const a of ordem) {
    const { fatura, criada } = await faturaDoCicloNa(tx, a.cartaoId, a);
    if (criada) await registrarAuditoria(tx, { usuarioId, tabela: "faturas_cartao", registroId: fatura.id, acao: "criar", depois: fatura });
    travadas.set(chave(a.cartaoId, a.fechamento), fatura);
  }
  if (antigas.some((a) => travadas.get(chave(a.cartaoId, a.fechamento))!.status === "baixado")) return DESFACA_FATURA;
  const vinculos = ciclos.map((c) => travadas.get(chave(c.cartaoId, c.fechamento))!);
  if (vinculos.some((f) => f.status === "baixado")) return FATURA_PAGA;
  return vinculos.map((f) => ({ cartaoId: f.cartaoId, faturaCartaoId: f.id }));
}
