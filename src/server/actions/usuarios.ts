"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FILIAIS, PERFIS_VALORES, type Filial, type Perfil } from "@/domain/perfis";
import { ErroAcesso, exigirPerfil } from "@/server/auth";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { usuarios } from "@/server/db/schema";
import { supabaseAdmin } from "@/server/supabase";

type Resultado<T = object> = ({ ok: true } & T) | { ok: false; erro: string };

class ErroNegocio extends Error {}

const MSG_ULTIMO_DIRETOR = "É preciso manter pelo menos um Diretor ativo";
const MSG_DUPLICADO = "Já existe um usuário com este e-mail";

const esquemaNovo = z.object({
  nome: z.string({ error: "Informe o nome" }).trim().min(1, "Informe o nome"),
  email: z
    .string({ error: "E-mail inválido" })
    .trim()
    .toLowerCase()
    .pipe(z.email("E-mail inválido")),
  perfil: z.enum(PERFIS_VALORES, { error: "Nível de acesso inválido" }),
  filial: z.enum(FILIAIS, { error: "Filial inválida" }),
});

const esquemaAlterar = z.object({
  id: z.uuid("Usuário inválido"),
  dados: z.object({
    perfil: z.enum(PERFIS_VALORES, { error: "Nível de acesso inválido" }).optional(),
    filial: z.enum(FILIAIS, { error: "Filial inválida" }).optional(),
    ativo: z.boolean({ error: "Situação inválida" }).optional(),
  }),
});

async function comoDiretor() {
  try {
    return { usuario: await exigirPerfil("diretor") };
  } catch (e) {
    if (e instanceof ErroAcesso) return { erro: "Sem permissão" };
    throw e;
  }
}

export async function criarUsuario(dados: {
  nome: string;
  email: string;
  perfil: Perfil;
  filial: Filial;
}): Promise<Resultado<{ id: string }>> {
  const acesso = await comoDiretor();
  if (!acesso.usuario) return { ok: false, erro: acesso.erro };

  const p = esquemaNovo.safeParse(dados);
  if (!p.success) return { ok: false, erro: p.error.issues[0].message };
  const { nome, email, perfil, filial } = p.data;

  const [existente] = await db
    .select({ id: usuarios.id })
    .from(usuarios)
    .where(sql`lower(${usuarios.email}) = ${email}`)
    .limit(1);
  if (existente) return { ok: false, erro: MSG_DUPLICADO };

  const admin = supabaseAdmin();
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
  if (error || !data.user) {
    const jaExiste = /already (been )?registered|already exists/i.test(error?.message ?? "");
    return {
      ok: false,
      erro: jaExiste ? MSG_DUPLICADO : "Não foi possível enviar o convite. Tente novamente",
    };
  }
  const id = data.user.id;

  try {
    await db.transaction(async (tx) => {
      const [linha] = await tx
        .insert(usuarios)
        .values({ id, nome, email, perfil, filial, ativo: true })
        .returning({
          id: usuarios.id,
          nome: usuarios.nome,
          email: usuarios.email,
          perfil: usuarios.perfil,
          filial: usuarios.filial,
          ativo: usuarios.ativo,
        });
      await registrarAuditoria(tx, {
        usuarioId: acesso.usuario.id,
        tabela: "usuarios",
        registroId: id,
        acao: "criar",
        depois: linha,
      });
    });
  } catch (e) {
    // Compensação: não deixa usuário órfão em auth.users.
    await admin.auth.admin.deleteUser(id);
    if (typeof e === "object" && e && "code" in e && e.code === "23505") {
      return { ok: false, erro: MSG_DUPLICADO };
    }
    return { ok: false, erro: "Não foi possível salvar o usuário. Tente novamente" };
  }

  revalidatePath("/admin/usuarios");
  return { ok: true, id };
}

export async function alterarUsuario(
  id: string,
  dados: { perfil?: Perfil; filial?: Filial; ativo?: boolean },
): Promise<Resultado> {
  const acesso = await comoDiretor();
  if (!acesso.usuario) return { ok: false, erro: acesso.erro };

  const p = esquemaAlterar.safeParse({ id, dados });
  if (!p.success) return { ok: false, erro: p.error.issues[0].message };
  const alvoId = p.data.id;
  const mud = p.data.dados;

  try {
    await db.transaction(async (tx) => {
      // Trava todos os Diretores ativos: duas alterações concorrentes se serializam aqui.
      const diretores = await tx
        .select({ id: usuarios.id })
        .from(usuarios)
        .where(and(eq(usuarios.perfil, "diretor"), eq(usuarios.ativo, true)))
        .orderBy(usuarios.id)
        .for("update");
      const [antes] = await tx.select().from(usuarios).where(eq(usuarios.id, alvoId)).for("update");
      if (!antes) throw new ErroNegocio("Usuário não encontrado");

      const depois = {
        perfil: mud.perfil ?? antes.perfil,
        filial: mud.filial ?? antes.filial,
        ativo: mud.ativo ?? antes.ativo,
      };
      if (
        depois.perfil === antes.perfil &&
        depois.filial === antes.filial &&
        depois.ativo === antes.ativo
      ) {
        return;
      }

      const eraDiretorAtivo = antes.perfil === "diretor" && antes.ativo;
      const continua = depois.perfil === "diretor" && depois.ativo;
      if (eraDiretorAtivo && !continua && diretores.length <= 1) {
        throw new ErroNegocio(MSG_ULTIMO_DIRETOR);
      }

      await tx
        .update(usuarios)
        .set({ ...depois, atualizadoEm: new Date() })
        .where(eq(usuarios.id, alvoId));
      await registrarAuditoria(tx, {
        usuarioId: acesso.usuario.id,
        tabela: "usuarios",
        registroId: alvoId,
        acao: antes.ativo && !depois.ativo ? "desativar" : "alterar",
        antes: { perfil: antes.perfil, filial: antes.filial, ativo: antes.ativo },
        depois,
      });
    });
  } catch (e) {
    if (e instanceof ErroNegocio) return { ok: false, erro: e.message };
    throw e;
  }

  revalidatePath("/admin/usuarios");
  return { ok: true };
}
