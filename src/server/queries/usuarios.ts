import "server-only";
import { asc } from "drizzle-orm";
import { exigirPerfil, type UsuarioAtual } from "@/server/auth";
import { db } from "@/server/db/client";
import { usuarios } from "@/server/db/schema";

export type UsuarioLista = UsuarioAtual & { ativo: boolean; criadoEm: Date };

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
    })
    .from(usuarios)
    .orderBy(asc(usuarios.nome));
}
