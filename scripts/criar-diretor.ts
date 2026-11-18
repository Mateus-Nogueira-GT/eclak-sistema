/**
 * Cria o primeiro Diretor: npx tsx scripts/criar-diretor.ts "<nome>" <email>
 * Lê DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY de .env.local ou do ambiente.
 * Recusa se já existir Diretor ativo. Envia convite por e-mail (a pessoa define a senha pelo link).
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

async function main() {
  const [nome, emailBruto] = process.argv.slice(2);
  if (!nome?.trim() || !emailBruto?.trim()) {
    console.error('Uso: npx tsx scripts/criar-diretor.ts "<nome>" <email>');
    process.exit(1);
  }
  const email = emailBruto.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("E-mail inválido");
    process.exit(1);
  }
  const { DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  if (!DATABASE_URL || !NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("Faltam DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const sql = postgres(DATABASE_URL, { prepare: false, max: 1 });
  const admin = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  try {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from usuarios where perfil = 'diretor' and ativo`;
    if (n > 0) {
      console.error("Já existe um Diretor ativo. Novos usuários são criados pelo Diretor, na tela Usuários.");
      process.exit(1);
    }
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email);
    if (error || !data.user) {
      console.error(`Falha ao enviar o convite: ${error?.message}`);
      process.exit(1);
    }
    try {
      await sql.begin(async (tx) => {
        await tx`
          insert into usuarios (id, nome, email, perfil, filial, ativo)
          values (${data.user.id}, ${nome.trim()}, ${email}, 'diretor', 'Rondonópolis', true)`;
        await tx`
          insert into auditoria (usuario_id, tabela, registro_id, acao, depois)
          values (${data.user.id}, 'usuarios', ${data.user.id}, 'criar',
                  ${sql.json({ nome: nome.trim(), email, perfil: "diretor", filial: "Rondonópolis", ativo: true })})`;
      });
    } catch (e) {
      await admin.auth.admin.deleteUser(data.user.id);
      throw e;
    }
    console.log(`Diretor criado. Convite enviado para ${email}.`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
