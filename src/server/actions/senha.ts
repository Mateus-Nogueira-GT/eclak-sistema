"use server";

import { redirect } from "next/navigation";
import { comPerfil } from "@/server/acesso";
import { urlConfirmacao } from "@/server/site";
import { supabaseAnonimo, supabaseServidor } from "@/server/supabase";

export type EstadoSenha = { erro: string | null };
export type EstadoPedido = { mensagem: string | null };

const MSG_PEDIDO =
  "Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.";

/** Define a senha do usuário logado (depois do link de convite ou de redefinição). */
export async function definirSenha(_: EstadoSenha, form: FormData): Promise<EstadoSenha> {
  const r = await comPerfil([], async (): Promise<EstadoSenha> => {
    const senha = String(form.get("senha") ?? "");
    const confirmacao = String(form.get("confirmacao") ?? "");
    if (senha.length < 8) return { erro: "A senha precisa ter pelo menos 8 caracteres" };
    if (senha !== confirmacao) return { erro: "As senhas não conferem" };

    const supabase = await supabaseServidor();
    const { error } = await supabase.auth.updateUser({ password: senha });
    if (error) {
      return {
        erro:
          error.code === "same_password"
            ? "A nova senha precisa ser diferente da atual"
            : "Não foi possível salvar a senha. Tente novamente",
      };
    }
    return { erro: null };
  });
  if ("ok" in r) return { erro: r.erro };
  if (r.erro) return r;
  redirect("/");
}

/** "Esqueci minha senha": sempre a mesma resposta, exista ou não o e-mail. */
export async function pedirNovaSenha(_: EstadoPedido, form: FormData): Promise<EstadoPedido> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (email) {
    const { error } = await supabaseAnonimo().auth.resetPasswordForEmail(email, {
      redirectTo: urlConfirmacao(),
    });
    if (error) console.error("Falha ao pedir nova senha", error.message);
  }
  return { mensagem: MSG_PEDIDO };
}
