# Passagem de sessão — Sistema ECLAK Viagens

Atualizado em 23/11/2026. Leia este arquivo inteiro antes de mexer no código. Ele resume o que foi feito, onde está, como rodar, as decisões tomadas e o que falta.

## 1. Em uma frase

O sistema real da ECLAK Viagens (agência de turismo de alto padrão de Rondonópolis-MT, diretor Augusto Kraemer) está sendo construído **por fatias**. As fatias **1, 2, 3a, 3b, 4a e 4b estão prontas, revisadas e mergeadas em `main`** (PRs #1 a #6, em 23/11/2026, com o "sim" do Mateus; a 4b — fluxo de caixa, reserva, anexos, notas fiscais e cartão corporativo — entrou pelo PR #6). **A fatia 5a (Operação: tarefas, roteiro e dailies) está pronta na branch `claude/fatia-5a-operacao`**, já integrada com `main` (merge de `main` com a 4b, migrações da 5a regeneradas depois das da 4b); PR [#7](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/7) aberto, base `main`, esperando o "sim" do Mateus para o merge. **A fatia 6a (Painéis: Visão geral e Relatórios) está pronta na branch `claude/fatia-6a-paineis`** (empilhada sobre a 5a; PR [#8](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/8) com base `claude/fatia-5a-operacao` até o #7 entrar). **A 5b (Reembolsos, Estoque, Caixa de experiência, Avisos) segue esperando o retorno do grupo e da Valeska (§8); **a fatia 6b (extrato OFX e conciliação) está pronta na branch `claude/fatia-6b-conciliacao`** (empilhada sobre a 6a; PR a abrir, testada só com OFX sintéticos: falta um OFX real de cada banco); a 6c (integrações) precisa de credenciais e do "sim" do Mateus**. Nada foi publicado (sem Railway, sem Supabase de produção).

## 2. Onde está cada coisa

### Repositórios
| Repositório | Para que serve | Branch de trabalho |
|---|---|---|
| `Mateus-Nogueira-GT/eclak-sistema` | **Sistema real** (este repositório) | pilha de branches abaixo |
| `Mateus-Nogueira-GT/eclak-mockup` | **Protótipo navegável** (31 telas, dados em memória) usado como referência visual e de regras | `main` (protótipo) e `claude/tender-feynman-ffq4fo` (cópia antiga do desenho e do plano da fatia 1 — **a versão válida está neste repositório**) |

O protótipo está publicado em https://prototipo-financeiro-six.vercel.app (publicado em 17/11/2026, 31 telas). **Não republicar sem o "sim" explícito do Mateus** (é preciso vincular o projeto Vercel "prototipo-financeiro").

### Branches e PRs
Os PRs #1 a #6 foram mergeados em `main` em ordem (merge commit, branches mantidas). **Toda fatia nova parte de `main`** numa branch `claude/fatia-…` e abre PR com base `main`. Atenção: a branch padrão do GitHub ainda é `claude/fatia-1-base`; ao abrir PR, passe `--base main`.

| Fatia | Branch | PR |
|---|---|---|
| 1 Base | `claude/fatia-1-base` | [#1](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/1) |
| 2 Clientes | `claude/fatia-2-clientes` | [#2](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/2) |
| 3a Cotação → proposta aprovada | `claude/fatia-3a-precificacao` | [#3](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/3) |
| 3b Venda → margem real | `claude/fatia-3b-venda` | [#4](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/4) |
| 4a Lançamentos e faturas | `claude/fatia-4-financeiro` | [#5](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/5) |
| 4b Caixa, reserva, anexos e cartão corporativo | `claude/fatia-4b-caixa` | [#6](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/6) |
| 5a Operação (tarefas, roteiro, dailies) | `claude/fatia-5a-operacao` | [#7](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/7) (base `main`, merge só com o "sim" do Mateus) |
| 6a Painéis (Visão geral e Relatórios) | `claude/fatia-6a-paineis` | [#8](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/8), base `claude/fatia-5a-operacao` até o #7 entrar (depois, `main`) |
| 6b Extrato OFX e conciliação | `claude/fatia-6b-conciliacao` | a abrir (base `claude/fatia-6a-paineis`) |

**Integração da 5a com a 4b (feita em 23/11/2026).** A 5a foi construída sobre `main` sem a 4b, e as duas fatias criaram migrações com os mesmos números. Em vez de renomear, as migrações da 5a foram apagadas num commit, `main` (com a 4b) foi mergeada na branch da 5a e as migrações foram **regeneradas** depois das da 4b (0035_operacao e 0036_operacao_rls), com o SQL custom de RLS, índices parciais e CHECKs colado sem mudança. Motivo: o `drizzle-kit migrate` registra no banco só o `created_at` da última migração aplicada e **pula as entradas do journal mais antigas que ela**, então uma migração renumerada mas com data antiga nunca rodaria num banco que já tem a 4b. Quem tinha banco local da 5a antiga precisa de `npx supabase db reset && npm run db:migrate`.

### Documentos
- Desenho geral (spec): `docs/superpowers/specs/2026-11-18-backend-sistema-real-design.md`
- Planos (cada um com "Decisões", "Global Constraints" e "Review Focus"):
  - `docs/superpowers/plans/2026-11-18-fatia-1-base.md`
  - `docs/superpowers/plans/2026-11-18-fatia-2-clientes.md`
  - `docs/superpowers/plans/2026-11-21-fatia-3a-precificacao.md`
  - `docs/superpowers/plans/2026-11-22-fatia-3b-venda.md` (tem a seção **"Para a fatia 4"**)
  - `docs/superpowers/plans/2026-11-22-fatia-4a-lancamentos-faturas.md` (tem a seção **"Para a 4b"**)
- Desenho da fatia 4 (4a e 4b): `docs/superpowers/specs/2026-11-22-fatia-4-financeiro-design.md`
- Plano da 4b: `docs/superpowers/plans/2026-11-23-fatia-4b-caixa.md` (tem os 12 rulings).
- Desenho da fatia 6 (6a, 6b, 6c): `docs/superpowers/specs/2026-11-23-fatia-6-paineis-integracoes-design.md` (a 6b e a 6c são esboços; §8 tem as perguntas).
- Plano da 6a: `docs/superpowers/plans/2026-11-23-fatia-6a-paineis.md` (tem os rulings R1 a R10 e a seção "Para a 6b e a 6c").
- Desenho das fatias 6b e 6c: `docs/superpowers/specs/2026-11-24-fatia-6b-6c-design.md` (§4 a 6b, §6 os rulings R-B1 a R-B3 e R-C1 a R-C4).
- Planos: `docs/superpowers/plans/2026-11-24-fatia-6b-conciliacao.md` e `docs/superpowers/plans/2026-11-24-fatia-6c-integracoes.md`.
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
src/domain/paineis.ts    períodos, DRE, avisos, agregações e CSV dos painéis (puro)
src/server/queries/paineis.ts  leituras da Visão geral e dos relatórios (só leitura; margem sempre por margensVendidas)
src/server/relatorios.ts   parâmetros da URL, escolha da leitura e montagem das tabelas dos relatórios (usado pela tela, pelo CSV e pela impressão)
src/domain/ofx.ts, conciliacao.ts  leitor OFX (SGML/XML, charset 1252) e regras da conciliação (sugestão, situações); puros
src/server/financeiro/lancamentos.ts  núcleo de criar e baixar lançamento (extraído de actions/financeiro.ts, usado também pela conciliação)
src/server/financeiro/conciliacao.ts  leitura das candidatas na view e trava da transação do extrato
src/server/actions/conciliacao.ts, queries/conciliacao.ts  importar extrato, confirmar, criar lançamento, ignorar, desfazer; leitura e aviso
src/app/(app)/financeiro/conciliacao/  tela (page, envio, lista)
src/app/(app)/       telas logadas; src/app/login, /auth/confirmar, /definir-senha
drizzle/             migrações 0000–0039 (geradas + custom para RLS, índices, enums; 0026–0034 da 4b, 0035_operacao e 0036_operacao_rls da 5a, 0037_situacao_extrato_enum, 0038_extratos e 0039_extratos_rls da 6b)
scripts/             seed-local, seed-orcamentos, seed-vendas, seed-financeiro, seed-operacao, seed-conciliacao, criar-diretor, local-guard, postbuild
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

**Fatia 4b — Caixa, anexos, notas e cartões.** *Fluxo de caixa* (`/financeiro/caixa`): saldo atual por conta (saldo inicial + baixas desde a data, só o que transita pelo caixa), projeção de 8 semanas e 12 meses a partir das linhas em aberto (valor líquido de taxa de cartão/boleto; crédito antecipado no 1º vencimento; vencidas marcadas na semana/mês atual), filtros centro/viagem/tipo, reserva = 6 × custo fixo mensal (Parâmetros) com "atingida em"; coluna Saldo atual em Contas bancárias; migrações de view 0026, 0033 e 0034. *Anexos* no Supabase Storage (bucket privado `anexos`, migração 0028; PDF/PNG/JPEG até 10 MB conferidos pelos bytes; URL assinada de 60 s; `bodySizeLimit` e `proxyClientMaxBodySize` "11mb") em qualquer linha da lista, faturas do cartão e notas fiscais. *Notas fiscais* (`/financeiro/notas-fiscais`): CPF/CNPJ validado, número único entre não canceladas, cancelar com motivo, PDF anexo, filtros período/destinatário. *Cartões corporativos* (`/financeiro/cartoes`): cadastro (final, fechamento e vencimento 1–28, conta de débito, centro); compras = lançamento a pagar em Cartão de crédito + cartão e pagamentos de viagem na forma Cartão corporativo + cartão; cada compra cai na fatura do ciclo; a fatura é UMA linha na lista e no caixa; baixa da fatura quita todas as compras (uma saída no banco; compra estrangeira com valor em reais informado → câmbio efetivo); desfazer; compra vinculada não tem baixa direta; `definirFormaFornecedor` recusa com fatura paga. Seed local: cartão "Visa Corporativo" (final 4821) com 3 compras e 1 nota fiscal sem anexo.

**Fatia 5a — Operação.** Menu Operação com **Tarefas** (`/tarefas`: minhas e todas; filtros por responsável, situação e viagem), **Roteiros** (`/roteiros`: vendidas não terminadas, com a situação do roteiro) e **Dailies** (`/dailies`: de hoje a +3 dias), abertos aos cinco perfis e sem nenhum valor de custo, margem ou comissão. Na viagem vendida, trilha **Viagem · Roteiro · Tarefas · Dailies**. **Tarefas:** 6 categorias do protótipo, prazo (sem prazo, data ou N dias antes do embarque), responsável, marca Customer care, conclusão, exclusão lógica, impressão `TAREFAS_<TITULAR>_<DESTINO>_<ini>-<fim>`; **5 automáticas ao fechar a venda** (venda + 1/2/7 dias, limitadas ao início) e **3 ao aprovar o roteiro** (60/60/90 dias antes), idempotentes por `(viagem, chave)`; botão "Criar as tarefas da venda" para viagens vendidas antes da 5a. **Roteiro (RT):** documento `jsonb` com dias das datas da viagem, DICA ECLAK, "Por que escolhemos", gastronomia, hotéis e voos pré-preenchidos, aviso de aniversário, fluxo rascunho > aguardando o cliente > aprovado, edição com controle de edição simultânea e impressão `RT_…`. **Dailies:** texto gerado sob demanda pelo modelo ECLAK (D-2 gerar, D-1 enviar), 6 indicadores de padrão, estados A gerar > Gerado, a revisar > Pronto para enviar > Enviado (dia que já passou sem texto fica "Não gerado", em cinza), plantão e nota interna, conversão de fuso (Itália × MT e Brasília). Encerramento do daily como parâmetro versionado em Admin › Parâmetros, card "Operação". Seed: tarefas da venda nas viagens vendidas e, na Família Ribeiro, tarefas manuais, roteiro aprovado e dois dailies. Fora da 5a (vai para a 5b e a 6): Reembolsos, Estoque, Caixa de experiência, Avisos, vouchers em PDF, Trello, Drive, "Reescrever com IA", agendador de dailies.

**Fatia 6a — Painéis.** Só leitura, sem migração. **Visão geral** (`/visao-geral`, Diretor e Financeiro estratégico, primeira tela deles) e **Relatórios** (`/financeiro/relatorios?rel=dre|pagar|receber|bancos|margens|consultores`, Diretor e os dois financeiros) com planilha CSV e impressão (PDF pelo navegador). Margem só por `margensVendidas` / `margemReal`; dinheiro pela view `lancamentos_financeiros`; caixa e reserva por `obterFluxoDeCaixa`. Rulings do controlador (plano da 6a, "Decisões"), para o Mateus conferir:
- **R1** vendido, margem e consultor pelo `aceite_em` da venda no período.
- **R2** recebido, pago, resultado de caixa e volume por banco pela data da baixa, só o que transita pelo caixa, pelo valor líquido (mesma regra do fluxo de caixa); "recebido de clientes" = parcelas, "pago a fornecedores" = pagamentos. Se a Valeska preferir bruto, muda na view (4b), não nos painéis.
- **R3** DRE por competência: viagens no mês do aceite (receita, custo, imposto e taxas de `margemReal`, sem custo fixo) e, abaixo, a empresa (lançamentos manuais não cancelados, por grupo e categoria). Viagem com margem em erro fica fora e é contada numa nota.
- **R4** margem do período ponderada pela receita (Σ final ÷ Σ receita), com a diferença para a planejada em pontos percentuais.
- **R5** "valor vendido" da viagem é o mesmo número da tela da viagem (coluna "Valor vendido" no relatório de margem).
- **R6** avisos "Para decidir hoje" na ordem caixa, margem, parcelas vencidas, comissões vencidas, contas a pagar (vencidas ou em até 7 dias), aprovações (só Diretor); no máximo 8 e "e mais N avisos"; agrupados por tipo, exceto caixa, margem e aprovações.
- **R7** `/visao-geral` é a primeira rota de Diretor e Financeiro estratégico (para onde `/` e o logo levam).
- **R8** menu: "Visão geral" em Gestão (antes de Aprovações); "Relatórios" em Financeiro (depois de Fluxo de caixa).
- **R9** CSV UTF-8 com BOM, `;`, decimal com vírgula, datas `dd/mm/aaaa`, por route handler com `exigirPerfil`; PDF por página de impressão.
- **R10** períodos da Visão geral por `?periodo=` (`30d` padrão, `90d`, `mes`, `mes_anterior`, `ano`) com comparação do vendido com o período anterior de mesma duração (spec §5.1): `mes` contra o mesmo trecho do mês anterior (1–23/11 contra 1–23/10), `ano` contra o mesmo trecho do ano anterior, `mes_anterior` contra o mês inteiro antes, `30d`/`90d` contra os dias logo antes; relatórios por `?de=AAAA-MM&ate=AAAA-MM` (padrão mês atual, máximo 24 meses).

Perguntas abertas para o Mateus (spec da 6, §8; não bloqueiam): (1) os critérios de período, principalmente a DRE pelo mês do aceite e não pelo mês da viagem; (2) **respondida: "Visão geral não aparece para a Valeska" (Mateus, 24/11/2026)**; (3) 6b: quais bancos e um OFX de exemplo (a 6b foi feita com arquivos sintéticos); (4) 6c: qual integração primeiro.

**Fatia 6b — Extrato OFX e conciliação** (branch `claude/fatia-6b-conciliacao`, empilhada sobre a 6a). A Valeska importa o OFX de cada conta em `/financeiro/conciliacao` e confere cada transação com as baixas da lista única. Migrações 0037 (enum `situacao_extrato`), 0038 (tabelas `extratos` e `extrato_transacoes`, CHECKs de coerência e índice único parcial por baixa conciliada) e 0039 (RLS). Leitor OFX 1.x/2.x com charset 1252/ISO-8859-1 (testado com arquivo SGML real de banco brasileiro, sintético). Importação idempotente: arquivo idêntico recusado pelo hash; extrato sobreposto traz só as transações novas (única por conta + FITID) e o resumo conta as repetidas. Situações exibidas: Confere, Diferença de R$ x, Não conciliado, Ignorado e "A baixa mudou: confira". Relatório "Conciliação extrato x sistema" (`rel=conciliacao`, filtro opcional `conta`, planilha e impressão) e aviso `conciliacao` na Visão geral (entre `pagar` e `aprovacao`, responsável Financeiro, só transação pendente com mais de 3 dias, contas ativas). Seed: extrato sintético com as 3 situações. Rulings (spec §6), para o Mateus conferir:
- **R-B1** o arquivo OFX não é guardado, só as transações e o hash (o bucket `anexos` só aceita PDF/PNG/JPEG; guardar exige bucket novo, uma migração).
- **R-B2** desfazer uma baixa não é bloqueado; a conciliação é conferida na leitura e a transação aparece como "A baixa mudou: confira" (bloquear exigiria mexer nos 5 núcleos de baixa). Não há trava na baixa lida da view; o índice único parcial é a fonte da verdade contra a mesma baixa em duas transações.
- **R-B3** sugestão pelo mesmo valor de caixa (líquido) e até 3 dias (`DIAS_SUGESTAO`), sem sugestão se o empate na distância é exato; escolha manual até 10 dias (`DIAS_ESCOLHA`); aviso após 3 dias (`DIAS_AVISO`).
- Rulings das Tarefas 3 e 4 (relatórios das tarefas em `.superpowers/sdd/2026-11-24-fatia-6b-conciliacao/`): lançamento criado a partir da transação é manual, forma "Débito em conta" (nunca cartão, que tiraria do caixa); valor 0 e data futura são recusados; descrição editável até 200 caracteres (a do extrato vai até 255 e a tela corta); a auditoria da importação é uma linha em `extratos` (as mudanças de situação auditam `extrato_transacoes`); `totais` do período inteiro antes do filtro de situação; aviso soma valores em módulo e só das contas ativas e não excluídas; desfazer a conciliação de um lançamento criado pela transação deixa o lançamento baixado (desfaz-se pela lista); `confirmarPar` sem pré-checagem de "já conciliada" (mensagem vem do 23505); situação "A baixa mudou" devolve `linha` nula; candidatas lidas por `baixado_em` na janela do período ± 10 dias; `criarLancamentoDaTransacao` valida por Zod; motivo de ignorar de 3 a 200 caracteres; parâmetros inválidos da URL da tela caem nos padrões sem erro.

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

Fatia 4b (Claude, conferir) — "Decisões do Claude (conferir)":
1. **Valor no caixa (decisão 12 do desenho):** parcela de cartão de crédito ou boleto entra pelo líquido (previsto − taxa prevista; recebido − taxa efetiva). Repasse já é líquido. Pix, comissões, lançamentos manuais e pagamentos: valor cheio. Crédito com antecipação (`vendas.forma->>'antecipado' = 'true'`): `data_caixa` = primeiro vencimento em aberto do cartão dessa venda.
2. **Saldo da conta** = saldo inicial + Σ entradas − Σ saídas com `baixado_em >= saldo_inicial_em`, só linhas `transita_caixa`. Baixas antigas sem conta bancária (anteriores à 4a) não entram em conta nenhuma.
3. **Fluxo:** base = saldo atual somado de todas as contas ativas; filtros (centro, viagem, tipo) filtram só os movimentos, não o saldo inicial. Tipos: Clientes (parcelas), Fornecedores (pagamentos de viagem), Comissões, Empresa (manuais fora de cartão), Cartão (faturas do cartão).
4. **Reserva:** meta = 6 × `custoFixoMensal` vigente (Parâmetros); "atingida em" = primeiro mês da projeção cujo saldo de fim de mês ≥ meta; senão "não atingida em 12 meses".
5. **Anexos** valem para qualquer linha da lista (manual, parcela, pagamento, comissão, fatura do cartão) e para notas fiscais: tabela `anexos` com `dono_tipo` + `dono_id` (sem FK; existência conferida na action).
6. **Upload** por Server Action com `serverActions.bodySizeLimit: "11mb"` (o padrão é 1 MB). Download por URL assinada de 60 s gerada no servidor.
7. **Notas fiscais:** número, data de emissão, competência, valor, destinatário (texto, opcionalmente fornecedor ou cliente), CPF/CNPJ (validado), viagem opcional, observação, PDF anexo. Cancelar com motivo (não apaga). Colunas da PLANILHA NOTAS FISCAIS entram quando ela chegar.
8. **Cartão corporativo:** cadastro (nome, final de 4 dígitos, dia de fechamento 1–28, dia de vencimento 1–28, conta bancária de débito, centro de custo, ativo). Ciclo: compra com dia ≤ fechamento cai na fatura do mês; depois do fechamento, na do mês seguinte; vencimento = dia de vencimento do mês seguinte ao fechamento se o dia de vencimento ≤ dia de fechamento, senão do mesmo mês do fechamento.
9. **Compras:** lançamento manual a pagar com forma `cartao_credito` + cartão; pagamento a fornecedor de conta com forma `cartao_corporativo` + cartão (o cartão escolhido no `definirFormaFornecedor`; a data informada é a da compra). A fatura (`faturas_cartao`, uma por cartão e fechamento) nasce na primeira compra; compra em fatura já paga é recusada.
10. **Moeda estrangeira no cartão:** a compra estrangeira entra na fatura pelo previsto em reais; na baixa da fatura, o financeiro informa o valor em reais cobrado de cada compra estrangeira (com IOF); esse valor vira `valor_brl_pago` e o câmbio efetivo = valor em reais ÷ valor original (4 casas). Fatura com compra estrangeira exige baixa individual.
11. **Baixa da fatura do cartão:** uma saída no banco (conta de débito do cartão ou outra ativa) pelo total; compras de viagem ficam `pago` com `conta_bancaria_id` nulo e `fatura_cartao_id`; manuais ficam `baixado` com a conta da baixa da fatura, mas fora do caixa (a view as marca `transita_caixa = false`). Desfazer a baixa da fatura volta tudo.
12. `definirFormaFornecedor` recusa trocar a forma quando algum pagamento da conta está numa fatura do cartão paga ("Desfaça a baixa da fatura do cartão antes"); se a fatura está em aberto, as compras são desvinculadas e a fatura recalcula (fatura sem compras some da lista).

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

**Fatia 6 (painéis e integrações):** a 6a está pronta (ver §5). PR #8 aberto (base `claude/fatia-5a-operacao`); depois do merge do #7, trocar a base do #8 para `main`. Merge só com o "sim" do Mateus. A **6b** (extrato OFX e conciliação) está pronta na branch `claude/fatia-6b-conciliacao` (ver §5), testada só com OFX sintéticos: falta um OFX real de cada banco para conferir o leitor e a regra do valor líquido de cartão; PR a abrir com base `claude/fatia-6a-paineis`. A **6c** (integrações: Trello, Drive, IA, agendador do daily etc.) precisa de credenciais e do "sim" do Mateus. A **5b** continua esperando a Valeska e o grupo.

**Imediato:** abrir o PR da `claude/fatia-5a-operacao` com `--base main` (só com o "sim" do Mateus) e revisar; a 4b já está em `main` (PR #6) e a 5a já foi integrada com ela (ver §2). Depois, a **5b**, que **depende do retorno do grupo e da Valeska** sobre Reembolsos, Estoque, Caixa de experiência e Avisos por setor, e do **texto oficial de encerramento do daily** (entra por Admin › Parâmetros, sem código). Escopo e perguntas no spec `docs/superpowers/specs/2026-11-23-fatia-5-operacao-design.md` §6 e no fim do plano da 5a ("Para a 5b e a fatia 6"):
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

### 8.0 Histórico: escopo da 4b (entregue no PR #6)

Escopo no desenho (`docs/superpowers/specs/2026-11-22-fatia-4-financeiro-design.md`, §6.5) e notas na seção "Para a 4b" do plano da 4a: fluxo de caixa com projeção de 12 meses (realizado + previsto da view `lancamentos_financeiros`, só `transita_caixa`), meta de reserva de 6 meses de custo fixo, anexos e notas fiscais (Supabase Storage, primeiro uso), faturas de cartão corporativo (custo variável, IOF). Referências no protótipo: `src/app/{fluxo-de-caixa,notas-fiscais,relatorios}/page.tsx`, `src/components/{reserva-projecao,cash-chart,operacionais}.tsx`, `src/lib/calc.ts`.

Materiais ainda pendentes do cliente (4b): modelo `FATURA_1405_…pdf`, plano de categorias do Conta Azul, `CUSTOS FIXOS.xlsx`, `PLANILHA NOTAS FISCAIS.xlsx`.

### 8.1 Referência: Conta Azul (pedido da Valeska)
O financeiro segue o Conta Azul (lista única, categorias grupo › categoria, competência, centro de custo MT/RS, formas de pagamento, baixa, conciliação, fluxo de caixa, DRE). A 4a já cobre lista, baixas, categorias, parcelamento e recorrência.

Materiais ainda não recebidos (Drive da Valeska): `CUSTOS FIXOS.xlsx` (base da reserva e das contas fixas), `PLANILHA NOTAS FISCAIS.xlsx` (comissões por empresa e competência), modelo `FATURA_1405_…pdf` (a impressão da fatura aguarda esse modelo), plano de categorias do Conta Azul.

### 8.2 Para confirmar com a Valeska ou o Augusto
- Regra (a) do cartão direto: a margem cai pelo que o fornecedor reteve; pagamento em euro do fornecedor do cartão segue na viagem.
- Card "Vencidos": só o período filtrado ou todos os vencidos.
- Numeração 1405 e telas do financeiro só para Diretor e financeiros.

### 8.2b Para confirmar com a Valeska ou o Augusto (4b)
- Os rulings 1 a 12 acima (em especial: valor líquido de taxa no caixa, reserva = 6 × custo fixo de Parâmetros, ciclo do cartão, baixa única da fatura).
- Filtros por categoria, centro e origem mudam quando uma compra vai para o cartão (ela passa a aparecer só dentro da fatura); o total geral não muda.
- A busca por código da viagem não acha pagamento já pago no cartão (ele some da lista, fica na fatura).
- IOF nas compras estrangeiras: informado na baixa da fatura, dentro do valor em reais de cada compra.
- Custo fixo da reserva vem de Parâmetros (até chegar o `CUSTOS FIXOS.xlsx`).
- Deploy: confirmar no primeiro deploy que a migração 0028 criou o bucket `anexos` em produção e que a 0032 marcou a categoria de sistema "Cartão corporativo".

### 8.3 Pendências menores da 4a (não bloqueiam)
Teste de auditoria sem `orderBy`; sem teste de concorrência no "esta e as próximas"; repasse esperado negativo sem mensagem própria; fornecedor do cartão não editável na tela depois de definido; "Código" da lista é o id curto; datas no formato do navegador; rótulo da forma não cita a entrada; seed não zera o contador de faturas; idempotência do seed pela descrição.

### 8.4 Pendências menores da 5a (não bloqueiam)
- Seed da operação: tarefas manuais idempotentes por viagem + item (se alguém renomear o item no app, o seed recria); o seed ajusta o nascimento do Lucas Ribeiro para cair dentro da viagem (aniversário de exemplo); a tarefa de Customer care nasce sem responsável (regra `tarefas_um_responsavel`).
- Verificação no navegador com os cinco perfis feita na onda final da revisão (23/11/2026); depois da integração com a 4b, smoke como Financeiro estratégico em /financeiro/caixa, /financeiro/cartoes, viagem vendida (trilha, entradas), roteiro, /tarefas e /dailies, sem erros.
- `npm run test:integracao` tem trava: o global setup (`tests/integracao/trava-global.ts`) pega um advisory lock do Postgres e uma segunda execução simultânea falha logo com mensagem clara. Um `npx vitest run tests/integracao/…` avulso não passa pela trava.
- Achados menores da revisão deixados para depois:
  - `marcarEnviado` (e as outras mudanças de estado do daily) não confere a versão (`atualizado_em`); trava a linha e confere o estado, mas não detecta edição de texto feita por outra pessoa no meio tempo.
  - Testes de D5/D29 não distinguem o consultor da viagem de quem fechou a venda (no fixture são a mesma pessoa) nem usam `vendida_em` retroativa.
  - `ordem` das tarefas pode repetir sob concorrência (duas criações ao mesmo tempo).
  - Filtro de responsável em `/tarefas` só lista usuários ativos.
  - `lpad(…, 4, '0')` do código na lista `/tarefas` (`src/server/queries/operacao.ts`) trunca códigos de cliente ≥ 10000.
  - `dataBr` duplicado (domínio e `formatos.ts` do app).
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
- Testes: `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build` (uma execução de integração por vez: a trava do global setup recusa a segunda). Últimos números (23/11/2026, branch `claude/fatia-5a-operacao` integrada com `main` e a 4b): 363 testes de domínio (23 arquivos) e 425 de integração (26 arquivos), tudo verde, build ok, seed duas vezes sem duplicar. **A integração trunca o banco local**: rodar `npm run seed:local` depois.
- Números da 6b (24/11/2026, branch `claude/fatia-6b-conciliacao`): 457 testes de domínio (26 arquivos) e 463 de integração (28 arquivos), lint, typecheck e build ok, seed duas vezes sem duplicar (a segunda cria 0 transações de extrato).
- Migração nova: `npm run db:generate` (gerada) ou `npx drizzle-kit generate --custom --name <nome>` (RLS, índices, enums); validar do zero (`npx supabase db reset` + `npm run db:migrate`) e sobre banco populado.
- Next gera `AGENTS.md` no dev: está no `.gitignore`.

## 10. Processo usado (para manter o padrão)

Cada fatia seguiu: conversa curta com o Mateus para decisões que mudam o código → plano em `docs/superpowers/plans/` (tarefas com testes primeiro, Global Constraints, Review Focus) → execução por subagentes (um implementador por tarefa, revisão de especificação e qualidade depois de cada tarefa, rodada de correção quando a revisão aponta algo) → revisão final da branch inteira no modelo mais forte → uma rodada única de correções → re-revisão → PR empilhado. Decisões tomadas sem o Mateus ficam registradas no plano e listadas para ele conferir. Os implementadores sempre verificaram no navegador com Playwright (`require('playwright')` funciona sem instalar) e rodaram as suítes antes de commitar.

Mensagens de commit em português, com as linhas de coautoria que o ambiente indicar.
