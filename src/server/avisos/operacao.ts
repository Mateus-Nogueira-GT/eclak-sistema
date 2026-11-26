import "server-only";
import { and, asc, eq, gte, isNull, lte, min, sql } from "drizzle-orm";
import { PASSO_AVISO_CENTRAL, perfisDoSetor, SETOR_DO_TIPO, type AvisoCentral, type TipoAvisoCentral } from "@/domain/avisos";
import { hojeEmCuiaba } from "@/domain/clientes";
import { aniversariosNaViagem } from "@/domain/roteiro";
import { dataBr } from "@/domain/tarefas";
import { somarDias } from "@/domain/venda";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { caixasExperiencia, clientes, dailies, pessoas, roteiros, tarefas, viagemPassageiros, viagens } from "@/server/db/schema";
import { plural } from "./financeiros";

// Avisos dos setores Operacional e Comercial (spec 5b §8.3): tarefa vencida, daily a gerar, caixa a montar e
// aniversário. Nenhum leva valor em reais (consultor e operacional recebem). Uma consulta por tipo.

const DIAS_ANIVERSARIO = 60;
const DIAS_CAIXA = 30;

/** Aviso de um alvo de Operacional ou Comercial. */
function aviso(tipo: TipoAvisoCentral, alvo: string, titulo: string, detalhe: string, href: string): AvisoCentral {
  return { chave: `${tipo}:${alvo}`, tipo, titulo, detalhe, passo: PASSO_AVISO_CENTRAL[tipo], setor: SETOR_DO_TIPO[tipo], href, dispensavel: true };
}

/** Viagem vendida e não excluída. */
const vendidaAtiva = and(eq(viagens.status, "vendida"), isNull(viagens.excluidoEm));

/** Tarefas abertas com prazo efetivo antes de hoje, uma linha por viagem com a contagem e a mais antiga. */
async function tarefasVencidas(hoje: string): Promise<AvisoCentral[]> {
  const efetivo = sql<string>`(case ${tarefas.prazoTipo} when 'data' then ${tarefas.prazoData} when 'dias_antes' then ${viagens.inicio} - ${tarefas.prazoDias} end)`;
  const linhas = await db
    .select({
      viagemId: viagens.id,
      clienteCodigo: clientes.codigo,
      seq: viagens.seq,
      cliente: clientes.grupo,
      destino: viagens.destino,
      quantidade: sql<number>`count(*)::int`,
      maisAntiga: min(efetivo).mapWith(String),
    })
    .from(tarefas)
    .innerJoin(viagens, eq(viagens.id, tarefas.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(vendidaAtiva, isNull(tarefas.excluidoEm), isNull(tarefas.concluidaEm), sql`${efetivo} < ${hoje}::date`))
    .groupBy(viagens.id, clientes.codigo, viagens.seq, clientes.grupo, viagens.destino)
    .orderBy(asc(min(efetivo)), asc(clientes.codigo), asc(viagens.seq));
  return linhas.map((l) =>
    aviso(
      "tarefa_vencida",
      l.viagemId,
      `Tarefas vencidas na ${formatarCodigoViagem(l.clienteCodigo, l.seq)}`,
      `${l.cliente} (${l.destino}): ${plural(l.quantidade, "tarefa vencida", "tarefas vencidas")}, a mais antiga de ${dataBr(l.maisAntiga)}`,
      `/viagens/${l.viagemId}/tarefas`,
    ),
  );
}

/**
 * Daily de hoje ou de amanhã sem linha ou com ela pendente (spec §14), de viagem vendida com roteiro aprovado e o dia
 * no roteiro (o mesmo critério do agendador). Um aviso por viagem e dia.
 */
async function dailiesAGerar(hoje: string): Promise<AvisoCentral[]> {
  const amanha = somarDias(hoje, 1);
  const linhas = await db
    .select({
      viagemId: viagens.id,
      clienteCodigo: clientes.codigo,
      seq: viagens.seq,
      cliente: clientes.grupo,
      destino: viagens.destino,
      conteudo: roteiros.conteudo,
      feitos: sql<string[]>`array(select ${dailies.data}::text from ${dailies} where ${dailies.roteiroId} = ${roteiros.id} and ${dailies.data} in (${hoje}::date, ${amanha}::date) and ${dailies.estado} <> 'pendente')`,
    })
    .from(roteiros)
    .innerJoin(viagens, eq(viagens.id, roteiros.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(vendidaAtiva, eq(roteiros.status, "aprovado"), lte(viagens.inicio, amanha), gte(viagens.fim, hoje)))
    .orderBy(asc(viagens.inicio), asc(clientes.codigo), asc(viagens.seq));
  const avisos: AvisoCentral[] = [];
  for (const dia of [hoje, amanha]) {
    for (const l of linhas) {
      if (!l.conteudo.dias.some((d) => d.data === dia) || l.feitos.includes(dia)) continue;
      avisos.push(
        aviso(
          "daily_a_gerar",
          `${l.viagemId}:${dia}`,
          `Daily de ${dataBr(dia)} a gerar na ${formatarCodigoViagem(l.clienteCodigo, l.seq)}`,
          `${l.cliente} (${l.destino}): daily de ${dataBr(dia)}`,
          `/viagens/${l.viagemId}/dailies`,
        ),
      );
    }
  }
  return avisos;
}

/**
 * Viagem vendida, não conciliada, com embarque de hoje até 30 dias e sem caixa de experiência confirmada (rascunho não
 * conta). Sem valores.
 */
async function caixasAMontar(hoje: string): Promise<AvisoCentral[]> {
  const linhas = await db
    .select({ viagemId: viagens.id, clienteCodigo: clientes.codigo, seq: viagens.seq, cliente: clientes.grupo, destino: viagens.destino, inicio: viagens.inicio })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(
      and(
        vendidaAtiva,
        isNull(viagens.conciliadaEm),
        gte(viagens.inicio, hoje),
        lte(viagens.inicio, somarDias(hoje, DIAS_CAIXA)),
        sql`not exists (select 1 from ${caixasExperiencia} where ${caixasExperiencia.viagemId} = ${viagens.id} and ${caixasExperiencia.situacao} = 'confirmada')`,
      ),
    )
    .orderBy(asc(viagens.inicio), asc(clientes.codigo), asc(viagens.seq));
  return linhas.map((l) =>
    aviso(
      "caixa_a_montar",
      l.viagemId,
      `Caixa de experiência a montar na ${formatarCodigoViagem(l.clienteCodigo, l.seq)}`,
      `${l.cliente} (${l.destino}): embarque em ${dataBr(l.inicio)}, sem caixa confirmada`,
      `/viagens/${l.viagemId}#caixa-experiencia`,
    ),
  );
}

/** Avisos do setor Operacional: tarefas vencidas, dailies a gerar e caixas a montar, nesta ordem. */
export async function avisosOperacionais(): Promise<AvisoCentral[]> {
  await exigirPerfil(...perfisDoSetor("Operacional"));
  const hoje = hojeEmCuiaba();
  const [t, d, c] = await Promise.all([tarefasVencidas(hoje), dailiesAGerar(hoje), caixasAMontar(hoje)]);
  return [...t, ...d, ...c];
}

/**
 * Avisos do setor Comercial: passageiro (pessoa não removida) que faz aniversário durante uma viagem vendida que começa
 * nos próximos 60 dias ou está em andamento. Um aviso por viagem e passageiro.
 */
export async function avisosComerciais(): Promise<AvisoCentral[]> {
  await exigirPerfil(...perfisDoSetor("Comercial"));
  const hoje = hojeEmCuiaba();
  const linhas = await db
    .select({
      viagemId: viagens.id,
      clienteCodigo: clientes.codigo,
      seq: viagens.seq,
      inicio: viagens.inicio,
      fim: viagens.fim,
      pessoaId: pessoas.id,
      nome: pessoas.nome,
      nascimento: pessoas.nascimento,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(viagemPassageiros, eq(viagemPassageiros.viagemId, viagens.id))
    .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
    .where(and(vendidaAtiva, lte(viagens.inicio, somarDias(hoje, DIAS_ANIVERSARIO)), gte(viagens.fim, hoje), isNull(pessoas.removidoEm), sql`${pessoas.nascimento} is not null`))
    .orderBy(asc(viagens.inicio), asc(clientes.codigo), asc(viagens.seq), asc(pessoas.ordem));

  const avisos: AvisoCentral[] = [];
  for (const l of linhas) {
    for (const n of aniversariosNaViagem([{ id: l.pessoaId, nome: l.nome, nascimento: l.nascimento }], l.inicio, l.fim, [])) {
      avisos.push(
        aviso(
          "aniversario",
          `${l.viagemId}:${l.pessoaId}`,
          `Aniversário de ${n.nome} na ${formatarCodigoViagem(l.clienteCodigo, l.seq)}`,
          `${n.nome} faz ${n.idade} anos em ${dataBr(n.data)}, no ${n.diaDaViagem}º dia da viagem`,
          `/viagens/${l.viagemId}/roteiro`,
        ),
      );
    }
  }
  return avisos;
}
