import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

// Conferência do segredo das rotas /api/cron/* (o proxy deixa passar sem sessão). Sem CRON_SECRET no ambiente o
// cron fica desligado (503); cabeçalho ausente ou diferente de `Bearer <CRON_SECRET>`: 401. A resposta nunca ecoa
// o segredo.

type Ambiente = Record<string, string | undefined>;

/** Compara em tempo constante: os dois lados viram SHA-256 (mesmo tamanho), então o tamanho do segredo não vaza. */
function iguais(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return ha.length === hb.length && timingSafeEqual(ha, hb);
}

/** null quando o pedido pode seguir; senão a resposta de recusa. */
export function exigirCron(request: Request, env: Ambiente = process.env): Response | null {
  const segredo = env.CRON_SECRET?.trim();
  if (!segredo) return Response.json({ erro: "Cron desligado: falta CRON_SECRET" }, { status: 503 });
  const cabecalho = request.headers.get("authorization") ?? "";
  if (!iguais(cabecalho, `Bearer ${segredo}`)) return Response.json({ erro: "Não autorizado" }, { status: 401 });
  return null;
}
