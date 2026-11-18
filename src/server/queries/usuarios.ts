import "server-only";
import { asc, sql } from "drizzle-orm";
import { exigirPerfil, type UsuarioAtual } from "@/server/auth";
import { db } from "@/server/db/client";
import { usuarios } from "@/server/db/schema";

/** `convitePendente`: nunca entrou no sistema (pode receber o convite de novo). */
export type UsuarioLista = UsuarioAtual & { ativo: boolean; criadoEm: Date; convitePendente: boolean };

/** Lista todos os usuários (ativos e inativos). Só o Diretor; lança "Sem permissão" nos demais. */
export async function listarUsuarios(): Promise<UsuarioLista[]> {
  await exigirPerfil("diretor");
  return db
    .select({
      id: usuarios.id,
      nome: usuarios.nome,
      email: usuarios.email,
      perfil: usuarios.perfil,
      filial: usuarios.filial,
      ativo: usuarios.ativo,
      criadoEm: usuarios.criadoEm,
      // Nome qualificado: dentro do subselect, um "id" solto seria o de auth.users.
      convitePendente: sql<boolean>`not exists (
        select 1 from auth.users a where a.id = "usuarios"."id" and a.last_sign_in_at is not null
      )`,
    })
    .from(usuarios)
    .orderBy(asc(usuarios.nome));
}
