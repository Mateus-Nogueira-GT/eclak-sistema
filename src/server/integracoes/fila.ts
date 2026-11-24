import "server-only";
import { after } from "next/server";
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import {
  ENVIANDO_PRESO_MIN,
  INTEGRACOES_FILA,
  LOTE_FILA,
  MAX_TENTATIVAS,
  proximaTentativa,
  repete,
  type IntegracaoFila,
} from "@/domain/integracoes";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { integracaoEnvios, type ErroEnvio } from "@/server/db/schema";
import { estadoIntegracao } from "./config";
import { ErroIntegracao, type Buscar } from "./http";

// Fila de envios às integrações (outbox). `enfileirar` roda na transação do evento; `processarFila` toma os envios
// numa transação curta (FOR UPDATE SKIP LOCKED → `enviando`), faz a chamada externa FORA de qualquer transação e
// grava o resultado em outra transação curta. As mudanças de situação feitas pela fila são auditadas como ação do
// sistema (usuario_id nulo).

const t = integracaoEnvios;

export type EnvioTomado = {
  id: string;
  integracao: IntegracaoFila;
  tipo: string;
  viagemId: string | null;
  chave: string;
  payload: unknown;
  /** Já contando esta tentativa (1-based). */
  tentativas: number;
  /** O que tentativas anteriores já gravaram (ids externos), para não criar de novo. */
  resultado: unknown;
};

export type DepsProcessador = {
  buscar: Buscar;
  agora: Date;
  /** Grava um resultado parcial já (ex.: o id do cartão criado antes do checklist), mantido se a tentativa falhar. */
  gravarResultado: (resultado: unknown) => Promise<void>;
};

/**
 * Faz o envio e devolve o `resultado` (ids e links externos; sem dado sensível). `undefined` mantém o que está
 * gravado. Erro de serviço: lançar `ErroIntegracao`; qualquer outro erro conta como `servidor` (tenta de novo).
 */
export type Processador = (envio: EnvioTomado, deps: DepsProcessador) => Promise<unknown>;

// Preenchido pelas integrações (Tasks 2 e 3 da fatia 6c). Integração sem processador não é tomada da fila.
const PROCESSADORES: Partial<Record<IntegracaoFila, Processador>> = {};

const substitutos = new Map<IntegracaoFila, Processador | null>();

/** Só testes: troca o processador (`null` = sem processador; `undefined` = volta ao normal). */
export function definirProcessadorParaTestes(i: IntegracaoFila, fn: Processador | null | undefined): void {
  if (process.env.NODE_ENV === "production") throw new Error("Só em testes");
  if (fn === undefined) substitutos.delete(i);
  else substitutos.set(i, fn);
}

function processadorDe(i: IntegracaoFila): Processador | null {
  return substitutos.has(i) ? substitutos.get(i)! : (PROCESSADORES[i] ?? null);
}

export type EventoFila = {
  integracao: IntegracaoFila;
  tipo: string;
  viagemId: string | null;
  chave: string;
  payload: unknown;
};

/**
 * Põe o envio na fila, na transação do evento. Só quando a integração está configurada agora (nada acumula enquanto
 * desligada). A mesma `chave` na mesma integração não entra de novo (idempotência).
 */
export async function enfileirar(tx: Transacao, e: EventoFila): Promise<void> {
  if (!estadoIntegracao(e.integracao).configurada) return;
  await tx
    .insert(t)
    .values({ integracao: e.integracao, tipo: e.tipo, viagemId: e.viagemId, chave: e.chave, payload: e.payload })
    .onConflictDoNothing({ target: [t.integracao, t.chave] });
}

function erroDe(e: unknown): ErroEnvio {
  return e instanceof ErroIntegracao ? { classe: e.classe, status: e.status } : { classe: "servidor", status: null };
}

/** Log sem corpo, sem mensagem e sem segredo: integração, classe e status. */
function logarFalha(integracao: IntegracaoFila, erro: ErroEnvio): void {
  console.error(`[integracoes] ${integracao}: ${erro.classe}${erro.status === null ? "" : ` HTTP ${erro.status}`}`);
}

function codigoDoErro(e: unknown): string {
  const codigo = (e as { code?: unknown } | null)?.code;
  if (typeof codigo === "string") return codigo;
  return e instanceof Error ? e.name : "desconhecido";
}

const situacaoAuditada = (l: { situacao: string; tentativas: number; ultimoErro: ErroEnvio | null }) => ({
  situacao: l.situacao,
  tentativas: l.tentativas,
  ultimoErro: l.ultimoErro,
});

/** `enviando` preso (processo caiu): volta a `pendente` para já, ou `falhou` se já gastou as tentativas. */
async function soltarPresos(agora: Date): Promise<void> {
  const limite = new Date(agora.getTime() - ENVIANDO_PRESO_MIN * 60_000);
  await db.transaction(async (tx) => {
    const soltos = await tx
      .update(t)
      .set({
        situacao: sql`case when ${t.tentativas} >= ${MAX_TENTATIVAS} then 'falhou'::situacao_envio else 'pendente'::situacao_envio end`,
        proximaEm: agora,
      })
      .where(and(eq(t.situacao, "enviando"), lt(t.tomadoEm, limite)))
      .returning();
    for (const l of soltos) {
      await registrarAuditoria(tx, {
        usuarioId: null,
        tabela: "integracao_envios",
        registroId: l.id,
        acao: "alterar",
        antes: { situacao: "enviando", tentativas: l.tentativas },
        depois: situacaoAuditada(l),
      });
    }
  });
}

async function tomar(integracoes: IntegracaoFila[], agora: Date, limite: number): Promise<EnvioTomado[]> {
  const linhas = await db.transaction(async (tx) => {
    const alvo = await tx
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.situacao, "pendente"), lte(t.proximaEm, agora), inArray(t.integracao, integracoes)))
      .orderBy(asc(t.proximaEm), asc(t.criadoEm))
      .limit(limite)
      .for("update", { skipLocked: true });
    if (alvo.length === 0) return [];
    return tx
      .update(t)
      .set({ situacao: "enviando", tentativas: sql`${t.tentativas} + 1`, tomadoEm: agora })
      .where(inArray(
        t.id,
        alvo.map((a) => a.id),
      ))
      .returning();
  });
  return linhas
    .sort((a, b) => a.proximaEm.getTime() - b.proximaEm.getTime() || a.criadoEm.getTime() - b.criadoEm.getTime())
    .map((l) => ({
      id: l.id,
      integracao: l.integracao,
      tipo: l.tipo,
      viagemId: l.viagemId,
      chave: l.chave,
      payload: l.payload,
      tentativas: l.tentativas,
      resultado: l.resultado,
    }));
}

async function gravarSucesso(envio: EnvioTomado, resultado: unknown, agora: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [l] = await tx
      .update(t)
      .set({
        situacao: "enviado",
        enviadoEm: agora,
        ultimoErro: null,
        ...(resultado === undefined ? {} : { resultado }),
      })
      .where(and(eq(t.id, envio.id), eq(t.situacao, "enviando")))
      .returning();
    if (!l) return;
    await registrarAuditoria(tx, {
      usuarioId: null,
      tabela: "integracao_envios",
      registroId: l.id,
      acao: "alterar",
      antes: { situacao: "enviando", tentativas: l.tentativas },
      depois: { ...situacaoAuditada(l), resultado: l.resultado },
    });
  });
}

async function gravarFalha(envio: EnvioTomado, erro: ErroEnvio, agora: Date): Promise<void> {
  const proxima = repete(erro.classe) ? proximaTentativa(envio.tentativas, agora) : null;
  await db.transaction(async (tx) => {
    const [l] = await tx
      .update(t)
      .set(
        proxima
          ? { situacao: "pendente", proximaEm: proxima, ultimoErro: erro }
          : { situacao: "falhou", ultimoErro: erro },
      )
      .where(and(eq(t.id, envio.id), eq(t.situacao, "enviando")))
      .returning();
    if (!l) return;
    await registrarAuditoria(tx, {
      usuarioId: null,
      tabela: "integracao_envios",
      registroId: l.id,
      acao: "alterar",
      antes: { situacao: "enviando", tentativas: l.tentativas },
      depois: { ...situacaoAuditada(l), proximaEm: proxima },
    });
  });
}

/**
 * Manda o que está na fila: solta os `enviando` presos, toma até `limite` pendentes vencidos das integrações
 * configuradas e com processador, e chama cada um fora de transação (um por vez).
 */
export async function processarFila(
  opts: { limite?: number; agora?: Date; buscar?: Buscar } = {},
): Promise<{ enviados: number; falhas: number }> {
  const agora = opts.agora ?? new Date();
  const buscar = opts.buscar ?? fetch;
  await soltarPresos(agora);
  const ativas = INTEGRACOES_FILA.filter((i) => processadorDe(i) !== null && estadoIntegracao(i).configurada);
  if (ativas.length === 0) return { enviados: 0, falhas: 0 };
  const envios = await tomar(ativas, agora, opts.limite ?? LOTE_FILA);
  let enviados = 0;
  let falhas = 0;
  for (const envio of envios) {
    const processador = processadorDe(envio.integracao);
    const deps: DepsProcessador = {
      buscar,
      agora,
      gravarResultado: async (resultado) => {
        await db
          .update(t)
          .set({ resultado })
          .where(and(eq(t.id, envio.id), eq(t.situacao, "enviando")));
      },
    };
    try {
      if (!processador) throw new ErroIntegracao("servidor", null);
      const resultado = await processador(envio, deps);
      await gravarSucesso(envio, resultado, agora);
      enviados++;
    } catch (e) {
      const erro = erroDe(e);
      logarFalha(envio.integracao, erro);
      await gravarFalha(envio, erro, agora);
      falhas++;
    }
  }
  return { enviados, falhas };
}

/**
 * Agenda `processarFila()` para depois da resposta (Server Action ou rota), logo depois do commit do evento. Nunca
 * lança para quem chama: o cron pega o que ficar para trás.
 */
export function processarDepois(): void {
  try {
    after(async () => {
      try {
        await processarFila();
      } catch (e) {
        console.error(`[integracoes] falha ao processar a fila: ${codigoDoErro(e)}`);
      }
    });
  } catch (e) {
    console.error(`[integracoes] não agendou a fila: ${codigoDoErro(e)}`);
  }
}

/**
 * Reenviar (Admin › Integrações): `falhou` ou `pendente` volta a `pendente` para agora, com as tentativas zeradas;
 * o `resultado` fica (ids já criados são reaproveitados). `enviado` e `enviando` não mudam. Auditado com quem pediu
 * (null = sistema). Devolve se mudou.
 */
export async function reenviar(envioId: string, usuarioId: string | null = null): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [antes] = await tx
      .select()
      .from(t)
      .where(and(eq(t.id, envioId), inArray(t.situacao, ["falhou", "pendente"])))
      .for("update");
    if (!antes) return false;
    const [l] = await tx
      .update(t)
      .set({ situacao: "pendente", tentativas: 0, proximaEm: sql`now()` })
      .where(eq(t.id, envioId))
      .returning();
    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "integracao_envios",
      registroId: l.id,
      acao: "alterar",
      antes: situacaoAuditada(antes),
      depois: situacaoAuditada(l),
    });
    return true;
  });
}
