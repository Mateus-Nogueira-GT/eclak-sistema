import { exigirCron } from "@/server/cron";
import { processarFila } from "@/server/integracoes/fila";

// Chamado pelo serviço cron do Railway: `POST` com `Authorization: Bearer <CRON_SECRET>`. Manda o que está na fila
// das integrações (pendentes cuja próxima tentativa chegou).
export async function POST(request: Request): Promise<Response> {
  const recusa = exigirCron(request);
  if (recusa) return recusa;
  const r = await processarFila();
  return Response.json(r);
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
