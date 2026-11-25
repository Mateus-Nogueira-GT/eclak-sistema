import "server-only";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { hojeEmCuiaba } from "@/domain/clientes";
import { chavePasta } from "@/domain/drive";
import { linkHttps } from "@/domain/integracoes";
import { chaveVenda } from "@/domain/trello";
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
import {
  conferirDaily,
  converterHorario,
  dataDeEnvio,
  estadoDoDaily,
  formatarHora,
  trocaDeHotel,
  type EstadoDaily,
  type Indicador,
} from "@/domain/daily";
import {
  aniversariosNaViagem,
  rotuloDiaRoteiro,
  sugerirIdiomaEFuso,
  type Aniversario,
  type ConteudoRoteiro,
  type Idioma,
  type StatusRoteiro,
} from "@/domain/roteiro";
import { somarDias } from "@/domain/venda";
import { formatarCodigoViagem, noites } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { estadoIntegracao } from "@/server/integracoes/config";
import {
  clientes,
  dailies,
  integracaoEnvios,
  pessoas,
  roteiros,
  tarefas,
  usuarios,
  viagemPassageiros,
  viagens,
} from "@/server/db/schema";
import { regrasVigentes } from "@/server/queries/regras";

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
  /** Link da pasta da viagem no Google Drive, quando o envio `pasta:` já saiu; null sem pasta. */
  pastaDrive: string | null;
  /** Link do cartão da viagem no Trello, quando o envio `venda:` já saiu; null sem cartão. */
  cartaoTrello: string | null;
  /** Só para o Diretor (null nos demais): o que mostrar no lugar de cada botão. */
  integracoesNaViagem: { trello: SituacaoNaViagem; drive: SituacaoNaViagem } | null;
};

/**
 * `enviar`: ligada, viagem vendida e nada na fila (mostra o botão); `pendente` (inclui `enviando`), `falhou` e
 * `enviado` seguem o envio; `desligada`: sem envio e sem como enviar (integração desligada ou viagem não vendida).
 */
export type SituacaoNaViagem = "desligada" | "enviar" | "pendente" | "falhou" | "enviado";

/** Envios `venda:` (Trello) e `pasta:` (Drive) da viagem; o link só de um `enviado` (o parcial de um pendente não conta). */
async function enviosDaViagem(viagemId: string) {
  const linhas = await db
    .select({ integracao: integracaoEnvios.integracao, situacao: integracaoEnvios.situacao, resultado: integracaoEnvios.resultado })
    .from(integracaoEnvios)
    .where(
      sql`(${integracaoEnvios.integracao} = 'trello' and ${integracaoEnvios.chave} = ${chaveVenda(viagemId)})
        or (${integracaoEnvios.integracao} = 'drive' and ${integracaoEnvios.chave} = ${chavePasta(viagemId)})`,
    );
  const de = (i: "trello" | "drive") => linhas.find((l) => l.integracao === i) ?? null;
  const link = (l: ReturnType<typeof de>, campo: "url" | "link") =>
    l?.situacao === "enviado" ? linkHttps((l.resultado as Record<string, unknown> | null)?.[campo]) : null;
  return { trello: de("trello"), drive: de("drive"), cartaoTrello: link(de("trello"), "url"), pastaDrive: link(de("drive"), "link") };
}

function situacaoNaViagem(
  envio: { situacao: "pendente" | "enviando" | "enviado" | "falhou" } | null,
  ligada: boolean,
  vendida: boolean,
): SituacaoNaViagem {
  if (envio) return envio.situacao === "enviando" ? "pendente" : envio.situacao;
  return ligada && vendida ? "enviar" : "desligada";
}

const CODIGO_VIAGEM_RE = /^ECL-(\d+)-(\d+)$/i;

/** Viagem não excluída pelo código completo (`ECL-0001-01`). Exige sessão ativa. */
export async function viagemPorCodigo(codigo: string): Promise<{ id: string; codigo: string; cliente: string } | null> {
  await exigirPerfil();
  const m = CODIGO_VIAGEM_RE.exec(codigo.trim());
  if (!m) return null;
  const clienteCodigo = Number(m[1]);
  const seq = Number(m[2]);
  if (!Number.isSafeInteger(clienteCodigo) || !Number.isSafeInteger(seq)) return null;
  const [v] = await db
    .select({ id: viagens.id, seq: viagens.seq, clienteCodigo: clientes.codigo, grupo: clientes.grupo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(eq(clientes.codigo, clienteCodigo), eq(viagens.seq, seq), isNull(viagens.excluidoEm)))
    .limit(1);
  if (!v) return null;
  return { id: v.id, codigo: formatarCodigoViagem(v.clienteCodigo, v.seq), cliente: v.grupo };
}

/** Cabeçalho da trilha da operação (só dados cadastrais; nada de preço, custo, margem ou comissão). */
export async function cabecalhoDaViagem(viagemId: string): Promise<CabecalhoViagem | null> {
  const usuario = await exigirPerfil();
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
    .where(and(eq(viagemPassageiros.viagemId, v.id), isNull(pessoas.removidoEm)))
    .orderBy(asc(pessoas.ordem), asc(pessoas.nome));
  const envios = await enviosDaViagem(v.id);
  const vendida = v.status === "vendida";
  const integracoesNaViagem =
    usuario.perfil === "diretor"
      ? {
          trello: situacaoNaViagem(envios.trello, estadoIntegracao("trello").configurada, vendida),
          drive: situacaoNaViagem(envios.drive, estadoIntegracao("drive").configurada, vendida),
        }
      : null;
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
    vendida,
    pastaDrive: envios.pastaDrive,
    cartaoTrello: envios.cartaoTrello,
    integracoesNaViagem,
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

// ---------------------------------------------------------------------------
// Roteiro
// ---------------------------------------------------------------------------

export type RoteiroTela = {
  id: string;
  status: StatusRoteiro;
  idioma: Idioma;
  fuso: string;
  abertura: string;
  conteudo: ConteudoRoteiro;
  /** ISO. */
  enviadoClienteEm: string | null;
  /** ISO. */
  aprovadoEm: string | null;
  /** Nome de quem marcou a aprovação. */
  aprovadoPor: string | null;
  /** Aprovado e com o conteúdo salvo depois da aprovação (D16). */
  alteradoDepoisDaAprovacao: boolean;
  /** ISO em milissegundos (vai de volta em `salvarRoteiro`). */
  atualizadoEm: string;
};

const aprovador = alias(usuarios, "aprovador");

/**
 * Roteiro da viagem (ou null se ainda não tem), aniversários dos passageiros (pessoas não removidas) que caem na
 * viagem e a sugestão de idioma e fuso pelo destino. null = sem viagem.
 */
export async function roteiroDaViagem(viagemId: string): Promise<{
  cabecalho: CabecalhoViagem;
  roteiro: RoteiroTela | null;
  aniversarios: Aniversario[];
  sugestao: { idioma: Idioma; fuso: string } | null;
} | null> {
  await exigirPerfil();
  const cabecalho = await cabecalhoDaViagem(viagemId);
  if (!cabecalho) return null;
  const [[r], passageiros] = await Promise.all([
    db
      .select({
        id: roteiros.id,
        status: roteiros.status,
        idioma: roteiros.idioma,
        fuso: roteiros.fuso,
        abertura: roteiros.abertura,
        conteudo: roteiros.conteudo,
        enviadoClienteEm: roteiros.enviadoClienteEm,
        aprovadoEm: roteiros.aprovadoEm,
        aprovadoPor: aprovador.nome,
        atualizadoEm: roteiros.atualizadoEm,
      })
      .from(roteiros)
      .leftJoin(aprovador, eq(aprovador.id, roteiros.aprovadoPor))
      .where(eq(roteiros.viagemId, viagemId))
      .limit(1),
    db
      .select({ id: pessoas.id, nome: pessoas.nome, nascimento: pessoas.nascimento })
      .from(viagemPassageiros)
      .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
      .where(and(eq(viagemPassageiros.viagemId, viagemId), isNull(pessoas.removidoEm)))
      .orderBy(asc(pessoas.ordem), asc(pessoas.nome)),
  ]);
  const roteiro: RoteiroTela | null = r
    ? {
        id: r.id,
        status: r.status,
        idioma: r.idioma,
        fuso: r.fuso,
        abertura: r.abertura,
        conteudo: r.conteudo,
        enviadoClienteEm: r.enviadoClienteEm?.toISOString() ?? null,
        aprovadoEm: r.aprovadoEm?.toISOString() ?? null,
        aprovadoPor: r.aprovadoEm ? r.aprovadoPor : null,
        alteradoDepoisDaAprovacao: r.status === "aprovado" && r.aprovadoEm !== null && r.atualizadoEm > r.aprovadoEm,
        atualizadoEm: r.atualizadoEm.toISOString(),
      }
    : null;
  return {
    cabecalho,
    roteiro,
    aniversarios: aniversariosNaViagem(passageiros, cabecalho.inicio, cabecalho.fim, roteiro?.conteudo.hoteis ?? []),
    sugestao: sugerirIdiomaEFuso(cabecalho.destino),
  };
}

export type RoteiroDaLista = {
  viagemId: string;
  codigo: string;
  cliente: string;
  destino: string;
  inicio: string;
  fim: string;
  situacao: "sem_roteiro" | StatusRoteiro;
};

/** Viagens vendidas ainda não terminadas (`fim >= hoje` em Cuiabá), por início, com a situação do roteiro. */
export async function listarRoteiros(): Promise<RoteiroDaLista[]> {
  await exigirPerfil();
  const linhas = await db
    .select({
      viagemId: viagens.id,
      clienteCodigo: clientes.codigo,
      seq: viagens.seq,
      cliente: clientes.grupo,
      destino: viagens.destino,
      inicio: viagens.inicio,
      fim: viagens.fim,
      status: roteiros.status,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .leftJoin(roteiros, eq(roteiros.viagemId, viagens.id))
    .where(and(isNull(viagens.excluidoEm), eq(viagens.status, "vendida"), gte(viagens.fim, hojeEmCuiaba())))
    .orderBy(asc(viagens.inicio), asc(clientes.codigo), asc(viagens.seq));
  return linhas.map((l) => ({
    viagemId: l.viagemId,
    codigo: formatarCodigoViagem(l.clienteCodigo, l.seq),
    cliente: l.cliente,
    destino: l.destino,
    inicio: l.inicio,
    fim: l.fim,
    situacao: l.status ?? "sem_roteiro",
  }));
}

// ---------------------------------------------------------------------------
// Dailies
// ---------------------------------------------------------------------------

export type HorarioPlantao = { hora: string; titulo: string; destino: string; mt: string; brasilia: string };

export type DailyTela = {
  data: string;
  /** "16/08 (segunda-feira)". */
  rotuloDia: string;
  /** Cidade do hotel em que se dorme na noite do dia, senão o destino. */
  cidade: string;
  troca: boolean;
  /** D-1. */
  dataEnvio: string;
  estado: ReturnType<typeof estadoDoDaily>;
  daily: {
    id: string;
    texto: string | null;
    estado: EstadoDaily;
    /** ISO. */
    geradoEm: string | null;
    /** ISO. */
    enviadoEm: string | null;
    /** Nome de quem marcou o envio. */
    enviadoPor: string | null;
    plantao: { id: string; nome: string } | null;
    interno: string | null;
    /** ISO em milissegundos (vai de volta nas actions de texto e interno). */
    atualizadoEm: string;
  } | null;
  /** Os 6 indicadores do texto gravado, com o encerramento vigente; null sem texto. */
  indicadores: Indicador[] | null;
  /** O conteúdo do roteiro foi salvo depois da geração. */
  roteiroMudou: boolean;
  horarios: HorarioPlantao[];
};

type RoteiroDoDaily = {
  id: string;
  idioma: Idioma;
  fuso: string;
  conteudo: ConteudoRoteiro;
  atualizadoEm: Date;
};

const plantonista = alias(usuarios, "plantonista");
const remetente = alias(usuarios, "remetente");

/** Colunas explícitas do daily, com os nomes do plantão e de quem marcou o envio. */
const colunasDaily = {
  id: dailies.id,
  roteiroId: dailies.roteiroId,
  data: dailies.data,
  estado: dailies.estado,
  texto: dailies.texto,
  geradoEm: dailies.geradoEm,
  enviadoEm: dailies.enviadoEm,
  enviadoPor: remetente.nome,
  plantaoId: dailies.plantaoId,
  plantaoNome: plantonista.nome,
  interno: dailies.interno,
  atualizadoEm: dailies.atualizadoEm,
};

type LinhaDaily = {
  id: string;
  roteiroId: string;
  data: string;
  estado: EstadoDaily;
  texto: string | null;
  geradoEm: Date | null;
  enviadoEm: Date | null;
  enviadoPor: string | null;
  plantaoId: string | null;
  plantaoNome: string | null;
  interno: string | null;
  atualizadoEm: Date;
};

function linhasDosDailies(roteiroIds: string[], de?: string, ate?: string): Promise<LinhaDaily[]> {
  if (roteiroIds.length === 0) return Promise.resolve([]);
  const conds: SQL[] = [inArray(dailies.roteiroId, roteiroIds)];
  if (de) conds.push(gte(dailies.data, de));
  if (ate) conds.push(lte(dailies.data, ate));
  return db
    .select(colunasDaily)
    .from(dailies)
    .leftJoin(plantonista, eq(plantonista.id, dailies.plantaoId))
    .leftJoin(remetente, eq(remetente.id, dailies.enviadoPor))
    .where(and(...conds));
}

function cidadeDoDia(conteudo: ConteudoRoteiro, data: string, destino: string): string {
  const h = conteudo.hoteis.find((x) => x.entrada && x.saida && x.entrada <= data && data < x.saida);
  return h?.cidade || destino;
}

/** Monta o dia da tela a partir do roteiro, da linha gravada (se houver) e do encerramento vigente. */
function dailyTela(r: RoteiroDoDaily, data: string, destino: string, linha: LinhaDaily | undefined, encerramento: string, hoje: string): DailyTela {
  const dia = r.conteudo.dias.find((d) => d.data === data);
  const troca = trocaDeHotel(r.conteudo.hoteis, data).troca;
  const comTexto = linha && linha.estado !== "pendente" && linha.texto !== null ? linha.texto : null;
  const horarios = (dia?.itens ?? [])
    .filter((i) => i.hora)
    .sort((a, b) => (a.hora as string).localeCompare(b.hora as string))
    .map((i) => {
      const hora = i.hora as string;
      return {
        hora,
        titulo: i.titulo,
        destino: formatarHora(hora),
        mt: formatarHora(converterHorario(data, hora, r.fuso, "America/Cuiaba")),
        brasilia: formatarHora(converterHorario(data, hora, r.fuso, "America/Sao_Paulo")),
      };
    });
  return {
    data,
    rotuloDia: rotuloDiaRoteiro(data),
    cidade: cidadeDoDia(r.conteudo, data, destino),
    troca,
    dataEnvio: dataDeEnvio(data),
    estado: estadoDoDaily(data, linha?.estado ?? null, hoje),
    daily: linha
      ? {
          id: linha.id,
          texto: linha.texto,
          estado: linha.estado,
          geradoEm: linha.geradoEm?.toISOString() ?? null,
          enviadoEm: linha.enviadoEm?.toISOString() ?? null,
          enviadoPor: linha.enviadoEm ? linha.enviadoPor : null,
          plantao: linha.plantaoId ? { id: linha.plantaoId, nome: linha.plantaoNome ?? "" } : null,
          interno: linha.interno,
          atualizadoEm: linha.atualizadoEm.toISOString(),
        }
      : null,
    indicadores: comTexto === null ? null : conferirDaily(comTexto, { troca, idioma: r.idioma, encerramento }),
    roteiroMudou: !!linha?.geradoEm && r.atualizadoEm.getTime() > linha.geradoEm.getTime(),
    horarios,
  };
}

const colunasRoteiroDoDaily = {
  id: roteiros.id,
  idioma: roteiros.idioma,
  fuso: roteiros.fuso,
  conteudo: roteiros.conteudo,
  atualizadoEm: roteiros.atualizadoEm,
};

/**
 * Dailies da viagem: um por dia do roteiro, com o estado exibido, os indicadores (encerramento vigente) e os
 * horários do plantão. Nada é gravado ao abrir (D10). Sem roteiro, `roteiro` é null e `dias` vazio. null = sem viagem.
 */
export async function dailiesDaViagem(viagemId: string): Promise<{
  cabecalho: CabecalhoViagem;
  roteiro: { id: string; idioma: Idioma; fuso: string; atualizadoEm: string } | null;
  encerramento: string;
  usuarios: { id: string; nome: string }[];
  dias: DailyTela[];
} | null> {
  await exigirPerfil();
  const cabecalho = await cabecalhoDaViagem(viagemId);
  if (!cabecalho) return null;
  const [[r], vigentes, ativos] = await Promise.all([
    db.select(colunasRoteiroDoDaily).from(roteiros).where(eq(roteiros.viagemId, viagemId)).limit(1),
    regrasVigentes(),
    usuariosAtivos(),
  ]);
  const encerramento = vigentes.valores.encerramentoDaily;
  if (!r) return { cabecalho, roteiro: null, encerramento, usuarios: ativos, dias: [] };
  const linhas = await linhasDosDailies([r.id]);
  const porData = new Map(linhas.map((l) => [l.data, l]));
  const hoje = hojeEmCuiaba();
  return {
    cabecalho,
    roteiro: { id: r.id, idioma: r.idioma, fuso: r.fuso, atualizadoEm: r.atualizadoEm.toISOString() },
    encerramento,
    usuarios: ativos,
    dias: r.conteudo.dias.map((d) => dailyTela(r, d.data, cabecalho.destino, porData.get(d.data), encerramento, hoje)),
  };
}

export type DailyDaLista = DailyTela & { viagem: { id: string; codigo: string; cliente: string } };

/** Dailies de hoje até hoje + 3 (Cuiabá) das viagens vendidas com roteiro, por data e código da viagem (D22). */
export async function listarDailies(): Promise<DailyDaLista[]> {
  await exigirPerfil();
  const hoje = hojeEmCuiaba();
  const ate = somarDias(hoje, 3);
  const [rs, vigentes] = await Promise.all([
    db
      .select({
        ...colunasRoteiroDoDaily,
        viagemId: viagens.id,
        clienteCodigo: clientes.codigo,
        seq: viagens.seq,
        cliente: clientes.grupo,
        destino: viagens.destino,
      })
      .from(roteiros)
      .innerJoin(viagens, eq(viagens.id, roteiros.viagemId))
      .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
      .where(and(isNull(viagens.excluidoEm), eq(viagens.status, "vendida"), lte(viagens.inicio, ate), gte(viagens.fim, hoje))),
    regrasVigentes(),
  ]);
  const encerramento = vigentes.valores.encerramentoDaily;
  const linhas = await linhasDosDailies(
    rs.map((r) => r.id),
    hoje,
    ate,
  );
  const porChave = new Map(linhas.map((l) => [`${l.roteiroId}|${l.data}`, l]));
  const saida: DailyDaLista[] = [];
  for (const r of rs) {
    const viagem = { id: r.viagemId, codigo: formatarCodigoViagem(r.clienteCodigo, r.seq), cliente: r.cliente };
    for (const d of r.conteudo.dias) {
      if (d.data < hoje || d.data > ate) continue;
      saida.push({ ...dailyTela(r, d.data, r.destino, porChave.get(`${r.id}|${d.data}`), encerramento, hoje), viagem });
    }
  }
  return saida.sort((a, b) => a.data.localeCompare(b.data) || a.viagem.codigo.localeCompare(b.viagem.codigo));
}
