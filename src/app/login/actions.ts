"use server";

import { redirect } from "next/navigation";
import { usuarioAtivoPorId } from "@/server/auth";
import { supabaseServidor } from "@/server/supabase";

export type EstadoLogin = { erro: string | null };

const ERRO = "E-mail ou senha incorretos";

export async function entrar(_: EstadoLogin, form: FormData): Promise<EstadoLogin> {
  const email = String(form.get("email") ?? "").trim();
  const senha = String(form.get("senha") ?? "");
  if (!email || !senha) return { erro: ERRO };

  const supabase = await supabaseServidor();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: senha });
  if (error || !data.user) return { erro: ERRO };

  // Usuário inativo (ou sem cadastro em `usuarios`) não entra.
  if (!(await usuarioAtivoPorId(data.user.id))) {
    await supabase.auth.signOut();
    return { erro: ERRO };
  }
  redirect("/");
}
