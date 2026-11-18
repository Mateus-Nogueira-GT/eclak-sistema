import "server-only";
import { eq } from "drizzle-orm";
import { cache } from "react";
import type { Filial, Perfil } from "@/domain/perfis";
import { db } from "@/server/db/client";
import { usuarios } from "@/server/db/schema";
import { supabaseServidor } from "@/server/supabase";

export type UsuarioAtual = {
  id: string;
  nome: string;
  email: string;
  perfil: Perfil;
  filial: Filial;
};

export class ErroAcesso extends Error {
  constructor() {
    super("Sem permissão");
    this.name = "ErroAcesso";
  }
}

/** Relê a linha de `usuarios` no banco. `null` se não existe ou está inativo. */
export async function usuarioAtivoPorId(id: string): Promise<UsuarioAtual | null> {
  const [u] = await db
    .select({
      id: usuarios.id,
      nome: usuarios.nome,
      email: usuarios.email,
      perfil: usuarios.perfil,
      filial: usuarios.filial,
      ativo: usuarios.ativo,
    })
    .from(usuarios)
    .where(eq(usuarios.id, id))
    .limit(1);
  if (!u || !u.ativo) return null;
  return { id: u.id, nome: u.nome, email: u.email, perfil: u.perfil, filial: u.filial };
}

async function resolverUsuarioAtual(): Promise<UsuarioAtual | null> {
  const supabase = await supabaseServidor();
  // getUser valida o token no servidor de Auth; getSession só leria o cookie.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return usuarioAtivoPorId(data.user.id);
}

// `cache` dedupe só dentro de uma renderização; fora dela (testes, actions) relê sempre.
const memo: <T extends () => Promise<unknown>>(fn: T) => T =
  typeof cache === "function" ? cache : (fn) => fn;

export const usuarioAtual: () => Promise<UsuarioAtual | null> = memo(resolverUsuarioAtual);

export async function exigirPerfil(...perfis: Perfil[]): Promise<UsuarioAtual> {
  const u = await resolverUsuarioAtual();
  if (!u) throw new ErroAcesso();
  if (perfis.length > 0 && !perfis.includes(u.perfil)) throw new ErroAcesso();
  return u;
}
