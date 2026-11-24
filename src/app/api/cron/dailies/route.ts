import { hojeEmCuiaba } from "@/domain/clientes";
import { somarDias } from "@/domain/venda";
import { exigirCron } from "@/server/cron";
import { gerarDailiesDoDia } from "@/server/operacao/dailies";

// Chamado pelo serviço cron do Railway uma vez por dia (07:00 em Cuiabá): `POST` com `Authorization: Bearer
// <CRON_SECRET>`. Gera os dailies de hoje + 2 (D-2, "hoje" em Cuiabá) dos roteiros aprovados que ainda não têm texto.
export async function POST(request: Request): Promise<Response> {
  const recusa = exigirCron(request);
  if (recusa) return recusa;
  const r = await gerarDailiesDoDia(somarDias(hojeEmCuiaba(), 2));
  return Response.json(r);
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
