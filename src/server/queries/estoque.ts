import "server-only";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { abaixoDoMinimo, type TipoMovimento, type UsoEstoque } from "@/domain/estoque";
import type { Centro } from "@/domain/financeiro";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { caixasExperiencia, estoqueMovimentos, estoqueSaldos, fornecedores, produtosEstoque, usuarios, viagens } from "@/server/db/schema";

// Leituras do estoque (fatia 5b, spec §4.3). Só Diretor e financeiros. Dinheiro em centavos.

export type SaldoDaFilial = { quantidade: number; minimo: number; abaixo: boolean };
export type ProdutoLinha = {
  id: string;
  nome: string;
  uso: UsoEstoque;
  ativo: boolean;
  mt: SaldoDaFilial;
  rs: SaldoDaFilial;
  custoMedioMt: bigint;
  custoMedioRs: bigint;
  /** Σ quantidade × custo médio nas filiais consideradas (as duas, ou só a do filtro). */
  valor: bigint;
};

export type FiltroEstoque = { uso?: UsoEstoque; filial?: Centro; soAbaixo?: boolean };

/**
 * Produtos (ativos primeiro, por nome) com o saldo das duas filiais. Os filtros valem só para as linhas: uso; filial
 * (restringe o valor da linha, o "abaixo do mínimo" e o "só abaixo" a ela). Os cartões `valorTotal` e `abaixoDoMinimo`
 * (produtos ativos com alguma filial abaixo) somam sempre as duas filiais e todos os usos, com qualquer filtro.
 * Produto desativado nunca conta como abaixo.
 */
export async function listarEstoque(f: FiltroEstoque): Promise<{ produtos: ProdutoLinha[]; valorTotal: bigint; abaixoDoMinimo: number }> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const produtos = await db.select().from(produtosEstoque).orderBy(desc(produtosEstoque.ativo), asc(produtosEstoque.nome));
  const saldos = await db.select().from(estoqueSaldos);
  const porPar = new Map(saldos.map((s) => [`${s.produtoId}:${s.filial}`, s]));
  const filiais: Centro[] = f.filial ? [f.filial] : ["MT", "RS"];

  let valorTotal = 0n;
  let abaixo = 0;
  const linhas: ProdutoLinha[] = [];
  for (const p of produtos) {
    const mt = porPar.get(`${p.id}:MT`);
    const rs = porPar.get(`${p.id}:RS`);
    const daFilial = (quantidade: number, minimo: number): SaldoDaFilial => ({ quantidade, minimo, abaixo: p.ativo && abaixoDoMinimo(quantidade, minimo) });
    const linha: ProdutoLinha = {
      id: p.id,
      nome: p.nome,
      uso: p.uso,
      ativo: p.ativo,
      mt: daFilial(mt?.quantidade ?? 0, p.minimoMt),
      rs: daFilial(rs?.quantidade ?? 0, p.minimoRs),
      custoMedioMt: mt?.custoMedio ?? 0n,
      custoMedioRs: rs?.custoMedio ?? 0n,
      valor: 0n,
    };
    const valorDe = (c: Centro) => {
      const s = c === "MT" ? mt : rs;
      return s ? BigInt(s.quantidade) * s.custoMedio : 0n;
    };
    const abaixoEm = (c: Centro) => (c === "MT" ? linha.mt : linha.rs).abaixo;
    valorTotal += valorDe("MT") + valorDe("RS");
    if (abaixoEm("MT") || abaixoEm("RS")) abaixo += 1;
    if (f.uso && p.uso !== f.uso) continue;
    linha.valor = filiais.reduce((soma, c) => soma + valorDe(c), 0n);
    if (!f.soAbaixo || filiais.some(abaixoEm)) linhas.push(linha);
  }
  return { produtos: linhas, valorTotal, abaixoDoMinimo: abaixo };
}

export type MovimentoLinha = {
  id: string;
  criadoEm: Date;
  tipo: TipoMovimento;
  filial: Centro;
  /** Com sinal: negativo é saída. */
  quantidade: number;
  custoUnitario: bigint;
  usuario: string;
  motivo: string | null;
  /** Fornecedor do cadastro ou o nome digitado (só na entrada). */
  fornecedor: string | null;
  /** A viagem da caixa de experiência (movimentos `caixa` e `devolucao_caixa`). */
  viagemId: string | null;
  viagemDestino: string | null;
  /** Entrada que é o último movimento do par produto/filial ("Desfazer entrada"). */
  desfazivel: boolean;
};

/** Até 200 movimentos do produto, mais recentes primeiro. */
export async function historicoDoProduto(produtoId: string): Promise<MovimentoLinha[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  if (!ehUuid(produtoId)) return [];
  const ordem = [desc(estoqueMovimentos.criadoEm), desc(estoqueMovimentos.id)];
  const linhas = await db
    .select({
      id: estoqueMovimentos.id,
      criadoEm: estoqueMovimentos.criadoEm,
      tipo: estoqueMovimentos.tipo,
      filial: estoqueMovimentos.filial,
      quantidade: estoqueMovimentos.quantidade,
      custoUnitario: estoqueMovimentos.custoUnitario,
      usuario: usuarios.nome,
      motivo: estoqueMovimentos.motivo,
      fornecedor: sql<string | null>`coalesce(${fornecedores.nome}, ${estoqueMovimentos.fornecedorTexto})`,
      viagemId: caixasExperiencia.viagemId,
      viagemDestino: viagens.destino,
    })
    .from(estoqueMovimentos)
    .innerJoin(usuarios, eq(usuarios.id, estoqueMovimentos.usuarioId))
    .leftJoin(fornecedores, eq(fornecedores.id, estoqueMovimentos.fornecedorId))
    .leftJoin(caixasExperiencia, eq(caixasExperiencia.id, estoqueMovimentos.caixaId))
    .leftJoin(viagens, eq(viagens.id, caixasExperiencia.viagemId))
    .where(eq(estoqueMovimentos.produtoId, produtoId))
    .orderBy(...ordem)
    .limit(200);
  // O último de cada filial (pela mesma ordem com que a action decide).
  const ultimos = await Promise.all(
    (["MT", "RS"] as const).map(async (filial) => {
      const [u] = await db
        .select({ id: estoqueMovimentos.id })
        .from(estoqueMovimentos)
        .where(and(eq(estoqueMovimentos.produtoId, produtoId), eq(estoqueMovimentos.filial, filial)))
        .orderBy(...ordem)
        .limit(1);
      return u?.id;
    }),
  );
  return linhas.map((l) => ({ ...l, desfazivel: l.tipo === "entrada" && ultimos.includes(l.id) }));
}
