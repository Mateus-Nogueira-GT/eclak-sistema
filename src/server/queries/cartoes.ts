import "server-only";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Centro, StatusLancamento } from "@/domain/financeiro";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { cartoesCorporativos, contasBancarias, contasPagar, faturasCartao, fornecedores, lancamentos, pagamentosFornecedor, viagens } from "@/server/db/schema";

export type CartaoOpcao = { id: string; nome: string; final: string };

/** Cartões ativos, por nome (selects das compras). */
export async function listarCartoesAtivos(): Promise<CartaoOpcao[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  return db
    .select({ id: cartoesCorporativos.id, nome: cartoesCorporativos.nome, final: cartoesCorporativos.final })
    .from(cartoesCorporativos)
    .where(eq(cartoesCorporativos.ativo, true))
    .orderBy(asc(cartoesCorporativos.nome));
}

export type CompraFatura = {
  origem: "manual" | "pagamento";
  id: string;
  /** Data da compra (o vencimento da linha). */
  data: string;
  descricao: string;
  pessoa: string | null;
  /** Previsto em reais. */
  valor: bigint;
  viagemId: string | null;
  viagemDestino: string | null;
};
export type FaturaDoCartao = {
  id: string;
  fechamento: string;
  vencimento: string;
  status: StatusLancamento;
  pagoEm: string | null;
  valorPago: bigint | null;
  total: bigint;
  compras: CompraFatura[];
};
export type CartaoItem = {
  id: string;
  nome: string;
  final: string;
  diaFechamento: number;
  diaVencimento: number;
  contaBancariaId: string;
  contaBancaria: string;
  centro: Centro;
  ativo: boolean;
  /** Só as faturas com compras, da mais recente para a mais antiga. */
  faturas: FaturaDoCartao[];
};

/**
 * Cartões (ativos primeiro, por nome) com as faturas e as compras de cada uma: lançamentos manuais não cancelados e
 * pagamentos de viagem de contas ativas. Fatura sem compras não aparece.
 */
export async function listarCartoes(): Promise<CartaoItem[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const cartoes = await db
    .select({
      id: cartoesCorporativos.id,
      nome: cartoesCorporativos.nome,
      final: cartoesCorporativos.final,
      diaFechamento: cartoesCorporativos.diaFechamento,
      diaVencimento: cartoesCorporativos.diaVencimento,
      contaBancariaId: cartoesCorporativos.contaBancariaId,
      contaBancaria: contasBancarias.nome,
      centro: cartoesCorporativos.centro,
      ativo: cartoesCorporativos.ativo,
    })
    .from(cartoesCorporativos)
    .innerJoin(contasBancarias, eq(contasBancarias.id, cartoesCorporativos.contaBancariaId))
    .orderBy(desc(cartoesCorporativos.ativo), asc(cartoesCorporativos.nome));
  if (cartoes.length === 0) return [];
  const faturas = await db
    .select()
    .from(faturasCartao)
    .where(inArray(faturasCartao.cartaoId, cartoes.map((k) => k.id)))
    .orderBy(desc(faturasCartao.fechamento));
  const ids = faturas.map((f) => f.id);
  const [manuais, pagamentos] =
    ids.length === 0
      ? [[], []]
      : await Promise.all([
          db
            .select({
              id: lancamentos.id,
              faturaId: lancamentos.faturaCartaoId,
              data: lancamentos.vencimento,
              descricao: lancamentos.descricao,
              fornecedor: fornecedores.nome,
              pessoaTexto: lancamentos.pessoaTexto,
              valor: lancamentos.valor,
            })
            .from(lancamentos)
            .leftJoin(fornecedores, eq(fornecedores.id, lancamentos.fornecedorId))
            .where(and(inArray(lancamentos.faturaCartaoId, ids), ne(lancamentos.status, "cancelado")))
            .orderBy(asc(lancamentos.vencimento), asc(lancamentos.criadoEm)),
          db
            .select({
              id: pagamentosFornecedor.id,
              faturaId: pagamentosFornecedor.faturaCartaoId,
              data: pagamentosFornecedor.vencimento,
              descricao: contasPagar.descricao,
              fornecedor: fornecedores.nome,
              valor: pagamentosFornecedor.valorBrlPrevisto,
              viagemId: contasPagar.viagemId,
              viagemDestino: viagens.destino,
            })
            .from(pagamentosFornecedor)
            .innerJoin(contasPagar, eq(contasPagar.id, pagamentosFornecedor.contaId))
            .innerJoin(viagens, eq(viagens.id, contasPagar.viagemId))
            .leftJoin(fornecedores, eq(fornecedores.id, contasPagar.fornecedorId))
            .where(and(inArray(pagamentosFornecedor.faturaCartaoId, ids), isNull(contasPagar.excluidoEm), ne(contasPagar.status, "cancelada")))
            .orderBy(asc(pagamentosFornecedor.vencimento), asc(pagamentosFornecedor.id)),
        ]);
  const compras = new Map<string, CompraFatura[]>();
  const juntar = (faturaId: string | null, c: CompraFatura) => {
    if (!faturaId) return;
    compras.set(faturaId, [...(compras.get(faturaId) ?? []), c]);
  };
  for (const m of manuais)
    juntar(m.faturaId, { origem: "manual", id: m.id, data: m.data, descricao: m.descricao, pessoa: m.fornecedor ?? m.pessoaTexto, valor: m.valor, viagemId: null, viagemDestino: null });
  for (const p of pagamentos)
    juntar(p.faturaId, { origem: "pagamento", id: p.id, data: p.data, descricao: p.descricao, pessoa: p.fornecedor, valor: p.valor, viagemId: p.viagemId, viagemDestino: p.viagemDestino });
  return cartoes.map((k) => ({
    ...k,
    faturas: faturas
      .filter((f) => f.cartaoId === k.id && compras.has(f.id))
      .map((f) => {
        const cs = [...compras.get(f.id)!].sort((a, b) => (a.data < b.data ? -1 : a.data > b.data ? 1 : 0));
        return {
          id: f.id,
          fechamento: f.fechamento,
          vencimento: f.vencimento,
          status: f.status,
          pagoEm: f.pagoEm,
          valorPago: f.valorPago,
          total: cs.reduce((t, c) => t + c.valor, 0n),
          compras: cs,
        };
      }),
  }));
}
