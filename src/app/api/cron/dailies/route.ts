import { hojeEmCuiaba } from "@/domain/clientes";
import { somarDias } from "@/domain/venda";
import { exigirCron } from "@/server/cron";
import { gerarDailiesDoDia } from "@/server/operacao/dailies";

/** Dias gerados a cada execução, a contar de hoje em Cuiabá: hoje, hoje + 1 e hoje + 2 (D-2). */
const DIAS_DO_CRON = 3;

// Chamado pelo serviço cron do Railway uma vez por dia (07:00 em Cuiabá): `POST` com `Authorization: Bearer
// <CRON_SECRET>`. Gera os dailies de hoje, hoje + 1 e hoje + 2 ("hoje" em Cuiabá) dos roteiros aprovados que ainda
// não têm texto nesses dias. Uma execução perdida (Railway fora, segredo trocado) é recuperada pela seguinte; o que já
// tem texto (gerado, revisado ou enviado) nunca é sobrescrito, então rodar de novo é seguro.
export async function POST(request: Request): Promise<Response> {
  const recusa = exigirCron(request);
  if (recusa) return recusa;
  const hoje = hojeEmCuiaba();
  let gerados = 0;
  let pulados = 0;
  for (let i = 0; i < DIAS_DO_CRON; i++) {
    const r = await gerarDailiesDoDia(somarDias(hoje, i));
    gerados += r.gerados;
    pulados += r.pulados;
  }
  return Response.json({ gerados, pulados });
}

export function GET(): Response {
  return new Response(null, { status: 405, headers: { Allow: "POST" } });
}
