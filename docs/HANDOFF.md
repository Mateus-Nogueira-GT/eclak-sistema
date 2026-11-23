# Passagem de sessão — Sistema ECLAK Viagens

Atualizado em 23/11/2026. Leia este arquivo inteiro antes de mexer no código. Ele resume o que foi feito, onde está, como rodar, as decisões tomadas e o que falta.

## 1. Em uma frase

O sistema real da ECLAK Viagens (agência de turismo de alto padrão de Rondonópolis-MT, diretor Augusto Kraemer) está sendo construído **por fatias**. As fatias **1, 2, 3a, 3b e 4a estão prontas, revisadas e mergeadas em `main`** (PRs #1 a #5, em 23/11/2026, com o "sim" do Mateus). **A 4b (Financeiro: fluxo de caixa, reserva, anexos e notas fiscais, cartão corporativo) está pronta no PR #6** (branch `claude/fatia-4b-caixa`), ainda não mergeado. **A fatia 5a (Operação: tarefas, roteiro e dailies) está pronta na branch `claude/fatia-5a-operacao`**, que parte de `main` **sem a 4b**; o PR da 5a será aberto com base `main` depois do merge da 4b, com rebase (ver §2). **A próxima é a 5b (Reembolsos, Estoque, Caixa de experiência, Avisos), que depende do retorno do grupo e da Valeska (§8)**. Nada foi publicado (sem Railway, sem Supabase de produção).

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
| 4b Caixa, reserva, anexos e cartão corporativo | `claude/fatia-4b-caixa` | [#6](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/6) (aberto, não mergeado) |
| 5a Operação (tarefas, roteiro, dailies) | `claude/fatia-5a-operacao` | a abrir (base `main`, depois do merge da 4b) |

**Rebase da 5a depois do merge da 4b (receita).** A 5a foi construída sobre `main` sem a 4b, e as duas fatias criaram migrações com os mesmos números. **Não renomeie as migrações: regenere.** O `drizzle-kit migrate` registra no banco só o `created_at` da última migração aplicada e **pula as entradas do journal mais antigas que ela**, então uma 0026 renumerada para depois da 4b mas com data antiga nunca roda num banco que já tem a 4b.
1. Na branch da 5a, antes do rebase, guarde o SQL custom: `cp drizzle/0027_operacao_rls.sql /tmp/operacao_rls.sql`.
2. Num commit da 5a, apague `drizzle/0026_operacao.sql`, `drizzle/0027_operacao_rls.sql`, `drizzle/meta/0026_snapshot.json`, `drizzle/meta/0027_snapshot.json` e as entradas `0026_operacao` e `0027_operacao_rls` de `drizzle/meta/_journal.json`.
3. `git rebase main` (com a 4b) e resolva os conflitos esperados: `src/components/shell.tsx` (menu), `src/app/(app)/viagens/[id]/page.tsx` (trilha da viagem), `tests/integracao/rls.test.ts` (tabelas novas das duas fatias), `scripts/seed-local.ts` (chamadas dos seeds), `README.md` e este `HANDOFF.md`.
4. `npm run db:generate` (gera a migração das tabelas e enums da 5a com o próximo número depois da 4b) e `npx drizzle-kit generate --custom --name operacao_rls`; cole nela o SQL guardado no passo 1 (RLS, índices parciais e CHECKs), sem mudar nada.
5. Banco local do zero, porque o journal mudou: `npx supabase db reset && npm run db:migrate`.
6. Gate completo (uma execução por vez: a integração trunca o banco) e `npm run seed:local` duas vezes (idempotência).

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
src/server/operacao/        criarTarefasAutomaticas (server-only, usada pela venda, pelo botão e pela aprovação do roteiro)
src/app/(app)/       telas logadas; src/app/login, /auth/confirmar, /definir-senha
drizzle/             migrações 0000–0027 na 5a (geradas + custom para RLS, índices, enums; renumerar depois da 4b)
scripts/             seed-local, seed-orcamentos, seed-vendas, seed-financeiro, seed-operacao, criar-diretor, local-guard, postbuild
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

**Fatia 5a — Operação.** Menu Operação com **Tarefas** (`/tarefas`: minhas e todas; filtros por responsável, situação e viagem), **Roteiros** (`/roteiros`: vendidas não terminadas, com a situação do roteiro) e **Dailies** (`/dailies`: de hoje a +3 dias), abertos aos cinco perfis e sem nenhum valor de custo, margem ou comissão. Na viagem vendida, trilha **Viagem · Roteiro · Tarefas · Dailies**. **Tarefas:** 6 categorias do protótipo, prazo (sem prazo, data ou N dias antes do embarque), responsável, marca Customer care, conclusão, exclusão lógica, impressão `TAREFAS_<TITULAR>_<DESTINO>_<ini>-<fim>`; **5 automáticas ao fechar a venda** (venda + 1/2/7 dias, limitadas ao início) e **3 ao aprovar o roteiro** (60/60/90 dias antes), idempotentes por `(viagem, chave)`; botão "Criar as tarefas da venda" para viagens vendidas antes da 5a. **Roteiro (RT):** documento `jsonb` com dias das datas da viagem, DICA ECLAK, "Por que escolhemos", gastronomia, hotéis e voos pré-preenchidos, aviso de aniversário, fluxo rascunho > aguardando o cliente > aprovado, edição com controle de edição simultânea e impressão `RT_…`. **Dailies:** texto gerado sob demanda pelo modelo ECLAK (D-2 gerar, D-1 enviar), 6 indicadores de padrão, estados A gerar > Gerado, a revisar > Pronto para enviar > Enviado (dia que já passou sem texto fica "Não gerado", em cinza), plantão e nota interna, conversão de fuso (Itália × MT e Brasília). Encerramento do daily como parâmetro versionado em Admin › Parâmetros, card "Operação". Seed: tarefas da venda nas viagens vendidas e, na Família Ribeiro, tarefas manuais, roteiro aprovado e dois dailies. Fora da 5a (vai para a 5b e a 6): Reembolsos, Estoque, Caixa de experiência, Avisos, vouchers em PDF, Trello, Drive, "Reescrever com IA", agendador de dailies.

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

Fatia 5a (Claude, **conferir com o Mateus**; D1–D32 completas no spec `docs/superpowers/specs/2026-11-23-fatia-5-operacao-design.md` §7, com o custo de trocar):
- Estrutura: base em `main` sem a 4b (D1); conteúdo do roteiro em `jsonb` validado, uma linha por viagem (D2); tarefas, roteiro e dailies só para viagem vendida (D3); concorrência otimista por `atualizado_em` (padrão Clientes), sem `travarViagem` fora da venda (D9).
- Tarefas: prazo só "data" ou "N dias antes" (D4); 8 automáticas com as categorias e prazos do spec (D5); automática excluída não volta (D6); viagens antigas ganham as tarefas pelo botão, já vencidas (D7, D29); "Customer care" é uma marca, não um usuário (D8); prazo da venda limitado ao início (D30).
- Dailies: gerado sob demanda, sem job nem geração ao abrir, com o estado extra "A gerar" (D10; **se quiserem o texto pronto sem clique, é preciso agendador**); passo manual "Marcar como revisado" (D27); pode gerar antes de D-2 (D26); enviado não aceita edição até "Desfazer envio" (D17); nomes da saudação: até 3 primeiros nomes, senão o grupo (D18); não exigem roteiro aprovado (D28).
- Padrão do texto: indicador 1 aceita a saudação do idioma do roteiro, inclusive "Bom dia" (D11); indicador 4 acusa dia sem item com hora, regra do protótipo mantida (D12); indicador 3 aceita `maps.app.goo.gl` (D25); hotel com hora de check-in/out e mapa, e link de busca com `%20` (D14).
- Roteiro: idioma e fuso guardados, sem cadastro de destinos (D13); pré-preenchimento só na criação e no botão "Trazer hotéis e voos" (D15); aprovar direto do rascunho, edição depois só avisa (D16).
- Outros: nome de arquivo com último sobrenome e destino em maiúsculas sem acento (D19); encerramento versionado, só o Diretor edita (D20); plantão sem telefone (D21); listas `/roteiros` e `/dailies` (D22); sem vouchers em PDF no daily (D23); aniversário só aviso na tela e item no roteiro (D24); textos do protótipo cortados: "e vão para o Trello" e "Data conferida no passaporte." (D31); `roteiros.atualizado_em` só muda com o conteúdo (D32).

## 7. Perguntas abertas para o Augusto
1. Taxa de roteiro: a planilha v7 mostra venda de R$ 259,69; o sistema usa R$ 250,00.
2. 6x com antecipação: interpolação dá 7,7367% (R$ 71.277,08); a planilha mostra 7,73% e R$ 71.273,78.
3. Matriz de acesso: margem/custos agora visíveis também aos financeiros.
4. Ainda em aberto no `PRODUCT.md` do protótipo: modelo de fatura, cartões corporativos, percentual do alerta de preço, validade da cotação, API do Sakura Click, fontes da marca (Evaida, CA Saygon Text) não enviadas.

## 8. Próximo passo

**Imediato:** mergear o PR #6 (4b), rebasear a `claude/fatia-5a-operacao` sobre `main` (ver §2), abrir o PR da 5a com `--base main` e revisar. Depois, a **5b**, que **depende do retorno do grupo e da Valeska** sobre Reembolsos, Estoque, Caixa de experiência e Avisos por setor, e do **texto oficial de encerramento do daily** (entra por Admin › Parâmetros, sem código). Escopo e perguntas no spec `docs/superpowers/specs/2026-11-23-fatia-5-operacao-design.md` §6 e no fim do plano da 5a ("Para a 5b e a fatia 6"):
- Reembolsos e Estoque com lançamentos na lista única da 4a (categorias "Reembolso a cliente", "Reembolso de fornecedor", "Caixa de experiência", "Papelaria").
- Caixa de experiência como custo da viagem na margem real (mexe em `margemReal`: exige decisão explícita).
- Avisos por setor, com os eventos candidatos da 5a (tarefa vencida, daily "A gerar", aniversário na viagem).

Perguntas abertas da 5b (spec §6):
1. Reembolso: os lançamentos nascem no registro da ocorrência ou nos marcos ("Fornecedor pagou", "Cliente reembolsado")? "Abatimento na próxima parcela" reduz a parcela da viagem ou vira lançamento à parte? Reembolso mexe na margem real?
2. Valor a devolver maior que o cobrado (ex.: 411,45 × 385,00): a diferença é custo da viagem ou da empresa?
3. Estoque: valor unitário pelo último preço (protótipo) ou custo médio? Precisa de saída manual, ajuste e transferência MT↔RS? Mínimo por filial ou um só?
4. Estoque: "onde foi comprado" é texto livre ou fornecedor do cadastro?
5. Caixa de experiência: regra do limite (faixas 30/60/100 mil → 100/180/260/350, ou 0,4% da venda)? Quem pode estourar e como o Diretor aprova? O custo entra como custo variável da viagem na margem real?
6. Caixa de experiência: em que status da viagem pode ser montada e até quando antes do embarque? Cancelar devolve ao estoque?
7. Avisos: lido/não lido por pessoa? Notificação fora do sistema (e-mail, WhatsApp)? O financeiro estratégico entra em que setor?
8. Avisos: quais eventos geram aviso automático (tarefa vencida, daily a gerar, estoque abaixo do mínimo, caixa a montar, reembolso)?
9. Perfis: Reembolsos e Estoque abertos aos cinco perfis (como no protótipo) ou só ao financeiro e ao Diretor?

Materiais pendentes da 5a: PDFs reais TAREFAS e RT (conferir colunas e layout da impressão), fontes da marca (Evaida, CA Saygon Text) para o PDF do RT, lista de destinos frequentes com idioma e fuso. **Fatia 6:** Trello (as automáticas já têm `chave` estável), Drive (pastas `ECL-NNNN_TITULAR_DESTINO_ini-fim`), vouchers em PDF no daily (Storage da 4b), "Reescrever com IA", plano logístico e mapas, agendador que chame `gerarDaily` em D-2.

### 8.0 Fatia 4b (Financeiro), já pronta no PR #6

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

### 8.4 Pendências menores da 5a (não bloqueiam)
- Seed da operação: tarefas manuais idempotentes por viagem + item (se alguém renomear o item no app, o seed recria); o seed ajusta o nascimento do Lucas Ribeiro para cair dentro da viagem (aniversário de exemplo); a tarefa de Customer care nasce sem responsável (regra `tarefas_um_responsavel`).
- Verificação no navegador com os cinco perfis feita na onda final da revisão (23/11/2026); vale repetir depois do rebase sobre a 4b.
- `npm run test:integracao` tem trava: o global setup (`tests/integracao/trava-global.ts`) pega um advisory lock do Postgres e uma segunda execução simultânea falha logo com mensagem clara. Um `npx vitest run tests/integracao/…` avulso não passa pela trava.
- Achados menores da revisão deixados para depois:
  - `marcarEnviado` (e as outras mudanças de estado do daily) não confere a versão (`atualizado_em`); trava a linha e confere o estado, mas não detecta edição de texto feita por outra pessoa no meio tempo.
  - Testes de D5/D29 não distinguem o consultor da viagem de quem fechou a venda (no fixture são a mesma pessoa) nem usam `vendida_em` retroativa.
  - `ordem` das tarefas pode repetir sob concorrência (max + 1 sem trava); a lista desempata, mas a ordem fica ambígua.
  - Filtro de responsável em `/tarefas` não lista usuários inativos (tarefas de quem saiu só aparecem em "Todas").
  - `lpad` do código do cliente nas listas da operação trunca códigos com 5 dígitos (≥ 10000).
  - `dataBr` duplicado (`src/domain/tarefas.ts` e o formatador do app).
  - Testes de CHECK usam `toThrow()` genérico (não conferem o nome da restrição).
  - Desfazer a aprovação de um roteiro aprovado direto do rascunho leva a "Aguardando o cliente", não de volta a "Rascunho".
  - O seed reimplementa em SQL o insert das tarefas automáticas (mesma lista e mesmo ON CONFLICT, mas código duplicado de `criarTarefasAutomaticas`).

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
npm run seed:local        # usuários (senha eclak-local), fornecedores, 30 clientes, orçamentos, vendas, financeiro e operação de exemplo
npm run dev               # abrir em localhost (127.0.0.1 não fica interativo no dev)
```
- `.env.local` (não versionado): `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL` (ver `.env.example`).
- Usuários do seed: `diretor@eclak.local`, `consultor@eclak.local`, `operacional@eclak.local`, `fin.operacional@eclak.local`, `fin.estrategico@eclak.local`, senha `eclak-local`.
- Testes: `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build` (uma execução de integração por vez: a trava do global setup recusa a segunda). Últimos números da 5a (23/11/2026, branch `claude/fatia-5a-operacao`): 318 testes de domínio e 345 de integração (22 arquivos), tudo verde, build ok, seed duas vezes sem duplicar (onda final da revisão); a 4b traz os próprios números no PR #6, e a soma só se confirma depois do rebase. **A integração trunca o banco local**: rodar `npm run seed:local` depois.
- Migração nova: `npm run db:generate` (gerada) ou `npx drizzle-kit generate --custom --name <nome>` (RLS, índices, enums); validar do zero (`npx supabase db reset` + `npm run db:migrate`) e sobre banco populado.
- Next gera `AGENTS.md` no dev: está no `.gitignore`.

## 10. Processo usado (para manter o padrão)

Cada fatia seguiu: conversa curta com o Mateus para decisões que mudam o código → plano em `docs/superpowers/plans/` (tarefas com testes primeiro, Global Constraints, Review Focus) → execução por subagentes (um implementador por tarefa, revisão de especificação e qualidade depois de cada tarefa, rodada de correção quando a revisão aponta algo) → revisão final da branch inteira no modelo mais forte → uma rodada única de correções → re-revisão → PR empilhado. Decisões tomadas sem o Mateus ficam registradas no plano e listadas para ele conferir. Os implementadores sempre verificaram no navegador com Playwright (`require('playwright')` funciona sem instalar) e rodaram as suítes antes de commitar.

Mensagens de commit em português, com as linhas de coautoria que o ambiente indicar.
