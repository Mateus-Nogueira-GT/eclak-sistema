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
- `npm run test:integracao`: testes de integração (`tests/integracao`, exigem o banco local; rodam em sequência, um arquivo por vez). Como truncam o banco, só uma execução por vez: o global setup (`tests/integracao/trava-global.ts`) pega um advisory lock do Postgres numa conexão aberta até o fim e, se outra execução já o tem, falha logo com "Outra execução dos testes de integração está usando o banco local agora". Rode sempre por este script (um `npx vitest run tests/integracao/...` avulso não passa pela trava).
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

`npm run seed:local` (com o banco local no ar e migrado) cria um usuário por perfil, todos com senha `eclak-local`, e os fornecedores fictícios do protótipo: `diretor@eclak.local`, `consultor@eclak.local`, `operacional@eclak.local`, `fin.operacional@eclak.local`, `fin.estrategico@eclak.local`. Também semeia o financeiro (contas Banco do Brasil e Bradesco PJ, lançamentos manuais do protótipo com datas relativas a hoje, alguns já baixados, a fatura da Família Ribeiro, o cartão "Visa Corporativo" final 4821 com três compras no ciclo atual e uma nota fiscal sem PDF) e a operação (as 5 tarefas da venda em toda viagem vendida; na Família Ribeiro, tarefas manuais do protótipo, roteiro aprovado com Florença e Veneza preenchidos e dois dailies) e a conciliação (um extrato sintético na conta Banco do Brasil com uma transação que confere, uma com diferença de R$ 2,00 e uma tarifa pendente). A venda da Família Ribeiro tem aceite 20 dias antes de hoje (com a entrada em Pix recebida no aceite), de modo que a Visão geral (últimos 30 dias) e a DRE do mês corrente mostram vendido, recebido, pago e os dois blocos. Roda de novo sem duplicar. Recusa executar se `DATABASE_URL` ou `NEXT_PUBLIC_SUPABASE_URL` não apontarem para `localhost`/`127.0.0.1`.

## Operação

Visível aos cinco perfis (nenhum valor de custo, margem ou comissão aparece nestas telas), só para viagem vendida.

- Rotas: `/tarefas` (minhas e todas, com filtros), `/roteiros` (viagens vendidas não terminadas), `/dailies` (hoje até +3 dias) e, por viagem, `/viagens/[id]/{roteiro,tarefas,dailies}` com a impressão em `/roteiro/imprimir` e `/tarefas/imprimir` (o título da página é o nome do arquivo: `RT_<TITULAR>_<DESTINO>_<ini>-<fim>` e `TAREFAS_…`).
- Tarefas automáticas: 5 ao fechar a venda (prazo venda + 1/2/7 dias, nunca depois do início) e 3 ao aprovar o roteiro (60/60/90 dias antes do embarque), sem duplicar (chave única por viagem).
- Dailies: o texto é gerado sob demanda ("Gerar texto"), e a geração é esperada em D-2 e o envio em D-1 da data do dia; antes de D-2 o botão vira "Gerar agora". O estado vai de A gerar a Gerado (a revisar), Pronto para enviar e Enviado. Com o agendador ligado (ver [Integrações](#integrações)), o sistema gera sozinho, às 07:00 de Cuiabá, o texto dos dias de hoje + 2 dos roteiros aprovados que ainda não têm texto.
- O texto de encerramento do daily muda em Admin › Parâmetros, card "Operação" (só o Diretor; vale a partir da versão nova, sem código).

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

## Painéis (Visão geral e Relatórios)

Só leitura (sem tabela nova). "Hoje" é sempre `America/Cuiaba`.

- **Visão geral** (`/visao-geral`, só Diretor e Financeiro estratégico; é a primeira tela deles): avisos "Para decidir hoje" (caixa negativo, margem abaixo da referência, parcelas e comissões vencidas, contas a pagar vencidas ou a vencer em 7 dias, aprovações pendentes; até 8 e "e mais N avisos"), números do período (vendido, margem real × planejada, recebido, pago, resultado de caixa), reserva de caixa, saldo semana a semana das próximas 8 semanas e as viagens que mais perderam margem. Período por `?periodo=` (`30d`, `90d`, `mes`, `mes_anterior`, `ano`).
- **Relatórios** (`/financeiro/relatorios?rel=…`, Diretor e os dois financeiros): DRE, Contas a pagar, Contas a receber, Volume por banco, Margem por viagem e Vendas por consultor, com período `?de=AAAA-MM&ate=AAAA-MM` (padrão: mês atual; máximo 24 meses). Cada linha abre a lista de lançamentos filtrada ou a viagem. **Planilha** em CSV (`/financeiro/relatorios/planilha?rel=…`: UTF-8 com BOM, `;`, decimal com vírgula) e **PDF** pela impressão do navegador (`/financeiro/relatorios/imprimir?rel=…`).
- Consultor e Operacional não têm acesso a nenhuma das duas telas (`/sem-acesso`).
- Os critérios de período e de DRE estão em `docs/HANDOFF.md` (seção da fatia 6a, rulings R1 a R10).

## Conciliação do extrato

`/financeiro/conciliacao` (Diretor e os dois financeiros; no menu, depois de "Contas bancárias").

- **Como importar:** escolha a conta, o período e envie o arquivo OFX que o banco gera (até 5 MB; aceita OFX 1.x em SGML e 2.x em XML, em UTF-8 ou Windows-1252/ISO-8859-1). O sistema mostra quantas transações são novas e quantas já estavam. Reenviar o mesmo arquivo na mesma conta é recusado; um extrato que se sobrepõe a outro só traz o que ainda não existe (a transação é única por conta e identificador do banco).
- **O que é guardado:** só as transações (data, valor com sinal, descrição, identificador do banco) e o resumo da importação (nome do arquivo, período, quem importou, contagens) com o hash do arquivo para recusar repetição. **O arquivo OFX em si não é guardado.**
- **Conferência:** cada transação é comparada com as baixas da conta (mesmo valor de caixa e até 3 dias de diferença para a sugestão; escolha manual até 10 dias). A Valeska confirma o par, escolhe outra baixa, cria o lançamento a partir da transação (tarifa, IOF, rendimento) ou ignora com um motivo, e pode desfazer. Situações: Confere, Diferença de R$ x, Não conciliado, Ignorado e "A baixa mudou: confira" (a baixa foi desfeita ou alterada depois de conciliar).
- **Fora da tela:** o relatório "Conciliação extrato x sistema" (`/financeiro/relatorios?rel=conciliacao`, com planilha e impressão, por conta opcional) e um aviso na Visão geral quando há transação do extrato sem par há mais de 3 dias (contas ativas).
- **Seed local:** um extrato sintético na conta Banco do Brasil (uma transação que confere, uma com diferença e uma tarifa pendente); rodar o seed de novo não duplica.

## Integrações

Trello, Google Drive, IA (chat e "Reescrever com IA") e o agendador (cron). Cada uma fica **desligada enquanto faltar alguma das suas variáveis**. Desligada, o sistema funciona como antes: nada entra na fila, o botão do chat e o "Reescrever com IA" não aparecem, e fechar venda e aprovar roteiro gravam normalmente. **Admin › Integrações** (`/admin/integracoes`, só o Diretor) mostra a situação real de cada uma ("Desligada. Para ligar, preencha no ambiente: …", só os nomes das variáveis, nunca os valores), o botão **Testar conexão** e a fila de envios, com Reenviar para o que falhou. Expedia TAAP e Infotera aparecem como desligadas, aguardando o contrato e a documentação da API. Ainda não existe código para elas, só a interface `ProvedorHotelaria` em `src/server/integracoes/hotelaria.ts`.

| Integração | Variáveis | Onde conseguir |
|---|---|---|
| Agendador | `CRON_SECRET` | Gere um valor aleatório longo (por exemplo `openssl rand -hex 32`). O serviço cron do Railway chama `POST /api/cron/integracoes` (a cada 10 min) e `POST /api/cron/dailies` (07:00 em Cuiabá). |
| Trello | `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_LISTA_ID` | No Power-Up admin do Trello, com a chave e o token da conta da ECLAK. O id da lista "Operações" está no `.json` do quadro. |
| Drive | `GOOGLE_SA_EMAIL`, `GOOGLE_SA_CHAVE`, `GOOGLE_DRIVE_PASTA_RAIZ_ID` | Crie uma conta de serviço no Google Cloud, com a Drive API ativa, e adicione-a como editora do drive compartilhado. `GOOGLE_SA_CHAVE` é a chave privada PEM do JSON da conta e aceita `\n` literais. |
| IA | `ANTHROPIC_API_KEY`, `IA_MODELO` (opcional, padrão `claude-opus-5-5`) | No Console da Anthropic, com a chave da organização da ECLAK. |

Todas as variáveis estão em `.env.example`, vazias e comentadas.

### Como ligar cada uma

1. Preencha as variáveis da integração no serviço do Railway (Variables) e faça um novo deploy. O sistema lê o ambiente na hora de cada chamada, sem cache.
2. Abra **Admin › Integrações**. O cartão deve mostrar "Ligada".
3. Clique em **Testar conexão**. O Trello lê a lista, o Drive pede o token e lê a pasta raiz, e a IA faz um pedido mínimo ao modelo. O resultado fica auditado e aparece no cartão como último teste: ok, ou a classe do erro (autenticação, limite, recusado, servidor, rede).
4. A partir daí, cada venda fechada cria o cartão no Trello (checklist "Tarefas da venda") e as pastas no Drive (`ECL-NNNN_SOBRENOME_DESTINO_AAAAMMDD-AAAAMMDD`, com "Público" e "Uso interno"). Cada roteiro aprovado leva o checklist "Tarefas do roteiro" ao mesmo cartão. Esses envios entram numa fila na mesma transação do evento e são mandados logo depois da resposta. O que falhar é repetido pelo cron, até 6 tentativas, com espera de 1, 5, 15, 60 e 180 min. Erro de autenticação ou pedido recusado vai direto a "falhou" e espera o Reenviar.
5. **Nada antigo é despejado ao ligar.** Só entra na fila o que acontece com a integração já ligada. Para uma viagem vendida antes de ligar, use os botões **Enviar para o Trello** e **Criar pastas no Drive** na própria viagem (só o Diretor).

**Drive:** a pasta raiz (`GOOGLE_DRIVE_PASTA_RAIZ_ID`) precisa estar num **drive compartilhado**, com a conta de serviço (`GOOGLE_SA_EMAIL`) como **editora**. Conta de serviço não tem cota própria, então numa pasta do "Meu Drive" de alguém a criação falha.

### Serviço cron no Railway

O cron só roda com `CRON_SECRET` definido no serviço do sistema. Sem ele, as duas rotas respondem 503 e nada roda. Cabeçalho ausente ou com o segredo errado dá 401. O proxy deixa `/api/cron/` passar sem sessão, porque é a rota que confere o segredo.

Crie no Railway um serviço separado, de cron, que chame as duas URLs com `Authorization: Bearer $CRON_SECRET`. O agendamento do Railway é em UTC:

| Rota | Quando | Agendamento (UTC) | O que faz |
|---|---|---|---|
| `POST /api/cron/integracoes` | a cada 10 min | `*/10 * * * *` | Manda o que está na fila e cuja próxima tentativa chegou (até 20 por vez). |
| `POST /api/cron/dailies` | todo dia às 07:00 em Cuiabá | `0 11 * * *` | Gera os dailies de hoje + 2 (D-2) dos roteiros aprovados. |

O comando de cada serviço (o `-f` faz o `curl` sair com erro em 401 ou 503, e o Railway mostra a falha):

```bash
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$SITE/api/cron/integracoes"
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" "$SITE/api/cron/dailies"
```

Nos dois serviços, `SITE` é o domínio público do sistema, o mesmo de `NEXT_PUBLIC_SITE_URL`, e `CRON_SECRET` é o mesmo valor do serviço do sistema. As URLs também aparecem em Admin › Integrações, no cartão do agendador.

**O agendador do daily** gera só o texto de dias sem texto: dia sem linha ou só com a versão interna, de roteiro **aprovado** de viagem **vendida**. Nunca sobrescreve um daily gerado, revisado ou enviado. O daily fica "Gerado, a revisar", com `gerado_por` vazio (sistema), e a auditoria registra o usuário vazio. O envio ao cliente continua manual (WhatsApp). Chamar a rota duas vezes no mesmo dia não gera de novo.

### O que nunca sai do sistema

- **Trello e Drive:** só o código, o sobrenome do titular, o destino e as datas (no nome do cartão e da pasta), o link da viagem no sistema e os nomes das tarefas. Nunca vão valor, custo, margem, comissão, CPF, passaporte nem nascimento.
- **IA:** antes de cada envio, CPF, CNPJ, passaporte, RG e as datas de nascimento conhecidas viram marcadores (`[CPF]`, `[PASSAPORTE]`, `[NASCIMENTO]`, `[DOCUMENTO]`…). Qualquer sequência de 11 dígitos é tratada como CPF, o que pode mascarar um celular escrito sem máscara. O chat só lê, com o perfil de quem pergunta: as ferramentas chamam as mesmas consultas das telas, e custo, margem e pagamentos a fornecedores só aparecem para quem já os vê. A conversa não é guardada no banco e some ao recarregar. O "Reescrever com IA" mostra a sugestão ao lado, e nada é gravado sem o clique.
- **Custo da IA:** é pago pela ECLAK direto à Anthropic (conta da `ANTHROPIC_API_KEY`). Cada uso fica em `ia_usos`: quem, quando, recurso, modelo e tokens de entrada e saída, sem o texto da conversa.
- **Segredos:** ficam só nas variáveis de ambiente. Não vão para o código, o banco, os logs, a auditoria nem a tela. Um erro de serviço externo é registrado só com a integração, a classe do erro e o status HTTP, nunca com o corpo da resposta.

### Testado só contra serviços falsos

Tudo foi testado contra `fetch` falso e provedores de IA falsos: formato exato das chamadas, erros 401, 403, 429 e 500, timeout, repetição e idempotência. **Nenhuma chamada real foi feita ao Trello, ao Google ou à Anthropic, e nenhuma conta, chave ou token foi criado.** "Só preencher as variáveis e ligar" fica provado apenas quando o primeiro **Testar conexão** real de cada integração der certo em Admin › Integrações, seguido de uma venda de teste conferida no Trello e no Drive.

Em desenvolvimento local: se o seu terminal exporta uma `ANTHROPIC_API_KEY` de verdade, suba o servidor com `ANTHROPIC_API_KEY= npm run dev`. Senão, cada clique no chat ou no "Reescrever" é uma chamada cobrada. Os testes já forçam a variável vazia.

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

   As variáveis das integrações (cron, Trello, Drive, IA) são opcionais e estão em [Integrações](#integrações).

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
