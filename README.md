# ECLAK Sistema

Sistema financeiro e operacional da ECLAK Viagens (Next.js, TypeScript, Tailwind v4).

## Como rodar

```bash
npm install
npm run dev
```

Abra http://localhost:3000.

## Scripts

- `npm run dev` / `build` / `start`: desenvolvimento, build e produção.
- `npm run lint`: ESLint.
- `npm run typecheck`: verificação de tipos (`tsc --noEmit`).
- `npm test`: testes de domínio (Vitest, `tests/domain`).
- `npm run test:integracao`: testes de integração (`tests/integracao`, exigem o banco local; rodam em sequência, um arquivo por vez).
- `npm run db:local`: sobe o Supabase local (Docker). Depois, `npm run db:migrate` aplica as migrações.
- `npm run db:generate`: gera migração a partir do esquema Drizzle (`src/server/db/schema`).
- `npm run db:migrate`: aplica as migrações em `drizzle/` no banco de `DATABASE_URL`.

Copie `.env.example` para `.env` e preencha as variáveis quando existirem.

## Banco local

1. Docker em execução. Na máquina de nuvem de desenvolvimento (Docker Hub limitado), exporte antes `SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io`; em máquina normal isso não é necessário.
2. `npm run db:local`, depois `npx supabase status -o env` para ver as chaves.
3. Crie `.env.local` (ignorado pelo git) com `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` e `SUPABASE_SERVICE_ROLE_KEY` (nomes em `.env.example`). Os testes de integração leem `.env.local`.
4. `npm run db:migrate`.

## Regra de RLS

Toda tabela de `public` tem RLS ligado e nenhuma política para `anon`/`authenticated`. **Toda migração nova que cria tabela termina com o `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` dela.** O teste `tests/integracao/rls.test.ts` verifica que `anon` não lê nada; estenda-o ao criar novas tabelas.

## Seed local

`npm run seed:local` (com o banco local no ar e migrado) cria um usuário por perfil, todos com senha `eclak-local`, e os fornecedores fictícios do protótipo: `diretor@eclak.local`, `consultor@eclak.local`, `operacional@eclak.local`, `fin.operacional@eclak.local`, `fin.estrategico@eclak.local`. Roda de novo sem duplicar. Recusa executar se `DATABASE_URL` ou `NEXT_PUBLIC_SUPABASE_URL` não apontarem para `localhost`/`127.0.0.1`.

## Deploy (produção)

Um único ambiente: um projeto Supabase e um serviço no Railway. Dados fictícios nunca vão para produção.

### 1. Supabase (produção)

1. Crie o projeto no Supabase (região mais próxima do Brasil) e guarde a senha do banco.
2. Authentication > Sign In / Providers > Email: desligue **Allow new users to sign up** (sem auto-cadastro; só o Diretor cria usuários).
3. Authentication > URL Configuration: **Site URL** = domínio do Railway (por exemplo `https://eclak-sistema.up.railway.app`); inclua o mesmo domínio em Redirect URLs.
4. Convites e redefinição de senha enviam e-mail: o SMTP padrão do Supabase tem limite baixo e só entrega a membros da equipe; configure um SMTP próprio em Authentication > SMTP Settings antes de convidar a equipe.
5. Database > Backups: confirme que os backups diários estão ativos.
6. Em Project Settings > Database > Connection string, copie:
   - **Transaction pooler** (porta 6543) para `DATABASE_URL`, acrescentando `?pgbouncer=true`;
   - **Direct connection** (porta 5432) para `DATABASE_URL_MIGRACAO`.
7. Em Project Settings > API, copie a URL do projeto, a chave `anon` e a chave `service_role`.

### 2. Railway

1. Novo serviço a partir do repositório (raiz do repositório). O `railway.json` define: build `npm ci && npm run build`, pré-deploy `npm run db:migrate`, start `node .next/standalone/server.js` e healthcheck em `/login`. O script `postbuild` copia `public/` e `.next/static` para dentro de `.next/standalone`.
2. Variáveis do serviço:
   - `DATABASE_URL`: pooler de transação, com `?pgbouncer=true`
   - `DATABASE_URL_MIGRACAO`: conexão direta (porta 5432), usada pelo pré-deploy
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `TZ=America/Cuiaba`
   - `HOSTNAME=0.0.0.0`

   `NEXT_PUBLIC_*` são embutidas no build; ao mudá-las, faça novo deploy. O Railway define `PORT` sozinho.
3. Gere o domínio público do serviço e volte ao passo 1.3 para ajustar a Site URL do Supabase.

### 3. Primeiro Diretor

Depois do primeiro deploy (migrações aplicadas), uma única vez, na sua máquina com `.env.local` apontando para produção (`DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`):

```bash
npx tsx scripts/criar-diretor.ts "<nome>" <email>
```

A pessoa recebe o convite por e-mail e define a senha pelo link. Novos usuários são criados pelo Diretor em Usuários e acessos.
