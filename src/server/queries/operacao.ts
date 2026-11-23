import "server-only";
import { and, asc, eq, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { hojeEmCuiaba } from "@/domain/clientes";
import {
  ordenarTarefas,
  prazoEfetivo,
  rotuloPrazo,
  situacaoTarefa,
  type CategoriaTarefa,
  type OrigemTarefa,
  type Prazo,
  type SituacaoTarefa,
} from "@/domain/tarefas";
import { formatarCodigoViagem, noites } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, pessoas, tarefas, usuarios, viagemPassageiros, viagens } from "@/server/db/schema";

export type CabecalhoViagem = {
  id: string;
  codigo: string;
  cliente: string;
  grupo: string;
  titular: string;
  destino: string;
  inicio: string;
  fim: string;
  noites: number;
  passageiros: { id: string; nome: string; nascimento: string | null }[];
  consultor: { id: string; nome: string };
  vendida: boolean;
};

/** Cabeçalho da trilha da operação (só dados cadastrais; nada de preço, custo, margem ou comissão). */
export async function cabecalhoDaViagem(viagemId: string): Promise<CabecalhoViagem | null> {
  await exigirPerfil();
  if (!ehUuid(viagemId)) return null;
  const [v] = await db
    .select({
      id: viagens.id,
      seq: viagens.seq,
      destino: viagens.destino,
      inicio: viagens.inicio,
      fim: viagens.fim,
      status: viagens.status,
      consultorId: viagens.consultorId,
      clienteId: viagens.clienteId,
      clienteCodigo: clientes.codigo,
      grupo: clientes.grupo,
      consultor: usuarios.nome,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)))
    .limit(1);
  if (!v) return null;
  const [titular] = await db
    .select({ nome: pessoas.nome })
    .from(pessoas)
    .where(and(eq(pessoas.clienteId, v.clienteId), eq(pessoas.titular, true), isNull(pessoas.removidoEm)))
    .limit(1);
  const passageiros = await db
    .select({ id: pessoas.id, nome: pessoas.nome, nascimento: pessoas.nascimento })
    .from(viagemPassageiros)
    .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
    .where(eq(viagemPassageiros.viagemId, v.id))
    .orderBy(asc(pessoas.ordem), asc(pessoas.nome));
  return {
    id: v.id,
    codigo: formatarCodigoViagem(v.clienteCodigo, v.seq),
    cliente: v.grupo,
    grupo: v.grupo,
    titular: titular?.nome ?? v.grupo,
    destino: v.destino,
    inicio: v.inicio,
    fim: v.fim,
    noites: noites(v.inicio, v.fim),
    passageiros,
    consultor: { id: v.consultorId, nome: v.consultor },
    vendida: v.status === "vendida",
  };
}

// ---------------------------------------------------------------------------
// Tarefas
// ---------------------------------------------------------------------------

export type ResponsavelTarefa = { tipo: "usuario"; id: string; nome: string } | { tipo: "customer_care" } | null;

export type TarefaLinha = {
  id: string;
  categoria: CategoriaTarefa;
  /** null = "Geral". */
  dia: string | null;
  item: string;
  fazer: string;
  prazo: Prazo | null;
  prazoEfetivo: string | null;
  rotuloPrazo: string;
  situacao: SituacaoTarefa;
  responsavel: ResponsavelTarefa;
  observacao: string | null;
  origem: OrigemTarefa;
  /** ISO. */
  concluidaEm: string | null;
  /** Nome de quem concluiu. */
  concluidaPor: string | null;
  /** ISO em milissegundos (vai de volta em `editarTarefa`). */
  atualizadoEm: string;
};

const responsavel = alias(usuarios, "responsavel");
const concluinte = alias(usuarios, "concluinte");

/** Colunas explícitas da tarefa (nada estratégico), com os nomes do responsável e de quem concluiu. */
const colunasTarefa = {
  id: tarefas.id,
  categoria: tarefas.categoria,
  dia: tarefas.dia,
  item: tarefas.item,
  fazer: tarefas.fazer,
  prazoTipo: tarefas.prazoTipo,
  prazoData: tarefas.prazoData,
  prazoDias: tarefas.prazoDias,
  responsavelId: tarefas.responsavelId,
  responsavelNome: responsavel.nome,
  customerCare: tarefas.customerCare,
  observacao: tarefas.observacao,
  ordem: tarefas.ordem,
  origem: tarefas.origem,
  concluidaEm: tarefas.concluidaEm,
  concluidaPor: concluinte.nome,
  atualizadoEm: tarefas.atualizadoEm,
};

type LinhaDb = {
  id: string;
  categoria: CategoriaTarefa;
  dia: string | null;
  item: string;
  fazer: string;
  prazoTipo: "data" | "dias_antes" | null;
  prazoData: string | null;
  prazoDias: number | null;
  responsavelId: string | null;
  responsavelNome: string | null;
  customerCare: boolean;
  observacao: string | null;
  ordem: number;
  origem: OrigemTarefa;
  concluidaEm: Date | null;
  concluidaPor: string | null;
  atualizadoEm: Date;
};

function prazoDaLinha(l: LinhaDb): Prazo | null {
  if (l.prazoTipo === "data" && l.prazoData) return { tipo: "data", data: l.prazoData };
  if (l.prazoTipo === "dias_antes" && l.prazoDias !== null) return { tipo: "dias_antes", dias: l.prazoDias };
  return null;
}

function tarefaLinha(l: LinhaDb, inicio: string, hoje: string): TarefaLinha {
  const prazo = prazoDaLinha(l);
  const efetivo = prazoEfetivo(prazo, inicio);
  return {
    id: l.id,
    categoria: l.categoria,
    dia: l.dia,
    item: l.item,
    fazer: l.fazer,
    prazo,
    prazoEfetivo: efetivo,
    rotuloPrazo: rotuloPrazo(prazo, inicio),
    situacao: situacaoTarefa({ prazoEfetivo: efetivo, concluida: l.concluidaEm !== null }, hoje),
    responsavel: l.customerCare
      ? { tipo: "customer_care" }
      : l.responsavelId
        ? { tipo: "usuario", id: l.responsavelId, nome: l.responsavelNome ?? "" }
        : null,
    observacao: l.observacao,
    origem: l.origem,
    concluidaEm: l.concluidaEm?.toISOString() ?? null,
    concluidaPor: l.concluidaEm ? l.concluidaPor : null,
    atualizadoEm: l.atualizadoEm.toISOString(),
  };
}

/** Usuários ativos (responsáveis possíveis), por nome. */
async function usuariosAtivos(): Promise<{ id: string; nome: string }[]> {
  return db.select({ id: usuarios.id, nome: usuarios.nome }).from(usuarios).where(eq(usuarios.ativo, true)).orderBy(asc(usuarios.nome));
}

/**
 * Tarefas não excluídas da viagem, na ordem da tela (categoria, "Geral" primeiro, dia, ordem). `temDaVenda` conta
 * também as excluídas (o botão "Criar as tarefas da venda" só aparece em viagem que nunca as teve). null = sem viagem.
 */
export async function tarefasDaViagem(viagemId: string): Promise<{
  cabecalho: CabecalhoViagem;
  tarefas: TarefaLinha[];
  temDaVenda: boolean;
  usuarios: { id: string; nome: string }[];
} | null> {
  await exigirPerfil();
  const cabecalho = await cabecalhoDaViagem(viagemId);
  if (!cabecalho) return null;
  const [linhas, [venda], ativos] = await Promise.all([
    db
      .select(colunasTarefa)
      .from(tarefas)
      .leftJoin(responsavel, eq(responsavel.id, tarefas.responsavelId))
      .leftJoin(concluinte, eq(concluinte.id, tarefas.concluidaPor))
      .where(and(eq(tarefas.viagemId, viagemId), isNull(tarefas.excluidoEm))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tarefas)
      .where(and(eq(tarefas.viagemId, viagemId), eq(tarefas.origem, "venda"))),
    usuariosAtivos(),
  ]);
  const hoje = hojeEmCuiaba();
  return {
    cabecalho,
    tarefas: ordenarTarefas(linhas).map((l) => tarefaLinha(l, cabecalho.inicio, hoje)),
    temDaVenda: venda.n > 0,
    usuarios: ativos,
  };
}

export type FiltroTarefas = {
  visao: "minhas" | "todas";
  /** Só em "todas": id do usuário, "customer_care" ou "ninguem". */
  responsavel?: string;
  situacao: "abertas" | "vencidas" | "concluidas";
  /** Busca pelo código da viagem (ECL-0001-01, sem caixa). */
  viagem?: string;
};

export type TarefaDaLista = TarefaLinha & { viagem: { id: string; codigo: string; destino: string; inicio: string } };

export const LIMITE_LISTA_TAREFAS = 500;

/**
 * Tarefas não excluídas das viagens vendidas, por prazo efetivo (sem prazo por último) e código da viagem. "Minhas" =
 * `responsavel_id` = quem consulta (customer care não entra). O prazo efetivo é calculado no SQL para o filtro de
 * vencidas (`hoje` em Cuiabá). No máximo `LIMITE_LISTA_TAREFAS` linhas.
 */
export async function listarTarefas(filtro: FiltroTarefas): Promise<TarefaDaLista[]> {
  const usuario = await exigirPerfil();
  const hoje = hojeEmCuiaba();
  const efetivo = sql`(case ${tarefas.prazoTipo} when 'data' then ${tarefas.prazoData} when 'dias_antes' then ${viagens.inicio} - ${tarefas.prazoDias} end)`;
  const codigo = sql`('ECL-' || lpad(${clientes.codigo}::text, 4, '0') || '-' || lpad(${viagens.seq}::text, 2, '0'))`;

  const conds: (SQL | undefined)[] = [isNull(tarefas.excluidoEm), isNull(viagens.excluidoEm), eq(viagens.status, "vendida")];
  if (filtro.visao === "minhas") conds.push(eq(tarefas.responsavelId, usuario.id));
  else if (filtro.responsavel === "customer_care") conds.push(eq(tarefas.customerCare, true));
  else if (filtro.responsavel === "ninguem") conds.push(isNull(tarefas.responsavelId), eq(tarefas.customerCare, false));
  else if (filtro.responsavel) {
    if (!ehUuid(filtro.responsavel)) return [];
    conds.push(eq(tarefas.responsavelId, filtro.responsavel));
  }
  if (filtro.situacao === "concluidas") conds.push(isNotNull(tarefas.concluidaEm));
  else conds.push(isNull(tarefas.concluidaEm));
  if (filtro.situacao === "vencidas") conds.push(sql`${efetivo} < ${hoje}::date`);
  const busca = filtro.viagem?.trim();
  if (busca) conds.push(sql`${codigo} ilike ${`%${busca.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);

  const linhas = await db
    .select({
      ...colunasTarefa,
      viagemId: viagens.id,
      clienteCodigo: clientes.codigo,
      seq: viagens.seq,
      destino: viagens.destino,
      inicio: viagens.inicio,
    })
    .from(tarefas)
    .innerJoin(viagens, eq(viagens.id, tarefas.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .leftJoin(responsavel, eq(responsavel.id, tarefas.responsavelId))
    .leftJoin(concluinte, eq(concluinte.id, tarefas.concluidaPor))
    .where(and(...conds))
    .orderBy(sql`${efetivo} asc nulls last`, asc(clientes.codigo), asc(viagens.seq), asc(tarefas.ordem))
    .limit(LIMITE_LISTA_TAREFAS);

  return linhas.map((l) => ({
    ...tarefaLinha(l, l.inicio, hoje),
    viagem: { id: l.viagemId, codigo: formatarCodigoViagem(l.clienteCodigo, l.seq), destino: l.destino, inicio: l.inicio },
  }));
}

/** Usuários ativos para o filtro de responsável da lista. */
export async function responsaveisPossiveis(): Promise<{ id: string; nome: string }[]> {
  await exigirPerfil();
  return usuariosAtivos();
}
