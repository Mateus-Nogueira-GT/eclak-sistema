import "server-only";
import { asc, desc, eq, lte, sql } from "drizzle-orm";
import { diferencasRegras, normalizarRegras, REGRAS_INICIAIS, type Regras } from "@/domain/regras";
import { exigirPerfil } from "@/server/auth";
import { db, type Transacao } from "@/server/db/client";
import { regrasVersoes, usuarios } from "@/server/db/schema";

export type RegrasVigentes = { versaoId: string; vigenteDesde: Date; valores: Regras };

const TRAVA_PRIMEIRA_VERSAO = 7_350_001;
/** A versão inicial representa as regras sempre em vigor, antes de qualquer alteração. */
export const INICIO_DOS_TEMPOS = new Date(0);

/**
 * Garante que exista ao menos uma versão. Race-safe: o lock consultivo serializa
 * quem encontra a tabela vazia, e só o primeiro insere. Uso interno (sem checagem de acesso).
 */
export async function garantirVersaoInicial(tx: Transacao): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${TRAVA_PRIMEIRA_VERSAO})`);
  const [existe] = await tx.select({ id: regrasVersoes.id }).from(regrasVersoes).limit(1);
  if (!existe) await tx.insert(regrasVersoes).values({ valores: REGRAS_INICIAIS, vigenteDesde: INICIO_DOS_TEMPOS });
}

/**
 * Regras em vigor na data `em` (padrão: agora): a versão mais recente com vigente_desde <= em.
 * A versão inicial vale desde 1970, então sempre há resposta. Exige apenas login.
 */
export async function regrasVigentes(em: Date = new Date()): Promise<RegrasVigentes> {
  await exigirPerfil();
  const buscar = async () => {
    const [v] = await db
      .select()
      .from(regrasVersoes)
      .where(lte(regrasVersoes.vigenteDesde, em))
      .orderBy(desc(regrasVersoes.vigenteDesde), desc(regrasVersoes.seq))
      .limit(1);
    return v;
  };
  let linha = await buscar();
  if (!linha) {
    await db.transaction((tx) => garantirVersaoInicial(tx));
    linha = await buscar();
  }
  return {
    versaoId: linha.id,
    vigenteDesde: linha.vigenteDesde,
    valores: normalizarRegras(linha.valores),
  };
}

export type LinhaHistorico = { em: Date; usuario: string; campo: string; antes: string; depois: string };

/** Diferenças campo a campo entre versões consecutivas, mais recentes primeiro. Só o Diretor. */
export async function historicoRegras(): Promise<LinhaHistorico[]> {
  await exigirPerfil("diretor");
  const versoes = await db
    .select({
      vigenteDesde: regrasVersoes.vigenteDesde,
      valores: regrasVersoes.valores,
      usuario: usuarios.nome,
    })
    .from(regrasVersoes)
    .leftJoin(usuarios, eq(usuarios.id, regrasVersoes.criadoPor))
    .orderBy(asc(regrasVersoes.vigenteDesde), asc(regrasVersoes.seq));

  const linhas: LinhaHistorico[] = [];
  for (let i = versoes.length - 1; i >= 1; i--) {
    const ant = normalizarRegras(versoes[i - 1].valores);
    const cur = normalizarRegras(versoes[i].valores);
    for (const d of diferencasRegras(ant, cur)) {
      linhas.push({ em: versoes[i].vigenteDesde, usuario: versoes[i].usuario ?? "Sistema", ...d });
    }
  }
  return linhas;
}

/** Valores de uma versão de regras pelo id (as versões não mudam depois de criadas). Exige login. */
export async function regrasDaVersao(versaoId: string): Promise<Regras> {
  await exigirPerfil();
  const [v] = await db.select({ valores: regrasVersoes.valores }).from(regrasVersoes).where(eq(regrasVersoes.id, versaoId));
  if (!v) throw new Error("Versão de regras não encontrada");
  return normalizarRegras(v.valores);
}
