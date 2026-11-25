import "server-only";
import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import { nomesDaSaudacao, textoDoDaily } from "@/domain/daily";
import { ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { clientes, dailies, pessoas, roteiros, viagemPassageiros, viagens } from "@/server/db/schema";
import { lerRegrasVigentes } from "@/server/queries/regras";

// Núcleo de gerar o daily (server-only, sem `comPerfil`), usado por `gerarDaily` (Server Action, com a pessoa) e pelo
// agendador (`gerarDailiesDoDia`, cron, `usuarioId` nulo). Também guarda as leituras e travas que as outras actions de
// `src/server/actions/dailies.ts` usam.
//
// Dois modos:
// - pessoa (`sistema` ausente): o de sempre. Não exige roteiro aprovado (D28); "Gerar de novo" num daily gerado ou
//   revisado exige `atualizadoEmEsperado`; daily enviado recusa.
// - sistema (`sistema: true`): só roteiro aprovado; só dia sem linha ou com `estado = pendente` (sem conferir versão,
//   o cron não tem tela aberta); texto gerado, revisado ou enviado nunca é sobrescrito. Tudo conferido sob as travas.

export type Falha = { ok: false; erro: string; campos?: Record<string, string>; conflito?: true };
export type DailyDb = typeof dailies.$inferSelect;
type RoteiroDb = typeof roteiros.$inferSelect;

export const SEM_ROTEIRO: Falha = { ok: false, erro: "Crie o roteiro antes dos dailies" };
export const FORA_DO_ROTEIRO: Falha = { ok: false, erro: "Dia fora do roteiro" };
export const NAO_VENDIDA: Falha = { ok: false, erro: "A viagem ainda não foi vendida" };
export const NAO_ENCONTRADO: Falha = { ok: false, erro: "Daily não encontrado" };
export const JA_ENVIADO: Falha = { ok: false, erro: "Daily já enviado: desfaça o envio para editar" };
export const CONCORRENCIA: Falha = { ok: false, erro: "Este daily foi alterado por outra pessoa. Recarregue a página.", conflito: true };
// Só no modo sistema (o agendador conta como pulado; nunca chega a uma tela).
const NAO_APROVADO: Falha = { ok: false, erro: "Roteiro não aprovado" };
const JA_TEM_TEXTO: Falha = { ok: false, erro: "Daily já tem texto" };

export const ehFalha = (x: unknown): x is Falha => typeof x === "object" && x !== null && "ok" in x && (x as Falha).ok === false;

export const semId = (r: DailyDb) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "id"));

export const conferirVersao = (d: DailyDb, esperado: string | undefined) =>
  !!esperado && new Date(esperado).getTime() === d.atualizadoEm.getTime();

const ehData = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * Roteiro lido `for share` e a viagem dele, vendida e não excluída; a data precisa ser um dia do roteiro. O lock
 * compartilhado faz um `salvarRoteiro` concorrente (que trava o roteiro `for update`) esperar o fim desta transação,
 * então o texto gerado nunca sai de um conteúdo já substituído sem o aviso de "roteiro mudou". Sem ciclo de locks:
 * ninguém trava um daily e depois o roteiro.
 */
export async function roteiroDoDia(tx: Transacao, roteiroId: string, data: string): Promise<{ r: RoteiroDb } | Falha> {
  if (!ehUuid(roteiroId)) return SEM_ROTEIRO;
  const [r] = await tx.select().from(roteiros).where(eq(roteiros.id, roteiroId)).for("share");
  if (!r) return SEM_ROTEIRO;
  const [v] = await tx
    .select({ status: viagens.status })
    .from(viagens)
    .where(and(eq(viagens.id, r.viagemId), isNull(viagens.excluidoEm)));
  if (!v) return SEM_ROTEIRO;
  if (v.status !== "vendida") return NAO_VENDIDA;
  if (!ehData(data) || !r.conteudo.dias.some((d) => d.data === data)) return FORA_DO_ROTEIRO;
  return { r };
}

/** Linha do dia travada, ou null se ainda não existe. */
export async function travarDoDia(tx: Transacao, roteiroId: string, data: string): Promise<DailyDb | null> {
  const [d] = await tx
    .select()
    .from(dailies)
    .where(and(eq(dailies.roteiroId, roteiroId), eq(dailies.data, data)))
    .for("update");
  return d ?? null;
}

/**
 * Cria a linha do dia; se outra pessoa a criou no meio tempo (índice único), é conflito. Devolve a linha criada.
 */
export async function inserirDoDia(tx: Transacao, valores: typeof dailies.$inferInsert): Promise<DailyDb | Falha> {
  const [novo] = await tx.insert(dailies).values(valores).onConflictDoNothing({ target: [dailies.roteiroId, dailies.data] }).returning();
  return novo ?? CONCORRENCIA;
}

/** Primeiros nomes dos passageiros (pessoas não removidas, ordem do cadastro) ou o nome do grupo. */
async function nomesDaViagem(tx: Transacao, viagemId: string): Promise<string> {
  const [c] = await tx
    .select({ grupo: clientes.grupo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(viagens.id, viagemId));
  const ps = await tx
    .select({ nome: pessoas.nome })
    .from(viagemPassageiros)
    .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
    .where(and(eq(viagemPassageiros.viagemId, viagemId), isNull(pessoas.removidoEm)))
    .orderBy(asc(pessoas.ordem), asc(pessoas.nome));
  return nomesDaSaudacao(
    ps.map((p) => p.nome),
    c?.grupo ?? "",
  );
}

export type PedidoGeracao = {
  roteiroId: string;
  data: string;
  /** Quem gerou; null = sistema (agendador). Vai para `gerado_por` e para a auditoria. */
  usuarioId: string | null;
  /** Encerramento vigente (lido fora da transação: `regrasVigentes` pode abrir a própria transação). */
  encerramento: string;
  atualizadoEmEsperado?: string;
  sistema?: boolean;
};

/**
 * Monta o texto do dia com o modelo (`textoDoDaily`) e o encerramento e grava `estado = gerado`, na transação de quem
 * chama. Cria a linha se ainda não existe; se existe, segue as regras do modo (ver o topo do arquivo). Audita com
 * `usuarioId` (nulo para o sistema).
 */
export async function gerarDailyNaTransacao(tx: Transacao, p: PedidoGeracao): Promise<{ viagemId: string; d: DailyDb } | Falha> {
  const x = await roteiroDoDia(tx, p.roteiroId, p.data);
  if (ehFalha(x)) return x;
  if (p.sistema && x.r.status !== "aprovado") return NAO_APROVADO;
  const dia = x.r.conteudo.dias.find((d) => d.data === p.data)!;
  const texto = textoDoDaily({
    data: p.data,
    idioma: x.r.idioma,
    nomes: await nomesDaViagem(tx, x.r.viagemId),
    dia,
    hoteis: x.r.conteudo.hoteis,
    encerramento: p.encerramento,
  });
  const agora = new Date();
  const colunas = { estado: "gerado" as const, texto, geradoEm: agora, geradoPor: p.usuarioId, atualizadoEm: agora };
  const antes = await travarDoDia(tx, p.roteiroId, p.data);
  if (!antes) {
    const novo = await inserirDoDia(tx, { roteiroId: p.roteiroId, data: p.data, ...colunas });
    if (ehFalha(novo)) return novo;
    await registrarAuditoria(tx, { usuarioId: p.usuarioId, tabela: "dailies", registroId: novo.id, acao: "criar", depois: semId(novo) });
    return { viagemId: x.r.viagemId, d: novo };
  }
  if (p.sistema) {
    if (antes.estado !== "pendente") return JA_TEM_TEXTO;
  } else {
    if (antes.estado === "enviado") return JA_ENVIADO;
    if (!conferirVersao(antes, p.atualizadoEmEsperado)) return CONCORRENCIA;
  }
  const [depois] = await tx
    .update(dailies)
    .set({ ...colunas, revisadoEm: null, revisadoPor: null })
    .where(eq(dailies.id, antes.id))
    .returning();
  await registrarAuditoria(tx, {
    usuarioId: p.usuarioId,
    tabela: "dailies",
    registroId: antes.id,
    acao: "alterar",
    antes: semId(antes),
    depois: semId(depois),
  });
  return { viagemId: x.r.viagemId, d: depois };
}

const codigoDe = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.cause?.code ?? x?.code;
};

/**
 * Agendador do daily (D-2): para cada roteiro **aprovado** de viagem **vendida** (não excluída) que tem o dia `data`
 * e ainda não tem texto nesse dia (sem linha ou `pendente`), gera o daily como sistema (`gerado_por` nulo, auditoria
 * com usuário nulo). Cada daily na própria transação; um erro de banco num roteiro é logado (só o código), conta como
 * pulado e não impede os outros. `pulados` = candidatos que não foram gerados (já tinham texto, mudaram no meio
 * tempo ou deram erro).
 */
export async function gerarDailiesDoDia(data: string): Promise<{ gerados: number; pulados: number }> {
  if (!ehData(data)) return { gerados: 0, pulados: 0 };
  const candidatos = await db
    .select({ id: roteiros.id, conteudo: roteiros.conteudo })
    .from(roteiros)
    .innerJoin(viagens, eq(viagens.id, roteiros.viagemId))
    .where(and(eq(roteiros.status, "aprovado"), eq(viagens.status, "vendida"), isNull(viagens.excluidoEm), lte(viagens.inicio, data), gte(viagens.fim, data)))
    .orderBy(asc(roteiros.id));
  const doDia = candidatos.filter((r) => r.conteudo.dias.some((d) => d.data === data));
  if (doDia.length === 0) return { gerados: 0, pulados: 0 };
  const encerramento = (await lerRegrasVigentes()).valores.encerramentoDaily;
  let gerados = 0;
  let pulados = 0;
  for (const r of doDia) {
    try {
      const res = await db.transaction((tx) =>
        gerarDailyNaTransacao(tx, { roteiroId: r.id, data, usuarioId: null, encerramento, sistema: true }),
      );
      if (ehFalha(res)) pulados++;
      else gerados++;
    } catch (e) {
      console.error("Erro ao gerar o daily pelo agendador", { code: codigoDe(e) });
      pulados++;
    }
  }
  return { gerados, pulados };
}
