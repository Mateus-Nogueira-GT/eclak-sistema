import "server-only";
import { and, eq, gte, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { rotuloForma } from "@/domain/aprovacoes";
import type { FormaPagamento } from "@/domain/precificacao";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, usuarios, versoesPrecificacao, viagens } from "@/server/db/schema";
import { regrasDaVersao } from "@/server/queries/regras";

/** Estado da proposta no Fechamento da venda. */
export type EstadoProposta = "aguardando" | "vendida" | "ajustes";

/** Só dados operacionais (o que o cliente viu): nada de custo, imposto ou margem. */
export type PropostaLista = {
  /** Id da viagem. */
  id: string;
  codigo: string;
  estado: EstadoProposta;
  numeroVersao: number;
  cliente: string;
  /** Destino, período e passageiros da versão aprovada (a proposta). */
  destino: string;
  inicio: string;
  fim: string;
  passageiros: string[];
  consultor: string;
  /** Preço ao cliente (pacote + taxa de serviço), centavos como texto. */
  precoCliente: string;
  /** "Boleto em 4x". */
  forma: string;
  aprovadoEm: Date | null;
  aprovadoPor: string | null;
  vendidaEm: Date | null;
  notaCliente: string | null;
};

const DIAS_VENDIDAS = 30;
const decisor = alias(usuarios, "decisor");

/**
 * Propostas: viagens `aprovado` (aguardando a resposta do cliente), `vendida` nos últimos 30 dias e
 * `em_edicao` com pedido de ajustes do cliente. Qualquer perfil logado. Mais recentes primeiro.
 */
export async function listarPropostas(): Promise<PropostaLista[]> {
  await exigirPerfil();
  const desde = new Date(Date.now() - DIAS_VENDIDAS * 86_400_000);
  const snap = versoesPrecificacao.snapshot;
  const linhas = await db
    .select({
      id: viagens.id,
      seq: viagens.seq,
      status: viagens.status,
      vendidaEm: viagens.vendidaEm,
      notaCliente: viagens.notaCliente,
      numeroVersao: versoesPrecificacao.numero,
      preco: versoesPrecificacao.preco,
      dias: versoesPrecificacao.dias,
      forma: versoesPrecificacao.forma,
      aprovadoEm: versoesPrecificacao.decididoEm,
      // Só os campos usados do snapshot e do resultado (nunca custo, imposto ou margem).
      destino: sql<string>`${snap}->>'destino'`,
      inicio: sql<string>`${snap}->>'inicio'`,
      fim: sql<string>`${snap}->>'fim'`,
      passageiros: sql<string[]>`(select coalesce(jsonb_agg(p.e->>'nome' order by p.n), '[]'::jsonb)
        from jsonb_array_elements(${snap}->'passageiros') with ordinality as p(e, n))`,
      precoCliente: sql<string | null>`${versoesPrecificacao.resultado}->>'precoCliente'`,
      regrasVersaoId: versoesPrecificacao.regrasVersaoId,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      consultor: usuarios.nome,
      decisor: decisor.nome,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, viagens.versaoAprovadaId))
    .leftJoin(decisor, eq(decisor.id, versoesPrecificacao.decididoPor))
    .where(
      and(
        isNull(viagens.excluidoEm),
        or(
          eq(viagens.status, "aprovado"),
          and(eq(viagens.status, "vendida"), gte(viagens.vendidaEm, desde)),
          and(eq(viagens.status, "em_edicao"), isNotNull(viagens.notaCliente)),
        ),
      ),
    );

  // Versões antigas, sem o preço ao cliente gravado, recalculam com as regras da versão.
  const semPreco = [...new Set(linhas.filter((l) => l.precoCliente === null).map((l) => l.regrasVersaoId))];
  const taxaPorRegras = new Map<string, bigint>();
  for (const id of semPreco) taxaPorRegras.set(id, BigInt((await regrasDaVersao(id)).taxaServicoPorDia));

  const lista = linhas.map(
    (l): PropostaLista => ({
      id: l.id,
      codigo: formatarCodigoViagem(l.clienteCodigo, l.seq),
      estado: l.status === "vendida" ? "vendida" : l.status === "aprovado" ? "aguardando" : "ajustes",
      numeroVersao: l.numeroVersao,
      cliente: l.cliente,
      destino: l.destino,
      inicio: l.inicio,
      fim: l.fim,
      passageiros: l.passageiros,
      consultor: l.consultor,
      precoCliente: l.precoCliente ?? (l.preco + BigInt(l.dias) * taxaPorRegras.get(l.regrasVersaoId)!).toString(),
      forma: rotuloForma(l.forma as FormaPagamento),
      aprovadoEm: l.aprovadoEm,
      aprovadoPor: l.decisor ?? null,
      vendidaEm: l.vendidaEm,
      notaCliente: l.notaCliente,
    }),
  );
  const t = (x: PropostaLista) => (x.vendidaEm ?? x.aprovadoEm)?.getTime() ?? 0;
  return lista.sort((a, b) => t(b) - t(a));
}
