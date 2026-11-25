"use server";

import { revalidatePath } from "next/cache";
import { RegrasSchema, type Regras } from "@/domain/regras";
import { comPerfil, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { regrasVersoes } from "@/server/db/schema";
import { garantirVersaoInicial } from "@/server/queries/regras";

type Resultado =
  | { ok: true; versaoId: string }
  | { ok: false; erro: string; campos?: Record<string, string> };

/** Sempre insere uma nova versão (nunca atualiza). Só o Diretor. */
export async function salvarRegras(valores: Regras): Promise<Resultado> {
  return comPerfil(["diretor"], (usuario) => salvar(usuario.id, valores));
}

async function salvar(usuarioId: string, valores: Regras): Promise<Resultado> {
  const p = RegrasSchema.safeParse(valores);
  if (!p.success) {
    return { ok: false, erro: p.error.issues[0].message, campos: errosDeCampo(p.error) };
  }

  let versaoId: string;
  try {
    versaoId = await db.transaction(async (tx) => {
      await garantirVersaoInicial(tx);
      const [v] = await tx
        .insert(regrasVersoes)
        .values({ valores: p.data, criadoPor: usuarioId })
        .returning({ id: regrasVersoes.id });
      await registrarAuditoria(tx, {
        usuarioId,
        tabela: "regras_versoes",
        registroId: v.id,
        acao: "criar",
        depois: p.data,
      });
      return v.id;
    });
  } catch (e) {
    const x = e as { code?: string; cause?: { code?: string } } | null;
    console.error("Erro ao salvar os parâmetros", { code: x?.cause?.code ?? x?.code });
    throw new Error("Erro ao salvar os parâmetros");
  }

  revalidatePath("/admin/parametros");
  revalidatePath("/financeiro/caixa");
  revalidatePath("/visao-geral");
  return { ok: true, versaoId };
}
