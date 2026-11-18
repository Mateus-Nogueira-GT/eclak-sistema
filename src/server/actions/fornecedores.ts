"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { FornecedorSchema, type FornecedorEntrada } from "@/domain/fornecedores";
import { registrarAuditoria } from "@/server/auditoria";
import { ErroAcesso, exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { fornecedores } from "@/server/db/schema";

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
const NAO_ENCONTRADO: Falha = { ok: false, erro: "Fornecedor não encontrado" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function acesso(...perfis: Parameters<typeof exigirPerfil>) {
  try {
    return { usuario: await exigirPerfil(...perfis) };
  } catch (e) {
    if (e instanceof ErroAcesso) return { erro: "Sem permissão" };
    throw e;
  }
}

function dadosDe(f: typeof fornecedores.$inferSelect) {
  const omitidos = new Set(["id", "criadoEm", "atualizadoEm", "excluidoEm"]);
  return Object.fromEntries(Object.entries(f).filter(([k]) => !omitidos.has(k)));
}

/** Cria (sem `id`) ou edita (com `id`). Qualquer usuário ativo. */
export async function salvarFornecedor(
  dados: FornecedorEntrada,
  id?: string,
): Promise<{ ok: true; id: string } | Falha> {
  const a = await acesso();
  if (!a.usuario) return { ok: false, erro: a.erro };

  const p = FornecedorSchema.safeParse(dados);
  if (!p.success) {
    const campos: Record<string, string> = {};
    for (const i of p.error.issues) {
      const chave = String(i.path[0] ?? "");
      if (!(chave in campos)) campos[chave] = i.message;
    }
    return { ok: false, erro: p.error.issues[0].message, campos };
  }
  if (id !== undefined && !UUID.test(id)) return NAO_ENCONTRADO;

  const usuarioId = a.usuario.id;
  const r = await db.transaction(async (tx) => {
    if (id === undefined) {
      const [novo] = await tx.insert(fornecedores).values(p.data).returning();
      await registrarAuditoria(tx, {
        usuarioId,
        tabela: "fornecedores",
        registroId: novo.id,
        acao: "criar",
        depois: dadosDe(novo),
      });
      return novo.id;
    }
    const [antes] = await tx
      .select()
      .from(fornecedores)
      .where(and(eq(fornecedores.id, id), isNull(fornecedores.excluidoEm)))
      .for("update");
    if (!antes) return null;
    const [depois] = await tx
      .update(fornecedores)
      .set({ ...p.data, atualizadoEm: new Date() })
      .where(eq(fornecedores.id, id))
      .returning();
    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "fornecedores",
      registroId: id,
      acao: "alterar",
      antes: dadosDe(antes),
      depois: dadosDe(depois),
    });
    return id;
  });
  if (r === null) return NAO_ENCONTRADO;

  revalidatePath("/fornecedores");
  return { ok: true, id: r };
}

/** Exclusão lógica. Só o Diretor. */
export async function excluirFornecedor(id: string): Promise<{ ok: true } | Falha> {
  const a = await acesso("diretor");
  if (!a.usuario) return { ok: false, erro: a.erro };
  if (!UUID.test(id)) return NAO_ENCONTRADO;
  const usuarioId = a.usuario.id;

  const ok = await db.transaction(async (tx) => {
    const [antes] = await tx
      .select()
      .from(fornecedores)
      .where(and(eq(fornecedores.id, id), isNull(fornecedores.excluidoEm)))
      .for("update");
    if (!antes) return false;
    const agora = new Date();
    await tx.update(fornecedores).set({ excluidoEm: agora, atualizadoEm: agora }).where(eq(fornecedores.id, id));
    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "fornecedores",
      registroId: id,
      acao: "excluir",
      antes: dadosDe(antes),
      depois: { excluidoEm: agora },
    });
    return true;
  });
  if (!ok) return NAO_ENCONTRADO;
  revalidatePath("/fornecedores");
  return { ok: true };
}
