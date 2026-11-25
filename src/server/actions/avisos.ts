"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { comunicadoSchema, justificativaSchema, recebe, SETOR_DO_TIPO, type Setor, type TipoAviso } from "@/domain/avisos";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { avisosDaCentral } from "@/server/avisos/central";
import { db, type Transacao } from "@/server/db/client";
import { avisosComunicados, avisosDispensados } from "@/server/db/schema";
import { falha, type Falha, type Ok } from "@/server/financeiro/baixas-viagem";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Central de avisos (fatia 5b, spec §8.4 e §14): dispensar e desfazer a dispensa de um aviso automático, criar e
// resolver comunicados, e o contador do topo. Os cinco perfis. Toda escrita audita na mesma transação.

const OK: Ok = { ok: true };
const AVISO_NAO_ENCONTRADO = falha("Aviso não encontrado");
const NAO_DISPENSAVEL = falha("Este aviso não pode ser dispensado");
const DISPENSA_NAO_ENCONTRADA = falha("Dispensa não encontrada");
const SO_QUEM_DISPENSOU = falha("Só quem dispensou ou o Diretor pode desfazer a dispensa");
const JA_RESOLVIDO = falha("Este aviso já foi resolvido");

/**
 * Contador do topo: o resultado por pessoa vale 60 s (spec §14). Qualquer gravação limpa tudo (a dispensa e o comunicado
 * valem para todos do setor) e avança a geração: um cálculo começado antes da limpeza não é guardado.
 */
const CACHE_MS = 60_000;
const contagens = new Map<string, { valor: number; ate: number }>();
let geracao = 0;

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

function aposGravar() {
  geracao += 1;
  contagens.clear();
  revalidatePath("/avisos");
}

async function transacao<T extends Ok | Falha>(mensagemErro: string, fn: (tx: Transacao) => Promise<T>): Promise<T> {
  try {
    return await db.transaction(fn);
  } catch (x) {
    const e = x as { code?: string; cause?: { code?: string } } | null;
    console.error(mensagemErro, { code: e?.cause?.code ?? e?.code });
    throw new Error(mensagemErro);
  }
}

/**
 * Dispensa um aviso automático que a pessoa recebe agora ("para mim", recalculado aqui), com justificativa de 10 a 500
 * caracteres. Grava tipo, título e detalhe como estão; o aviso some para todos enquanto a dispensa valer.
 */
export async function dispensarAviso(chave: string, justificativa: string): Promise<Ok | Falha> {
  return comPerfil([], async (usuario) => {
    const j = justificativaSchema.safeParse(justificativa);
    if (!j.success) return { ok: false, erro: j.error.issues[0].message, campos: { justificativa: j.error.issues[0].message } };
    if (typeof chave !== "string") return AVISO_NAO_ENCONTRADO;
    const aviso = (await avisosDaCentral({})).abertos.find((a) => a.chave === chave);
    if (!aviso) return AVISO_NAO_ENCONTRADO;
    if (!aviso.dispensavel) return NAO_DISPENSAVEL;
    const r = await transacao("Erro ao dispensar o aviso", async (tx) => {
      const [d] = await tx
        .insert(avisosDispensados)
        .values({ chave: aviso.chave, tipo: aviso.tipo, titulo: aviso.titulo, detalhe: aviso.detalhe, usuarioId: usuario.id, justificativa: j.data })
        .returning();
      await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "avisos_dispensados", registroId: d.id, acao: "criar", depois: d });
      return OK;
    });
    aposGravar();
    return r;
  });
}

/** Desfaz a dispensa (apaga a linha; a auditoria guarda): quem dispensou ou o Diretor. */
export async function desfazerDispensa(id: string): Promise<Ok | Falha> {
  return comPerfil([], async (usuario) => {
    if (typeof id !== "string" || !ehUuid(id)) return DISPENSA_NAO_ENCONTRADA;
    const r = await transacao("Erro ao desfazer a dispensa", async (tx): Promise<Ok | Falha> => {
      const [d] = await tx.select().from(avisosDispensados).where(eq(avisosDispensados.id, id)).for("update");
      const setor = d ? SETOR_DO_TIPO[d.tipo as TipoAviso] : undefined;
      if (!d || !setor || !recebe(usuario.perfil, setor)) return DISPENSA_NAO_ENCONTRADA;
      if (d.usuarioId !== usuario.id && usuario.perfil !== "diretor") return SO_QUEM_DISPENSOU;
      await tx.delete(avisosDispensados).where(eq(avisosDispensados.id, id));
      await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "avisos_dispensados", registroId: d.id, acao: "excluir", antes: d });
      return OK;
    });
    if (r.ok) aposGravar();
    return r;
  });
}

/** Comunicado para um setor (ou Geral): texto de 5 a 500 caracteres e próximo passo opcional, até 200. */
export async function criarComunicado(dados: unknown): Promise<Ok | Falha> {
  return comPerfil([], async (usuario) => {
    const p = comunicadoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const r = await transacao("Erro ao criar o aviso", async (tx) => {
      const [c] = await tx.insert(avisosComunicados).values({ ...p.data, criadoPor: usuario.id }).returning();
      await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "avisos_comunicados", registroId: c.id, acao: "criar", depois: c });
      return OK;
    });
    aposGravar();
    return r;
  });
}

/** Resolve o comunicado: quem recebe o setor ou quem criou. Resolvido sai das listas (fica no banco). */
export async function resolverComunicado(id: string): Promise<Ok | Falha> {
  return comPerfil([], async (usuario) => {
    if (typeof id !== "string" || !ehUuid(id)) return AVISO_NAO_ENCONTRADO;
    const r = await transacao("Erro ao resolver o aviso", async (tx): Promise<Ok | Falha> => {
      const [c] = await tx.select().from(avisosComunicados).where(eq(avisosComunicados.id, id)).for("update");
      if (!c || (c.criadoPor !== usuario.id && !recebe(usuario.perfil, c.setor as Setor))) return AVISO_NAO_ENCONTRADO;
      if (c.resolvidoEm) return JA_RESOLVIDO;
      const [depois] = await tx
        .update(avisosComunicados)
        .set({ resolvidoPor: usuario.id, resolvidoEm: new Date() })
        .where(eq(avisosComunicados.id, id))
        .returning();
      await registrarAuditoria(tx, { usuarioId: usuario.id, tabela: "avisos_comunicados", registroId: c.id, acao: "alterar", antes: c, depois });
      return OK;
    });
    if (r.ok) aposGravar();
    return r;
  });
}

/** Quantos avisos abertos "para mim" (automáticos não dispensados e comunicados), guardado por 60 s por pessoa. */
export async function contarAvisos(): Promise<number> {
  const r = await comPerfil([], async (usuario) => {
    const agora = Date.now();
    const guardado = contagens.get(usuario.id);
    if (guardado && guardado.ate > agora) return guardado.valor;
    if (guardado) contagens.delete(usuario.id);
    const inicio = geracao;
    const { abertos, comunicados } = await avisosDaCentral({});
    const valor = abertos.length + comunicados.length;
    if (geracao === inicio) contagens.set(usuario.id, { valor, ate: agora + CACHE_MS });
    return valor;
  });
  return typeof r === "number" ? r : 0;
}
