import "server-only";
import { and, asc, eq, gte, inArray, isNull, lte, ne } from "drizzle-orm";
import { hojeEmCuiaba } from "@/domain/clientes";
import type { SituacaoCaixa } from "@/domain/estoque";
import { CENTROS, centroDaFilial, type Centro } from "@/domain/financeiro";
import { PERFIS_FINANCEIRO, PERFIS_VALORES, veCamadaEstrategica } from "@/domain/perfis";
import { formatarCodigoViagem } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { caixaItens, caixasExperiencia, clientes, estoqueSaldos, produtosEstoque, usuarios, viagens } from "@/server/db/schema";

// Leituras da caixa de experiência (fatia 5b, spec §5.3 e §14). A caixa da viagem e os produtos para montá-la: os
// cinco perfis, com os valores (custo de cada item, total, custo médio) só para quem vê a camada estratégica — para
// os demais os campos não existem no objeto. As caixas das próximas viagens: Diretor e financeiros. Centavos.

export type ItemDaCaixa = { produtoId: string; nome: string; quantidade: number; disponivel: number; custoUnitario?: bigint };
export type CaixaDaViagem = {
  situacao: SituacaoCaixa;
  filial: Centro;
  itens: ItemDaCaixa[];
  /** Confirmada: o custo gravado; rascunho: o estimado pelo custo médio atual. Só com a camada estratégica. */
  total?: bigint;
  confirmadaEm?: Date;
  /** Nome de quem confirmou. */
  confirmadaPor?: string;
};
export type ProdutoParaCaixa = { id: string; nome: string; disponivel: number; custoMedio?: bigint };
export type CaixaProxima = { viagemId: string; codigo: string; cliente: string; embarque: string; filial: Centro; situacao: "sem_caixa" | SituacaoCaixa };

const TODOS = [...PERFIS_VALORES];
const DIAS_PROXIMAS = 60;

function somarDias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Saldos da filial pelos produtos (sem linha = 0). */
async function saldosDaFilial(filial: Centro, produtoIds: string[]) {
  if (produtoIds.length === 0) return new Map<string, { quantidade: number; custoMedio: bigint }>();
  const ss = await db
    .select({ produtoId: estoqueSaldos.produtoId, quantidade: estoqueSaldos.quantidade, custoMedio: estoqueSaldos.custoMedio })
    .from(estoqueSaldos)
    .where(and(eq(estoqueSaldos.filial, filial), inArray(estoqueSaldos.produtoId, produtoIds)));
  return new Map(ss.map((s) => [s.produtoId, s]));
}

/** A caixa não cancelada da viagem (`null` sem caixa), com o disponível de cada item na filial dela. */
export async function caixaDaViagem(viagemId: string): Promise<CaixaDaViagem | null> {
  const u = await exigirPerfil(...TODOS);
  if (!ehUuid(viagemId)) return null;
  const valores = veCamadaEstrategica(u.perfil);
  const [c] = await db
    .select({ caixa: caixasExperiencia, confirmadaPor: usuarios.nome })
    .from(caixasExperiencia)
    .leftJoin(usuarios, eq(usuarios.id, caixasExperiencia.confirmadaPor))
    .where(and(eq(caixasExperiencia.viagemId, viagemId), ne(caixasExperiencia.situacao, "cancelada")));
  if (!c) return null;
  const caixa = c.caixa;
  const linhas = await db
    .select({ produtoId: caixaItens.produtoId, nome: produtosEstoque.nome, quantidade: caixaItens.quantidade, custoUnitario: caixaItens.custoUnitario })
    .from(caixaItens)
    .innerJoin(produtosEstoque, eq(produtosEstoque.id, caixaItens.produtoId))
    .where(eq(caixaItens.caixaId, caixa.id))
    .orderBy(asc(produtosEstoque.nome));
  const saldos = await saldosDaFilial(caixa.filial, linhas.map((l) => l.produtoId));
  let total = 0n;
  const itens = linhas.map((l): ItemDaCaixa => {
    const s = saldos.get(l.produtoId);
    const item: ItemDaCaixa = { produtoId: l.produtoId, nome: l.nome, quantidade: l.quantidade, disponivel: s?.quantidade ?? 0 };
    if (!valores) return item;
    const unitario = caixa.situacao === "confirmada" ? (l.custoUnitario ?? 0n) : (s?.custoMedio ?? 0n);
    total += BigInt(l.quantidade) * unitario;
    return { ...item, custoUnitario: unitario };
  });
  const resposta: CaixaDaViagem = { situacao: caixa.situacao, filial: caixa.filial, itens };
  if (valores) resposta.total = caixa.situacao === "confirmada" ? (caixa.custoTotal ?? total) : total;
  if (caixa.confirmadaEm) resposta.confirmadaEm = caixa.confirmadaEm;
  if (c.confirmadaPor) resposta.confirmadaPor = c.confirmadaPor;
  return resposta;
}

/** Produtos ativos de caixa de experiência (por nome) com o disponível na filial; custo médio só com a camada estratégica. */
export async function produtosParaCaixa(filial: Centro): Promise<ProdutoParaCaixa[]> {
  const u = await exigirPerfil(...TODOS);
  if (!CENTROS.includes(filial)) return [];
  const valores = veCamadaEstrategica(u.perfil);
  const ps = await db
    .select({ id: produtosEstoque.id, nome: produtosEstoque.nome })
    .from(produtosEstoque)
    .where(and(eq(produtosEstoque.ativo, true), eq(produtosEstoque.uso, "caixa_experiencia")))
    .orderBy(asc(produtosEstoque.nome));
  const saldos = await saldosDaFilial(filial, ps.map((p) => p.id));
  return ps.map((p) => {
    const s = saldos.get(p.id);
    const linha: ProdutoParaCaixa = { id: p.id, nome: p.nome, disponivel: s?.quantidade ?? 0 };
    return valores ? { ...linha, custoMedio: s?.custoMedio ?? 0n } : linha;
  });
}

/** Viagens vendidas, não excluídas e não conciliadas com embarque de hoje até daqui a 60 dias (as mais próximas primeiro), com a situação da caixa. */
export async function caixasProximas(): Promise<CaixaProxima[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const hoje = hojeEmCuiaba();
  const vs = await db
    .select({ id: viagens.id, seq: viagens.seq, codigoCliente: clientes.codigo, cliente: clientes.grupo, inicio: viagens.inicio, filial: viagens.filial })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(eq(viagens.status, "vendida"), isNull(viagens.excluidoEm), isNull(viagens.conciliadaEm), gte(viagens.inicio, hoje), lte(viagens.inicio, somarDias(hoje, DIAS_PROXIMAS))))
    .orderBy(asc(viagens.inicio), asc(viagens.id));
  const caixas =
    vs.length === 0
      ? []
      : await db
          .select({ viagemId: caixasExperiencia.viagemId, situacao: caixasExperiencia.situacao })
          .from(caixasExperiencia)
          .where(and(inArray(caixasExperiencia.viagemId, vs.map((v) => v.id)), ne(caixasExperiencia.situacao, "cancelada")));
  const situacao = new Map(caixas.map((c) => [c.viagemId, c.situacao]));
  return vs.map((v) => ({
    viagemId: v.id,
    codigo: formatarCodigoViagem(v.codigoCliente, v.seq),
    cliente: v.cliente,
    embarque: v.inicio,
    filial: centroDaFilial(v.filial),
    situacao: situacao.get(v.id) ?? "sem_caixa",
  }));
}
