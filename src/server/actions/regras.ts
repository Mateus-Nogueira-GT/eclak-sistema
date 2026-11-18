"use server";

import { revalidatePath } from "next/cache";
import { RegrasSchema, type Regras } from "@/domain/regras";
import { ErroAcesso, exigirPerfil } from "@/server/auth";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { regrasVersoes } from "@/server/db/schema";
import { garantirVersaoInicial } from "@/server/queries/regras";

type Resultado =
  | { ok: true; versaoId: string }
  | { ok: false; erro: string; campos?: Record<string, string> };

async function comoDiretor() {
  try {
    return { usuario: await exigirPerfil("diretor") };
  } catch (e) {
    if (e instanceof ErroAcesso) return { erro: "Sem permissão" };
    throw e;
  }
}

/** Sempre insere uma nova versão (nunca atualiza). Só o Diretor. */
export async function salvarRegras(valores: Regras): Promise<Resultado> {
  const acesso = await comoDiretor();
  if (!acesso.usuario) return { ok: false, erro: acesso.erro };

  const p = RegrasSchema.safeParse(valores);
  if (!p.success) {
    const campos: Record<string, string> = {};
    for (const i of p.error.issues) {
      const chave = i.path.join(".");
      if (!(chave in campos)) campos[chave] = i.message;
    }
    return { ok: false, erro: p.error.issues[0].message, campos };
  }

  const versaoId = await db.transaction(async (tx) => {
    await garantirVersaoInicial(tx);
    const [v] = await tx
      .insert(regrasVersoes)
      .values({ valores: p.data, criadoPor: acesso.usuario.id })
      .returning({ id: regrasVersoes.id });
    await registrarAuditoria(tx, {
      usuarioId: acesso.usuario.id,
      tabela: "regras_versoes",
      registroId: v.id,
      acao: "criar",
      depois: p.data,
    });
    return v.id;
  });

  revalidatePath("/admin/parametros");
  return { ok: true, versaoId };
}
