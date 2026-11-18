import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseServidor } from "@/server/supabase";

const TIPOS: EmailOtpType[] = ["invite", "recovery"];

/**
 * Destino do link dos e-mails de convite e de redefinição de senha
 * (`/auth/confirmar?token_hash=…&type=invite|recovery`). Valida o token, abre a sessão
 * (cookies) e leva a pessoa a criar a senha.
 */
export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const tipo = request.nextUrl.searchParams.get("type") as EmailOtpType | null;
  const destino = request.nextUrl.clone();
  destino.search = "";

  if (tokenHash && tipo && TIPOS.includes(tipo)) {
    const supabase = await supabaseServidor();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: tipo });
    if (!error) {
      destino.pathname = "/definir-senha";
      return NextResponse.redirect(destino);
    }
  }
  destino.pathname = "/login";
  destino.searchParams.set("erro", "link");
  return NextResponse.redirect(destino);
}
