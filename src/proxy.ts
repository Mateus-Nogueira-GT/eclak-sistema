import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { podeAcessar } from "@/domain/perfis";
import { usuarioAtivoPorId } from "@/server/auth";
import { deveProteger } from "@/server/proxy-caminhos";

// Caminhos que qualquer usuário ativo acessa (a página "/" decide o destino por perfil).
const LIVRES_LOGADO = new Set(["/", "/sem-acesso", "/definir-senha"]);

export async function proxy(request: NextRequest) {
  if (!deveProteger(request.nextUrl.pathname)) return NextResponse.next();

  // Resposta "padrão"; cookies renovados pelo Supabase são gravados nela.
  let resposta = NextResponse.next({ request });
  const cookiesNovos: { name: string; value: string; options?: Record<string, unknown> }[] = [];
  let cabecalhos: Record<string, string> = {};

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (lista, headers) => {
          cabecalhos = { ...cabecalhos, ...headers };
          for (const c of lista) request.cookies.set(c.name, c.value);
          resposta = NextResponse.next({ request });
          for (const c of lista) {
            resposta.cookies.set(c.name, c.value, c.options);
            cookiesNovos.push(c);
          }
          for (const [k, v] of Object.entries(cabecalhos)) resposta.headers.set(k, v);
        },
      },
    },
  );

  const redirecionar = (caminho: string) => {
    const r = NextResponse.redirect(new URL(caminho, request.url));
    for (const c of cookiesNovos) r.cookies.set(c.name, c.value, c.options);
    for (const [k, v] of Object.entries(cabecalhos)) r.headers.set(k, v);
    return r;
  };

  // Valida o token no servidor de Auth (não confia só no cookie).
  const { data } = await supabase.auth.getUser();
  if (!data.user) return redirecionar("/login");

  // Perfil e `ativo` vêm sempre do banco.
  const usuario = await usuarioAtivoPorId(data.user.id);
  if (!usuario) {
    await supabase.auth.signOut();
    return redirecionar("/login");
  }

  const caminho = request.nextUrl.pathname;
  if (!LIVRES_LOGADO.has(caminho) && !podeAcessar(usuario.perfil, caminho)) {
    return redirecionar("/sem-acesso");
  }
  return resposta;
}

export const config = {
  matcher: [
    // Literal exigido pelo Next; testado contra MATCHER_PROXY em tests/domain/proxy-caminhos.test.ts.
    "/((?!_next/static|_next/image|favicon\\.ico$|logo-eclak\\.png$|login(?:/|$)|auth/confirmar(?:/|$)).*)",
  ],
};
