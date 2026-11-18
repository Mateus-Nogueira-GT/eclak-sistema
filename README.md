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
