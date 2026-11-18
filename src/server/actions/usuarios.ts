"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { FILIAIS, PERFIS_VALORES, type Filial, type Perfil } from "@/domain/perfis";
import { comPerfil } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { usuarios } from "@/server/db/schema";
import { urlConfirmacao } from "@/server/site";
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

export async function criarUsuario(dados: {
  nome: string;
  email: string;
  perfil: Perfil;
  filial: Filial;
}): Promise<Resultado<{ id: string }>> {
  return comPerfil(["diretor"], (diretor) => criar(diretor.id, dados));
}

async function criar(diretorId: string, dados: unknown): Promise<Resultado<{ id: string }>> {
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
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    redirectTo: urlConfirmacao(),
  });
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
        usuarioId: diretorId,
        tabela: "usuarios",
        registroId: id,
        acao: "criar",
        depois: linha,
      });
    });
  } catch (e) {
    // Compensação: só apaga o usuário de auth se nenhuma linha de `usuarios` o referencia
    // (o convite devolve o usuário existente quando o e-mail já foi convidado).
    const [linha] = await db
      .select({ id: usuarios.id })
      .from(usuarios)
      .where(eq(usuarios.id, id))
      .limit(1)
      .catch(() => []);
    if (linha) return { ok: false, erro: MSG_DUPLICADO };
    try {
      await admin.auth.admin.deleteUser(id);
    } catch (e2) {
      console.error("Falha ao remover usuário de auth na compensação", id, e2);
    }
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
  return comPerfil(["diretor"], (diretor) => alterar(diretor.id, id, dados));
}

async function alterar(diretorId: string, id: string, dados: unknown): Promise<Resultado> {
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
        usuarioId: diretorId,
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
