"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { FornecedorSchema, type FornecedorEntrada } from "@/domain/fornecedores";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { fornecedores } from "@/server/db/schema";

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
const NAO_ENCONTRADO: Falha = { ok: false, erro: "Fornecedor não encontrado" };

function dadosDe(f: typeof fornecedores.$inferSelect) {
  const omitidos = new Set(["id", "criadoEm", "atualizadoEm", "excluidoEm"]);
  return Object.fromEntries(Object.entries(f).filter(([k]) => !omitidos.has(k)));
}

/** Cria (sem `id`) ou edita (com `id`). Qualquer usuário ativo. */
export async function salvarFornecedor(
  dados: FornecedorEntrada,
  id?: string,
): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([], (usuario) => salvar(usuario.id, dados, id));
}

async function salvar(
  usuarioId: string,
  dados: FornecedorEntrada,
  id?: string,
): Promise<{ ok: true; id: string } | Falha> {
  const p = FornecedorSchema.safeParse(dados);
  if (!p.success) {
    return { ok: false, erro: p.error.issues[0].message, campos: errosDeCampo(p.error) };
  }
  if (id !== undefined && !ehUuid(id)) return NAO_ENCONTRADO;

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
  return comPerfil(["diretor"], (usuario) => excluir(usuario.id, id));
}

async function excluir(usuarioId: string, id: string): Promise<{ ok: true } | Falha> {
  if (!ehUuid(id)) return NAO_ENCONTRADO;

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
