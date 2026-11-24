import { ErroAcesso } from "@/server/auth";
import { gerarCsv, parametrosDoRelatorio } from "@/server/relatorios";

// O proxy já redireciona quem não é do financeiro; o handler confere o perfil de novo (nas leituras) e responde 403
// sem corpo CSV.
export async function GET(request: Request) {
  const params = parametrosDoRelatorio(Object.fromEntries(new URL(request.url).searchParams));
  try {
    const { nome, corpo } = await gerarCsv(params);
    return new Response(corpo, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${nome}"`,
        "cache-control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof ErroAcesso) return new Response(null, { status: 403 });
    throw e;
  }
}
