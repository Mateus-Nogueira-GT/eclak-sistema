# Passagem de sessão — Sistema ECLAK Viagens

Atualizado em 23/11/2026. Leia este arquivo inteiro antes de mexer no código. Ele resume o que foi feito, onde está, como rodar, as decisões tomadas e o que falta.

## 1. Em uma frase

O sistema real da ECLAK Viagens (agência de turismo de alto padrão de Rondonópolis-MT, diretor Augusto Kraemer) está sendo construído **por fatias**. As fatias **1, 2, 3a, 3b e 4a estão prontas, revisadas e mergeadas em `main`** (PRs #1 a #5, em 23/11/2026, com o "sim" do Mateus). A **próxima é a fatia 4b (Financeiro: fluxo de caixa, reserva, anexos e notas fiscais, cartão corporativo)**. Nada foi publicado (sem Railway, sem Supabase de produção).

## 2. Onde está cada coisa

### Repositórios
| Repositório | Para que serve | Branch de trabalho |
|---|---|---|
| `Mateus-Nogueira-GT/eclak-sistema` | **Sistema real** (este repositório) | pilha de branches abaixo |
| `Mateus-Nogueira-GT/eclak-mockup` | **Protótipo navegável** (31 telas, dados em memória) usado como referência visual e de regras | `main` (protótipo) e `claude/tender-feynman-ffq4fo` (cópia antiga do desenho e do plano da fatia 1 — **a versão válida está neste repositório**) |

O protótipo está publicado em https://prototipo-financeiro-six.vercel.app (publicado em 17/11/2026, 31 telas). **Não republicar sem o "sim" explícito do Mateus** (é preciso vincular o projeto Vercel "prototipo-financeiro").

### Branches e PRs
Os PRs #1 a #5 foram mergeados em `main` em ordem (merge commit, branches mantidas). **Toda fatia nova parte de `main`** numa branch `claude/fatia-…` e abre PR com base `main`. Atenção: a branch padrão do GitHub ainda é `claude/fatia-1-base`; ao abrir PR, passe `--base main`.

| Fatia | Branch | PR |
|---|---|---|
| 1 Base | `claude/fatia-1-base` | [#1](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/1) |
| 2 Clientes | `claude/fatia-2-clientes` | [#2](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/2) |
| 3a Cotação → proposta aprovada | `claude/fatia-3a-precificacao` | [#3](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/3) |
| 3b Venda → margem real | `claude/fatia-3b-venda` | [#4](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/4) |
| 4a Lançamentos e faturas | `claude/fatia-4-financeiro` | [#5](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/5) |

### Documentos
- Desenho geral (spec): `docs/superpowers/specs/2026-11-18-backend-sistema-real-design.md`
- Planos (cada um com "Decisões", "Global Constraints" e "Review Focus"):
  - `docs/superpowers/plans/2026-11-18-fatia-1-base.md`
  - `docs/superpowers/plans/2026-11-18-fatia-2-clientes.md`
  - `docs/superpowers/plans/2026-11-21-fatia-3a-precificacao.md`
  - `docs/superpowers/plans/2026-11-22-fatia-3b-venda.md` (tem a seção **"Para a fatia 4"**)
  - `docs/superpowers/plans/2026-11-22-fatia-4a-lancamentos-faturas.md` (tem a seção **"Para a 4b"**)
- Desenho da fatia 4 (4a e 4b): `docs/superpowers/specs/2026-11-22-fatia-4-financeiro-design.md`
- `README.md`: como rodar, banco local, seed, convite/senha, RLS e **passo a passo do deploy** (ainda não executado).
- Protótipo, para regras e visual: `eclak-mockup/PRODUCT.md`, `eclak-mockup/DESIGN.md`, `eclak-mockup/src/app/**`, `eclak-mockup/src/lib/**`.

## 3. Sobre o Mateus e o cliente (como trabalhar)

- Mateus Nogueira conduz o projeto para o cliente Augusto Kraemer (ECLAK Viagens). Fala português-BR, prefere respostas diretas, resumo prático primeiro, depois detalhes; gosta de alternativas com recomendação; é iterativo. Datas e recortes sempre explícitos.
- Valeska é do financeiro da ECLAK. **Retorno dela (confirmado pelo Mateus em 22/11/2026): o financeiro deve ser parecido com o Conta Azul** (contas a pagar e receber, categorias, competência, centro de custo, formas de pagamento, baixa, conciliação, fluxo de caixa, DRE). Ver a seção 8.1. Ainda pendente o retorno do grupo sobre Reembolsos, Estoque, Caixa de experiência, Avisos por setor e Daily padrão.
- Pendente também: texto oficial de encerramento do daily (constante `ENCERRAMENTO` provisória em `eclak-mockup/src/app/dailies/page.tsx`).
- A precificação é sigilosa.
- **Regras de marca (valem para todo texto e tela):** azul #2E5C71 dominante; laranja #F26531 só em destaque; texto #333132; sem preto puro; **sem vermelho** (avisos em `ouro`); sem gradiente; sem ícone de estrelinha para IA; sem emoji em mensagens ao cliente; sem tag "Fase 2". Textos em pt-BR.
- Ações irreversíveis ou externas (deploy, publicar, merge, criar projetos em Supabase/Railway, mandar e-mail ao Augusto): **sempre pedir o "sim" do Mateus**.

## 4. Stack e arquitetura (decidido)

- Next.js 16.4 (App Router; `src/proxy.ts` no lugar de middleware), React 19.3, Tailwind v4, TypeScript estrito.
- Supabase: Postgres + Auth (+ Storage previsto, ainda não usado). **Acesso ao banco só pelo servidor via Drizzle**; RLS ligado em toda tabela de `public` **sem políticas** (bloqueia acesso direto do navegador).
- Deploy previsto: **Railway, um único ambiente (produção)** + um único projeto Supabase. Nada foi publicado ainda.
- Só a ECLAK usa (sem multiagência). Duas filiais: `Rondonópolis` e `RS`.
- Server Actions (sem API separada). Zod para validação. Vitest para testes.

### Organização do código
```
src/domain/          regras puras, sem I/O (dinheiro, perfis, regras, clientes, precificacao, aprovacoes, venda, cambio, decimal…)
src/server/db/       schema Drizzle e cliente
src/server/actions/  Server Actions ("use server")
src/server/queries/  leituras (server-only)
src/server/acesso.ts comPerfil / errosDeCampo / ehUuid
src/server/auth.ts   usuarioAtual / exigirPerfil / ErroAcesso
src/server/trava-viagem.ts  trava da viagem (advisory lock + for update)
src/server/auditoria.ts     registrarAuditoria (sempre na mesma transação)
src/server/financeiro/      núcleo das baixas (baixas-viagem.ts) e faturas (server-only, sem "use server")
src/app/(app)/       telas logadas; src/app/login, /auth/confirmar, /definir-senha
drizzle/             migrações 0000–0025 (geradas + custom para RLS, índices, enums)
scripts/             seed-local, seed-orcamentos, seed-vendas, criar-diretor, local-guard, postbuild
tests/domain, tests/integracao (integração roda contra Supabase local e TRUNCA o banco)
```

### Convenções obrigatórias (Global Constraints acumuladas)
- Dinheiro em `bigint` **centavos**; percentuais como string `"19.000"`; nenhuma conta de dinheiro em ponto flutuante; arredondamento meio-para-cima com `arredondar` (`src/domain/decimal.ts`); repartições: truncar e a última absorve (nunca negativo).
- "Hoje" sempre em `America/Cuiaba` (`hojeEmCuiaba`); datas ISO `AAAA-MM-DD`.
- **Toda Server Action começa com `comPerfil(...)`** (actions são alcançáveis por POST de qualquer caminho; o proxy não as protege). **Toda query chama `exigirPerfil(...)`**.
- Auditoria (quem, quando, tabela, id, antes, depois) **na mesma transação** de toda alteração.
- Exclusão lógica em cadastros; lançamentos financeiros nunca apagados (cancelados/estornados). Exceção aceita: linhas de previsão de pagamento ainda não pagas são refeitas ao trocar a forma de pagamento ao fornecedor.
- Toda tabela nova termina com `ENABLE ROW LEVEL SECURITY` numa migração custom e entra em `tests/integracao/rls.test.ts`.
- Valor novo de enum em migração própria (só o `ALTER TYPE … ADD VALUE`).
- Escritas em viagem/venda/financeiro: `travarViagem` (advisory + `for update`) e mesma ordem de travas.
- Erros de banco logados só com o código (sem parâmetros: evitam CPF/passaporte em log).

### Perfis e acesso
`diretor`, `consultor`, `operacional`, `fin_operacional`, `fin_estrategico`. Mapa de rotas em `src/domain/perfis.ts` (`ROTAS_POR_PERFIL`, `podeAcessar`). **Camada estratégica** (custo, margem, compensação, imposto, rateio, ponte): só diretor e os dois financeiros (`veCamadaEstrategica`), **montada só para esses perfis no servidor** (nunca calcular e esconder). Aprovar precificação: só diretor. Baixas e conciliação: diretor e financeiros. Fechar venda: consultor, operacional, diretor. Clientes e fornecedores: todos.

## 5. O que cada fatia entrega

**Fatia 1 — Base.** Login (Supabase Auth, sessão por cookie), proxy com bloqueio por perfil, convite por e-mail + `/auth/confirmar` + `/definir-senha` + "Esqueci minha senha" + reenviar convite; Admin › Usuários (só Diretor; nunca fica sem Diretor ativo); Admin › Parâmetros **versionados** com histórico (valores iniciais da tela do protótipo; a versão inicial vale "desde sempre"; câmbio USD/EUR/GBP/CHF com data, mantido à mão); Fornecedores; auditoria; seed local; configuração do Railway.

**Fatia 2 — Clientes.** Cliente = grupo (titular + quem viaja), contato, preferências, filial, código `ECL-NNNN` a partir de **ECL-0001**; CPF válido e único entre clientes ativos; pessoas com **id estável** e remoção lógica; avisos de documento e aniversário; controle de edição simultânea; busca sem acento por nome, CPF/telefone com máscara e código. Sem upload de documentos (cópias seguem no Drive até a fatia 6).

**Fatia 3a — Da cotação à proposta aprovada.** Orçamento com código `ECL-NNNN-NN` (código do cliente + sequencial); itens com várias cotações (moeda original + câmbio do dia); taxa de roteiro automática; **aéreo vendido à parte** (fora da margem); fórmulas da planilha v7 (`src/domain/precificacao.ts`, testadas contra o caso Itália: 2x a 6x → R$ 66.965,18, 19,0%); envio para aprovação com versões que **fixam as regras da época**; decisão do Diretor (aprovar, aprovar com ajuste por cotação e moeda, devolver); proposta para impressão/PDF só após aprovação, com aviso se o orçamento mudou depois; valor de referência ao cliente visível a todos.

**Fatia 3b — Da venda à margem real.** Fechamento da venda (só com orçamento aprovado; forma diferente volta ao Diretor; ajustes do cliente voltam à precificação); parcelas a receber exatas; contas a pagar a partir da cotação escolhida; comissão por reserva (descontada ou a receber); baixas (só Diretor e financeiro) com câmbio efetivo; atualizar previsto com motivo (complemento se a conta já estava paga); contestação; conciliação; **margem real com a mesma fórmula da aprovação** e ponte planejada → real com soma exata; status Vendida / Em viagem / Recebendo / Conciliada; aviso de passaporte pela data de volta (6 meses).

**Fatia 4a — Lançamentos e faturas.** Menu Financeiro (só Diretor e financeiros): **lista única** a pagar e a receber no modelo Conta Azul (abas, filtros período/situação/categoria/centro, totais vencidos/vencem hoje/a vencer/pagos, baixa individual e em lote), juntando lançamentos manuais (único, parcelado, recorrente com "só esta"/"esta e as próximas") e as linhas das viagens pela view `lancamentos_financeiros` (sem duplicar dado); **a mesma baixa** na lista e na viagem (núcleo `src/server/financeiro/baixas-viagem.ts`), com **conta bancária obrigatória**; desfazer baixa e desfazer cancelamento; categorias em dois níveis editáveis (27 iniciais); contas bancárias; **cartão direto no fornecedor** (regra a: linha de repasse; esperado − repassado = taxa; valor repassado gravado na parcela); **faturas a partir de 1405** sem buracos (contador travado), retrato por emissão, aviso de desatualizada, reemissão com o mesmo número, impressão; próximo número ajustável em Parâmetros enquanto não houver fatura. Parâmetros vigentes lidos pelo relógio do banco.

## 6. Decisões tomadas (todas)

Do Mateus:
- Postgres no Supabase, deploy no Railway, **um ambiente só**, sem API separada, só a ECLAK, repositório novo separado do protótipo.
- Camada estratégica aberta também aos dois perfis financeiros (o protótipo mostrava só ao Diretor; a matriz na tela de Usuários foi atualizada — **vale avisar o Augusto**, que respondeu diferente no formulário de 13/11/2026).
- Fórmula oficial = a da tela Aprovações do protótipo (imposto 7% sobre o spread, taxa de roteiro, rateio do custo fixo).
- Clientes: código a partir de ECL-0001; sem upload de documentos.
- Código da viagem: `ECL-NNNN-NN`.
- Aéreo à parte; cotações em moeda original com câmbio.
- Fatia 3 dividida em 3a e 3b; baixa simples já na 3b, só Diretor e financeiro.
- Venda só com orçamento aprovado.

Do Claude (registradas nos planos, conferir com o Mateus):
- "Margem sem taxa de serviço" = margem líquida sobre o preço ao cliente (bate com a planilha).
- Diferenças de 1 centavo da planilha por arredondamento linha a linha; rateio por dia arredondado a R$ 230,29/dia antes de multiplicar.
- Taxa de roteiro com venda R$ 250,00 (sem margem/compensação).
- 6x com antecipação por interpolação linear (7,7367%).
- Preço pelo **pior custo** de cada item; a cotação escolhida gera a "margem extra".
- Editar cotação estrangeira mantém o câmbio gravado (só muda se trocar a moeda).
- Clientes é a tela inicial de todos os perfis.
- Semáforo de margem: "No alvo" / "Abaixo do alvo" / "Abaixo da referência" (alvo e referência são 19% nos Parâmetros atuais).
- Taxas das parcelas = rateio das taxas aprovadas; só a taxa efetiva de parcela recebida muda a margem real.
- Desconto à vista do fornecedor entra na margem real quando pago.
- **Recebimento a menos ou parcela cancelada reduz a receita da margem real** (só a parte do pacote) e exige observação — **mais importante de confirmar**.
- Comissão cancelada fica marcada (nunca apagada).

Fatia 4 (Mateus, 22/11/2026): fatura começa em **1405**; sem importação dos lançamentos atuais; conciliação por **OFX na fatia 6**; fatia 4 dividida em **4a** (lançamentos, baixas, faturas) e **4b** (fluxo de caixa, reserva, anexos/notas, cartão corporativo); tabela `lancamentos` + view união com as linhas das viagens (abordagem A); cartão direto pela regra (a), a confirmar com a Valeska.

Fatia 4a (Claude, conferir): rótulos das formas de pagamento só no TypeScript (a view emite códigos); o repasse a menos entra como taxa na margem real (a margem não muda além disso); o bloqueio "pago no cartão do fornecedor" vale só para contas em reais (pagamento em euro desse fornecedor segue baixado na viagem); o card "Vencidos" soma só o período filtrado (padrão: mês atual).

## 7. Perguntas abertas para o Augusto
1. Taxa de roteiro: a planilha v7 mostra venda de R$ 259,69; o sistema usa R$ 250,00.
2. 6x com antecipação: interpolação dá 7,7367% (R$ 71.277,08); a planilha mostra 7,73% e R$ 71.273,78.
3. Matriz de acesso: margem/custos agora visíveis também aos financeiros.
4. Ainda em aberto no `PRODUCT.md` do protótipo: modelo de fatura, cartões corporativos, percentual do alerta de preço, validade da cotação, API do Sakura Click, fontes da marca (Evaida, CA Saygon Text) não enviadas.

## 8. Próximo passo: fatia 4b (Financeiro)

Escopo no desenho (`docs/superpowers/specs/2026-11-22-fatia-4-financeiro-design.md`, §6.5) e notas na seção "Para a 4b" do plano da 4a: fluxo de caixa com projeção de 12 meses (realizado + previsto da view `lancamentos_financeiros`, só `transita_caixa`), meta de reserva de 6 meses de custo fixo, anexos e notas fiscais (Supabase Storage, primeiro uso), faturas de cartão corporativo (custo variável, IOF). Referências no protótipo: `src/app/{fluxo-de-caixa,notas-fiscais,relatorios}/page.tsx`, `src/components/{reserva-projecao,cash-chart,operacionais}.tsx`, `src/lib/calc.ts`.

### 8.1 Referência: Conta Azul (pedido da Valeska)
O financeiro segue o Conta Azul (lista única, categorias grupo › categoria, competência, centro de custo MT/RS, formas de pagamento, baixa, conciliação, fluxo de caixa, DRE). A 4a já cobre lista, baixas, categorias, parcelamento e recorrência.

Materiais ainda não recebidos (Drive da Valeska): `CUSTOS FIXOS.xlsx` (base da reserva e das contas fixas), `PLANILHA NOTAS FISCAIS.xlsx` (comissões por empresa e competência), modelo `FATURA_1405_…pdf` (a impressão da fatura aguarda esse modelo), plano de categorias do Conta Azul.

### 8.2 Para confirmar com a Valeska ou o Augusto
- Regra (a) do cartão direto: a margem cai pelo que o fornecedor reteve; pagamento em euro do fornecedor do cartão segue na viagem.
- Card "Vencidos": só o período filtrado ou todos os vencidos.
- Numeração 1405 e telas do financeiro só para Diretor e financeiros.

### 8.3 Pendências menores da 4a (não bloqueiam)
Teste de auditoria sem `orderBy`; sem teste de concorrência no "esta e as próximas"; repasse esperado negativo sem mensagem própria; fornecedor do cartão não editável na tela depois de definido; "Código" da lista é o id curto; datas no formato do navegador; rótulo da forma não cita a entrada; seed não zera o contador de faturas; idempotência do seed pela descrição.

Outras pendências menores acumuladas (não bloqueiam): teste de RLS aceita qualquer erro; `comSessao` nos testes depende de `fileParallelism: false`; auditoria guarda CPF/passaporte (anotar na política de LGPD); trava global de CPF serializa cadastros; telefones só brasileiros; lista de orçamentos sem paginação; sugestão de custo de referência conta cotações, não itens; "Passeio guiado" virou "Passeio" no tipo de item; validação de data duplicada entre formulário e domínio de regras.

Deploy (quando o Mateus der o "sim"): seguir `README.md` › Deploy. Cuidados já documentados: usar o **Session pooler** (IPv4) para migrações e `criar-diretor`, Transaction pooler para a aplicação, sem `?pgbouncer=true`; configurar os templates de e-mail de convite e recuperação no Supabase; `NEXT_PUBLIC_SITE_URL`; Railpack com Node 22.

## 9. Como rodar (inclui as manhas da máquina de nuvem)

```bash
npm install
# Mac do Mateus: Docker via Colima (brew install colima docker; colima start --cpu 4 --memory 6)
# Docker: nesta nuvem o daemon não sobe sozinho
docker ps || (dockerd > /tmp/dockerd.log 2>&1 &)
# Docker Hub e ECR limitam downloads nesta nuvem: usar o registro do GitHub
export SUPABASE_INTERNAL_IMAGE_REGISTRY=ghcr.io
npm run db:local          # supabase start sem os serviços pesados
npx supabase status -o env   # chaves para o .env.local
npm run db:migrate
npm run seed:local        # usuários (senha eclak-local), fornecedores, 30 clientes, orçamentos e vendas de exemplo
npm run dev               # abrir em localhost (127.0.0.1 não fica interativo no dev)
```
- `.env.local` (não versionado): `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL` (ver `.env.example`).
- Usuários do seed: `diretor@eclak.local`, `consultor@eclak.local`, `operacional@eclak.local`, `fin.operacional@eclak.local`, `fin.estrategico@eclak.local`, senha `eclak-local`.
- Testes: `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build`. Últimos números (23/11/2026): 262 testes de domínio, 283 de integração, tudo verde. **A integração trunca o banco local**: rodar `npm run seed:local` depois.
- Migração nova: `npm run db:generate` (gerada) ou `npx drizzle-kit generate --custom --name <nome>` (RLS, índices, enums); validar do zero (`npx supabase db reset` + `npm run db:migrate`) e sobre banco populado.
- Next gera `AGENTS.md` no dev: está no `.gitignore`.

## 10. Processo usado (para manter o padrão)

Cada fatia seguiu: conversa curta com o Mateus para decisões que mudam o código → plano em `docs/superpowers/plans/` (tarefas com testes primeiro, Global Constraints, Review Focus) → execução por subagentes (um implementador por tarefa, revisão de especificação e qualidade depois de cada tarefa, rodada de correção quando a revisão aponta algo) → revisão final da branch inteira no modelo mais forte → uma rodada única de correções → re-revisão → PR empilhado. Decisões tomadas sem o Mateus ficam registradas no plano e listadas para ele conferir. Os implementadores sempre verificaram no navegador com Playwright (`require('playwright')` funciona sem instalar) e rodaram as suítes antes de commitar.

Mensagens de commit em português, com as linhas de coautoria que o ambiente indicar.
