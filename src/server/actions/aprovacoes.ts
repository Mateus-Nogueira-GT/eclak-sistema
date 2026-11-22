"use server";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
  ajustarSnapshot,
  ajusteSchema,
  envioSchema,
  itensDoSnapshot,
  motivoSchema,
  MOTIVO_SUBSTITUIDA,
  MSG_JA_DECIDIDO,
  MSG_NAO_CALCULA,
  precoCalculado,
  custosDoSnapshot,
  resultadoDaVersao,
  type ItemLido,
  type ResultadoVersao,
  type Snapshot,
} from "@/domain/aprovacoes";
import type { FormaPagamento, Rateio } from "@/domain/precificacao";
import type { Regras } from "@/domain/regras";
import { MSG_VIAGEM_VENDIDA } from "@/domain/venda-entrada";
import { diasDaViagem } from "@/domain/viagens";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { cotacoes, fornecedores, itensViagem, pessoas, versoesPrecificacao, viagemPassageiros, viagens } from "@/server/db/schema";
import { regrasDaVersao, regrasVigentes } from "@/server/queries/regras";
import { sincronizarTaxaRoteiro } from "@/server/taxa-roteiro";
import { travarViagem } from "@/server/trava-viagem";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Ordem das travas (igual em todas as actions daqui): lock consultivo da viagem → viagem `for update` →
// versão `for update`. As actions de itens/cotações travam a viagem `for update`, então o envio e as
// decisões ficam serializados com elas.

export type EnvioEntrada = {
  /** Reais em formato brasileiro ("71.273,78"); vazio = preço calculado pela fórmula na forma escolhida. */
  preco?: string | null;
  forma: FormaPagamento;
  /** "O que mudou" desde a versão anterior. */
  alteracao: string;
};

export type AjusteEntrada = {
  /** Reais em formato brasileiro. */
  preco: string;
  forma: FormaPagamento;
  /** Padrão: o rateio da versão ajustada. */
  rateio?: Rateio;
  /**
   * Ajustes por item, só no snapshot da nova versão (itens e cotações não mudam). Cada um vale para uma cotação
   * do item (padrão: a precificada no momento). Valor em reais; comissão "4,5".
   */
  itens?: { itemId: string; cotacaoId?: string; valorFornecedor?: string; comissaoPct?: string }[];
};

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
const ORCAMENTO_NAO_ENCONTRADO: Falha = { ok: false, erro: "Orçamento não encontrado" };
const PEDIDO_NAO_ENCONTRADO: Falha = { ok: false, erro: "Pedido não encontrado" };
const DECIDIDO: Falha = { ok: false, erro: MSG_JA_DECIDIDO };
const NAO_CALCULA: Falha = { ok: false, erro: MSG_NAO_CALCULA };
const VENDIDA: Falha = { ok: false, erro: MSG_VIAGEM_VENDIDA };
const AGUARDANDO: Falha = {
  ok: false,
  erro: "Orçamento aguardando aprovação. Peça ao Diretor para devolver antes de alterar.",
};

type ViagemLinha = typeof viagens.$inferSelect;
type VersaoLinha = typeof versoesPrecificacao.$inferSelect;

/** Recusa dentro da transação que precisa desfazer o que já foi gravado; vira a `falha` fora dela. */
class Desfazer extends Error {
  constructor(readonly falha: Falha) {
    super(falha.erro);
  }
}

const ehFalha = (x: unknown): x is Falha => typeof x === "object" && x !== null && "ok" in x;

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

function falhaDeValidacao(erro: import("zod").ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

const semId = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id"));

/** Itens ativos da viagem com as cotações ativas (mais antigas primeiro); taxa automática por último. */
async function lerItens(tx: Transacao, viagemId: string): Promise<ItemLido[]> {
  const itens = await tx
    .select()
    .from(itensViagem)
    .where(and(eq(itensViagem.viagemId, viagemId), isNull(itensViagem.excluidoEm)))
    .orderBy(asc(itensViagem.automatico), asc(itensViagem.ordem));
  if (itens.length === 0) return [];
  const cots = await tx
    .select({ c: cotacoes, fornecedor: fornecedores.nome })
    .from(cotacoes)
    .leftJoin(fornecedores, eq(fornecedores.id, cotacoes.fornecedorId))
    .where(and(inArray(cotacoes.itemId, itens.map((i) => i.id)), isNull(cotacoes.excluidoEm)))
    .orderBy(asc(cotacoes.criadoEm), asc(cotacoes.id));
  return itens.map((i) => ({
    id: i.id,
    ordem: i.ordem,
    tipo: i.tipo,
    cidade: i.cidade,
    servico: i.servico,
    checkin: i.checkin,
    checkout: i.checkout,
    diarias: i.diarias,
    automatico: i.automatico,
    cotacoes: cots
      .filter((x) => x.c.itemId === i.id)
      .map(({ c, fornecedor }) => ({
        id: c.id,
        fornecedorId: c.fornecedorId,
        fornecedor: c.fornecedorId ? (fornecedor ?? null) : null,
        moeda: c.moeda,
        valorOriginal: c.valorOriginal,
        cambioComercial: c.cambioComercial,
        cambioAplicado: c.cambioAplicado,
        cambioData: c.cambioData,
        valorBrl: c.valorBrl,
        comissaoPct: c.comissaoPct,
        descontoAVistaPct: c.descontoAVistaPct,
        tarifaFixa: c.tarifaFixa,
        escolhida: c.escolhida,
      })),
  }));
}

async function proximoNumero(tx: Transacao, viagemId: string): Promise<number> {
  const [r] = await tx
    .select({ max: sql<number>`coalesce(max(${versoesPrecificacao.numero}), 0)::int` })
    .from(versoesPrecificacao)
    .where(eq(versoesPrecificacao.viagemId, viagemId));
  return r.max + 1;
}

async function mudarStatusViagem(
  tx: Transacao,
  usuarioId: string,
  v: ViagemLinha,
  depois: Pick<ViagemLinha, "status"> & Partial<Pick<ViagemLinha, "versaoAprovadaId" | "notaCliente">>,
  agora: Date,
): Promise<void> {
  await tx
    .update(viagens)
    .set({ ...depois, atualizadoEm: agora })
    .where(eq(viagens.id, v.id));
  await registrarAuditoria(tx, {
    usuarioId,
    tabela: "viagens",
    registroId: v.id,
    acao: "alterar",
    antes: {
      status: v.status,
      ...("versaoAprovadaId" in depois ? { versaoAprovadaId: v.versaoAprovadaId } : {}),
      ...("notaCliente" in depois ? { notaCliente: v.notaCliente } : {}),
    },
    depois,
  });
}

function revalidar(viagemId: string) {
  revalidatePath("/viagens");
  revalidatePath(`/viagens/${viagemId}`);
  revalidatePath("/aprovacoes");
}

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/**
 * Envia o orçamento para o Diretor: nova versão (`numero` = última + 1) `aguardando`, com o snapshot do que foi
 * precificado (pior custo e escolhida de cada item), as regras vigentes e o rateio vigente. Qualquer perfil.
 */
export async function enviarParaAprovacao(
  viagemId: string,
  dados: EnvioEntrada,
): Promise<{ ok: true; id: string; numero: number } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(viagemId)) return ORCAMENTO_NAO_ENCONTRADO;
    const vig = await regrasVigentes();
    const regras = vig.valores;
    const p = envioSchema(regras.parcelamentoMaximo).safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const { forma, alteracao } = p.data;

    let r: { id: string; numero: number } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const v = await travarViagem(tx, viagemId);
        if (!v) return ORCAMENTO_NAO_ENCONTRADO;
        if (v.status === "aguardando_aprovacao") return AGUARDANDO;
        if (v.status === "vendida") return VENDIDA;
        const agora = new Date();
        // A taxa de roteiro acompanha os Parâmetros vigentes antes do snapshot (mudou desde a última edição?).
        // Daqui em diante, recusa desfaz a transação (Desfazer): envio que falha não muda nada.
        await sincronizarTaxaRoteiro(tx, viagemId, regras, usuario.id, agora);
        const itens = itensDoSnapshot(await lerItens(tx, viagemId));
        if ("erro" in itens) throw new Desfazer({ ok: false, erro: itens.erro });
        const passageiros = await tx
          .select({ id: pessoas.id, nome: pessoas.nome })
          .from(viagemPassageiros)
          .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
          .where(eq(viagemPassageiros.viagemId, viagemId))
          .orderBy(asc(pessoas.ordem), asc(pessoas.nome));
        const snapshot: Snapshot = { destino: v.destino, inicio: v.inicio, fim: v.fim, passageiros, itens };
        const dias = diasDaViagem(v.inicio, v.fim);
        const rateio = regras.rateio.metodo;
        const preco = p.data.preco ?? precoCalculado(custosDoSnapshot(snapshot).custo, forma, regras);
        if (preco === null) throw new Desfazer(NAO_CALCULA);
        let resultado: ResultadoVersao;
        try {
          resultado = resultadoDaVersao(snapshot, preco, forma, dias, rateio, regras);
        } catch {
          throw new Desfazer(NAO_CALCULA);
        }

        const [ver] = await tx
          .insert(versoesPrecificacao)
          .values({
            viagemId,
            numero: await proximoNumero(tx, viagemId),
            status: "aguardando",
            snapshot,
            preco,
            forma,
            dias,
            regrasVersaoId: vig.versaoId,
            rateio,
            resultado,
            alteracao,
            enviadoPor: usuario.id,
            enviadoEm: agora,
          })
          .returning();
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "versoes_precificacao",
          registroId: ver.id,
          acao: "criar",
          depois: semId(ver),
        });
        // O pedido de ajustes do cliente foi atendido por esta versão.
        const depois = v.notaCliente === null ? {} : { notaCliente: null };
        await mudarStatusViagem(tx, usuario.id, v, { status: "aguardando_aprovacao", ...depois }, agora);
        return { id: ver.id, numero: ver.numero };
      });
    } catch (e) {
      if (e instanceof Desfazer) return e.falha;
      throw erroDeBanco("Erro ao enviar para aprovação", e);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    return { ok: true, ...r };
  });
}

// ---------------------------------------------------------------------------
// Decisão do Diretor
// ---------------------------------------------------------------------------

/** Viagem da versão (sem trava), para travar a viagem antes da versão. */
async function versaoSemTrava(versaoId: string): Promise<Pick<VersaoLinha, "viagemId" | "regrasVersaoId"> | null> {
  if (!ehUuid(versaoId)) return null;
  const [x] = await db
    .select({ viagemId: versoesPrecificacao.viagemId, regrasVersaoId: versoesPrecificacao.regrasVersaoId })
    .from(versoesPrecificacao)
    .where(eq(versoesPrecificacao.id, versaoId));
  return x ?? null;
}

/** Trava viagem e versão; só a última versão da viagem, e só `aguardando`, pode ser decidida. */
async function travarPedido(tx: Transacao, versaoId: string, viagemId: string): Promise<{ v: ViagemLinha; ver: VersaoLinha } | Falha> {
  const v = await travarViagem(tx, viagemId);
  if (!v) return PEDIDO_NAO_ENCONTRADO;
  if (v.status === "vendida") return VENDIDA;
  const [ver] = await tx.select().from(versoesPrecificacao).where(eq(versoesPrecificacao.id, versaoId)).for("update");
  if (!ver) return PEDIDO_NAO_ENCONTRADO;
  if (ver.status !== "aguardando") return DECIDIDO;
  if (ver.numero !== (await proximoNumero(tx, viagemId)) - 1) return DECIDIDO;
  return { v, ver };
}

async function decidirVersao(
  tx: Transacao,
  usuarioId: string,
  ver: VersaoLinha,
  status: "aprovada" | "devolvida",
  comentario: string | null,
  agora: Date,
): Promise<void> {
  const depois = { status, decididoPor: usuarioId, decididoEm: agora, comentario };
  await tx.update(versoesPrecificacao).set(depois).where(eq(versoesPrecificacao.id, ver.id));
  await registrarAuditoria(tx, {
    usuarioId,
    tabela: "versoes_precificacao",
    registroId: ver.id,
    acao: "alterar",
    antes: { status: ver.status, decididoPor: ver.decididoPor, decididoEm: ver.decididoEm, comentario: ver.comentario },
    depois,
  });
}

/** Roda uma decisão sobre a versão `aguardando` mais recente. */
async function decidir<T extends object>(
  versaoId: string,
  fn: (tx: Transacao, ctx: { v: ViagemLinha; ver: VersaoLinha; agora: Date }) => Promise<T | Falha>,
  mensagemErro: string,
  ref?: Pick<VersaoLinha, "viagemId"> | null,
): Promise<({ ok: true } & T) | Falha> {
  const alvo = ref === undefined ? await versaoSemTrava(versaoId) : ref;
  if (!alvo) return PEDIDO_NAO_ENCONTRADO;
  let r: T | Falha;
  try {
    r = await db.transaction(async (tx) => {
      const p = await travarPedido(tx, versaoId, alvo.viagemId);
      if (ehFalha(p)) return p;
      return fn(tx, { ...p, agora: new Date() });
    });
  } catch (e) {
    throw erroDeBanco(mensagemErro, e);
  }
  if (ehFalha(r)) return r;
  revalidar(alvo.viagemId);
  return { ok: true, ...r };
}

/** Aprova a versão: viagem `aprovado` com `versao_aprovada_id` = esta. Só o Diretor. */
export async function aprovar(versaoId: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], (usuario) =>
    decidir(
      versaoId,
      async (tx, { v, ver, agora }) => {
        await decidirVersao(tx, usuario.id, ver, "aprovada", null, agora);
        await mudarStatusViagem(tx, usuario.id, v, { status: "aprovado", versaoAprovadaId: ver.id }, agora);
        return {};
      },
      "Erro ao aprovar",
    ),
  );
}

/**
 * Devolve a versão com o motivo (obrigatório): viagem `devolvido`; a última versão aprovada, se houver, fica.
 * Nova forma recusada (`resultado.origem = "nova_forma"`): a viagem volta a `aprovado` com a versão aprovada
 * anterior (a forma original continua valendo para fechar a venda).
 */
export async function devolver(versaoId: string, comentario: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    const m = motivoSchema.safeParse(comentario);
    if (!m.success) return { ok: false, erro: m.error.issues[0].message, campos: { comentario: m.error.issues[0].message } };
    return decidir(
      versaoId,
      async (tx, { v, ver, agora }) => {
        await decidirVersao(tx, usuario.id, ver, "devolvida", m.data, agora);
        const novaForma = (ver.resultado as ResultadoVersao).origem === "nova_forma" && v.versaoAprovadaId !== null;
        await mudarStatusViagem(tx, usuario.id, v, { status: novaForma ? "aprovado" : "devolvido" }, agora);
        return {};
      },
      "Erro ao devolver",
    );
  });
}

/**
 * Aprova com ajuste: cria a versão seguinte `aprovada_com_ajuste` (snapshot copiado com os ajustes, mesmas
 * regras e dias da versão ajustada), marca a ajustada `devolvida` (MOTIVO_SUBSTITUIDA) e
 * aprova a viagem com a nova. Itens e cotações não mudam. Só o Diretor.
 */
export async function aprovarComAjuste(
  versaoId: string,
  dados: AjusteEntrada,
): Promise<{ ok: true; id: string; numero: number } | Falha> {
  return comPerfil(["diretor"], async (usuario) => {
    const ref = await versaoSemTrava(versaoId);
    if (!ref) return PEDIDO_NAO_ENCONTRADO;
    const regras: Regras = await regrasDaVersao(ref.regrasVersaoId);
    const p = ajusteSchema(regras.parcelamentoMaximo).safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const { preco, forma } = p.data;

    return decidir(
      versaoId,
      async (tx, { v, ver, agora }) => {
        const snapshot = ajustarSnapshot(ver.snapshot as Snapshot, p.data.itens ?? []);
        if ("erro" in snapshot) return { ok: false, erro: snapshot.erro } satisfies Falha;
        const rateio = p.data.rateio ?? (ver.rateio as Rateio);
        let resultado: ResultadoVersao;
        try {
          resultado = resultadoDaVersao(snapshot, preco, forma, ver.dias, rateio, regras);
        } catch {
          return NAO_CALCULA;
        }
        const [nova] = await tx
          .insert(versoesPrecificacao)
          .values({
            viagemId: v.id,
            numero: ver.numero + 1,
            status: "aprovada_com_ajuste",
            snapshot,
            preco,
            forma,
            dias: ver.dias,
            regrasVersaoId: ver.regrasVersaoId,
            rateio,
            resultado,
            alteracao: "Ajuste do Diretor",
            enviadoPor: usuario.id,
            enviadoEm: agora,
            decididoPor: usuario.id,
            decididoEm: agora,
          })
          .returning();
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "versoes_precificacao",
          registroId: nova.id,
          acao: "criar",
          depois: semId(nova),
        });
        await decidirVersao(tx, usuario.id, ver, "devolvida", MOTIVO_SUBSTITUIDA, agora);
        await mudarStatusViagem(tx, usuario.id, v, { status: "aprovado", versaoAprovadaId: nova.id }, agora);
        return { id: nova.id, numero: nova.numero };
      },
      "Erro ao aprovar com ajuste",
      ref,
    );
  });
}
