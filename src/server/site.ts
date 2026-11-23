import "server-only";

/**
 * Endereço público do sistema (`NEXT_PUBLIC_SITE_URL`). Obrigatório em produção;
 * no desenvolvimento cai para o `site_url` do Supabase local.
 */
export function urlDoSite(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL;
  if (url) return url.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "production") throw new Error("NEXT_PUBLIC_SITE_URL não definida");
  return "http://127.0.0.1:3000";
}

/** Destino dos links de convite e de redefinição de senha. */
export function urlConfirmacao(): string {
  return `${urlDoSite()}/auth/confirmar`;
}
