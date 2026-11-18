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
- `npm run test:integracao`: testes de integração (`tests/integracao`, exigem banco).

Copie `.env.example` para `.env` e preencha as variáveis quando existirem.
