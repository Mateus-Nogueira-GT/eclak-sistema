# Passagem de sessão — Sistema ECLAK Viagens

Atualizado em 25/11/2026. Leia este arquivo inteiro antes de mexer no código. Ele resume o que foi feito, onde está, como rodar, as decisões tomadas e o que falta.

## 1. Em uma frase

O sistema real da ECLAK Viagens (agência de turismo de alto padrão de Rondonópolis-MT, diretor Augusto Kraemer) está sendo construído **por fatias**. **As fatias 1, 2, 3a, 3b, 4a, 4b, 5a, 6a, 6b e 6c estão prontas, revisadas e mergeadas em `main`** (PRs #1 a #6 em 23/11/2026; #7 a #11 em 24/11/2026, todos com o "sim" do Mateus). Os PRs #8, #9 e #10 eram empilhados e foram mergeados nas branches de base; o conteúdo chegou a `main` pelo PR [#11](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/11) (branch `claude/fatia-6c-integracoes`, que continha as três). Os PRs #12 a #17 (24 e 25/11/2026: documentação, antecipação manual, correções do debug, botão flutuante e agente do chat) também estão em `main`. **A fatia 5b (Estoque, Caixa de experiência, Reembolsos e Avisos) foi entregue no branch `claude/fatia-5b`, com PR a abrir (base `main`, sem merge até o "sim" do Mateus).** O Mateus decidiu em 25/11/2026 quatro das perguntas do grupo e mandou construir; as demais seguem as decisões do spec, listadas em §6 para conferir com a Valeska e o grupo. A 6b foi testada só com OFX sintéticos: falta um OFX real de cada banco. As integrações da 6c ficam desligadas enquanto faltar alguma variável e **foram testadas só contra serviços falsos**: nenhuma chamada real, nenhuma conta ou chave criada; "ligar" fica provado só quando o primeiro "Testar conexão" real de cada uma der certo (checklist em §8.6). Nada foi publicado (sem Railway, sem Supabase de produção).

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
| 5a Operação (tarefas, roteiro, dailies) | `claude/fatia-5a-operacao` | [#7](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/7) (mergeado em `main`, 24/11/2026) |
| 6a Painéis (Visão geral e Relatórios) | `claude/fatia-6a-paineis` | [#8](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/8) (em `main` pelo [#11](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/11), 24/11/2026) |
| 6b Extrato OFX e conciliação | `claude/fatia-6b-conciliacao` | [#9](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/9) (em `main` pelo #11, 24/11/2026) |
| 6c Integrações (Trello, Drive, IA, agendador do daily) | `claude/fatia-6c-integracoes` | [#10](https://github.com/Mateus-Nogueira-GT/eclak-sistema/pull/10) (em `main` pelo #11, 24/11/2026) |
| 5b Estoque, Caixa de experiência, Reembolsos e Avisos | `claude/fatia-5b` (parte de `main` em `b7b7b0f`, depois do #17) | PR a abrir com `--base main`; sem merge |

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
- Desenho da fatia 6 (6a, 6b, 6c): `docs/superpowers/specs/2026-11-23-fatia-6-paineis-integracoes-design.md` (a 6b e a 6c viraram o desenho de 24/11 abaixo; §8 tem as perguntas).
- Plano da 6a: `docs/superpowers/plans/2026-11-23-fatia-6a-paineis.md` (tem os rulings R1 a R10 e a seção "Para a 6b e a 6c").
- Desenho das fatias 6b e 6c: `docs/superpowers/specs/2026-11-24-fatia-6b-6c-design.md` (§4 a 6b, §5 a 6c, §6 os rulings R-B1 a R-B3 e R-C1 a R-C8, §8 a tabela "para ligar cada integração").
- Planos: `docs/superpowers/plans/2026-11-24-fatia-6b-conciliacao.md` e `docs/superpowers/plans/2026-11-24-fatia-6c-integracoes.md` (a 6c tem as "Decisões" com os nomes exatos das variáveis, da fila e das chamadas a cada serviço).
- Desenho da 5b: `docs/superpowers/specs/2026-11-25-fatia-5b-design.md` (decisões do Mateus no topo, §10 as decisões do Claude, **§14 as precisões depois da conferência com o código, que valem sobre o resto**). Plano: `docs/superpowers/plans/2026-11-25-fatia-5b.md`. Ledger da execução (rulings do controlador) em `.superpowers/sdd/2026-11-25-fatia-5b/progress.md` (o git ignora; copiados em §6).
- `README.md`: como rodar, banco local, seed, convite/senha, RLS, **Integrações** (variáveis, onde conseguir, como ligar, serviço cron do Railway, o que nunca sai do sistema) e **passo a passo do deploy** (ainda não executado).
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
src/domain/integracoes.ts, trello.ts, drive.ts, ia-privacidade.ts, chat.ts  constantes da fila (tentativas, esperas, classes de erro), nomes do cartão e da pasta, troca de documentos por marcadores; puros
src/server/integracoes/  config.ts (lê o ambiente na chamada: configurada e quais variáveis faltam), http.ts (fetch injetável, timeout, classes de erro),
                     fila.ts (integracao_envios: enfileirar na transação, processarFila, reenviar), eventos.ts (o que entra na fila ao fechar venda e aprovar roteiro),
                     trello.ts, google.ts (JWT e token), drive.ts, ia.ts (ProvedorIA e o adaptador do Claude), testes.ts ("Testar conexão"),
                     hotelaria.ts (só a interface ProvedorHotelaria; provedorHotelaria() devolve null)
src/server/ia/       ferramentas.ts (as 4 ferramentas só de leitura do chat), erros.ts (mensagens por classe de erro)
src/server/actions/integracoes.ts, ia.ts, chat.ts  Enviar para o Trello / Criar pastas no Drive / Reenviar / Testar conexão; Reescrever com IA; conversar
src/server/cron.ts   exigirCron (segredo das rotas de cron)
src/app/api/cron/integracoes, /dailies  rotas POST do serviço cron do Railway (fila a cada 10 min; dailies de hoje, hoje + 1 e hoje + 2 às 07:00 de Cuiabá)
src/server/operacao/dailies.ts  núcleo de gerar o daily (usado por gerarDaily e pelo agendador) e gerarDailiesDoDia
src/app/(app)/admin/integracoes/  Admin › Integrações (só Diretor); src/components/chat-ia.tsx  painel do chat
src/domain/estoque.ts, estoque-entrada.ts  custo médio (entrada, saída, desfazer pelo custo_medio_antes), schemas do estoque e da caixa (5b)
src/domain/reembolsos.ts, reembolsos-entrada.ts  formas de devolução, situação derivada do caso, schemas (5b)
src/domain/avisos.ts  setores, quem recebe o quê (SETORES_DO_PERFIL, recebe), tipos, passos e chaves dos avisos (5b)
src/server/estoque/movimentos.ts  núcleo do estoque: travarSaldo, gravarSaldo, gravarMovimento (usado pelo estoque e pela caixa)
src/server/actions/estoque.ts, caixa-experiencia.ts, reembolsos.ts, avisos.ts  actions da 5b; queries/estoque.ts, caixa-experiencia.ts, reembolsos.ts
src/server/avisos/   um módulo por grupo de avisos (gestao, financeiros, operacao, estoque, reembolsos), cada função com o seu exigirPerfil; central.ts monta a central (dispensas e comunicados)
src/app/(app)/financeiro/estoque, /financeiro/reembolsos, /avisos  telas da 5b; viagens/[id]/caixa-experiencia.tsx  bloco da caixa; components/contador-avisos.tsx  o sino
src/app/(app)/       telas logadas; src/app/login, /auth/confirmar, /definir-senha
drizzle/             migrações 0000–0058 (geradas + custom para RLS, índices, enums; 0026–0034 da 4b, 0035_operacao e 0036_operacao_rls da 5a, 0037_situacao_extrato_enum, 0038_extratos e 0039_extratos_rls da 6b; 0040_integracoes_enums, 0041_integracao_envios, 0042_integracao_envios_rls, 0043_ia_usos e 0044_ia_usos_rls da 6c; 0045_view_sem_antecipacao; 0046–0058 da 5b)
scripts/             seed-local, seed-orcamentos, seed-vendas, seed-financeiro, seed-operacao, seed-conciliacao, seed-5b, criar-diretor, local-guard, postbuild
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
- Núcleo do financeiro (5b): criar, baixar, desfazer baixa, cancelar e alterar valor e vencimento de lançamento em aberto existem numa transação `tx` em `src/server/financeiro/lancamentos.ts` (`…Na`); quem mexe em dinheiro de outro módulo (estoque, reembolso) usa o núcleo, nunca `insert` cru em `lancamentos`.
- Contas com vínculo (5b): lançamento com `estoque_movimento_id` ou `reembolso_id` pode ser baixado na lista, mas não editado nem cancelado ali (a view `lancamentos_financeiros` expõe as duas colunas no ramo manual; a lista esconde os botões e as actions recusam pelo mesmo critério). Altera-se pelo Estoque ou pelo caso.
- Estoque (5b): movimento só é inserido (nunca alterado nem apagado), grava `custo_medio_antes` e `criado_em = clock_timestamp()` lido já com a trava do saldo; travas na ordem viagem → caixa → produtos (`for share`) → saldos (`for update`) em ordem crescente de `produto_id`.
- Categorias de sistema (5b): "Reembolso a cliente", "Reembolso de fornecedor", "Caixa de experiência" e "Papelaria" têm slug em `categorias_financeiras.sistema` (`reembolso_cliente`, `reembolso_fornecedor`, `caixa_experiencia`, `papelaria`) e são procuradas pelo slug, não pelo nome.
- Integrações (6c): segredos só em `process.env` (nunca em código, banco, log, auditoria ou tela; a tela mostra só os **nomes** das variáveis que faltam); nenhuma chamada externa dentro de `db.transaction` nem sob `travarViagem` (enfileirar sim, na transação do evento); só enfileirar com a integração configurada no momento do evento; ação do sistema (cron) audita com `usuarioId: null`; nenhum teste, seed ou verificação chama serviço real.

### Perfis e acesso
`diretor`, `consultor`, `operacional`, `fin_operacional`, `fin_estrategico`. Mapa de rotas em `src/domain/perfis.ts` (`ROTAS_POR_PERFIL`, `podeAcessar`). **Camada estratégica** (custo, margem, compensação, imposto, rateio, ponte): só diretor e os dois financeiros (`veCamadaEstrategica`), **montada só para esses perfis no servidor** (nunca calcular e esconder). Aprovar precificação: só diretor. Baixas e conciliação: diretor e financeiros. Fechar venda: consultor, operacional, diretor. Clientes e fornecedores: todos.

## 5. O que cada fatia entrega

**Fatia 1 — Base.** Login (Supabase Auth, sessão por cookie), proxy com bloqueio por perfil, convite por e-mail + `/auth/confirmar` + `/definir-senha` + "Esqueci minha senha" + reenviar convite; Admin › Usuários (só Diretor; nunca fica sem Diretor ativo); Admin › Parâmetros **versionados** com histórico (valores iniciais da tela do protótipo; a versão inicial vale "desde sempre"; câmbio USD/EUR/GBP/CHF com data, mantido à mão); Fornecedores; auditoria; seed local; configuração do Railway.

**Fatia 2 — Clientes.** Cliente = grupo (titular + quem viaja), contato, preferências, filial, código `ECL-NNNN` a partir de **ECL-0001**; CPF válido e único entre clientes ativos; pessoas com **id estável** e remoção lógica; avisos de documento e aniversário; controle de edição simultânea; busca sem acento por nome, CPF/telefone com máscara e código. Sem upload de documentos (cópias seguem no Drive até a fatia 6).

**Fatia 3a — Da cotação à proposta aprovada.** Orçamento com código `ECL-NNNN-NN` (código do cliente + sequencial); itens com várias cotações (moeda original + câmbio do dia); taxa de roteiro automática; **aéreo vendido à parte** (fora da margem); fórmulas da planilha v7 (`src/domain/precificacao.ts`, testadas contra o caso Itália: 2x a 6x → R$ 66.965,18, 19,0%); envio para aprovação com versões que **fixam as regras da época**; decisão do Diretor (aprovar, aprovar com ajuste por cotação e moeda, devolver); proposta para impressão/PDF só após aprovação, com aviso se o orçamento mudou depois; valor de referência ao cliente visível a todos.

**Fatia 3b — Da venda à margem real.** Fechamento da venda (só com orçamento aprovado; forma diferente volta ao Diretor; ajustes do cliente voltam à precificação); parcelas a receber exatas; contas a pagar a partir da cotação escolhida; comissão por reserva (descontada ou a receber); baixas (só Diretor e financeiro) com câmbio efetivo; atualizar previsto com motivo (complemento se a conta já estava paga); contestação; conciliação; **margem real com a mesma fórmula da aprovação** e ponte planejada → real com soma exata; status Vendida / Em viagem / Recebendo / Conciliada; aviso de passaporte pela data de volta (6 meses).

**Fatia 4a — Lançamentos e faturas.** Menu Financeiro (só Diretor e financeiros): **lista única** a pagar e a receber no modelo Conta Azul (abas, filtros período/situação/categoria/centro, totais vencidos/vencem hoje/a vencer/pagos, baixa individual e em lote), juntando lançamentos manuais (único, parcelado, recorrente com "só esta"/"esta e as próximas") e as linhas das viagens pela view `lancamentos_financeiros` (sem duplicar dado); **a mesma baixa** na lista e na viagem (núcleo `src/server/financeiro/baixas-viagem.ts`), com **conta bancária obrigatória**; desfazer baixa e desfazer cancelamento; categorias em dois níveis editáveis (27 iniciais); contas bancárias; **cartão direto no fornecedor** (regra a: linha de repasse; esperado − repassado = taxa; valor repassado gravado na parcela); **faturas a partir de 1405** sem buracos (contador travado), retrato por emissão, aviso de desatualizada, reemissão com o mesmo número, impressão; próximo número ajustável em Parâmetros enquanto não houver fatura. Parâmetros vigentes lidos pelo relógio do banco.

**Fatia 4b — Caixa, anexos, notas e cartões.** *Fluxo de caixa* (`/financeiro/caixa`): saldo atual por conta (saldo inicial + baixas desde a data, só o que transita pelo caixa), projeção de 8 semanas e 12 meses a partir das linhas em aberto (valor líquido de taxa de cartão/boleto; cada parcela no seu vencimento — sem antecipação automática desde 24/11/2026; vencidas marcadas na semana/mês atual), filtros centro/viagem/tipo, reserva = 6 × custo fixo mensal (Parâmetros) com "atingida em"; coluna Saldo atual em Contas bancárias; migrações de view 0026, 0033 e 0034. *Anexos* no Supabase Storage (bucket privado `anexos`, migração 0028; PDF/PNG/JPEG até 10 MB conferidos pelos bytes; URL assinada de 60 s; `bodySizeLimit` e `proxyClientMaxBodySize` "11mb") em qualquer linha da lista, faturas do cartão e notas fiscais. *Notas fiscais* (`/financeiro/notas-fiscais`): CPF/CNPJ validado, número único entre não canceladas, cancelar com motivo, PDF anexo, filtros período/destinatário. *Cartões corporativos* (`/financeiro/cartoes`): cadastro (final, fechamento e vencimento 1–28, conta de débito, centro); compras = lançamento a pagar em Cartão de crédito + cartão e pagamentos de viagem na forma Cartão corporativo + cartão; cada compra cai na fatura do ciclo; a fatura é UMA linha na lista e no caixa; baixa da fatura quita todas as compras (uma saída no banco; compra estrangeira com valor em reais informado → câmbio efetivo); desfazer; compra vinculada não tem baixa direta; `definirFormaFornecedor` recusa com fatura paga. Seed local: cartão "Visa Corporativo" (final 4821) com 3 compras e 1 nota fiscal sem anexo.

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

Perguntas abertas para o Mateus (spec da 6, §8; não bloqueiam): (1) os critérios de período, principalmente a DRE pelo mês do aceite e não pelo mês da viagem; (2) **respondida: "Visão geral não aparece para a Valeska" (Mateus, 24/11/2026)**; (3) 6b: quais bancos e um OFX de exemplo (a 6b foi feita com arquivos sintéticos); (4) 6c: qual integração primeiro (a 6c construiu todas atrás das variáveis; a ordem de ligar fica com o Mateus e as credenciais).

**Fatia 6b — Extrato OFX e conciliação** (branch `claude/fatia-6b-conciliacao`, empilhada sobre a 6a). A Valeska importa o OFX de cada conta em `/financeiro/conciliacao` e confere cada transação com as baixas da lista única. Migrações 0037 (enum `situacao_extrato`), 0038 (tabelas `extratos` e `extrato_transacoes`, CHECKs de coerência e índice único parcial por baixa conciliada) e 0039 (RLS). Leitor OFX 1.x/2.x que decide o charset pelos bytes (UTF-8 estrito; se não é UTF-8 válido, windows-1252) e decodifica entidades nomeadas e numéricas; testado só com arquivos sintéticos nos dialetos SGML 1.x e XML 2.x (nenhum OFX real de banco ainda). Importação idempotente: arquivo idêntico recusado pelo hash; extrato sobreposto traz só as transações novas (conta + FITID com a mesma data e valor = repetida; FITID repetido com outra data ou valor entra separado, com FITID ajustado) e o resumo conta as repetidas e as ajustadas. Extrato de outro banco ou outro final de conta pede confirmação; importação sem nada tratado pode ser desfeita pelo histórico. Situações exibidas: Confere, Diferença de R$ x, Não conciliado, Ignorado e "A baixa mudou: confira". Relatório "Conciliação extrato x sistema" (`rel=conciliacao`, filtro opcional `conta`, planilha e impressão) e aviso `conciliacao` na Visão geral (entre `pagar` e `aprovacao`, responsável Financeiro, só transação pendente com mais de 3 dias, contas ativas). Seed: extrato sintético com as 3 situações. Rulings (spec §6), para o Mateus conferir:
- **R-B1** o arquivo OFX não é guardado, só as transações e o hash (o bucket `anexos` só aceita PDF/PNG/JPEG; guardar exige bucket novo, uma migração).
- **R-B2** desfazer uma baixa não é bloqueado; a conciliação é conferida na leitura e a transação aparece como "A baixa mudou: confira" (bloquear exigiria mexer nos 5 núcleos de baixa). Não há trava na baixa lida da view; o índice único parcial é a fonte da verdade contra a mesma baixa em duas transações.
- **R-B3** sugestão pelo mesmo valor de caixa (líquido) e até 3 dias (`DIAS_SUGESTAO`), sem sugestão se o empate na distância é exato; escolha manual até 10 dias (`DIAS_ESCOLHA`); aviso após 3 dias (`DIAS_AVISO`).
- Rulings das Tarefas 3 e 4 (relatórios das tarefas em `.superpowers/sdd/2026-11-24-fatia-6b-conciliacao/`): lançamento criado a partir da transação é manual, forma "Débito em conta" (nunca cartão, que tiraria do caixa); valor 0 e data futura são recusados; descrição editável até 200 caracteres (a do extrato vai até 255 e a tela corta); a auditoria da importação é uma linha em `extratos` (as mudanças de situação auditam `extrato_transacoes`); `totais` do período inteiro antes do filtro de situação; aviso soma valores em módulo e só das contas ativas e não excluídas; desfazer a conciliação de um lançamento criado pela transação deixa o lançamento baixado (desfaz-se pela lista); `confirmarPar` sem pré-checagem de "já conciliada" (mensagem vem do 23505); situação "A baixa mudou" devolve `linha` nula; candidatas lidas por `baixado_em` na janela do período ± 10 dias; `criarLancamentoDaTransacao` valida por Zod; motivo de ignorar de 3 a 200 caracteres; parâmetros inválidos da URL da tela caem nos padrões sem erro.
- Rulings da revisão final (24/11/2026, relatório em `.superpowers/sdd/2026-11-24-fatia-6b-conciliacao/final-fix-report.md`):
  - **I1** o charset sai dos bytes, não do cabeçalho (bancos declaram `CHARSET:1252` e mandam UTF-8, ou `CHARSET:NONE` e mandam 1252): `TextDecoder("utf-8", { fatal: true })` e, se falha, windows-1252; texto só ASCII é igual nos dois, então o cabeçalho não desempata nada e foi tirado.
  - **I2** FITID já gravado na conta (ou antes no mesmo arquivo): mesma data e valor = repetida; outra data ou valor = grava com FITID `<fitid>#<data>#<valor em centavos>` e conta em `ajustadas` (reimportar o mesmo arquivo depois vê a ajustada como repetida). `extratos.transacoes` = gravadas (novas, incluindo as ajustadas); `ajustadas` só no retorno da action e no `depois` da auditoria (sem migração).
  - **I3** (a) se a conta já tem extrato com `banco_ofx` ou `conta_ofx` (não nulos) diferentes dos do arquivo, a importação recusa com "Este extrato parece ser de outra conta (banco X, final Y). Confirme para importar mesmo assim." e a tela mostra "Importar mesmo assim" (reenvia o mesmo arquivo com `confirmarOutraConta=1`); compara com todos os extratos anteriores, então depois de uma confirmação as próximas importações daquela conta voltam a perguntar enquanto houver extratos dos dois. (b) o histórico mostra banco e final da conta. (c) `desfazerImportacao(extratoId)` apaga as transações e o extrato (auditoria `excluir` com `antes` de cada um, na mesma transação), só com todas pendentes; senão "Desfaça as conciliações deste extrato antes". Botão "Desfazer importação" no histórico, com diálogo de confirmação.
  - **M2** a importação trava a linha da conta com `for no key update` (em vez do `for update` literal: serializa as importações da mesma conta e não barra inserts que só referenciam a conta pela FK; as actions que conferem a conta com `for share`, como as baixas, esperam a importação terminar) e grava as transações ordenadas por FITID.
  - **I2 depois de desfazer** transação já gravada como `fitid#data#valor` é repetida mesmo se o FITID original ficou livre (desfeita a importação que o tinha), para não gravar o mesmo movimento duas vezes.
  - Relatório usa `obterConciliacao(…, { sugestoes: false })`: mesmas linhas, situações e totais da tela, sem calcular sugestão, opções nem histórico.
  - Seed: `conta_ofx` mascarada ('3456', como a importação grava); par já conciliado à mão → a transação do seed entra pendente.

**Fatia 6c — Integrações** (branch `claude/fatia-6c-integracoes`, empilhada sobre a 6b). Desenho no spec `docs/superpowers/specs/2026-11-24-fatia-6b-6c-design.md` §5, plano `docs/superpowers/plans/2026-11-24-fatia-6c-integracoes.md`; como ligar no `README.md` › Integrações. Migrações 0040 (enums `integracao_fila` e `situacao_envio`), 0041 (tabela `integracao_envios`: fila com chave única por integração, CHECKs de coerência, índice por situação e próxima tentativa), 0042 (RLS), 0043 (tabela `ia_usos`: quem, quando, recurso, modelo, tokens; sem texto) e 0044 (RLS). Todas aditivas.
- **Base:** `config.ts` lê o ambiente na chamada e diz quais variáveis faltam (nomes); `http.ts` com timeout de 15 s e classes `rede`/`autenticacao`/`limite`/`recusado`/`servidor`, sem ler corpo de erro (exceto o motivo do 403 do Drive); fila `integracao_envios` gravada na transação do evento e mandada fora dela (`after()` logo depois da resposta e o cron), até 6 tentativas com espera de 1, 5, 15, 60 e 180 min, `autenticacao` e `recusado` direto a `falhou`, `enviando` preso há mais de 10 min volta a `pendente`, tomada um envio por vez com `FOR UPDATE SKIP LOCKED` e fencing por `tomado_em` (uma execução velha não grava por cima da nova); o que espera o cartão da venda fica "Aguardando o cartão da venda" sem gastar tentativa. Rotas `POST /api/cron/integracoes` e `/api/cron/dailies` com `Authorization: Bearer <CRON_SECRET>` (503 sem segredo no ambiente, 401 com segredo ausente ou errado; o proxy deixa `/api/cron/` passar sem sessão).
- **Trello:** venda fechada → cartão `<código> · <SOBRENOME> · <destino> · dd/mm a dd/mm/aaaa` na lista, descrição com o link da viagem, checklist "Tarefas da venda"; roteiro aprovado → checklist "Tarefas do roteiro" no mesmo cartão. Retomada reaproveita o cartão, o checklist e os itens já gravados no `resultado`.
- **Drive:** JWT RS256 com `node:crypto` (sem biblioteca do Google), token em memória até 60 s antes de expirar; venda fechada → pasta `ECL-NNNN_SOBRENOME_DESTINO_AAAAMMDD-AAAAMMDD` na raiz (drive compartilhado) com "Público" e "Uso interno"; upload multipart até 5 MB e listagem prontos no cliente, sem tela (R-C3). Link "Pasta no Drive" e "Cartão no Trello" na trilha da viagem.
- **Admin › Integrações** (`/admin/integracoes`, só Diretor): um cartão por integração (Trello, Drive, IA, hotelaria, agendador) com a situação real, "Testar conexão" (auditado), as URLs do agendador e a fila com pendentes e falhas (Reenviar). Nota no Trello e no Drive: o "Testar conexão" só lê (token do Trello com escrita; conta de serviço Editor do drive compartilhado); sem `CRON_SECRET` e com envios na fila: "Sem o agendador, o que ficou na fila só sai no próximo evento ou pelo Reenviar." Na viagem, só o Diretor: "Enviar para o Trello" (leva também o checklist do roteiro se já aprovado) e "Criar pastas no Drive" para viagens vendidas antes de ligar (R-C1).
- **IA:** `ProvedorIA` com o adaptador do Claude (SDK oficial `@anthropic-ai/sdk` 1.7.0, `claude-opus-5-5` ou `IA_MODELO`, beta `server-side-fallback-2026-07-01` com `fallbacks: "default"`, esforço `low` no Reescrever e `medium` no chat, `max_tokens` 16000 (o pensamento conta no limite), recusa conferida antes do texto). `protegerTexto` troca CPF e CNPJ (com ou sem máscara, separadores ponto, hífen, barra ou espaço), passaporte (com espaço ou hífen opcional), RG, telefone com DDD, nascimentos conhecidos (d/m/aaaa, dd-mm-aaaa, dd.mm.aaaa, ISO) e documentos conhecidos (com ou sem separadores) por marcadores antes de todo envio à IA e nos itens de checklist que vão ao Trello. **Reescrever com IA** na abertura, DICA ECLAK e "Por que escolhemos" do roteiro e no texto do daily (sugestão ao lado; nada gravado sem o clique). **Chat** (balão de conversa no topo, painel lateral) só de leitura com 4 ferramentas (`buscar_viagens`, `resumo_da_viagem`, `minhas_tarefas`, `dailies_da_semana`) que chamam as queries existentes com o perfil de quem pergunta; camada estratégica só para quem já a vê; laço manual de ferramentas com no máximo 6 voltas; conversa sem histórico no banco. Uso registrado em `ia_usos`; o custo é pago pela ECLAK à Anthropic. Desligada, nenhum botão de IA aparece.
- **Agendador do daily (D-2):** `POST /api/cron/dailies` gera, para hoje, hoje + 1 e hoje + 2 em Cuiabá (uma execução perdida é recuperada pela seguinte), o daily de cada roteiro aprovado de viagem vendida que não tem texto nesse dia (sem linha ou `pendente`), com o mesmo núcleo de `gerarDaily` (extraído para `src/server/operacao/dailies.ts`), `gerado_por` nulo e auditoria com usuário nulo, cada um na própria transação; nunca sobrescreve texto gerado, revisado ou enviado. O envio ao cliente segue manual.
- **Hotelaria (Expedia TAAP, Infotera):** só `interface ProvedorHotelaria` (destino, datas, quartos e hóspedes, refeição, tarifa) e `provedorHotelaria()` que devolve `null`; nenhuma URL nem variável (R-C7).

Rulings do desenho (spec §6), para o Mateus conferir:
- **R-C1** fila só quando a integração já está ligada no momento do evento; viagens antigas pelo botão na viagem (custo: um filtro na hora de enfileirar).
- **R-C2** Drive: pasta-mãe com "Público" e "Uso interno" (custo: nome e estrutura num lugar só).
- **R-C3** upload e leitura no Drive prontos no cliente, sem tela (documentos de passaporte/RG pedem decisão de LGPD) (custo: telas novas quando decidirem).
- **R-C4** IA: Claude (`claude-opus-5-5`) pelo SDK oficial, atrás de interface (custo: trocar o adaptador).
- **R-C5** chat sem histórico no banco (custo: tabela nova).
- **R-C6** chat só lê; escrever pelo chat fica para depois (custo: ferramentas de escrita com confirmação).
- **R-C7** Expedia/Infotera só interface (custo: implementar quando houver documentação).
- **R-C8** vouchers em PDF fora (custo: modelo do voucher).

Rulings do controlador durante a execução (ledger `.superpowers/sdd/2026-11-24-fatia-6c-integracoes/progress.md`, que o git ignora; copiados aqui):
- "Enviar para o Trello" leva também o checklist do roteiro aprovado (cria o `roteiro:` ou reabre o que falhou/está pendente), corrigido na tarefa do Trello e não na de Admin, porque o botão é o caminho do R-C1 (custo: nenhum).
- Drive: 403 com motivo de limite (`rateLimitExceeded`, `userRateLimitExceeded`) vira `limite` (repete), lendo só o motivo do corpo; o plano mandava 403 → `autenticacao` (custo: nenhum, o resto do 403 continua igual).
- Links "Cartão no Trello" e "Pasta no Drive" visíveis a todos que veem a viagem (sem dado sensível; o acesso é governado pelo próprio serviço) (custo: esconder por perfil é uma condição).
- "Testar conexão" auditado com a ação `criar` (o enum da auditoria não tem "testar") (custo: migração de enum se quiserem filtrar).
- IA com timeout de 60 s por pedido, sem nova tentativa, prazo total de 90 s (o plano dizia 15 s; o modelo sempre pensa) (custo: uma constante).
- Marcador extra `[DOCUMENTO]` para documentos conhecidos fora do padrão; 11 dígitos soltos viram `[CPF]` (pode mascarar um celular sem máscara): erra para o lado seguro (custo: o modelo vê `[CPF]` no lugar de um telefone).
- Recusa da IA ainda grava `ia_usos` (os tokens são cobrados) (custo: nenhum).
- SDK `@anthropic-ai/sdk` 1.7.0 fixo (publicado em 09/11/2026) (custo: atualizar a versão).
- Chat: o limite de 6 voltas devolve `ok: false` com mensagem, que não entra no histórico (custo: uma linha).
- `chat.ts` usa os tipos do SDK (provedor acoplado ao formato da Anthropic); abstrair quando houver um segundo provedor (custo: refatorar `chat.ts`).
- Prazo total do chat de 3 min; pagamentos a fornecedor ocultos no chat para perfis sem camada estratégica (custo: constantes/condição).

Decisões de implementação registradas nos relatórios das tarefas (conferir se quiser): coluna extra `tomado_em` na fila (não estava no spec) para detectar envio preso e fazer o fencing; `tentativas` sobe na tomada (processo que cai também gasta tentativa); `ultimo_erro` em jsonb `{classe, status}`; 2xx com corpo que não é JSON conta como `servidor`; envio de integração desligada ou sem processador fica `pendente` sem gastar tentativa; arquivo `src/server/integracoes/eventos.ts` para evitar ciclo de imports; sobrenome com acento no cartão do Trello (só a pasta do Drive tira acento); viagem que vira o ano aparece "28/12/2026 a 04/01/2027" no cartão; checklist sem itens não é criado; sem `NEXT_PUBLIC_SITE_URL` em produção a descrição do cartão leva o caminho relativo (não desfaz a venda); 401 do Drive descarta o token guardado; "Testar conexão" da IA não grava `ia_usos`.

Rulings da tarefa do agendador (Task 7):
- `lerRegrasVigentes()` (em `src/server/queries/regras.ts`) é o núcleo de `regrasVigentes()` sem `exigirPerfil`, só para o agendador (cron, sem sessão), como `garantirVersaoInicial` (custo: nenhum).
- O núcleo tem dois modos: o da pessoa é o de antes (sem exigir roteiro aprovado, D28; "Gerar de novo" com `atualizadoEmEsperado`); o do sistema confere sob as travas que o roteiro está aprovado e que o dia está sem linha ou `pendente`, e gera o `pendente` sem conferir versão (o cron não tem tela aberta), mantendo plantão e nota interna.
- `gerarDailiesDoDia` devolve só `{ gerados, pulados }`: um erro de banco num roteiro é logado (só o código), conta como pulado e não impede os outros (custo: um campo `erros` se quiserem separar).
- A rota do cron não chama `revalidatePath` (as telas de dailies são dinâmicas).
- `ProvedorHotelaria`: quartos com adultos e idades das crianças, regime de refeição (`sem_refeicao` a `tudo_incluido`), só reembolsável opcional; tarifa com código, quarto, refeição, reembolsável, prazo de cancelamento e total em centavos (`bigint`) na moeda do provedor (custo: ajustar os tipos quando chegar a documentação).

**Fatia 5b — Estoque, Caixa de experiência, Reembolsos e Avisos** (branch `claude/fatia-5b`, a partir de `main` depois do PR #17; PR a abrir). Desenho `docs/superpowers/specs/2026-11-25-fatia-5b-design.md` (§14 vale sobre o resto), plano `docs/superpowers/plans/2026-11-25-fatia-5b.md`. Migrações 0046–0058, todas aditivas: 0046 (enums `uso_estoque`, `tipo_movimento_estoque`, `situacao_caixa`), 0047 (tabelas `produtos_estoque`, `estoque_saldos`, `estoque_movimentos`, `caixas_experiencia`, `caixa_itens` e a coluna `lancamentos.estoque_movimento_id`), 0048 (RLS), 0049 (as quatro categorias de sistema novas), 0050 (`lancamentos.reembolso_id`), 0051 (view `lancamentos_financeiros` com as duas colunas de vínculo, cópia da 0045), 0052 (CHECK do sinal da quantidade por tipo de movimento), 0053 (enum `forma_devolucao`), 0054 (tabela `reembolsos` e a FK de `lancamentos.reembolso_id`), 0055 (RLS), 0056 (dono `reembolso` nos anexos), 0057 (`avisos_dispensados` e `avisos_comunicados`), 0058 (RLS).
- **Estoque** (`/financeiro/estoque`, Diretor e financeiros): produtos (brindes de caixa de experiência e papelaria) com mínimo por filial; saldo e custo médio por filial (MT = Rondonópolis, RS); entrada (compra) gera **uma conta a pagar** pelo núcleo (categoria pelo uso, centro = filial, "Estoque: <n> × <produto>"; valor 0 não gera conta; aceita o cartão corporativo, e a conta entra na fatura do ciclo); saída e ajuste com motivo, sem lançamento; desfazer entrada só quando é o último movimento do produto na filial e a conta não foi paga (volta ao `custo_medio_antes`); produto só desativa com saldo 0 nas duas filiais. Cartões (valor em estoque, abaixo do mínimo), filtros, histórico e a aba "Caixas" (vendidas não conciliadas que embarcam em até 60 dias, com a situação da caixa).
- **Caixa de experiência** (bloco na viagem vendida, os cinco perfis): rascunho com produtos de caixa ativos da filial da viagem; confirmar trava a viagem, a caixa e os saldos, recusa item acima do saldo, baixa ao custo médio e grava o custo de cada item e o total; cancelar o rascunho apaga, cancelar a confirmada (motivo) devolve ao estoque ao custo gravado; uma caixa não cancelada por viagem; só em viagem vendida e não conciliada; conciliar é recusado com caixa em rascunho. Consultor e operacional não veem valores.
- **Reembolsos** (`/financeiro/reembolsos`, Diretor e financeiros; bloco na viagem para os mesmos perfis): o caso (serviço da viagem, ocorrido, valor a cobrar e a devolver, forma, prazos) cria na mesma transação a conta a receber do fornecedor e, em PIX ou transferência, a conta a pagar ao cliente; "Fornecedor pagou" e "Cliente reembolsado" são a **baixa dessas contas** (a mesma da lista; o caso lê as contas, não as copia); editar acompanha a conta em aberto; cancelar só sem baixa; comprovantes pelos anexos. Situação derivada: Pedir ao fornecedor, Aguardando fornecedor e cliente, Aguardando o fornecedor, Reembolsar o cliente, Concluído, Cancelado. Vale em viagem conciliada (a tela avisa "Margem alterada por reembolso depois da conciliação").
- **Margem real com ajustes:** `margemReal` e `ponteDaMargem` recebem `ajustes { caixa, reembolsos }` (padrão 0): `receita`, `custo`, `imposto`, `taxas` e `fixo` não mudam (viagem sem ajuste dá o mesmo resultado de antes, testado); só `final` desconta. Reembolsos = Σ (devolver − cobrar) dos casos não cancelados (o recebido e o devolvido quando baixados; abatimento conta 0, porque a parcela recebida a menor já reduz a receita). A ponte ganha as linhas "Caixa de experiência" e "Reembolsos" depois de "Imposto". O DRE não conta duas vezes (as compras e as contas do reembolso aparecem só nas categorias).
- **Núcleo do financeiro extraído:** desfazer baixa, cancelar e alterar valor e vencimento de lançamento em aberto passaram a existir numa transação em `src/server/financeiro/lancamentos.ts`, e as actions da lista chamam o núcleo (sem mudança de comportamento). Contas com vínculo (estoque ou reembolso) não são editadas nem canceladas na lista.
- **Avisos** (`/avisos`, os cinco perfis, e o sino no topo com o contador "para mim"): os sete avisos da Visão geral saíram para `src/server/avisos/` (uma função por aviso, cada uma com `exigirPerfil`; a Visão geral mostra o mesmo de antes) e a central soma tarefa vencida, daily a gerar, aniversário na viagem, estoque abaixo do mínimo, caixa a montar e os três de reembolso, cada um com chave estável, setor e próximo passo. Setores e quem recebe: spec §8.2 (o financeiro operacional passa a receber parcela, comissão, pagar e conciliação). Dispensar com justificativa de 10 a 500 caracteres (caixa negativo não dispensa), aba "Dispensados" (90 dias) e "Desfazer dispensa" (quem dispensou ou o Diretor); comunicados para um setor ou Geral, resolvidos por quem recebe ou quem criou. Contador por Server Action com 60 s de memória por pessoa.
- **Seed** (`scripts/seed-5b.ts`): 11 produtos do protótipo com o saldo do protótipo nas duas filiais, cada saldo vindo de uma entrada com conta a pagar (o Caderno em MT no cartão corporativo); caixa confirmada na Família Ribeiro (MT) e em rascunho na Família Teixeira (viagem vendida nova do seed, RS, embarque em 20 dias); três reembolsos (Pedir ao fornecedor e Reembolsar o cliente na Ribeiro; Concluído na viagem conciliada dos Vasconcelos); dois comunicados (Operacional e Geral).

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

Do Mateus para a 5b (25/11/2026, "Construa 5b"):
1. **Reembolso:** a diferença entre o devolvido ao cliente e o recebido do fornecedor é **custo da viagem** (entra na margem real).
2. **Caixa de experiência:** o custo dos itens **entra na margem real** da viagem.
3. **Limite da caixa:** **sem limite por enquanto**; a tela só mostra o total, sem aprovação.
4. **Perfis:** Reembolsos e Estoque **só para Diretor e financeiros**; consultor e operacional só montam a caixa de experiência na viagem.

Rulings do controlador durante a execução da 5b (ledger `.superpowers/sdd/2026-11-25-fatia-5b/progress.md`, copiados aqui; entre parênteses, o custo de trocar):
- Desfazer entrada volta o saldo ao `custo_medio_antes` gravado no movimento, não pela fórmula inversa da média (que perde centavos no arredondamento) (uma coluna).
- Ajuste positivo numa filial com saldo 0 entra ao custo médio da **outra filial** (se maior que 0), senão a 0: a "transferência" por dois ajustes (spec §10.3) não zera o custo (uma linha na action).
- Próximo passo dos sete avisos que já existiam só na central (a Visão geral continua sem passo), com os textos do spec §14 (textos).
- A dispensa vale enquanto **título e detalhe** forem iguais aos gravados (o título dos avisos agregados traz a contagem), por até 30 dias; o spec dizia só o detalhe (um campo).
- "Para mim" inclui os comunicados que a pessoa criou, mesmo para outro setor (nenhum).
- Aniversário segue o spec: avisa até o fim da viagem (nenhum; ver §8.7).
- Cancelar a caixa em rascunho apaga a caixa e os itens (nada saiu do estoque); só a confirmada vira `cancelada` com motivo (nenhum).
- `ajustesDaViagem` (soma da caixa e dos reembolsos para a margem) é interna, sem `exigirPerfil`; só é chamada por `calcularMargens`, que já está atrás do perfil (uma chamada).
- Motivo do cancelamento do reembolso com 5 a 200 caracteres (constante).
- Migrações numeradas pelo próximo número livre (o plano ficou defasado): 0046–0058.
- Seed da 5b (Task 15): escreve pelo mesmo núcleo das actions (`travarSaldo`/`gravarMovimento`/`gravarSaldo`, `criarLancamentosNa`, `baixarLancamentoNa`, `naViagemVendidaNa`) e valida pelos mesmos schemas, porque as Server Actions não rodam fora do Next (`cookies()` da sessão e `revalidatePath` exigem a requisição); o corpo das actions de entrada, caixa e reembolso fica, portanto, repetido no seed (custo: manter os dois iguais). O seed **não limpa** nada (padrão dos outros seeds; apagar lançamentos ligados a movimentos e casos seria `delete` cru em tabela de dinheiro). Ganhou uma terceira viagem vendida (Família Teixeira, RS) porque a caixa só vai em viagem vendida e não conciliada, uma por viagem. A entrada em MT soma o que a caixa da Ribeiro consome, para o saldo final ficar o do protótipo.

Do Augusto (respostas no WhatsApp, 23/11/2026; registradas pelo Mateus em 24/11/2026):
- **Antecipação de recebíveis:** "a gente não usa antecipação automática, ela é calculada quando precisamos de caixa". Mudança feita (branch `claude/antecipacao-manual`): a forma "6x com antecipação" fica só como referência nas análises do simulador (não é forma de proposta, de aprovação nem de venda; `formaSchema` recusa com mensagem) e o caixa põe cada parcela de cartão no seu vencimento (migração 0045, cópia da view 0034 sem o deslocamento). Ainda **não** existe uma ação "antecipar recebíveis" no caixa: falta saber se a taxa da antecipação reduz a margem da viagem ou é custo financeiro da empresa (§7).
- **Compra no cartão corporativo em moeda estrangeira:** dois formatos. (a) Cartão de crédito convertido pelo banco: é o que a 4b faz (valor em reais informado na baixa da fatura) — confirmado. (b) **Cartão Wise em moeda local** (saldo em moeda estrangeira): ainda não modelado; perguntas em §7.
- **Cartão direto no fornecedor:** "precisa da programação da comissão que será recebida da ECLAK; é mais em caso de aéreo, 90% das vezes". A Beatriz vai explicar o processo comercial e mandar um bilhete aéreo de exemplo com os campos e onde aparece o valor a receber. A regra (a) da 4a (o que o fornecedor reteve a mais vira taxa) fica como está até lá. Atenção: o sistema vende o aéreo à parte, fora da margem, e já tem "comissão a receber" por reserva — talvez o caso real seja comissão de aéreo, não repasse de hotel.

Do Claude (registradas nos planos, conferir com o Mateus):
- "Margem sem taxa de serviço" = margem líquida sobre o preço ao cliente (bate com a planilha).
- Diferenças de 1 centavo da planilha por arredondamento linha a linha; rateio por dia arredondado a R$ 230,29/dia antes de multiplicar.
- Taxa de roteiro com venda R$ 250,00 (sem margem/compensação).
- 6x com antecipação por interpolação linear (7,7367%). Desde 24/11/2026 é só referência no simulador (Augusto: a antecipação não é automática).
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
1. **Valor no caixa (decisão 12 do desenho):** parcela de cartão de crédito ou boleto entra pelo líquido (previsto − taxa prevista; recebido − taxa efetiva). Repasse já é líquido. Pix, comissões, lançamentos manuais e pagamentos: valor cheio. ~~Crédito com antecipação: `data_caixa` = primeiro vencimento em aberto~~ — **substituído em 24/11/2026** (resposta do Augusto): cada parcela no seu vencimento, sem antecipação automática (migração 0045).
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
- Dailies: gerado sob demanda, sem job nem geração ao abrir, com o estado extra "A gerar" (D10; o agendador veio na 6c: com `CRON_SECRET`, `POST /api/cron/dailies` gera às 07:00 de Cuiabá o texto de hoje até D-2 dos roteiros aprovados que ainda não têm texto); passo manual "Marcar como revisado" (D27); pode gerar antes de D-2 (D26); enviado não aceita edição até "Desfazer envio" (D17); nomes da saudação: até 3 primeiros nomes, senão o grupo (D18); não exigem roteiro aprovado (D28).
- Padrão do texto: indicador 1 aceita a saudação do idioma do roteiro, inclusive "Bom dia" (D11); indicador 4 acusa dia sem item com hora, regra do protótipo mantida (D12); indicador 3 aceita `maps.app.goo.gl` (D25); hotel com hora de check-in/out e mapa, e link de busca com `%20` (D14).
- Roteiro: idioma e fuso guardados, sem cadastro de destinos (D13); pré-preenchimento só na criação e no botão "Trazer hotéis e voos" (D15); aprovar direto do rascunho, edição depois só avisa (D16).
- Outros: nome de arquivo com último sobrenome e destino em maiúsculas sem acento (D19); encerramento versionado, só o Diretor edita (D20); plantão sem telefone (D21); listas `/roteiros` e `/dailies` (D22); sem vouchers em PDF no daily (D23); aniversário só aviso na tela e item no roteiro (D24); textos do protótipo cortados: "e vão para o Trello" e "Data conferida no passaporte." (D31); `roteiros.atualizado_em` só muda com o conteúdo (D32).

### Para conferir com a Valeska e o grupo (5b)
Decisões do Claude no spec da 5b (§10 e §14), tomadas sem resposta do grupo; cada uma foi escrita para ser trocada num lugar só:
1. Os lançamentos do reembolso nascem **no registro da ocorrência**, em aberto; as baixas acontecem nos marcos ("Fornecedor pagou", "Cliente reembolsado"), que são a mesma baixa da lista única.
2. "Abatimento na próxima parcela" **não muda a parcela sozinho**: a Valeska dá baixa na parcela pelo valor menor, e é por aí que a margem sente; o caso só guarda a data. "Crédito para a próxima viagem" conta como custo desta viagem e não vira saldo do cliente no sistema.
3. Estoque pelo **custo médio**; saída manual e ajuste com motivo; mínimo **por filial**; sem transferência entre filiais (ajuste numa e na outra, com o motivo). Ajuste positivo em filial vazia entra ao **custo médio da outra filial**.
4. "Onde foi comprado": fornecedor do cadastro **ou** texto livre.
5. Caixa só em viagem vendida e não conciliada, sem prazo antes do embarque; cancelar devolve ao estoque; conciliar a viagem é recusado com a caixa em rascunho.
6. Os ajustes (caixa e reembolso) **não reduzem a base do imposto** sobre a margem.
7. Avisos: sem lido/não lido por pessoa e sem notificação fora do sistema; o financeiro estratégico recebe Gestão e Financeiro; o consultor recebe Comercial e Operacional; o financeiro operacional recebe Financeiro (passa a ver parcela, comissão, pagar e conciliação).
8. Eventos automáticos: tabela do spec §8.3. Caixa a montar avisa a 30 dias do embarque; aniversário, a 60.
9. Reembolso pode ser registrado em viagem já conciliada (muda a margem real dela, com aviso na tela).
10. **Desfazer entrada** só quando ela é o último movimento do produto na filial; depois disso, "Faça um ajuste de estoque".
11. **Consultor e operacional não veem valores da caixa** (só itens, quantidades e o disponível); valor por item e total só para Diretor e financeiros.
12. Entrada com valor unitário 0 (doação, brinde recebido) é aceita e não gera conta; entrada no cartão corporativo entra na fatura do ciclo, e desfazer é recusado com a fatura paga.
13. A baixa do reembolso com valor diferente do previsto exige observação, como na lista.
14. Se o fornecedor vai abater na conta dele em vez de devolver, o valor a cobrar fica em 0 (o formulário avisa; não há bloqueio contra o benefício em dobro).
15. **Textos de próximo passo dos sete avisos** que já existiam: caixa "Rever o fluxo de caixa"; margem "Rever os custos lançados na viagem"; parcela "Cobrar o cliente"; comissão "Cobrar a comissão do fornecedor"; pagar "Pagar ou reprogramar as contas"; conciliação "Conciliar o extrato"; aprovação "Aprovar ou devolver os pedidos".
16. **Dispensa** vale para todos enquanto o título e o detalhe do aviso forem os mesmos, **por até 30 dias**; mudou o texto (por exemplo, de 3 para 4 parcelas vencidas) ou passaram 30 dias, o aviso volta. Aviso de caixa negativo não pode ser dispensado.
17. "Para mim" é por setor (o sistema não separa viagens por consultor).

## 7. Perguntas abertas para o Augusto
Novas (das respostas de 23/11/2026):
- **Antecipação (Valeska):** quando a ECLAK antecipa, quem recebe é a maquininha (qual?) e o valor entra de uma vez? A taxa da antecipação deve reduzir a margem da viagem dona das parcelas ou entrar como custo financeiro da empresa (DRE)? Com isso dá para ter no Fluxo de caixa um "simular/registrar antecipação".
- **Valor líquido no caixa:** ele respondeu só sobre a antecipação; falta confirmar que cartão e boleto entram no caixa já descontada a taxa (a conciliação da 6b compara por esse líquido).
- **Wise (Valeska):** a compra no cartão Wise sai na hora do saldo em moeda (débito) ou vem numa fatura? Como o saldo é abastecido (transferência em reais convertida pela Wise)? Qual câmbio vale como custo da viagem: o do abastecimento ou o do dia da compra? Precisam ver o saldo em euro/dólar no sistema?
- **Cartão direto no fornecedor / aéreo (Beatriz):** um bilhete aéreo de exemplo (sem dado pessoal) e: quem cobra o cliente, quanto a ECLAK recebe (comissão ou repasse), quando e de quem; isso entra na margem da viagem ou fica à parte como o aéreo?

Anteriores:
1. Taxa de roteiro: a planilha v7 mostra venda de R$ 259,69; o sistema usa R$ 250,00.
2. 6x com antecipação: interpolação dá 7,7367% (R$ 71.277,08); a planilha mostra 7,73% e R$ 71.273,78.
3. Matriz de acesso: margem/custos agora visíveis também aos financeiros.
4. Ainda em aberto no `PRODUCT.md` do protótipo: modelo de fatura, cartões corporativos, percentual do alerta de preço, validade da cotação, API do Sakura Click, fontes da marca (Evaida, CA Saygon Text) não enviadas.

## 8. Próximo passo

**Imediato:** abrir o PR da `claude/fatia-5b` com `--base main` e revisar (abrir e mergear só com o "sim" do Mateus). A 5a, a 4b e as fatias 6a, 6b e 6c já estão em `main` (§2); toda fatia nova parte de `main`. Depois do merge, conferir com a Valeska e o grupo a lista "Para conferir com a Valeska e o grupo (5b)" em §6 (cada decisão troca num lugar só) e as pendências menores da 5b (§8.7).

**Fatia 6 (painéis e integrações):** pendências para usar de verdade: um OFX real de cada banco (6b); as credenciais de cada integração e o primeiro "Testar conexão" real (6c, README › Integrações e §8.6). Ainda falta o **texto oficial de encerramento do daily** (entra por Admin › Parâmetros, sem código).

**O que a 5b deixou de fora (não-objetivos do spec §2):** limite e aprovação da caixa (decisão 3 do Mateus); transferência de estoque entre filiais; inventário com contagem; aviso por e-mail ou WhatsApp; lido/não lido por pessoa; reduzir a parcela do cliente automaticamente no "abatimento"; crédito do cliente como saldo reutilizável; reembolso em moeda estrangeira. As nove perguntas abertas da 5b (spec da 5a §6) viraram as decisões listadas em §6.

Materiais pendentes da 5a: PDFs reais TAREFAS e RT (conferir colunas e layout da impressão), fontes da marca (Evaida, CA Saygon Text) para o PDF do RT, lista de destinos frequentes com idioma e fuso. **Fatia 6:** Trello, Drive, "Reescrever com IA" e o agendador do daily em D-2 entraram na 6c. Ficam de fora: vouchers em PDF no daily (R-C8), plano logístico e mapas.

### 8.0 Histórico: escopo da 4b (entregue no PR #6)

Escopo no desenho (`docs/superpowers/specs/2026-11-22-fatia-4-financeiro-design.md`, §6.5) e notas na seção "Para a 4b" do plano da 4a: fluxo de caixa com projeção de 12 meses (realizado + previsto da view `lancamentos_financeiros`, só `transita_caixa`), meta de reserva de 6 meses de custo fixo, anexos e notas fiscais (Supabase Storage, primeiro uso), faturas de cartão corporativo (custo variável, IOF). Referências no protótipo: `src/app/{fluxo-de-caixa,notas-fiscais,relatorios}/page.tsx`, `src/components/{reserva-projecao,cash-chart,operacionais}.tsx`, `src/lib/calc.ts`.

Materiais ainda pendentes do cliente (4b): modelo `FATURA_1405_…pdf`, plano de categorias do Conta Azul, `CUSTOS FIXOS.xlsx`, `PLANILHA NOTAS FISCAIS.xlsx`.

### 8.1 Referência: Conta Azul (pedido da Valeska)
O financeiro segue o Conta Azul (lista única, categorias grupo › categoria, competência, centro de custo MT/RS, formas de pagamento, baixa, conciliação, fluxo de caixa, DRE). A 4a já cobre lista, baixas, categorias, parcelamento e recorrência.

Materiais ainda não recebidos (Drive da Valeska): `CUSTOS FIXOS.xlsx` (base da reserva e das contas fixas), `PLANILHA NOTAS FISCAIS.xlsx` (comissões por empresa e competência), modelo `FATURA_1405_…pdf` (a impressão da fatura aguarda esse modelo), plano de categorias do Conta Azul.

### 8.2 Para confirmar com a Valeska ou o Augusto
- Regra (a) do cartão direto: a margem cai pelo que o fornecedor reteve; pagamento em euro do fornecedor do cartão segue na viagem. **Augusto (23/11): depende do processo de comissão do aéreo; a Beatriz vai explicar (§7).**
- Card "Vencidos": só o período filtrado ou todos os vencidos.
- Numeração 1405 e telas do financeiro só para Diretor e financeiros.

### 8.2b Para confirmar com a Valeska ou o Augusto (4b)
- Os rulings 1 a 12 acima (em especial: valor líquido de taxa no caixa, reserva = 6 × custo fixo de Parâmetros, ciclo do cartão, baixa única da fatura). **Respondido pelo Augusto (23/11):** sem antecipação automática (feito, migração 0045); compra estrangeira no cartão de crédito convertida pelo banco confirmada; cartão Wise em moeda local ainda a modelar (§7).
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

### 8.5 Pendências menores da 6b (não bloqueiam)
- Antes da produção: conseguir um OFX real de cada banco usado pela ECLAK e importar (charset, FITID, ACCTID, valor líquido de cartão).
- "A baixa mudou" e "Diferença" não geram aviso na Visão geral (só "sem par no sistema" gera).
- O sinal do valor vem só de `TRNAMT`; `TRNTYPE` (DEBIT/CREDIT) é guardado mas não usado para conferir o sinal.
- `desfazerImportacao` audita transação por transação (um INSERT de auditoria por linha): extrato com milhares de transações fica lento.
- A confirmação de "outra conta" compara com todos os extratos anteriores da conta: conta que recebe de propósito extratos de dois bancos pergunta em toda importação.
- Desfazer um extrato apaga também as transações que um extrato posterior sobreposto contou como "repetidas" (o posterior não guardou cópia própria). Para recuperá-las, reimporte o arquivo desfeito (se estava certo) ou desfaça também o posterior e reimporte os dois. No uso principal (arquivo da conta errada) os FITIDs não colidem.

### 8.6 Pendências da 6c (não bloqueiam)
- **Nada foi ligado de verdade.** Antes de contar com cada integração: preencher as variáveis no Railway, "Testar conexão" em Admin › Integrações e uma venda de teste conferida no Trello e no Drive. Prompt e esforço do chat (`medium`) e do Reescrever (`low`) nunca foram avaliados contra o modelo real: olhar as primeiras respostas quando a chave entrar.
- **Cartão ou pasta duplicados:** se o `POST` que cria o cartão do Trello ou a pasta-mãe do Drive der timeout depois de o serviço já ter criado, ou se a primeira gravação do resultado falhar no banco, a retomada cria outro (nenhum dos dois serviços tem chave de idempotência; fechar isso pediria procurar pelo nome antes de criar). Mesma janela, menor, para um item de checklist repetido.
- **`ANTHROPIC_API_KEY` real na shell desta máquina de desenvolvimento:** todo dev server sobe com `ANTHROPIC_API_KEY= npm run dev`, senão cada clique no chat ou no Reescrever é uma chamada cobrada. Os testes já forçam a variável vazia.
- **Chat sem limite de uso por pessoa** (nem por minuto nem por dia): o custo só aparece em `ia_usos`.
- O Next despacha as Server Actions de um mesmo navegador uma de cada vez: uma pergunta longa ao chat (até 3 min no pior caso) faz um salvar na página esperar. Um Route Handler para o chat resolveria.
- Ramos do chat sem teste automatizado: `pause_turn`, prazo total estourado, `tool_use` sem blocos. `resumo_da_viagem` sem a sequência só acha a viagem quando há um resultado.
- `processarDepois` (`after()` dentro de uma requisição) só foi exercitado no navegador pelo botão "Enviar para o Trello"; o teste automatizado cobre o caminho fora de requisição.
- **Primeiro uso real (checklist, nesta ordem):**
  1. Depois de preencher `ANTHROPIC_API_KEY`: "Testar conexão" da IA e **uma pergunta no chat** (ex.: "minhas tarefas"). O teste de conexão não manda ferramentas; só a pergunta valida o schema das 4 ferramentas no serviço real (um 400 em toda pergunta = schema recusado).
  2. **Trello:** "Testar conexão" e fechar **uma venda de teste**; conferir que o cartão chega na lista com o checklist "Tarefas da venda" e os 5 itens (os itens vão em `POST /1/checklists/<id>/checkItems` com corpo JSON, formato nunca exercitado contra o Trello real). Aprovar o roteiro da mesma viagem e conferir o checklist "Tarefas do roteiro".
  3. **Drive:** "Testar conexão" (só lê a pasta raiz) e uma venda de teste: a pasta-mãe com "Público" e "Uso interno" no drive compartilhado. Falha de escrita com o teste ok = a conta de serviço não é Editor do drive compartilhado.
  4. Conferir em `ia_usos` que os tokens são contados quando o fallback do servidor responde (o `modelo` gravado é o que respondeu; olhar uma recusa, se aparecer).
  5. **Railway cron:** criar os dois serviços com a imagem real (ex.: `curlimages/curl`) e o comando com `sh -c '…'` do README, e conferir no log do primeiro disparo um `200` com `{"gerados":…,"pulados":…}` / `{"enviados":…,"falhas":…}` (um 401 com o segredo certo = o comando rodou sem shell e mandou `$CRON_SECRET` literal).
- **Rulings da revisão final da 6c (para o Mateus conferir):** `max_tokens` 16000 no reescrever e no chat (com 4000 o pensamento podia comer o limite e a resposta cortava; custo: respostas longas custam mais, o "Testar conexão" segue com 256); `minhas_tarefas` e `dailies_da_semana` sem `strict: true` (ferramenta sem parâmetro não tem entrada a garantir e um schema vazio no modo estrito arriscava 400 em toda pergunta; custo: nenhum, o Zod confere o objeto vazio); `protegerTexto` também nos itens de checklist que vão ao Trello (texto livre das tarefas; aplicado ao montar o payload e de novo ao mandar; custo: um CPF ou telefone digitado na tarefa aparece como marcador no Trello); cron dos dailies gera hoje, hoje + 1 e hoje + 2 (idempotente, nunca sobrescreve texto; custo: um dia gerado antes de D-2 se o roteiro foi aprovado em cima da hora, o que a pessoa já podia fazer à mão); token do Google com 400/401 (`invalid_grant`) é `autenticacao` e vai direto a `falhou` (Reenviar depois de corrigir a credencial).
- `gravarEspera` (auditoria da espera pelo cartão): `antes.tentativas` mantido como as tentativas que o envio tinha antes da tomada (o teste da fila fixa esse valor de propósito); não mudou nesta rodada.
- No agendador, a reconferência de "roteiro aprovado" sob a trava (roteiro desaprovado entre a consulta e a transação) não tem teste próprio: a consulta dos candidatos já filtra.

### 8.7 Pendências menores da 5b (não bloqueiam)
- O aviso de **aniversário** continua aparecendo até o fim da viagem (o spec diz "durante a viagem"; depois do dia do aniversário ele ainda fica até a volta).
- **Barra de navegação no celular** (390 px) rola para o lado sem indício de que há mais itens; em `/avisos` a barra de baixo mostra a primeira área sem marcação. A barra do `Shell` já estourava a 390 antes da 5b.
- Seed: repete o corpo das actions de entrada, caixa e reembolso (as actions não rodam fora do Next; ver os rulings em §6); não limpa o que os testes de integração deixam no banco (`npx supabase db reset`, `npm run db:migrate` e o seed para começar limpo).
- Estoque: erro de fornecedor repetido sai no campo `fornecedor` (a tela mapeia); `aposEntrada` assume quantidade ≥ 1 (o schema garante); valores `bigint` passados direto ao componente de cliente; título do histórico com filtro.
- Caixa: uma recusa antiga pode reaparecer se o editor desmonta e volta; sufixo fixo "O rascunho ficou gravado" na recusa; "Descartar rascunho" sem confirmação; `caixaItensSchema` aceita lista vazia (a confirmação recusa).
- Núcleo: `alterarEmAbertoNa` não valida data e descrição (quem chama valida) e pode lançar `Desfazer`; `auditarAlteracao` existe em três lugares.
- Reembolsos: `?editar` e `?anexos` só resolvem na aba atual; o aviso de margem alterada depois da conciliação compara só `criado_em` do caso com `conciliada_em`; a lista de viagens do formulário vai até 500.
- Avisos: sem teste do `?setor=` para quem não é Diretor.
- Teste intermitente: `caixa-experiencia.test.ts` ("cancelar a confirmada… depois outra caixa pode ser montada") ordena as caixas por `criado_em` e falhou uma vez na suíte inteira (veio `rascunho` antes de `cancelada`); passou sozinho 4 vezes. Causa não confirmada: `criado_em` é o `now()` do início da transação e as duas transações rodam uma depois da outra, então a ordem não deveria inverter. Investigar.

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
npm run seed:local        # usuários (senha eclak-local), fornecedores, 31 clientes, orçamentos, vendas, financeiro, operação, conciliação e a 5b (estoque, caixas, reembolsos, comunicados)
npm run dev               # abrir em localhost (127.0.0.1 não fica interativo no dev)
```
- `.env.local` (não versionado): `DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SITE_URL` (ver `.env.example`). As variáveis das integrações (`CRON_SECRET`, `TRELLO_*`, `GOOGLE_*`, `ANTHROPIC_API_KEY`, `IA_MODELO`) ficam vazias em desenvolvimento; **nunca ponha credencial real no `.env.local`**. Se a shell exporta uma `ANTHROPIC_API_KEY`, suba com `ANTHROPIC_API_KEY= npm run dev`.
- Usuários do seed: `diretor@eclak.local`, `consultor@eclak.local`, `operacional@eclak.local`, `fin.operacional@eclak.local`, `fin.estrategico@eclak.local`, senha `eclak-local`.
- Testes: `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build` (uma execução de integração por vez: a trava do global setup recusa a segunda). Últimos números (23/11/2026, branch `claude/fatia-5a-operacao` integrada com `main` e a 4b): 363 testes de domínio (23 arquivos) e 425 de integração (26 arquivos), tudo verde, build ok, seed duas vezes sem duplicar. **A integração trunca o banco local**: rodar `npm run seed:local` depois.
- Números da 6b (24/11/2026, branch `claude/fatia-6b-conciliacao`, depois da revisão final): 464 testes de domínio (26 arquivos) e 473 de integração (28 arquivos), lint, typecheck e build ok, seed duas vezes sem duplicar (a segunda cria 0 transações de extrato); relatório "Conciliação extrato x sistema", importação de outra conta com confirmação e "Desfazer importação" conferidos no navegador.
- Números da 6c (24/11/2026, branch `claude/fatia-6c-integracoes`, depois da rodada de correções da revisão final): 554 testes de domínio (31 arquivos) e 660 de integração (35 arquivos), lint, typecheck e build ok (rotas `/api/cron/integracoes` e `/api/cron/dailies` dinâmicas), seed duas vezes sem duplicar. Nenhum teste chama serviço real: Trello e Drive contra `fetch` falso, IA contra provedor falso, `ANTHROPIC_API_KEY` forçada vazia.
- Números da 5b (25/11/2026, branch `claude/fatia-5b`, Task 15): 616 testes de domínio (34 arquivos) e 783 de integração (44 arquivos), lint e typecheck ok, seed duas vezes sem duplicar (contagens das tabelas da 5b, `lancamentos`, `viagens` e `auditoria` iguais depois da segunda). Na suíte inteira, 1 falha de asserção em `caixa-experiencia.test.ts` (ordem das caixas, que o teste lê por `criado_em`; causa não confirmada); o arquivo sozinho passou 4 vezes seguidas (13/13).
- Migração nova: `npm run db:generate` (gerada) ou `npx drizzle-kit generate --custom --name <nome>` (RLS, índices, enums); validar do zero (`npx supabase db reset` + `npm run db:migrate`) e sobre banco populado.
- Next gera `AGENTS.md` no dev: está no `.gitignore`.

## 10. Processo usado (para manter o padrão)

Cada fatia seguiu: conversa curta com o Mateus para decisões que mudam o código → plano em `docs/superpowers/plans/` (tarefas com testes primeiro, Global Constraints, Review Focus) → execução por subagentes (um implementador por tarefa, revisão de especificação e qualidade depois de cada tarefa, rodada de correção quando a revisão aponta algo) → revisão final da branch inteira no modelo mais forte → uma rodada única de correções → re-revisão → PR empilhado. Decisões tomadas sem o Mateus ficam registradas no plano e listadas para ele conferir. Os implementadores sempre verificaram no navegador com Playwright (`require('playwright')` funciona sem instalar) e rodaram as suítes antes de commitar.

Mensagens de commit em português, com as linhas de coautoria que o ambiente indicar.
