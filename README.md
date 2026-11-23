# ECLAK Sistema

Sistema financeiro e operacional da ECLAK Viagens (Next.js, TypeScript, Tailwind v4).

## Como rodar

1. Docker em execução (o Supabase local roda em contêineres).
2. `npm install`
3. `npm run db:local` (sobe o Supabase local; detalhes em [Banco local](#banco-local)).
4. Crie `.env.local` com as variáveis de `.env.example` (valores locais em [Banco local](#banco-local)).
5. `npm run db:migrate`
6. `npm run seed:local` (usuários e fornecedores fictícios)
7. `npm run dev` e abra http://127.0.0.1:3000.

E-mails enviados localmente (convite, nova senha) chegam no Mailpit: http://127.0.0.1:54324.

## Scripts

- `npm run dev` / `build` / `start`: desenvolvimento, build e produção.
- `npm run lint`: ESLint.
- `npm run typecheck`: verificação de tipos (`tsc --noEmit`).
- `npm test`: testes de domínio (Vitest, `tests/domain`).
- `npm run test:integracao`: testes de integração (`tests/integracao`, exigem o banco local; rodam em sequência, um arquivo por vez).
- `npm run db:local`: sobe o Supabase local (Docker). Depois, `npm run db:migrate` aplica as migrações.
- `npm run db:generate`: gera migração a partir do esquema Drizzle (`src/server/db/schema`).
- `npm run db:migrate`: aplica as migrações em `drizzle/` no banco de `DATABASE_URL`.

As variáveis locais ficam em `.env.local`: é o arquivo lido pelos scripts, pelos testes e pelo `drizzle-kit` (não crie `.env`).

## Banco local

1. Docker em execução. Na máquina de nuvem de desenvolvimento (Docker Hub limitado), exporte antes `SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io`; em máquina normal isso não é necessário.
2. `npm run db:local`, depois `npx supabase status -o env` para ver as chaves.
3. Crie `.env.local` (ignorado pelo git) com `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` e `NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000` (nomes em `.env.example`). Os testes de integração leem `.env.local`.
4. `npm run db:migrate`.

Os modelos de e-mail de convite e de nova senha ficam em `supabase/templates/` e são ligados em `supabase/config.toml`. Ao alterá-los, reinicie o Supabase local (`npx supabase stop && npm run db:local`).

## Convite e senha

- O Diretor cria o usuário em Admin › Usuários; o Supabase envia o convite. O link do e-mail abre `/auth/confirmar`, que valida o token e leva a `/definir-senha`, onde a pessoa cria a senha (mínimo 8 caracteres) e entra.
- Se o convite expirar, o Diretor usa **Reenviar convite** na linha do usuário (aparece enquanto a pessoa nunca entrou).
- Na tela de login, **Esqueci minha senha** envia um link de nova senha, que segue o mesmo caminho (`/auth/confirmar` e `/definir-senha`).

## Regra de RLS

Toda tabela de `public` tem RLS ligado e nenhuma política para `anon`/`authenticated`. **Toda migração nova que cria tabela termina com o `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` dela.** O teste `tests/integracao/rls.test.ts` verifica que `anon` não lê nada; estenda-o ao criar novas tabelas.

## Seed local

`npm run seed:local` (com o banco local no ar e migrado) cria um usuário por perfil, todos com senha `eclak-local`, e os fornecedores fictícios do protótipo: `diretor@eclak.local`, `consultor@eclak.local`, `operacional@eclak.local`, `fin.operacional@eclak.local`, `fin.estrategico@eclak.local`. Também semeia o financeiro (contas Banco do Brasil e Bradesco PJ, lançamentos manuais do protótipo com datas relativas a hoje, alguns já baixados, a fatura da Família Ribeiro, o cartão "Visa Corporativo" final 4821 com três compras no ciclo atual e uma nota fiscal sem PDF). Roda de novo sem duplicar. Recusa executar se `DATABASE_URL` ou `NEXT_PUBLIC_SUPABASE_URL` não apontarem para `localhost`/`127.0.0.1`.

## Financeiro

Área só do Diretor e dos perfis financeiros (Financeiro › Lançamentos, Fluxo de caixa, Faturas, Notas fiscais, Cartões, Contas bancárias e Categorias).

- **Lista única de lançamentos** (a pagar e a receber): os lançamentos manuais (únicos, parcelados ou recorrentes) e as linhas das viagens (parcelas, pagamentos a fornecedores e comissões) aparecem juntos. A baixa individual ou em lote é a mesma da tela da viagem: o que se baixa de um lado aparece no outro.
- **Conta bancária obrigatória** em toda baixa nova.
- **Cartão direto no fornecedor** (cliente paga no cartão e o fornecedor repassa): a lista mostra uma linha de repasse; a baixa informa o valor repassado, e a diferença para o esperado vira taxa da forma.
- **Faturas** numeradas a partir de 1405, sem buracos (rollback não consome número). Reemitir mantém o número e guarda um novo retrato. Enquanto não houver nenhuma fatura, o próximo número pode ser ajustado em Admin › Parâmetros.

- **Fluxo de caixa** (`/financeiro/caixa`): saldo atual por conta (saldo inicial mais as baixas desde a data do saldo, só o que transita pelo caixa) e projeção de 8 semanas e 12 meses a partir das linhas em aberto. Cartão de crédito e boleto entram pelo valor líquido da taxa; crédito antecipado entra no primeiro vencimento; vencidas ficam marcadas na semana e no mês atuais. Filtros por centro, viagem e tipo (clientes, fornecedores, comissões, empresa, cartão). A coluna Saldo atual também aparece em Contas bancárias.
- **Reserva**: meta = 6 × custo fixo mensal vigente (Admin › Parâmetros), com o mês em que a projeção a atinge ("atingida em") ou "não atingida em 12 meses".
- **Anexos**: PDF, PNG ou JPEG de até 10 MB (tipo conferido pelos bytes) em qualquer linha da lista, nas faturas do cartão e nas notas fiscais. Ficam no bucket privado `anexos` do Supabase Storage; o download usa URL assinada de 60 segundos.
- **Notas fiscais** (`/financeiro/notas-fiscais`): número único entre as não canceladas, CPF/CNPJ validado, cancelamento com motivo (a nota nunca é apagada), PDF anexo e filtros por período e destinatário.
- **Cartões corporativos** (`/financeiro/cartoes`): cadastro com final, dias de fechamento e vencimento (1 a 28), conta de débito e centro. Compras (lançamento a pagar em Cartão de crédito com o cartão, ou pagamento de viagem na forma Cartão corporativo) caem na fatura do ciclo. A fatura é uma só linha na lista e no caixa; a baixa quita todas as compras com uma saída no banco (compras em moeda estrangeira pedem o valor em reais cobrado, que vira o câmbio efetivo) e pode ser desfeita.

## Deploy (produção)

Um único ambiente: um projeto Supabase e um serviço no Railway. Dados fictícios nunca vão para produção.

### 1. Supabase (produção)

1. Crie o projeto no Supabase (região mais próxima do Brasil) e guarde a senha do banco.
2. Authentication > Sign In / Providers > Email: desligue **Allow new users to sign up** (sem auto-cadastro; só o Diretor cria usuários).
3. Authentication > URL Configuration: **Site URL** = domínio do Railway (por exemplo `https://eclak-sistema.up.railway.app`); em Redirect URLs, inclua `https://<domínio>/auth/confirmar`.
4. Authentication > Email Templates: cole os modelos do repositório, que levam o link para `/auth/confirmar`:
   - **Invite user**: assunto `Convite para o sistema da ECLAK`, corpo = conteúdo de `supabase/templates/invite.html`;
   - **Reset password**: assunto `Crie uma nova senha no sistema da ECLAK`, corpo = conteúdo de `supabase/templates/recovery.html`.

   Sem esses modelos o link do e-mail não abre a tela de definir senha.
5. Convites e redefinição de senha enviam e-mail: o SMTP padrão do Supabase tem limite baixo e só entrega a membros da equipe; configure um SMTP próprio em Authentication > SMTP Settings antes de convidar a equipe.
6. Database > Backups: confirme que os backups diários estão ativos.
7. Em Connect (ou Project Settings > Database) > Connection string, copie:
   - **Transaction pooler** (porta 6543) para `DATABASE_URL`, acrescentando `?sslmode=require`;
   - **Session pooler** (porta 5432, mesmo host do pooler) para `DATABASE_URL_MIGRACAO`, acrescentando `?sslmode=require`.

   Não use a **Direct connection** (`db.<projeto>.supabase.co`): ela é só IPv6, e muitas redes (inclusive a sua máquina, em geral) só saem por IPv4; o Session pooler é IPv4 e aceita DDL (migrações). Não acrescente `?pgbouncer=true`: esse parâmetro é só do Prisma e o driver usado aqui (postgres.js) o envia ao banco, que recusa a conexão (`unrecognized configuration parameter "pgbouncer"`).
8. Em Project Settings > API, copie a URL do projeto, a chave `anon` e a chave `service_role`.

### 2. Railway

1. Novo serviço a partir do repositório (raiz do repositório). O `railway.json` define: builder Railpack, build `npm run build` (a instalação `npm ci` é feita antes pelo próprio Railpack), pré-deploy `npm run db:migrate`, start `node .next/standalone/server.js` e healthcheck em `/login`. O script `postbuild` copia `public/` e `.next/static` para dentro de `.next/standalone`.
2. Variáveis do serviço:
   - `DATABASE_URL`: Transaction pooler (porta 6543), com `?sslmode=require`
   - `DATABASE_URL_MIGRACAO`: Session pooler (porta 5432), com `?sslmode=require`, usada pelo pré-deploy
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `NEXT_PUBLIC_SITE_URL`: o domínio público do serviço, sem barra no fim (por exemplo `https://eclak-sistema.up.railway.app`)
   - `TZ=America/Cuiaba`
   - `HOSTNAME=0.0.0.0`
   - `RAILPACK_NODE_VERSION=22` (recomendado: fixa o Node; o `package.json` exige `>=20.9`, mínimo do Next 16)

   `NEXT_PUBLIC_*` são embutidas no build; ao mudá-las, faça novo deploy. O Railway define `PORT` sozinho. As variáveis precisam existir já no build (o build carrega os módulos do servidor).
3. O pré-deploy roda `drizzle-kit` (dependência de desenvolvimento). No log do primeiro deploy, confirme que as devDependencies foram instaladas e mantidas na imagem (o `npm run db:migrate` precisa achar `drizzle-kit`). Se não estiverem, defina `NPM_CONFIG_PRODUCTION=false` no serviço.
4. Gere o domínio público do serviço e volte aos passos 1.3 (Site URL e Redirect URLs) e 2.2 (`NEXT_PUBLIC_SITE_URL`, que exige novo deploy).

### 2.1 Anexos (Storage) e limite de upload

- A migração `0028` cria o bucket privado `anexos` (insert em `storage.buckets`). No primeiro deploy, confirme no painel do Supabase (Storage) que o bucket existe; se não existir, crie-o como **privado**.
- O upload passa pela Server Action com `serverActions.bodySizeLimit` e `experimental.proxyClientMaxBodySize` em `"11mb"` (`next.config.ts`), para caber o arquivo de 10 MB. Se houver proxy na frente do serviço, ele também precisa aceitar corpos de 11 MB.
- A categoria de sistema "Cartão corporativo" é marcada pela migração `0032` casando por nome (Administrativo › Cartão corporativo); confirme após migrar.

### 3. Primeiro Diretor

Depois do primeiro deploy (migrações aplicadas), uma única vez, na sua máquina. Passe as variáveis de produção na própria linha de comando, sem editar o `.env.local` (o script lê `.env.local` só para o que não vier do ambiente; o que está na linha de comando prevalece):

```bash
DATABASE_URL="<Session pooler, porta 5432, ?sslmode=require>" \
NEXT_PUBLIC_SUPABASE_URL="https://<projeto>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<service_role>" \
NEXT_PUBLIC_SITE_URL="https://<domínio do Railway>" \
npx tsx scripts/criar-diretor.ts "<nome>" <email>
```

Use o Session pooler também aqui: a Direct connection é só IPv6. A pessoa recebe o convite por e-mail, abre o link, define a senha em `/definir-senha` e entra. Novos usuários são criados pelo Diretor em Usuários e acessos.
