"use server";

import { and, asc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { chavePasta } from "@/domain/drive";
import { INTEGRACOES, type Integracao, type IntegracaoFila } from "@/domain/integracoes";
import { chaveRoteiro, chaveVenda } from "@/domain/trello";
import { comPerfil, ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import type { Transacao } from "@/server/db/client";
import { integracaoEnvios, roteiros, tarefas, viagens } from "@/server/db/schema";
import { estadoIntegracao } from "@/server/integracoes/config";
import { agendarEnvios, eventoCartaoDaViagem, eventoChecklistDoRoteiro, eventoPastaDaViagem } from "@/server/integracoes/eventos";
import { inserirEnvio, reenviarNaTransacao } from "@/server/integracoes/fila";
import { TESTES_CONEXAO, type ResultadoTeste } from "@/server/integracoes/testes";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint). Só o Diretor.

type Falha = { ok: false; erro: string };

const VIAGEM_NAO_ENCONTRADA: Falha = { ok: false, erro: "Viagem não encontrada" };
const NAO_VENDIDA: Falha = { ok: false, erro: "A viagem ainda não foi vendida" };
const TRELLO_DESLIGADO: Falha = { ok: false, erro: "O Trello não está configurado" };
const JA_NO_TRELLO: Falha = { ok: false, erro: "Esta viagem já foi enviada ao Trello" };
const DRIVE_DESLIGADO: Falha = { ok: false, erro: "O Google Drive não está configurado" };
const JA_NO_DRIVE: Falha = { ok: false, erro: "As pastas desta viagem já foram criadas no Drive" };
const DESCONHECIDA: Falha = { ok: false, erro: "Integração desconhecida" };
const DESLIGADA: Falha = { ok: false, erro: "Integração desligada" };
const SEM_TESTE: Falha = { ok: false, erro: "Esta integração não tem teste de conexão" };
const ENVIO_NAO_ENCONTRADO: Falha = { ok: false, erro: "Envio não encontrado" };
const NAO_REENVIA: Falha = { ok: false, erro: "Este envio não pode ser reenviado agora" };

function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

/** Itens (não excluídos, na ordem da lista) das tarefas automáticas da viagem com essa origem. */
async function itensDe(tx: Transacao, viagemId: string, origem: "venda" | "roteiro"): Promise<string[]> {
  const linhas = await tx
    .select({ item: tarefas.item })
    .from(tarefas)
    .where(and(eq(tarefas.viagemId, viagemId), eq(tarefas.origem, origem), isNull(tarefas.excluidoEm)))
    .orderBy(asc(tarefas.ordem));
  return linhas.map((l) => l.item);
}

/**
 * Com o roteiro aprovado, o checklist "Tarefas do roteiro" vai junto: entra na fila com as tarefas do roteiro de
 * agora; se já estava na fila (`pendente`) ou falhou esperando o cartão (`falhou`), volta para agora com as
 * tentativas zeradas (como Reenviar). `enviado` e `enviando` ficam.
 */
async function checklistDoRoteiroJunto(tx: Transacao, viagemId: string, usuarioId: string): Promise<void> {
  const [r] = await tx.select({ status: roteiros.status }).from(roteiros).where(eq(roteiros.viagemId, viagemId));
  if (r?.status !== "aprovado") return;
  const [existente] = await tx
    .select({ id: integracaoEnvios.id })
    .from(integracaoEnvios)
    .where(and(eq(integracaoEnvios.integracao, "trello"), eq(integracaoEnvios.chave, chaveRoteiro(viagemId))));
  if (existente) {
    await reenviarNaTransacao(tx, existente.id, usuarioId);
    return;
  }
  const id = await inserirEnvio(tx, eventoChecklistDoRoteiro(viagemId, await itensDe(tx, viagemId, "roteiro")));
  if (id) await auditarCriacao(tx, usuarioId, id, "trello", "checklist_roteiro", chaveRoteiro(viagemId));
}

function auditarCriacao(tx: Transacao, usuarioId: string, id: string, integracao: IntegracaoFila, tipo: string, chave: string) {
  return registrarAuditoria(tx, {
    usuarioId,
    tabela: "integracao_envios",
    registroId: id,
    acao: "criar",
    depois: { integracao, tipo, chave, situacao: "pendente" },
  });
}

/**
 * Viagem vendida antes de o Trello ser ligado (nada acumula enquanto desligado, R-C1): põe na fila o cartão com as
 * tarefas da venda que a viagem tem agora (não excluídas, na ordem da lista) e, se o roteiro já está aprovado, o
 * checklist do roteiro. Uma vez por viagem: se o envio do cartão já existe (enviado, pendente ou com falha), recusa;
 * a falha se reenvia em Admin › Integrações. A configuração é conferida uma vez só, dentro da transação.
 */
export async function enviarViagemAoTrello(viagemId: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    let r: { ok: true } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        if (!estadoIntegracao("trello").configurada) return TRELLO_DESLIGADO;
        const [v] = await tx
          .select({ status: viagens.status })
          .from(viagens)
          .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
        if (!v) return VIAGEM_NAO_ENCONTRADA;
        if (v.status !== "vendida") return NAO_VENDIDA;
        const evento = await eventoCartaoDaViagem(tx, viagemId, await itensDe(tx, viagemId, "venda"));
        const id = evento ? await inserirEnvio(tx, evento) : null;
        if (!id) return JA_NO_TRELLO;
        await auditarCriacao(tx, usuario.id, id, "trello", "cartao_viagem", chaveVenda(viagemId));
        await checklistDoRoteiroJunto(tx, viagemId, usuario.id);
        return { ok: true as const };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao enviar a viagem ao Trello", x);
    }
    if (!r.ok) return r;
    revalidatePath(`/viagens/${viagemId}`);
    agendarEnvios();
    return r;
  });
}

/**
 * Viagem vendida antes de o Drive ser ligado (R-C1): põe na fila a pasta da viagem com "Público" e "Uso interno". Uma
 * vez por viagem: se o envio da pasta já existe (enviado, pendente ou com falha), recusa; a falha se reenvia em
 * Admin › Integrações. A configuração é conferida uma vez só, dentro da transação.
 */
export async function criarPastasNoDrive(viagemId: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    if (!ehUuid(viagemId)) return VIAGEM_NAO_ENCONTRADA;
    let r: { ok: true } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        if (!estadoIntegracao("drive").configurada) return DRIVE_DESLIGADO;
        const [v] = await tx
          .select({ status: viagens.status })
          .from(viagens)
          .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
        if (!v) return VIAGEM_NAO_ENCONTRADA;
        if (v.status !== "vendida") return NAO_VENDIDA;
        const evento = await eventoPastaDaViagem(tx, viagemId);
        const id = evento ? await inserirEnvio(tx, evento) : null;
        if (!id) return JA_NO_DRIVE;
        await auditarCriacao(tx, usuario.id, id, "drive", "pasta_viagem", chavePasta(viagemId));
        return { ok: true as const };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao criar as pastas no Drive", x);
    }
    if (!r.ok) return r;
    revalidatePath(`/viagens/${viagemId}`);
    agendarEnvios();
    return r;
  });
}

const ehIntegracao = (v: unknown): v is Integracao => typeof v === "string" && (INTEGRACOES as readonly string[]).includes(v);

/**
 * "Testar conexão" (Admin › Integrações): só com a integração ligada; uma chamada de leitura ao serviço, FORA de
 * transação; depois audita `{ ok, classe }` (tabela `integracoes`, registro = nome da integração), sem segredo nem
 * resposta do serviço. Teste que falhou também é `{ ok: true }` (o teste rodou); o resultado vem em `conexao`.
 */
export async function testarConexao(integracao: string): Promise<{ ok: true; conexao: ResultadoTeste } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    if (!ehIntegracao(integracao)) return DESCONHECIDA;
    if (!estadoIntegracao(integracao).configurada) return DESLIGADA;
    const testar = TESTES_CONEXAO[integracao];
    if (!testar) return SEM_TESTE;
    let conexao: ResultadoTeste | null;
    try {
      conexao = await testar(fetch);
    } catch {
      // Os testadores não lançam; se lançar, é falha do serviço do ponto de vista da tela (sem a mensagem).
      conexao = { ok: false, classe: "servidor" };
    }
    if (!conexao) return DESLIGADA;
    const registro = conexao;
    try {
      // `acao: "criar"`: o enum de ações da auditoria não tem "testar"; cada teste é um registro novo (o resultado em
      // `depois`) e "Último teste" lê a auditoria mais recente de `tabela = 'integracoes'`.
      await db.transaction((tx) =>
        registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "integracoes", registroId: integracao, acao: "criar", depois: registro }),
      );
    } catch (x) {
      throw erroDeBanco("Erro ao registrar o teste de conexão", x);
    }
    revalidatePath("/admin/integracoes");
    return { ok: true as const, conexao: registro };
  });
}

/**
 * Reenviar (Admin › Integrações): `falhou` ou `pendente` volta para agora com as tentativas zeradas (ver
 * `reenviarNaTransacao`). Reenviar o cartão do Trello (`venda:`) reabre junto, na mesma transação, o checklist do
 * roteiro da mesma viagem que falhou esperando por ele; o que está pendente ou enviado fica.
 */
export async function reenviarEnvio(envioId: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    if (!ehUuid(envioId)) return ENVIO_NAO_ENCONTRADO;
    let r: { ok: true; viagemId: string | null } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const [e] = await tx
          .select({ integracao: integracaoEnvios.integracao, chave: integracaoEnvios.chave, viagemId: integracaoEnvios.viagemId })
          .from(integracaoEnvios)
          .where(eq(integracaoEnvios.id, envioId));
        if (!e) return ENVIO_NAO_ENCONTRADO;
        if (!(await reenviarNaTransacao(tx, envioId, usuario.id))) return NAO_REENVIA;
        if (e.integracao === "trello" && e.viagemId && e.chave === chaveVenda(e.viagemId)) {
          const [roteiro] = await tx
            .select({ id: integracaoEnvios.id })
            .from(integracaoEnvios)
            .where(
              and(
                eq(integracaoEnvios.integracao, "trello"),
                eq(integracaoEnvios.chave, chaveRoteiro(e.viagemId)),
                eq(integracaoEnvios.situacao, "falhou"),
              ),
            );
          if (roteiro) await reenviarNaTransacao(tx, roteiro.id, usuario.id);
        }
        return { ok: true as const, viagemId: e.viagemId };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao reenviar", x);
    }
    if (!r.ok) return r;
    revalidatePath("/admin/integracoes");
    if (r.viagemId) revalidatePath(`/viagens/${r.viagemId}`);
    agendarEnvios();
    return { ok: true as const };
  });
}
