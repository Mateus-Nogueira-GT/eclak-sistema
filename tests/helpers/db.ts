import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { garantirBancoLocal } from "../../scripts/local-guard";
import { db, sql } from "@/server/db/client";
import { categoriasFinanceiras, faturasContador, usuarios, type Filial, type Perfil } from "@/server/db/schema";
import { CATEGORIAS_INICIAIS, PROXIMA_FATURA_INICIAL } from "@/server/db/seed-financeiro-inicial";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** Cliente anônimo sem sessão persistida (como o navegador de quem abre o link do e-mail). */
export function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

export { garantirBancoLocal };

function exigirLocal() {
  garantirBancoLocal(process.env.DATABASE_URL ?? "", process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
}

/**
 * Trunca todas as tabelas de `public` e apaga os usuários de `auth.users`. Depois reinsere os dados iniciais que as
 * migrações gravam (categorias financeiras e contador de faturas em 1405), do mesmo módulo que a 0020 replica.
 */
export async function limparBanco(): Promise<void> {
  exigirLocal();
  const tabelas = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'`;
  if (tabelas.length > 0) {
    const lista = tabelas.map((t) => `"public"."${t.tablename}"`).join(", ");
    await sql.unsafe(`truncate table ${lista} restart identity cascade`);
  }
  // `restart identity` só reinicia sequências de colunas; reinicia também as avulsas (ex.: cliente_codigo_seq).
  const sequencias = await sql<{ sequencename: string }[]>`
    select sequencename from pg_sequences where schemaname = 'public'`;
  for (const s of sequencias) await sql.unsafe(`alter sequence "public"."${s.sequencename}" restart`);
  await sql`delete from auth.users`;
  await db.insert(categoriasFinanceiras).values(CATEGORIAS_INICIAIS);
  await db.insert(faturasContador).values({ id: 1, proximo: PROXIMA_FATURA_INICIAL });
}

export async function criarUsuarioTeste(
  perfil: Perfil,
  opcoes: { ativo?: boolean; filial?: Filial } = {},
): Promise<{ id: string; email: string; senha: string }> {
  exigirLocal();
  const email = `teste-${randomUUID()}@eclak.test`;
  const senha = randomUUID();
  const { data, error } = await adminClient().auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Falha ao criar usuário de auth: ${error?.message}`);
  await db.insert(usuarios).values({
    id: data.user.id,
    nome: `Teste ${perfil}`,
    email,
    perfil,
    filial: opcoes.filial ?? "Rondonópolis",
    ativo: opcoes.ativo ?? true,
  });
  return { id: data.user.id, email, senha };
}

// ---------------------------------------------------------------------------
// Sessão falsa para testes de integração (sem cookies).
//
// Padrão de uso (Tasks 6-8 repetem): em cada arquivo de teste que chama código
// que usa `usuarioAtual()`/`exigirPerfil()`, registre o mock ANTES dos imports
// do código sob teste (vi.mock é hoisted pelo vitest):
//
//   vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
//
// e então rode o código dentro de `comSessao(usuario.id, async () => { ... })`.
// O `usuarioAtual()` real continua relendo `usuarios` no banco; só o
// `supabase.auth.getUser()` é substituído. Fora de `comSessao` não há sessão.
// ---------------------------------------------------------------------------
let sessaoDeTeste: string | null = null;

export function mockSupabase() {
  return {
    supabaseServidor: async () => ({
      auth: {
        getUser: async () =>
          sessaoDeTeste
            ? { data: { user: { id: sessaoDeTeste } }, error: null }
            : { data: { user: null }, error: { message: "sem sessão" } },
        // Sem cookies: valida o token num cliente anônimo descartável.
        verifyOtp: (p: Parameters<ReturnType<typeof anonClient>["auth"]["verifyOtp"]>[0]) =>
          anonClient().auth.verifyOtp(p),
        // Troca a senha do usuário da sessão de teste pela service role.
        updateUser: async ({ password }: { password: string }) => {
          if (!sessaoDeTeste) return { data: { user: null }, error: { message: "sem sessão" } };
          return adminClient().auth.admin.updateUserById(sessaoDeTeste, { password });
        },
        // `definirSenha` revoga as outras sessões depois da troca; sem cookies não há o que revogar aqui.
        signOut: async () => ({ error: null }),
      },
    }),
    supabaseAdmin: () => adminClient(),
    supabaseAnonimo: () => anonClient(),
  };
}

export async function comSessao<T>(usuarioId: string, fn: () => Promise<T>): Promise<T> {
  const anterior = sessaoDeTeste;
  sessaoDeTeste = usuarioId;
  try {
    return await fn();
  } finally {
    sessaoDeTeste = anterior;
  }
}
