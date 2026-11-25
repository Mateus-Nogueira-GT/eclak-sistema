import type { EmailOtpType } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/server/db/client";
import { usuarios } from "@/server/db/schema";
import { supabaseServidor } from "@/server/supabase";

const TIPOS: EmailOtpType[] = ["invite", "recovery"];

/**
 * Location relativo: num servidor ligado em 0.0.0.0 (Railway, standalone) a URL da requisição
 * traz o host de bind, e um destino absoluto mandaria o navegador para https://0.0.0.0:<porta>.
 * Os cookies gravados pelo cliente SSR (via `cookies()`) vão nesta mesma resposta.
 */
function irPara(caminho: string) {
  return new NextResponse(null, { status: 303, headers: { Location: caminho, "Cache-Control": "no-store" } });
}

/**
 * Destino do link dos e-mails de convite e de redefinição de senha
 * (`/auth/confirmar?token_hash=…&type=invite|recovery`). Valida o token, abre a sessão
 * (cookies) e leva a pessoa a criar a senha.
 */
export async function GET(request: NextRequest) {
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const tipo = request.nextUrl.searchParams.get("type") as EmailOtpType | null;

  if (tokenHash && tipo && TIPOS.includes(tipo)) {
    const supabase = await supabaseServidor();
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: tipo });
    if (!error) {
      if (data.user) {
        const [u] = await db.select({ ativo: usuarios.ativo }).from(usuarios).where(eq(usuarios.id, data.user.id)).limit(1);
        if (u && !u.ativo) {
          await supabase.auth.signOut();
          return irPara("/login?erro=link");
        }
      }
      return irPara("/definir-senha");
    }
  }
  return irPara("/login?erro=link");
}
