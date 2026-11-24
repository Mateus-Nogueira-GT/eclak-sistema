import "server-only";
import { createSign } from "node:crypto";
import type { ConfigDrive } from "./config";
import { chamar, ErroIntegracao, type Buscar } from "./http";

// Token de acesso do Google para a conta de serviço: JWT RS256 assinado com `node:crypto` (sem biblioteca do
// Google) trocado no endpoint de token. O token fica só em memória, nunca em banco, log ou URL.

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const ESCOPO_DRIVE = "https://www.googleapis.com/auth/drive";
const GRANT_JWT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Validade pedida no JWT (o máximo que o Google aceita). */
const VALIDADE_JWT_S = 3600;
/** O token guardado é trocado este tanto antes de expirar. */
const MARGEM_S = 60;

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Asserção JWT da conta de serviço (header RS256, claims iss/scope/aud/iat/exp em segundos). */
export function jwtGoogle(cfg: Pick<ConfigDrive, "email" | "chave">, agora: Date = new Date()): string {
  const iat = Math.floor(agora.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: cfg.email, scope: ESCOPO_DRIVE, aud: GOOGLE_TOKEN_URL, iat, exp: iat + VALIDADE_JWT_S }),
  );
  const assinado = `${header}.${claims}`;
  let assinatura: Buffer;
  try {
    const s = createSign("RSA-SHA256");
    s.update(assinado);
    assinatura = s.sign(cfg.chave);
  } catch {
    // Chave que não é PEM válida: repetir não resolve (e a mensagem do crypto não sai daqui).
    throw new ErroIntegracao("autenticacao", null);
  }
  return `${assinado}.${b64url(assinatura)}`;
}

const tokens = new Map<string, { token: string; expiraEm: number }>();

/** Só testes: esquece os tokens guardados em memória. */
export function esquecerTokensGoogle(): void {
  if (process.env.NODE_ENV === "production") throw new Error("Só em testes");
  tokens.clear();
}

/** Token recusado pelo serviço (401: revogado ou expirado antes da hora): o próximo pedido busca outro. */
export function descartarTokenGoogle(email: string): void {
  tokens.delete(email);
}

/** Token de acesso (Bearer) da conta de serviço, reaproveitado até 60 s antes de expirar. */
export async function tokenGoogle(cfg: Pick<ConfigDrive, "email" | "chave">, buscar: Buscar, agora: Date = new Date()): Promise<string> {
  const guardado = tokens.get(cfg.email);
  if (guardado && agora.getTime() < guardado.expiraEm - MARGEM_S * 1000) return guardado.token;
  const corpo = new URLSearchParams({ grant_type: GRANT_JWT, assertion: jwtGoogle(cfg, agora) }).toString();
  const r = await chamar(buscar, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: corpo,
  });
  // No endpoint de token, 400 e 401 são credencial recusada (`invalid_grant`, `invalid_client`: chave revogada,
  // conta apagada, relógio errado): `autenticacao`, não `recusado`. Os dois vão direto a `falhou` (repetir não resolve).
  if (!r.ok) throw new ErroIntegracao(r.status === 400 || r.status === 401 ? "autenticacao" : r.classe, r.status);
  const json = (typeof r.json === "object" && r.json !== null ? r.json : {}) as Record<string, unknown>;
  const token = typeof json.access_token === "string" && json.access_token !== "" ? json.access_token : null;
  if (!token) throw new ErroIntegracao("servidor", r.status);
  const validade = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : VALIDADE_JWT_S;
  tokens.set(cfg.email, { token, expiraEm: agora.getTime() + validade * 1000 });
  return token;
}
