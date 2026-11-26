import { exigirCron } from "@/server/cron";
import { limparChat } from "@/server/ia/limpeza";
import { processarFila } from "@/server/integracoes/fila";

// Chamado pelo serviço cron do Railway: `POST` com `Authorization: Bearer <CRON_SECRET>`. Manda o que está na fila
// das integrações (pendentes cuja próxima tentativa chegou) e limpa propostas/anexos vencidos do chat.
export async function POST(request: Request): Promise<Response> {
  const recusa = exigirCron(request);
  if (recusa) return recusa;
  const r = await processarFila();
  const limpeza = await limparChat();
  return Response.json({ ...r, ...limpeza });
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
