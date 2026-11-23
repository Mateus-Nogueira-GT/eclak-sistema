"use server";

import { and, eq, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { MSG_NUMERO_REPETIDO, motivoCancelamentoSchema, notaFiscalSchema, type NotaFiscalEntrada } from "@/domain/notas-fiscais";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { clientes, fornecedores, notasFiscais, viagens } from "@/server/db/schema";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Notas fiscais: criar, editar (só emitida) e cancelar com motivo (nunca apaga; cancelar libera o número).
// Só Diretor e financeiros; linha alterada travada com `for update`; auditoria na mesma transação.

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
type Ok = { ok: true; id?: string };

const falha = (erro: string, campo?: string): Falha => (campo ? { ok: false, erro, campos: { [campo]: erro } } : { ok: false, erro });
const NAO_ENCONTRADA = falha("Nota fiscal não encontrada");
const NUMERO_REPETIDO = falha(MSG_NUMERO_REPETIDO, "numero");

class Desfazer extends Error {
  constructor(readonly falha: Falha) {
    super(falha.erro);
  }
}

const codigoDe = (e: unknown): string | undefined => {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  return x?.cause?.code ?? x?.code;
};

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  console.error(mensagem, { code: codigoDe(e) });
  return new Error(mensagem);
}

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Transação com `Desfazer`; a violação de unicidade do número (23505) vira a falha do campo. */
async function transacao(mensagemErro: string, fn: (tx: Transacao) => Promise<Ok | Falha>): Promise<Ok | Falha> {
  try {
    return await db.transaction(fn);
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    if (codigoDe(x) === "23505") return NUMERO_REPETIDO;
    throw erroDeBanco(mensagemErro, x);
  }
}

const revalidar = () => revalidatePath("/financeiro", "layout");

const FINANCEIRO = [...PERFIS_FINANCEIRO];

/** Fornecedor, cliente e viagem informados existem (e não foram excluídos). */
async function conferirReferencias(tx: Transacao, v: NotaFiscalEntrada): Promise<void> {
  if (v.fornecedorId && (await tx.select({ id: fornecedores.id }).from(fornecedores).where(and(eq(fornecedores.id, v.fornecedorId), isNull(fornecedores.excluidoEm)))).length === 0)
    throw new Desfazer(falha("Fornecedor não encontrado", "fornecedorId"));
  if (v.clienteId && (await tx.select({ id: clientes.id }).from(clientes).where(and(eq(clientes.id, v.clienteId), isNull(clientes.excluidoEm)))).length === 0)
    throw new Desfazer(falha("Cliente não encontrado", "clienteId"));
  if (v.viagemId && (await tx.select({ id: viagens.id }).from(viagens).where(and(eq(viagens.id, v.viagemId), isNull(viagens.excluidoEm)))).length === 0)
    throw new Desfazer(falha("Viagem não encontrada", "viagemId"));
}

export async function criarNotaFiscal(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = notaFiscalSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    const r = await transacao("Falha ao criar a nota fiscal", async (tx) => {
      await conferirReferencias(tx, v);
      const [nova] = await tx.insert(notasFiscais).values({ ...v, criadoPor: u.id }).returning();
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "notas_fiscais", registroId: nova.id, acao: "criar", depois: nova });
      return { ok: true, id: nova.id };
    });
    if (r.ok) revalidar();
    return r;
  });
}

export async function editarNotaFiscal(id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (typeof id !== "string" || !ehUuid(id)) return NAO_ENCONTRADA;
    const p = notaFiscalSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = p.data;
    const r = await transacao("Falha ao salvar a nota fiscal", async (tx) => {
      const [atual] = await tx.select().from(notasFiscais).where(eq(notasFiscais.id, id)).for("update");
      if (!atual) throw new Desfazer(NAO_ENCONTRADA);
      if (atual.status === "cancelada") throw new Desfazer(falha("Nota cancelada não pode ser editada"));
      await conferirReferencias(tx, v);
      const [repetida] = await tx
        .select({ id: notasFiscais.id })
        .from(notasFiscais)
        .where(and(eq(notasFiscais.numero, v.numero), ne(notasFiscais.status, "cancelada"), ne(notasFiscais.id, id)));
      if (repetida) throw new Desfazer(NUMERO_REPETIDO);
      // Auditoria só com o que mudou.
      const mudou = (Object.keys(v) as (keyof NotaFiscalEntrada)[]).filter((k) => atual[k] !== v[k]);
      if (mudou.length === 0) return { ok: true, id };
      const depois = Object.fromEntries(mudou.map((k) => [k, v[k]]));
      const antes = Object.fromEntries(mudou.map((k) => [k, atual[k]]));
      await tx.update(notasFiscais).set(depois).where(eq(notasFiscais.id, id));
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "notas_fiscais", registroId: id, acao: "alterar", antes, depois });
      return { ok: true, id };
    });
    if (r.ok) revalidar();
    return r;
  });
}

/** Cancela a nota com motivo (obrigatório). Ela fica na lista, marcada, e libera o número. */
export async function cancelarNotaFiscal(id: string, motivo: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (typeof id !== "string" || !ehUuid(id)) return NAO_ENCONTRADA;
    const m = motivoCancelamentoSchema.safeParse(motivo);
    if (!m.success) return falha(m.error.issues[0].message, "motivo");
    const r = await transacao("Falha ao cancelar a nota fiscal", async (tx) => {
      const [atual] = await tx.select().from(notasFiscais).where(eq(notasFiscais.id, id)).for("update");
      if (!atual) throw new Desfazer(NAO_ENCONTRADA);
      if (atual.status === "cancelada") throw new Desfazer(falha("Nota já cancelada"));
      const depois = { status: "cancelada" as const, motivoCancelamento: m.data };
      await tx.update(notasFiscais).set(depois).where(eq(notasFiscais.id, id));
      await registrarAuditoria(tx, {
        usuarioId: u.id,
        tabela: "notas_fiscais",
        registroId: id,
        acao: "alterar",
        antes: { status: atual.status, motivoCancelamento: null },
        depois,
      });
      return { ok: true };
    });
    if (r.ok) revalidar();
    return r.ok ? { ok: true } : r;
  });
}
