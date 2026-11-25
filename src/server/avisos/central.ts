import "server-only";
import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  DIAS_DISPENSADOS,
  DIAS_VALIDADE_DISPENSA,
  dispensaVale,
  SETOR_DO_TIPO,
  SETORES_DO_PERFIL,
  setoresDaVisao,
  tiposDosSetores,
  type AvisoCentral,
  type FiltroAvisos,
  type Setor,
  type TipoAviso,
} from "@/domain/avisos";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { avisosComunicados, avisosDispensados as tabelaDispensados, usuarios } from "@/server/db/schema";
import { avisosDeEstoque } from "./estoque";
import { avisosFinanceiros } from "./financeiros";
import { avisosDeGestao } from "./gestao";
import { avisosComerciais, avisosOperacionais } from "./operacao";
import { avisosDeReembolsos } from "./reembolsos";

// Central de avisos (fatia 5b, spec §8 e §14): os automáticos de cada setor, menos os dispensados, e os comunicados
// abertos. Calculado sempre na hora. Cada setor chama só as funções que o perfil pode chamar (a lista de setores já é
// um subconjunto do que o perfil recebe).

export type Comunicado = {
  id: string;
  setor: Setor;
  texto: string;
  passo: string | null;
  /** Nome de quem criou. */
  por: string;
  criadoPor: string;
  criadoEm: Date;
};

export type Dispensado = {
  id: string;
  chave: string;
  tipo: TipoAviso;
  setor: Setor;
  /** Título e detalhe como estavam na dispensa. */
  titulo: string;
  detalhe: string;
  justificativa: string;
  /** Nome de quem dispensou. */
  por: string;
  usuarioId: string;
  criadoEm: Date;
  /** Quem dispensou ou o Diretor. */
  podeDesfazer: boolean;
};

const DIA_MS = 24 * 60 * 60 * 1000;
const nenhum = Promise.resolve([] as AvisoCentral[]);

/** Os automáticos dos setores, na ordem Gestão, Financeiro, Comercial, Operacional. */
async function automaticos(setores: Setor[]): Promise<AvisoCentral[]> {
  const tem = (s: Setor) => setores.includes(s);
  const listas = await Promise.all([
    tem("Gestão") ? avisosDeGestao() : nenhum,
    tem("Financeiro") ? avisosFinanceiros() : nenhum,
    tem("Financeiro") ? avisosDeEstoque() : nenhum,
    tem("Financeiro") ? avisosDeReembolsos() : nenhum,
    tem("Comercial") ? avisosComerciais() : nenhum,
    tem("Operacional") ? avisosOperacionais() : nenhum,
  ]);
  return listas.flat();
}

/** Tira os avisos com dispensa que ainda vale (mesmo detalhe, até 30 dias): a dispensa vale para todos. */
async function semDispensados(avisos: AvisoCentral[]): Promise<AvisoCentral[]> {
  if (avisos.length === 0) return avisos;
  const agora = new Date();
  const dispensas = await db
    .select({ chave: tabelaDispensados.chave, detalhe: tabelaDispensados.detalhe, criadoEm: tabelaDispensados.criadoEm })
    .from(tabelaDispensados)
    .where(
      and(
        inArray(tabelaDispensados.chave, [...new Set(avisos.map((a) => a.chave))]),
        gte(tabelaDispensados.criadoEm, new Date(agora.getTime() - DIAS_VALIDADE_DISPENSA * DIA_MS)),
      ),
    );
  return avisos.filter((a) => !dispensas.some((d) => d.chave === a.chave && dispensaVale(d, a, agora)));
}

async function comunicadosAbertos(setores: Setor[]): Promise<Comunicado[]> {
  const linhas = await db
    .select({
      id: avisosComunicados.id,
      setor: avisosComunicados.setor,
      texto: avisosComunicados.texto,
      passo: avisosComunicados.passo,
      por: usuarios.nome,
      criadoPor: avisosComunicados.criadoPor,
      criadoEm: avisosComunicados.criadoEm,
    })
    .from(avisosComunicados)
    .innerJoin(usuarios, eq(usuarios.id, avisosComunicados.criadoPor))
    .where(and(isNull(avisosComunicados.resolvidoEm), inArray(avisosComunicados.setor, setores)))
    .orderBy(desc(avisosComunicados.criadoEm), desc(avisosComunicados.id));
  return linhas.map((l) => ({ ...l, setor: l.setor as Setor }));
}

/**
 * Avisos abertos e comunicados da central. "Para mim" (os setores do perfil) por padrão; o Diretor pode pedir um setor
 * ou "todos". Os cinco perfis.
 */
export async function avisosDaCentral(filtro: FiltroAvisos = {}): Promise<{ abertos: AvisoCentral[]; comunicados: Comunicado[] }> {
  const usuario = await exigirPerfil();
  const setores = setoresDaVisao(usuario.perfil, filtro);
  const [abertos, comunicados] = await Promise.all([automaticos(setores).then(semDispensados), comunicadosAbertos(setores)]);
  return { abertos, comunicados };
}

/** Dispensas dos últimos 90 dias dos tipos que a pessoa recebe, as mais recentes primeiro. */
export async function avisosDispensados(): Promise<Dispensado[]> {
  const usuario = await exigirPerfil();
  const tipos = tiposDosSetores(SETORES_DO_PERFIL[usuario.perfil]);
  const linhas = await db
    .select({
      id: tabelaDispensados.id,
      chave: tabelaDispensados.chave,
      tipo: tabelaDispensados.tipo,
      titulo: tabelaDispensados.titulo,
      detalhe: tabelaDispensados.detalhe,
      justificativa: tabelaDispensados.justificativa,
      por: usuarios.nome,
      usuarioId: tabelaDispensados.usuarioId,
      criadoEm: tabelaDispensados.criadoEm,
    })
    .from(tabelaDispensados)
    .innerJoin(usuarios, eq(usuarios.id, tabelaDispensados.usuarioId))
    .where(and(inArray(tabelaDispensados.tipo, tipos), gte(tabelaDispensados.criadoEm, new Date(Date.now() - DIAS_DISPENSADOS * DIA_MS))))
    .orderBy(desc(tabelaDispensados.criadoEm), desc(tabelaDispensados.id));
  return linhas.map((l) => {
    const tipo = l.tipo as TipoAviso;
    return { ...l, tipo, setor: SETOR_DO_TIPO[tipo], podeDesfazer: l.usuarioId === usuario.id || usuario.perfil === "diretor" };
  });
}
