# Fatia 6b — Extrato OFX e conciliação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Valeska importa o OFX de cada conta bancária e concilia cada transação com as baixas do sistema (confirmar sugestão, escolher outra, criar lançamento, ignorar, desfazer), com relatório "Conciliação extrato x sistema" e aviso na Visão geral.

**Architecture:** Leitor OFX puro (`src/domain/ofx.ts`), regras de sugestão e situação puras (`src/domain/conciliacao.ts`), duas tabelas novas (`extratos`, `extrato_transacoes`) com RLS, núcleo server-only em `src/server/financeiro/conciliacao.ts`, Server Actions em `src/server/actions/conciliacao.ts`, query em `src/server/queries/conciliacao.ts`. A linha conciliada é apontada por `(linha_origem, linha_id)` da view `lancamentos_financeiros`, como os anexos.

**Tech Stack:** Next.js 16.4 (leia `node_modules/next/dist/docs` antes de página, action com arquivo ou route handler), Drizzle, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-fatia-6b-6c-design.md` §4 (6b) e §6 (rulings R-B1..R-B3). Contexto: `docs/HANDOFF.md`; 6a: `docs/superpowers/plans/2026-11-23-fatia-6a-paineis.md`.

**Branch:** `claude/fatia-6b-conciliacao`, a partir de `claude/fatia-6a-paineis` (PR #8 ainda aberto).

## Global Constraints

- Dinheiro em centavos `bigint` (sinal: entrada +, saída −); **nunca** `parseFloat`/`Number` em valor monetário; formatação com `formatarReais`.
- "Hoje" por `hojeEmCuiaba()`; datas ISO `AAAA-MM-DD`.
- Toda Server Action começa com `comPerfil(PERFIS_FINANCEIRO, …)` (diretor, fin_operacional, fin_estrategico); toda query com `exigirPerfil(...)`.
- Auditoria (`registrarAuditoria`) na mesma transação de toda escrita.
- Tabela nova: `ENABLE ROW LEVEL SECURITY` em migração custom e entrada em `tests/integracao/rls.test.ts`. Enum novo em migração própria. Migrações geradas depois da 0036 (`npm run db:generate`; custom com `npx drizzle-kit generate --custom --name <nome>`).
- Erros de banco logados só com o código.
- Marca: azul #2E5C71 dominante, laranja só destaque, texto #333132, **sem vermelho** (diferença/pendência em `ouro`), sem gradiente, sem emoji, sem estrelinha. Kit existente (`src/components/ui.tsx`, `kit.tsx`). pt-BR. Desktop 1440–1920.
- Arquivos OFX de teste são **sintéticos** (nomes e valores fictícios), em `tests/fixtures/ofx/`.
- Testes de integração só por `npm run test:integracao` (truncam o banco; depois `npm run seed:local`).
- Commits em português terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca `git stash` sem tag. Nunca `pkill` global.

## Decisões (do spec, valores exatos)

- Tolerância da sugestão: `DIAS_SUGESTAO = 3`; janela da escolha manual: `DIAS_ESCOLHA = 10`; aviso só para transação pendente com data < hoje − 3 dias (`DIAS_AVISO = 3`).
- Tamanho máximo do arquivo: `TAMANHO_MAXIMO_OFX = 5 * 1024 * 1024`.
- Situações gravadas: `pendente` | `conciliada` | `ignorada`. Situações exibidas (`SituacaoConciliacao`): `confere` | `diferenca` | `nao_conciliado` | `ignorado` | `baixa_mudou`. Rótulos: "Confere", "Diferença de R$ x" (x = |extrato − sistema|), "Não conciliado", "Ignorado", "A baixa mudou: confira".
- Candidata = linha da view com `status_base = 'baixado'`, `transita_caixa`, `conta_bancaria_id` = conta do extrato, sem transação `conciliada` apontando para ela. Valor da linha com sinal: `receber` → `+valor_caixa_baixado`, `pagar` → `−valor_caixa_baixado`; data = `baixado_em`.
- "A baixa mudou": transação `conciliada` cuja linha já não é candidata válida (não baixada, outra conta, ou o valor com sinal mudou de sinal). Diferença de valor numa linha ainda baixada é `diferenca`, não `baixa_mudou`.
- Criar lançamento a partir da transação: manual, `lado` pelo sinal, `valor = |valor|`, `vencimento = competencia(mês) = baixado_em = data`, conta = a do extrato, categoria escolhida (obrigatória, ativa, do lado certo), descrição = descrição do extrato (editável), já baixado; reusar o núcleo de criação/baixa de `src/server/actions/financeiro.ts` (extrair para `src/server/financeiro/` se for preciso chamá-lo de outra action) e conciliar na mesma transação.

## Review Focus

1. **Arquivo de banco brasileiro em SGML com `CHARSET:1252`** e descrição acentuada ("TARIFA BANCÁRIA", "PAGTO ÁGUA"): os acentos chegam certos. Teste de domínio na Task 1.
2. **Reimportar o mesmo extrato ou um extrato sobreposto** (mesmo mês baixado duas vezes, com FITIDs repetidos): nada duplica; o resumo conta as repetidas. Arquivo idêntico é recusado pelo hash com mensagem. Teste na Task 3.
3. **Duas baixas de mesmo valor perto da mesma data** (duas parcelas iguais): sem sugestão automática se o empate é exato na distância; nunca a mesma baixa em duas transações (índice único parcial). Testes nas Tasks 2 e 3.
4. **Fatura do cartão corporativo paga**: a linha `fatura_cartao` é candidata; as compras não. Teste na Task 3.
5. **Perfil errado** (consultor/operacional) em `/financeiro/conciliacao`, nas actions e no relatório: recusa. Teste na Task 3 e 5.

---

### Task 1: Leitor OFX

**Files:**
- Create: `src/domain/ofx.ts`, `tests/domain/ofx.test.ts`, `tests/fixtures/ofx/sgml-1252.ofx`, `tests/fixtures/ofx/xml-utf8.ofx`, `tests/fixtures/ofx/duas-contas.ofx`, `tests/fixtures/ofx/cartao.ofx`

**Interfaces:**
- Produces:
  - `type TransacaoOfx = { fitid: string; data: string; valor: bigint; tipo: string; descricao: string }`
  - `type ExtratoOfx = { banco: string | null; conta: string | null /* só os 4 últimos */; inicio: string | null; fim: string | null; transacoes: TransacaoOfx[] }`
  - `decodificarOfx(bytes: Uint8Array): string` (charset pelo cabeçalho; ver spec §4.2)
  - `lerOfx(texto: string): { ok: true; extrato: ExtratoOfx } | { ok: false; erro: string }`
  - `valorOfxEmCentavos(s: string): bigint | null` (aceita `-2862.49`, `-2862,49`, `+10`; um só separador decimal, no máximo 2 casas; separador de milhar não existe em OFX → `null`)
  - `dataOfx(s: string): string | null` (`20261103120000[-3:BRT]` → `2026-11-03`)
  - `TAMANHO_MAXIMO_OFX`

- [ ] **Step 1: Testes** — `valorOfxEmCentavos`: `"-2862.49"`→`-286249n`, `"-2862,49"`→`-286249n`, `"100"`→`10000n`, `"0.5"`→`50n`, `"1.234,56"`→`null`, `"abc"`→`null`, `"1.234"`→`null` (3 casas). `dataOfx`: `"20261103"`, `"20261103120000"`, `"20261103120000.000[-3:BRT]"` → `"2026-11-03"`; `"20261340"` → `null`. `lerOfx` em cada fixture: SGML 1252 (3 transações, uma com "TARIFA BANCÁRIA" lida de bytes 1252 via `decodificarOfx`; NAME+MEMO juntos com " · " quando diferentes; descrição cortada em 255), XML UTF-8 (2 transações, tags fechadas), `duas-contas` → `{ ok:false, erro:"O arquivo tem mais de uma conta. Baixe o extrato de uma conta por vez" }`, `cartao` (CCSTMTRS) → `{ ok:false, erro:"Extrato de cartão de crédito não é aceito aqui" }`, texto qualquer → `"O arquivo não parece um extrato OFX"`, transação sem FITID → `"Transação sem identificador (FITID) no extrato"`. Conta mascarada: `ACCTID 12345-6` → `"3456"` (4 últimos caracteres alfanuméricos).
- [ ] **Step 2: Rodar e ver falhar** — `npx vitest run tests/domain/ofx.test.ts`.
- [ ] **Step 3: Implementar** — leitura tolerante por regex de tags (`<TAG>valor` até `<` ou fim de linha), sem dependência nova.
- [ ] **Step 4: Passar** — mesmo comando, PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(conciliacao): leitor de extrato OFX (SGML e XML)`.

### Task 2: Tabelas e regras de conciliação

**Files:**
- Create: `src/server/db/schema/conciliacao.ts` (exportar em `schema/index.ts`), migrações (enum `situacao_extrato` em migração própria; tabelas geradas; custom com RLS, índice único parcial `(linha_origem, linha_id) WHERE situacao = 'conciliada'`, CHECKs de coerência: `conciliada` ⇔ `linha_origem/linha_id/conciliada_por/conciliada_em` não nulos; `ignorada` ⇔ `ignorada_motivo` não vazio), `src/domain/conciliacao.ts`, `tests/domain/conciliacao.test.ts`
- Modify: `tests/integracao/rls.test.ts`

**Interfaces:**
- Produces (domínio):
  - `SITUACOES_EXTRATO = ["pendente","conciliada","ignorada"] as const`
  - `type Candidata = { origem: Origem; id: string; data: string; valor: bigint /* com sinal */; pessoa: string; descricao: string }`
  - `sugerirPar(t: { data: string; valor: bigint }, candidatas: Candidata[]): Candidata | null` (mesmo valor, |dias| ≤ `DIAS_SUGESTAO`, a única mais próxima; empate na menor distância → null)
  - `opcoesDeEscolha(t, candidatas): Candidata[]` (|dias| ≤ `DIAS_ESCOLHA`, mesmo sinal, ordenadas por |Δvalor| e depois |Δdias|)
  - `situacaoExibida(t: { situacao; valor: bigint }, linha: { valor: bigint } | null /* null = não é mais candidata */): { tipo: SituacaoConciliacao; rotulo: string; diferenca: bigint }`
  - constantes `DIAS_SUGESTAO`, `DIAS_ESCOLHA`, `DIAS_AVISO`
- Tabelas: colunas do spec §4.1 (`extratos.arquivo_hash` único por `conta_bancaria_id`; `extrato_transacoes` único `(conta_bancaria_id, fitid)`; FKs `restrict`).

- [ ] **Step 1: Testes de domínio** — sugestão com 1 candidata a 2 dias → ela; a 4 dias → null; duas de mesmo valor a 1 e 2 dias → a de 1; duas a 1 dia → null; sinal diferente nunca; `situacaoExibida`: conciliada com valor igual → `confere`; com −286249 × −298176 → `diferenca`, rótulo `"Diferença de R$ 119,27"`; conciliada com linha null → `baixa_mudou`; pendente → `nao_conciliado`; ignorada → `ignorado`.
- [ ] **Step 2: Ver falhar; implementar; passar** (`npx vitest run tests/domain/conciliacao.test.ts`).
- [ ] **Step 3: Esquema e migrações** — gerar, revisar o SQL, `npx supabase db reset && npm run db:migrate` do zero; RLS em `rls.test.ts`.
- [ ] **Step 4: `npm run test:integracao`** (rls verde) e `npm run typecheck`.
- [ ] **Step 5: Commit** — `feat(conciliacao): tabelas do extrato e regras de sugestão`.

### Task 3: Importar e conciliar (servidor)

**Files:**
- Create: `src/server/financeiro/conciliacao.ts` (server-only), `src/server/actions/conciliacao.ts` ("use server"), `src/server/queries/conciliacao.ts`, `tests/integracao/conciliacao.test.ts`
- Modify (se preciso): `src/server/actions/financeiro.ts` (extrair núcleo de criar+baixar lançamento para `src/server/financeiro/`)

**Interfaces:**
- Actions (todas `comPerfil(PERFIS_FINANCEIRO)`; devolvem `{ ok: true, … } | { ok: false; erro: string; campos?: Record<string,string> }`):
  - `importarExtrato(form: FormData /* contaBancariaId, arquivo */): { ok: true; extratoId: string; novas: number; repetidas: number; inicio: string|null; fim: string|null }`. Recusas: conta inativa/inexistente; arquivo > 5 MB ("O arquivo passa de 5 MB"); mesmo hash na conta ("Este arquivo já foi importado nesta conta em dd/mm/aaaa"); erro do leitor.
  - `confirmarPar(transacaoId: string, origem: Origem, linhaId: string)` — valida que a linha é candidata para aquela transação (mesma conta, baixada, transita, não conciliada; janela `DIAS_ESCOLHA`); concilia. Conflito no índice único → "Esta baixa já está conciliada com outra transação".
  - `criarLancamentoDaTransacao(transacaoId: string, dados: { categoriaId: string; descricao: string; centro: … })`
  - `ignorarTransacao(transacaoId: string, motivo: string)` (motivo 3–200 caracteres)
  - `desfazerConciliacao(transacaoId: string)` (de `conciliada` ou `ignorada` volta a `pendente`)
  - Toda escrita trava a transação `for update`; audita `extratos`/`extrato_transacoes`.
- Query: `obterConciliacao({ contaBancariaId, de, ate, situacao? }): { conta; importacoes: …[]; linhas: { transacao; situacao: SituacaoExibida; linha: Candidata | null; sugestao: Candidata | null; opcoes: Candidata[] }[]; totais: Record<SituacaoConciliacao, { qtd: number; valor: bigint }> }` — `exigirPerfil(...PERFIS_FINANCEIRO)`; candidatas lidas da view em lote (uma consulta por pedido, janela de datas do período ± `DIAS_ESCOLHA`).
- `pendentesParaAviso(hoje: string): Promise<{ qtd: number; valor: bigint }>` (sem checagem de acesso; usada por `obterVisaoGeral`, que já checa).

- [ ] **Step 1: Testes de integração** (usar os helpers de `tests/helpers/`): importar SGML → 3 novas; reimportar o mesmo arquivo → recusa pelo hash; arquivo com 2 FITIDs repetidos e 1 novo → `novas: 1, repetidas: 2`; sugestão aparece para manual baixado de mesmo valor a 2 dias; `confirmarPar` concilia e audita; segunda transação na mesma baixa → recusa; parcela de viagem baixada é candidata (origem `parcela`); fatura de cartão paga é candidata e a compra no cartão não; `criarLancamentoDaTransacao` cria lançamento baixado na conta e concilia (aparece na lista única com `baixado_em` = data); `ignorarTransacao` sem motivo → erro de campo; `desfazerConciliacao`; desfazer a baixa da linha conciliada → `obterConciliacao` mostra `baixa_mudou`; consultor e operacional → `Sem permissão` em todas as actions e `ErroAcesso` na query.
- [ ] **Step 2: Ver falhar; implementar; passar** — `npm run test:integracao`.
- [ ] **Step 3: Commit** — `feat(conciliacao): importar OFX e conciliar com as baixas`.

### Task 4: Tela de conciliação

**Files:**
- Create: `src/app/(app)/financeiro/conciliacao/page.tsx` e componentes cliente ao lado (`envio.tsx`, `lista.tsx`)
- Modify: `src/components/shell.tsx` (item "Conciliação" em Financeiro, depois de "Contas bancárias")

**Interfaces:**
- Consumes: `obterConciliacao`, actions da Task 3, `listarContasBancarias`/categorias existentes.
- Página por `?conta=<id>&de=AAAA-MM-DD&ate=AAAA-MM-DD&situacao=`; padrão: primeira conta ativa, mês atual. Cabeçalho "Financeiro" / "Conciliação" / subtítulo "Confira o extrato do banco com as baixas do sistema." Totais por situação; tabela Data · Extrato (descrição) · Extrato (R$) · Sistema (linha, pessoa, R$) · Situação · Ações (Confirmar / Escolher outra / Criar lançamento / Ignorar / Desfazer). Envio do OFX com resumo do resultado. Histórico das importações (data, arquivo, período, novas, repetidas, quem).
- Sem conta bancária: estado vazio "Cadastre uma conta bancária para importar extratos" com link.

- [ ] **Step 1: Implementar** seguindo o padrão das telas de `src/app/(app)/financeiro/lancamentos/`.
- [ ] **Step 2: Verificar no navegador** com Playwright headless (`require('playwright')` ou o `playwright-core` da máquina) logado como `fin.operacional@eclak.local`: importar `tests/fixtures/ofx/sgml-1252.ofx` numa conta do seed, confirmar uma sugestão, ignorar uma, criar lançamento de uma tarifa; captura em 1440 px. Consultor recebe `/sem-acesso`.
- [ ] **Step 3: `npm run lint && npm run typecheck && npm run build`.**
- [ ] **Step 4: Commit** — `feat(conciliacao): tela de conciliação do extrato`.

### Task 5: Relatório, aviso, seed e documentação

**Files:**
- Modify: `src/domain/paineis.ts` (`RELATORIOS` ganha `conciliacao` "Conciliação extrato x sistema" / "Extrato OFX conferido com as baixas do sistema"; `CABECALHOS.conciliacao`; aviso tipo `conciliacao` em `ordenarAvisos` entre `pagar` e `aprovacao`, responsável Financeiro), `src/server/queries/paineis.ts` (`relatorioConciliacao`, aviso via `pendentesParaAviso`), `src/server/relatorios.ts`, `src/app/(app)/financeiro/relatorios/tabelas.tsx`, `scripts/seed-financeiro.ts` (ou um `scripts/seed-conciliacao.ts` chamado pelo `seed-local`: um extrato sintético idempotente numa conta do seed com 1 transação que confere, 1 com diferença, 1 tarifa pendente), `README.md`, `docs/HANDOFF.md`
- Test: `tests/domain/paineis.test.ts`, `tests/integracao/paineis.test.ts`

**Interfaces:**
- `relatorioConciliacao(intervalo: { de: string; ate: string }, contaBancariaId?: string)` → linhas `{ data, descricao, conta, valorExtrato, valorSistema | null, situacao: rotulo }` + totais por situação; CSV com as mesmas colunas (Data; Conta; Lançamento no extrato; Extrato (R$); Sistema (R$); Situação).
- Aviso: `{ tipo: "conciliacao", texto: "N transações do extrato sem par no sistema", valor, href: "/financeiro/conciliacao?situacao=nao_conciliado", responsavel: "Financeiro" }` só com pendentes de data < hoje − 3.

- [ ] **Step 1: Testes** — ordem dos avisos com `conciliacao` entre `pagar` e `aprovacao`; relatório de integração com as 3 transações do cenário (Confere / Diferença de R$ x / Não conciliado); CSV com BOM e `;`; consultor recusado no CSV (403).
- [ ] **Step 2: Implementar; passar** (`npm test`, `npm run test:integracao`).
- [ ] **Step 3: Seed** idempotente (rodar `npm run seed:local` duas vezes, sem duplicar).
- [ ] **Step 4: README** (seção "Conciliação do extrato": como importar, o que é guardado) e **HANDOFF** (linha da 6b na tabela de fatias, §5 "Fatia 6b", rulings R-B1..R-B3, migrações novas, números dos testes).
- [ ] **Step 5: Gate completo** `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build`; commit `feat(conciliacao): relatório, aviso na Visão geral, seed e documentação`.
