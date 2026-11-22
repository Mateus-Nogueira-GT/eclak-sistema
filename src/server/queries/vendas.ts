import "server-only";
import { and, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { rotuloForma, type ResultadoVersao, type Snapshot } from "@/domain/aprovacoes";
import type { FormaPagamento } from "@/domain/precificacao";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, regrasVersoes, usuarios, versoesPrecificacao, viagens } from "@/server/db/schema";
import { normalizarRegras } from "@/domain/regras";

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
  const linhas = await db
    .select({
      v: viagens,
      ver: versoesPrecificacao,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      consultor: usuarios.nome,
      decisor: decisor.nome,
      regras: regrasVersoes.valores,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .innerJoin(versoesPrecificacao, eq(versoesPrecificacao.id, viagens.versaoAprovadaId))
    .innerJoin(regrasVersoes, eq(regrasVersoes.id, versoesPrecificacao.regrasVersaoId))
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

  const lista = linhas.map(({ v, ver, ...l }): PropostaLista => {
    const s = ver.snapshot as Snapshot;
    const res = ver.resultado as ResultadoVersao;
    // Versões antigas, sem o preço ao cliente gravado, recalculam com as regras da versão.
    const precoCliente =
      res.precoCliente ?? (ver.preco + BigInt(ver.dias) * BigInt(normalizarRegras(l.regras).taxaServicoPorDia)).toString();
    return {
      id: v.id,
      codigo: formatarCodigoViagem(l.clienteCodigo, v.seq),
      estado: v.status === "vendida" ? "vendida" : v.status === "aprovado" ? "aguardando" : "ajustes",
      numeroVersao: ver.numero,
      cliente: l.cliente,
      destino: s.destino,
      inicio: s.inicio,
      fim: s.fim,
      passageiros: s.passageiros.map((p) => p.nome),
      consultor: l.consultor,
      precoCliente,
      forma: rotuloForma(ver.forma as FormaPagamento),
      aprovadoEm: ver.decididoEm,
      aprovadoPor: l.decisor ?? null,
      vendidaEm: v.vendidaEm,
      notaCliente: v.notaCliente,
    };
  });
  const t = (x: PropostaLista) => (x.vendidaEm ?? x.aprovadoEm)?.getTime() ?? 0;
  return lista.sort((a, b) => t(b) - t(a));
}
