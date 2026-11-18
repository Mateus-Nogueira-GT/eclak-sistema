import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { db, sql } from "@/server/db/client";
import { usuarios, type Filial, type Perfil } from "@/server/db/schema";

function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** Trunca todas as tabelas de `public` e apaga os usuários de `auth.users`. */
export async function limparBanco(): Promise<void> {
  const tabelas = await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public'`;
  if (tabelas.length > 0) {
    const lista = tabelas.map((t) => `"public"."${t.tablename}"`).join(", ");
    await sql.unsafe(`truncate table ${lista} restart identity cascade`);
  }
  await sql`delete from auth.users`;
}

export async function criarUsuarioTeste(
  perfil: Perfil,
  opcoes: { ativo?: boolean; filial?: Filial } = {},
): Promise<{ id: string; email: string; senha: string }> {
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
