/** Guarda de segurança: scripts e testes destrutivos só rodam contra banco/API locais. Sem imports de servidor. */
const HOSTS_LOCAIS = new Set(["127.0.0.1", "localhost"]);

/** Garante que banco e API do Supabase são locais; lança erro caso contrário. */
export function garantirBancoLocal(databaseUrl: string, supabaseUrl: string): void {
  for (const [nome, url] of [
    ["DATABASE_URL", databaseUrl],
    ["NEXT_PUBLIC_SUPABASE_URL", supabaseUrl],
  ] as const) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* URL inválida: tratada como não local */
    }
    if (!HOSTS_LOCAIS.has(host)) {
      throw new Error(`Recusado: ${nome} não aponta para banco local (host "${host}").`);
    }
  }
}
