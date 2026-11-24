import "server-only";
import { after } from "next/server";
import { and, asc, eq, inArray, lt, lte, sql } from "drizzle-orm";
import {
  ENVIANDO_PRESO_MIN,
  ESPERA_AGUARDANDO_MIN,
  INTEGRACOES_FILA,
  LOTE_FILA,
  MAX_TENTATIVAS,
  proximaTentativa,
  repete,
  type ClasseErro,
  type IntegracaoFila,
  type MotivoEspera,
} from "@/domain/integracoes";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { integracaoEnvios, type ErroEnvio } from "@/server/db/schema";
import { estadoIntegracao } from "./config";
import { ErroIntegracao, EsperaIntegracao, type Buscar } from "./http";
import { processarDrive } from "./drive";
import { processarTrello } from "./trello";

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
  /** Marca desta tomada: toda escrita desta execução só vale enquanto o envio ainda é dela (fencing). */
  tomadoEm: Date;
};

export type DepsProcessador = {
  buscar: Buscar;
  agora: Date;
  /**
   * Grava um resultado parcial já (ex.: o id do cartão criado antes do checklist), mantido se a tentativa falhar.
   * Substitui o `resultado` inteiro. Lança se o envio já não é desta execução (foi solto e tomado por outra): o
   * processador para ali, sem mais chamadas externas.
   */
  gravarResultado: (resultado: unknown) => Promise<void>;
};

/**
 * Faz o envio e devolve o `resultado` (ids e links externos; sem dado sensível). `undefined` mantém o que está
 * gravado. Erro de serviço: lançar `ErroIntegracao`; qualquer outro erro conta como `servidor` (tenta de novo).
 */
export type Processador = (envio: EnvioTomado, deps: DepsProcessador) => Promise<unknown>;

// Integração sem processador não é tomada da fila.
const PROCESSADORES: Partial<Record<IntegracaoFila, Processador>> = { trello: processarTrello, drive: processarDrive };

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
 * desligada). A mesma `chave` na mesma integração não entra de novo (idempotência). Devolve o id do envio criado,
 * ou null quando nada entrou (desligada ou a chave já estava na fila).
 */
export async function enfileirar(tx: Transacao, e: EventoFila): Promise<string | null> {
  if (!estadoIntegracao(e.integracao).configurada) return null;
  return inserirEnvio(tx, e);
}

/**
 * Como `enfileirar`, sem conferir a configuração: só para quem já conferiu nesta mesma transação (uma conferência só,
 * para a resposta "não configurado" e a gravação não divergirem). Devolve o id criado ou null (a chave já existia).
 */
export async function inserirEnvio(tx: Transacao, e: EventoFila): Promise<string | null> {
  const [l] = await tx
    .insert(t)
    .values({ integracao: e.integracao, tipo: e.tipo, viagemId: e.viagemId, chave: e.chave, payload: e.payload })
    .onConflictDoNothing({ target: [t.integracao, t.chave] })
    .returning({ id: t.id });
  return l?.id ?? null;
}

type ErroServico = { classe: ClasseErro; status: number | null };

function erroDe(e: unknown): ErroServico {
  return e instanceof ErroIntegracao ? { classe: e.classe, status: e.status } : { classe: "servidor", status: null };
}

/** Log sem corpo, sem mensagem e sem segredo: integração, classe e status. */
function logarFalha(integracao: IntegracaoFila, erro: ErroServico): void {
  console.error(`[integracoes] ${integracao}: ${erro.classe}${erro.status === null ? "" : ` HTTP ${erro.status}`}`);
}

function codigoDoErro(e: unknown): string {
  const x = e as { code?: unknown; cause?: { code?: unknown } } | null;
  // O Drizzle embrulha o erro do Postgres: o código (SQLSTATE) fica na causa.
  const codigo = x?.cause?.code ?? x?.code;
  if (typeof codigo === "string") return codigo;
  return e instanceof Error ? e.name : "desconhecido";
}

/** Erro do sistema da fila (não do serviço): só o código, sem mensagem nem parâmetros. */
function logarErroDaFila(contexto: string, e: unknown): void {
  console.error(`[integracoes] ${contexto}: ${codigoDoErro(e)}`);
}

/** Preso que gastou as tentativas: a tela mostra uma classe (o processo caiu ou a chamada nunca voltou). */
const ERRO_PRESO: ErroEnvio = { classe: "rede", status: null };

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
        ultimoErro: sql`case when ${t.tentativas} >= ${MAX_TENTATIVAS} then ${JSON.stringify(ERRO_PRESO)}::jsonb else ${t.ultimoErro} end`,
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
      .where(inArray(t.id, alvo.map((a) => a.id)))
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
      tomadoEm: l.tomadoEm!,
    }));
}

/** O envio ainda é desta execução: `enviando` com a marca desta tomada. */
const aindaMeu = (envio: EnvioTomado) => and(eq(t.id, envio.id), eq(t.situacao, "enviando"), eq(t.tomadoEm, envio.tomadoEm));

/** Devolve se gravou (false = o envio já não era desta execução). */
async function gravarSucesso(envio: EnvioTomado, resultado: unknown, agora: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [l] = await tx
      .update(t)
      .set({
        situacao: "enviado",
        enviadoEm: agora,
        ultimoErro: null,
        ...(resultado === undefined ? {} : { resultado }),
      })
      .where(aindaMeu(envio))
      .returning();
    if (!l) return false;
    await registrarAuditoria(tx, {
      usuarioId: null,
      tabela: "integracao_envios",
      registroId: l.id,
      acao: "alterar",
      antes: { situacao: "enviando", tentativas: l.tentativas },
      depois: { ...situacaoAuditada(l), resultado: l.resultado },
    });
    return true;
  });
}

/** Devolve se gravou (false = o envio já não era desta execução). */
async function gravarFalha(envio: EnvioTomado, erro: ErroServico, agora: Date): Promise<boolean> {
  const proxima = repete(erro.classe) ? proximaTentativa(envio.tentativas, agora) : null;
  return db.transaction(async (tx) => {
    const [l] = await tx
      .update(t)
      .set(
        proxima
          ? { situacao: "pendente", proximaEm: proxima, ultimoErro: erro }
          : { situacao: "falhou", ultimoErro: erro },
      )
      .where(aindaMeu(envio))
      .returning();
    if (!l) return false;
    await registrarAuditoria(tx, {
      usuarioId: null,
      tabela: "integracao_envios",
      registroId: l.id,
      acao: "alterar",
      antes: { situacao: "enviando", tentativas: l.tentativas },
      depois: { ...situacaoAuditada(l), proximaEm: proxima },
    });
    return true;
  });
}

/**
 * O envio depende de outro que ainda não saiu: volta a `pendente` daqui a `ESPERA_AGUARDANDO_MIN` sem gastar a
 * tentativa (a tomada a tinha contado) e com o motivo em `ultimo_erro`. Devolve se gravou.
 */
async function gravarEspera(envio: EnvioTomado, motivo: MotivoEspera, agora: Date): Promise<boolean> {
  const proxima = new Date(agora.getTime() + ESPERA_AGUARDANDO_MIN * 60_000);
  const espera: ErroEnvio = { classe: "aguardando", status: null, motivo };
  return db.transaction(async (tx) => {
    const [l] = await tx
      .update(t)
      .set({ situacao: "pendente", proximaEm: proxima, ultimoErro: espera, tentativas: sql`greatest(${t.tentativas} - 1, 0)` })
      .where(aindaMeu(envio))
      .returning();
    if (!l) return false;
    await registrarAuditoria(tx, {
      usuarioId: null,
      tabela: "integracao_envios",
      registroId: l.id,
      acao: "alterar",
      // A tomada contou esta tentativa e a espera a devolveu: o registro mostra as que o envio tinha antes dela.
      antes: { situacao: "enviando", tentativas: l.tentativas },
      depois: { ...situacaoAuditada(l), proximaEm: proxima },
    });
    return true;
  });
}

/**
 * Manda o que está na fila: solta os `enviando` presos e, até `limite` vezes, toma o pendente vencido mais antigo das
 * integrações configuradas e com processador e o chama fora de transação. `enviado_em` e a próxima tentativa contam
 * da hora em que a chamada terminou.
 */
export async function processarFila(
  opts: { limite?: number; agora?: Date; buscar?: Buscar } = {},
): Promise<{ enviados: number; falhas: number }> {
  const relogio = () => opts.agora ?? new Date();
  const buscar = opts.buscar ?? fetch;
  await soltarPresos(relogio());
  const ativas = INTEGRACOES_FILA.filter((i) => processadorDe(i) !== null && estadoIntegracao(i).configurada);
  if (ativas.length === 0) return { enviados: 0, falhas: 0 };
  const limite = opts.limite ?? LOTE_FILA;
  let enviados = 0;
  let falhas = 0;
  // Um envio tomado por vez, com o relógio da hora: os ainda não tomados ficam `pendente` (outra execução pode
  // pegá-los) e um lote demorado não faz os últimos parecerem presos (`tomado_em` antigo) para o cron seguinte.
  for (let n = 0; n < limite; n++) {
    const agora = relogio();
    let envio: EnvioTomado | undefined;
    try {
      [envio] = await tomar(ativas, agora, 1);
    } catch (e) {
      // Banco fora: o resto do lote também não seria tomado; o cron tenta de novo.
      logarErroDaFila("falha ao tomar da fila", e);
      break;
    }
    if (!envio) break;
    const meu = envio;
    const processador = processadorDe(envio.integracao);
    const deps: DepsProcessador = {
      buscar,
      agora,
      gravarResultado: async (resultado) => {
        const gravou = await db.update(t).set({ resultado }).where(aindaMeu(meu)).returning({ id: t.id });
        if (gravou.length === 0) throw new Error("O envio já não é desta execução");
      },
    };
    // A chamada e a gravação do resultado ficam separadas: erro ao gravar não pode virar "falha" de um envio que
    // saiu (seria mandado de novo). O envio fica `enviando`, o cron o solta depois de 10 min e o resultado parcial
    // gravado pelo processador evita criar de novo.
    let resultado: unknown;
    let erro: ErroServico | null = null;
    let espera: MotivoEspera | null = null;
    try {
      if (!processador) throw new ErroIntegracao("servidor", null);
      resultado = await processador(envio, deps);
    } catch (e) {
      if (e instanceof EsperaIntegracao) espera = e.motivo;
      else erro = erroDe(e);
    }
    try {
      // Espera não é envio nem falha: não conta em nenhum dos dois.
      if (espera) await gravarEspera(envio, espera, relogio());
      else if (erro) {
        logarFalha(envio.integracao, erro);
        if (await gravarFalha(envio, erro, relogio())) falhas++;
      } else if (await gravarSucesso(envio, resultado, relogio())) {
        enviados++;
      }
    } catch (e) {
      logarErroDaFila(`${envio.integracao}: falha ao gravar o envio`, e);
    }
  }
  return { enviados, falhas };
}

/**
 * Agenda `processarFila()` para depois da resposta (Server Action ou rota), logo depois do commit do evento. Nunca
 * lança para quem chama: o cron pega o que ficar para trás.
 */
export function processarDepois(): void {
  // Nenhuma integração da fila ligada: nada a mandar (e nenhum trabalho depois da resposta).
  if (!INTEGRACOES_FILA.some((i) => estadoIntegracao(i).configurada)) return;
  try {
    after(async () => {
      try {
        await processarFila();
      } catch (e) {
        logarErroDaFila("falha ao processar a fila", e);
      }
    });
  } catch (e) {
    logarErroDaFila("não agendou a fila", e);
  }
}

/**
 * Reenviar (Admin › Integrações): `falhou` ou `pendente` volta a `pendente` para agora, com as tentativas zeradas;
 * o `resultado` fica (ids já criados são reaproveitados). `enviado` e `enviando` não mudam. Auditado com quem pediu
 * (null = sistema). Devolve se mudou.
 */
export async function reenviar(envioId: string, usuarioId: string | null = null): Promise<boolean> {
  return db.transaction((tx) => reenviarNaTransacao(tx, envioId, usuarioId));
}

/** `reenviar` dentro da transação de quem chama (ex.: "Enviar para o Trello" retomando o checklist do roteiro). */
export async function reenviarNaTransacao(tx: Transacao, envioId: string, usuarioId: string | null): Promise<boolean> {
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
}
