# Fatia 4b — Caixa: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Saldo das contas bancárias, fluxo de caixa (8 semanas + 12 meses) com a meta de reserva, anexos (Supabase Storage) em lançamentos e notas fiscais, e cartão corporativo com fatura mensal que vira uma linha só na lista única.

**Architecture:** Tudo sai da view `lancamentos_financeiros` da 4a (fonte única). A view ganha, no fim, colunas de caixa (`valor_caixa_previsto`, `valor_caixa_baixado`, `data_caixa`) e depois `fatura_cartao_id` + a origem `fatura_cartao`. A regra "o que entra/sai do banco" mora só na view; o domínio (`src/domain/caixa.ts`) faz as contas puras (semanas, meses, reserva, ciclo do cartão). Storage: bucket privado criado por migração, upload por Server Action com limite de corpo configurado, download por URL assinada curta. A baixa da fatura do cartão passa pelo núcleo de baixas da 4a (`src/server/financeiro/baixas-viagem.ts`), com o padrão do repasse: compras quitadas sem conta bancária e com vínculo; só a fatura mexe no banco.

**Tech Stack:** Next.js 16.4 App Router, React 19.3, Tailwind v4, Drizzle + drizzle-kit, Supabase (Postgres, Auth, Storage), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-22-fatia-4-financeiro-design.md` (§6.5, §7 "4b", §8, §9). Notas da 4a: `docs/superpowers/plans/2026-11-22-fatia-4a-lancamentos-faturas.md` › "Para a 4b". Contexto geral: `docs/HANDOFF.md`.

Referência visual e de regras (protótipo, só leitura): `/private/tmp/claude-501/-Users-mateusnascimentonogueiradasilva-orca-workspaces-eclak-sistema-seal/2fc14e22-6b4f-4b97-b7d7-702159fb45f5/scratchpad/ref/eclak-mockup/` — `src/app/fluxo-de-caixa/page.tsx`, `src/app/notas-fiscais/page.tsx`, `src/components/reserva-projecao.tsx`, `src/components/cash-chart.tsx`, `src/lib/calc.ts`.

## Global Constraints

- Dinheiro em `bigint` centavos; nenhuma conta de dinheiro em ponto flutuante (só a escala do gráfico, na borda); `arredondar` de `src/domain/decimal.ts` quando houver divisão.
- "Hoje" sempre `hojeEmCuiaba()`; datas ISO `AAAA-MM-DD`; semana começa na **segunda-feira**.
- Toda Server Action começa com `comPerfil([...PERFIS_FINANCEIRO], …)`; toda query chama `exigirPerfil([...PERFIS_FINANCEIRO])`. Consultor e Operacional recebem "Sem permissão".
- Auditoria (`registrarAuditoria` / `auditarAlteracao`) na mesma transação de toda alteração.
- Exclusão lógica: nada financeiro é apagado (cancelado/estornado/`excluido_em`). Anexo removido = `excluido_em` (o objeto no Storage fica).
- Toda tabela nova: `ENABLE ROW LEVEL SECURITY` em migração custom + entrada em `tests/integracao/rls.test.ts`.
- Valor novo de enum em migração própria (só o `ALTER TYPE … ADD VALUE`). CHECK alterado = DROP + ADD na mesma migração.
- View: só `CREATE OR REPLACE VIEW` numa migração nova; colunas novas **no fim**, mesma ordem e tipos das existentes; reaplicar `WITH (security_invoker = true)` e `REVOKE ALL ON "lancamentos_financeiros" FROM anon, authenticated;`; atualizar o `pgView(...).existing()` em `src/server/db/schema/financeiro.ts`.
- Escrita em dinheiro de viagem: `travarViagem` (várias viagens: ordem crescente de `viagem_id`), recusar viagem conciliada.
- Margem real (`src/domain/venda.ts`, `margemReal`) não é alterada por esta fatia.
- Marca: azul #2E5C71 dominante, laranja #F26531 só destaque, texto #333132, **sem vermelho** (negativo/atrasado em `ouro`), sem gradiente, sem emoji, sem estrelinha de IA. Textos pt-BR. Desktop 1440–1920.
- Anexo: só PDF, PNG ou JPEG, **até 10 MB**, conferidos no servidor pelos bytes iniciais (não pela extensão).
- Erros de banco logados só com o código.
- Testes de integração truncam o banco: rodar `npm run seed:local` no fim de cada tarefa que rodou integração.

## Review Focus

1. **Cartão contado duas vezes:** depois que compras entram numa fatura do cartão, os totais da lista, o saldo e o fluxo têm de dar exatamente o mesmo de antes (a fatura substitui as compras). Teste-invariante na Task 6.
2. **Taxa descontada duas vezes:** parcela comum entra no caixa pelo líquido (valor − taxa); o repasse do cartão direto já é líquido (a taxa dele é o que o fornecedor reteve). Teste na Task 2.
3. **Baixa da fatura do cartão com compra de viagem conciliada ou em outra viagem travada:** recusa inteira, nada gravado; ordem de travas crescente. Task 7.
4. **Anexo que não é PDF/imagem renomeado para .pdf, ou acima de 10 MB:** recusado no servidor; URL assinada só para quem tem perfil e só de anexo não excluído. Task 3.
5. **Vencidas em aberto:** entram na semana atual marcadas (não somem do fluxo nem ficam no passado). Task 1/2.

---

## Rulings desta fatia (Claude, para o Mateus conferir)

1. **Valor no caixa (decisão 12 do desenho):** parcela de cartão de crédito ou boleto entra pelo líquido (previsto − taxa prevista; recebido − taxa efetiva). Repasse já é líquido. Pix, comissões, lançamentos manuais e pagamentos: valor cheio. Crédito com antecipação (`vendas.forma->>'antecipado' = 'true'`): `data_caixa` = primeiro vencimento em aberto do cartão dessa venda.
2. **Saldo da conta** = saldo inicial + Σ entradas − Σ saídas com `baixado_em >= saldo_inicial_em`, só linhas `transita_caixa`. Baixas antigas sem conta bancária (anteriores à 4a) não entram em conta nenhuma.
3. **Fluxo:** base = saldo atual somado de todas as contas ativas; filtros (centro, viagem, tipo) filtram só os movimentos, não o saldo inicial. Tipos: Clientes (parcelas), Fornecedores (pagamentos de viagem), Comissões, Empresa (manuais fora de cartão), Cartão (faturas do cartão).
4. **Reserva:** meta = 6 × `custoFixoMensal` vigente (Parâmetros); "atingida em" = primeiro mês da projeção cujo saldo de fim de mês ≥ meta; senão "não atingida em 12 meses".
5. **Anexos** valem para qualquer linha da lista (manual, parcela, pagamento, comissão, fatura do cartão) e para notas fiscais: tabela `anexos` com `dono_tipo` + `dono_id` (sem FK; existência conferida na action).
6. **Upload** por Server Action com `serverActions.bodySizeLimit: "11mb"` em `next.config.ts` (o padrão é 1 MB; ver `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`). Download por URL assinada de 60 s gerada no servidor.
7. **Notas fiscais:** número, data de emissão, competência, valor, destinatário (texto, opcionalmente fornecedor ou cliente), CPF/CNPJ (validado), viagem opcional, observação, PDF anexo. Cancelar com motivo (não apaga). Colunas da PLANILHA NOTAS FISCAIS entram quando ela chegar.
8. **Cartão corporativo:** cadastro (nome, final de 4 dígitos, dia de fechamento 1–28, dia de vencimento 1–28, conta bancária de débito, centro de custo, ativo). Ciclo: compra com dia ≤ fechamento cai na fatura do mês; depois do fechamento, na do mês seguinte; vencimento = dia de vencimento do mês seguinte ao fechamento se o dia de vencimento ≤ dia de fechamento, senão do mesmo mês do fechamento.
9. **Compras:** lançamento manual a pagar com forma `cartao_credito` + cartão; pagamento a fornecedor de conta com forma `cartao_corporativo` + cartão (o cartão escolhido no `definirFormaFornecedor`; a data informada é a da compra). A fatura (`faturas_cartao`, uma por cartão e fechamento) nasce na primeira compra; compra em fatura já paga é recusada.
10. **Moeda estrangeira no cartão:** a compra estrangeira entra na fatura pelo previsto em reais; na baixa da fatura, o financeiro informa o valor em reais cobrado de cada compra estrangeira (com IOF); esse valor vira `valor_brl_pago` e o câmbio efetivo = valor em reais ÷ valor original (4 casas). Fatura com compra estrangeira exige baixa individual.
11. **Baixa da fatura do cartão:** uma saída no banco (conta de débito do cartão ou outra ativa) pelo total; compras de viagem ficam `pago` com `conta_bancaria_id` nulo e `fatura_cartao_id`; manuais ficam `baixado` com a conta da baixa da fatura, mas fora do caixa (a view as marca `transita_caixa = false`). Desfazer a baixa da fatura volta tudo.
12. `definirFormaFornecedor` recusa trocar a forma quando algum pagamento da conta está numa fatura do cartão paga ("Desfaça a baixa da fatura do cartão antes"); se a fatura está em aberto, as compras são desvinculadas e a fatura recalcula (fatura sem compras some da lista).

---

### Task 1: Domínio do caixa e do cartão

**Files:**
- Create: `src/domain/caixa.ts`
- Test: `tests/domain/caixa.test.ts`

**Interfaces:**
- Produces:
  - `type MovimentoCaixa = { data: string; valor: bigint; lado: "pagar" | "receber"; vencida: boolean; tipo: TipoCaixa }`
  - `const TIPOS_CAIXA = ["clientes", "fornecedores", "comissoes", "empresa", "cartao"] as const; type TipoCaixa`
  - `inicioDaSemana(data: string): string` (segunda-feira)
  - `projetarSemanas(saldoInicial: bigint, movimentos: MovimentoCaixa[], hoje: string, semanas = 8): PeriodoCaixa[]`
  - `projetarMeses(saldoInicial: bigint, movimentos: MovimentoCaixa[], hoje: string, meses = 12): PeriodoCaixa[]`
  - `type PeriodoCaixa = { inicio: string; fim: string; rotulo: string; entradas: bigint; saidas: bigint; saldoFinal: bigint; vencidas: bigint }`
  - `metaReserva(custoFixoMensal: bigint, meses = 6): bigint`
  - `situacaoReserva(saldoAtual: bigint, custoFixoMensal: bigint, projecaoMensal: PeriodoCaixa[]): { meta: bigint; temos: bigint; falta: bigint; atingidaEm: string | null }` (`falta` nunca negativo; `atingidaEm` = `rotulo` do mês)
  - `cicloDoCartao(dataCompra: string, diaFechamento: number, diaVencimento: number): { fechamento: string; vencimento: string }`

- [ ] **Step 1: Write the failing tests** em `tests/domain/caixa.test.ts`:
  - `inicioDaSemana("2026-11-23")` = `"2026-11-23"` (segunda); `inicioDaSemana("2026-11-29")` = `"2026-11-23"` (domingo).
  - `projetarSemanas(100000n, [{data:"2026-11-10", valor:5000n, lado:"pagar", vencida:true, tipo:"empresa"}, {data:"2026-11-25", valor:20000n, lado:"receber", vencida:false, tipo:"clientes"}, {data:"2026-12-02", valor:3000n, lado:"pagar", vencida:false, tipo:"fornecedores"}], "2026-11-23")`: 8 períodos; [0] = `{inicio:"2026-11-23", fim:"2026-11-29", entradas:20000n, saidas:5000n, vencidas:5000n, saldoFinal:115000n}`; [1].saldoFinal = 112000n; [7].saldoFinal = 112000n.
  - Movimento depois da última semana fica fora das semanas.
  - `projetarMeses` com os mesmos movimentos: 12 períodos; [0] = novembro/2026 (`inicio:"2026-11-01"`, `fim:"2026-11-30"`, rotulo `"nov/2026"`), vencida também no mês atual; [1] = `"dez/2026"` com saídas 3000n; saldo acumulado.
  - `metaReserva(2072593n)` = 12435558n.
  - `situacaoReserva(10000000n, 2072593n, meses)` com saldo final de algum mês ≥ meta → `atingidaEm` = rótulo desse mês; sem nenhum → `null`; `falta` = meta − temos (0 se temos ≥ meta).
  - `cicloDoCartao("2026-11-10", 15, 25)` → `{fechamento:"2026-11-15", vencimento:"2026-11-25"}`; `("2026-11-16", 15, 25)` → `{"2026-12-15","2026-12-25"}`; `("2026-11-10", 25, 5)` → `{"2026-11-25","2026-12-05"}`; `("2026-12-28", 25, 5)` → `{"2027-01-25","2027-02-05"}`.
  - Entradas inválidas (dia 0 ou 29, data inválida) lançam `Error`.

- [ ] **Step 2: Run** `npx vitest run tests/domain/caixa.test.ts` — FAIL (módulo não existe).
- [ ] **Step 3: Implement** em `src/domain/caixa.ts` reusando `somarMeses`/`lerData` existentes no domínio (procure em `src/domain/venda.ts` ou `src/domain/financeiro.ts` antes de escrever helpers de data). Rótulo do mês: `"jan".."dez"` + `/AAAA`; rótulo da semana: `"23/11 a 29/11"`.
- [ ] **Step 4: Run** `npx vitest run tests/domain/caixa.test.ts` — PASS; `npm test` verde.
- [ ] **Step 5: Commit** `feat: domínio do caixa (semanas, meses, reserva e ciclo do cartão)`.

---

### Task 2: Saldo das contas, fluxo de caixa e reserva (view + query + tela)

**Files:**
- Create: `drizzle/0026_view_caixa.sql` (custom: `npx drizzle-kit generate --custom --name view_caixa`)
- Modify: `src/server/db/schema/financeiro.ts` (view: 3 colunas no fim)
- Create: `src/server/queries/caixa.ts`
- Modify: `src/server/queries/financeiro.ts` (`listarContasBancarias` devolve `saldoAtual`)
- Create: `src/app/(app)/financeiro/caixa/page.tsx` (+ componentes locais, gráfico em SVG inline como `cash-chart.tsx`)
- Modify: `src/components/shell.tsx` (item "Fluxo de caixa" logo depois de "Lançamentos"), `src/app/(app)/financeiro/contas-bancarias/*` (coluna Saldo atual)
- Test: `tests/integracao/caixa.test.ts`

**Interfaces:**
- Consumes: Task 1 (`projetarSemanas`, `projetarMeses`, `situacaoReserva`, `TipoCaixa`); `regrasVigentes()` de `src/server/queries/regras.ts` (`custoFixoMensal`).
- Produces:
  - View: `valor_caixa_previsto bigint NOT NULL`, `valor_caixa_baixado bigint` (nulo se não baixado), `data_caixa date NOT NULL`. Drizzle: `valorCaixaPrevisto`, `valorCaixaBaixado`, `dataCaixa`.
  - `saldosDasContas(): Promise<{ contaId: string; nome: string; saldoAtual: bigint }[]>` (só ativas; exige perfil)
  - `obterFluxoDeCaixa(filtro: { centro?: Centro; viagemId?: string; tipo?: TipoCaixa }): Promise<{ hoje: string; saldoAtual: bigint; contas: …; semanas: PeriodoCaixa[]; meses: PeriodoCaixa[]; reserva: ReturnType<typeof situacaoReserva> }>`
  - `tipoCaixaDaLinha(origem: Origem, categoriaSistema: string | null): TipoCaixa` (em `src/domain/caixa.ts` se for puro).

- [ ] **Step 1: Failing integration tests** em `tests/integracao/caixa.test.ts` (fixtures `vendida`, `contaBancaria` de `tests/helpers/venda.ts`):
  - Parcela de cartão de crédito em aberto com taxa prevista T: `valorCaixaPrevisto = valorPrevisto − T`; recebida com taxa efetiva E: `valorCaixaBaixado = valorBaixado − E`.
  - Repasse do cartão direto (fixture `vendida({ cartao: "hotel" })`, repasse de esperado − 100,00): `valorCaixaBaixado = esperado − 10000n` (igual a `valorBaixado`; a taxa não é descontada de novo).
  - Pix, pagamento e lançamento manual: `valorCaixa* = valor*`.
  - Venda com crédito antecipado: todas as parcelas de cartão em aberto com `dataCaixa` = o primeiro vencimento delas.
  - Saldo: conta com saldo inicial 1.000,00 em D; manual a receber 300,00 baixado em D+1 nessa conta; manual a pagar 100,00 baixado em D−1 (antes da data do saldo inicial) → `saldoAtual = 130000n`; pagamento de fornecedor do cartão direto (`transita_caixa = false`) não muda o saldo.
  - `obterFluxoDeCaixa({})`: vencida em aberto aparece em `semanas[0].vencidas` e `meses[0]`; filtro `tipo: "clientes"` deixa só parcelas; `saldoAtual` não muda com o filtro.
  - Reserva com `custoFixoMensal` do seed das regras: `meta = 6 × custo`.
  - Consultor e operacional: `obterFluxoDeCaixa` e `saldosDasContas` lançam/recebem "Sem permissão" (o mesmo padrão dos testes de `listarLancamentos`).
- [ ] **Step 2: Run** `npx vitest run tests/integracao/caixa.test.ts` — FAIL.
- [ ] **Step 3: Migration 0026**: copiar a view inteira de `drizzle/0025_view_repasse_gravado.sql` e acrescentar as 3 colunas no fim de **cada** ramo do UNION. Regras (ruling 1): manual → previsto `valor`, baixado `valor_pago`, data `vencimento`; parcela comum (`meio` em `cartao_credito`, `boleto`) → previsto `valor − taxa_prevista`, baixado `valor_recebido − coalesce(taxa_efetiva, taxa_prevista)`; parcela `pix` → cheio; repasse → previsto = a coluna `valor_previsto` do ramo, baixado = a coluna `valor_baixado` do ramo (sem descontar taxa); data_caixa da parcela de crédito antecipado = `min(vencimento)` das parcelas `cartao_credito` em aberto da mesma venda (ou o próprio vencimento se não houver outra); pagamento e comissão → cheio, data = vencimento/prevista_para.
- [ ] **Step 4: Queries** em `src/server/queries/caixa.ts` (server-only, `exigirPerfil` primeiro). Saldo pela ruling 2, em SQL agregado sobre a view. Fluxo: linhas `status_base = 'em_aberto'` e `transita_caixa`, `MovimentoCaixa` com `valor = valor_caixa_previsto`, `data = data_caixa`, `vencida = data_caixa < hoje`; projeção pelo domínio.
- [ ] **Step 5: Tela** `/financeiro/caixa` (Server Component; filtros por `searchParams`, como a lista de lançamentos): cards Saldo atual (por conta, expansível), Reserva (meta, temos, falta, "atingida em …" — texto do `reserva-projecao.tsx`), gráfico de barras entradas/saídas + linha de saldo (SVG inline, cores da marca, negativo em `ouro`), tabela 8 semanas e tabela 12 meses (vencidas marcadas na primeira linha). Contas bancárias: coluna "Saldo atual".
- [ ] **Step 6: Run** a integração nova + `npm run test:integracao` + `npm run lint && npm run typecheck`; abrir a tela no navegador (Playwright, `require('playwright')`) com `fin.estrategico@eclak.local` / `eclak-local` depois de `npm run seed:local`.
- [ ] **Step 7: Commit** `feat: saldo das contas, fluxo de caixa e reserva`.

---

### Task 3: Storage e anexos

**Files:**
- Create: `drizzle/0027_anexos.sql` (gerada da tabela) e `drizzle/0028_anexos_rls_bucket.sql` (custom: RLS + bucket)
- Create: `src/server/db/schema/anexos.ts` (exportar em `src/server/db/schema/index.ts`)
- Create: `src/domain/anexos.ts` (tipos, limite, `tipoPelosBytes(bytes: Uint8Array): "application/pdf" | "image/png" | "image/jpeg" | null`)
- Create: `src/server/storage.ts` (server-only: cliente Supabase service role já existente em `src/server/supabase*` — procure e reuse; `BUCKET_ANEXOS = "anexos"`)
- Create: `src/server/actions/anexos.ts` (`enviarAnexo(formData: FormData)`, `removerAnexo(id: string)`, `linkDoAnexo(id: string): Promise<{ ok: true; url: string } | Falha>`)
- Create: `src/server/queries/anexos.ts` (`listarAnexos(donoTipo, donoId)`)
- Create: `src/components/anexos.tsx` (lista + enviar + abrir + remover; usado na edição do lançamento e no painel da linha da lista)
- Modify: `next.config.ts` (`experimental.serverActions.bodySizeLimit: "11mb"` — conferir o nome/posição exatos na doc local citada na ruling 6)
- Modify: `tests/integracao/rls.test.ts`, `tests/helpers/db.ts` (se `limparBanco` precisar limpar `anexos`)
- Test: `tests/domain/anexos.test.ts`, `tests/integracao/anexos.test.ts`

**Interfaces:**
- Produces:
  - Tabela `anexos`: `id uuid`, `dono_tipo text` (CHECK em `manual|parcela|pagamento|comissao|fatura_cartao|nota_fiscal`), `dono_id uuid`, `caminho text unique`, `nome text`, `mime text`, `tamanho integer` (CHECK 1..10485760), `enviado_por uuid → usuarios`, `enviado_em timestamptz default now()`, `excluido_em timestamptz`; índice `(dono_tipo, dono_id) WHERE excluido_em IS NULL`.
  - `type DonoAnexo = "manual" | "parcela" | "pagamento" | "comissao" | "fatura_cartao" | "nota_fiscal"` em `src/domain/anexos.ts`; `TAMANHO_MAXIMO_ANEXO = 10 * 1024 * 1024`.
  - `enviarAnexo` (FormData: `donoTipo`, `donoId`, `arquivo`): confere perfil, dono existente (`fatura_cartao` e `nota_fiscal` passam a existir nas Tasks 4–6: a checagem por tipo fica num `switch` com um caso por tabela; casos de tabelas que ainda não existem entram na task que as cria), tamanho, tipo pelos bytes; caminho = `${donoTipo}/${donoId}/${uuid}` (nome original só na coluna `nome`); sobe no Storage; grava a linha e auditoria na mesma transação (se a gravação falhar, remove o objeto).
  - `linkDoAnexo`: `createSignedUrl(caminho, 60)`; anexo excluído → "Anexo não encontrado".
- [ ] **Step 1: Bucket por migração** — verificar no Supabase local se `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES ('anexos','anexos', false, 10485760, ARRAY['application/pdf','image/png','image/jpeg']) ON CONFLICT (id) DO NOTHING;` roda pela `npm run db:migrate` (usuário do `DATABASE_URL`). Se roda: fica na 0028. Se não: criar o bucket no início de `src/server/storage.ts` (idempotente, `createBucket` com service role na primeira chamada) e anotar no README › Deploy. Nenhuma política em `storage.objects` (acesso só pelo service role no servidor).
- [ ] **Step 2: Failing tests:** domínio (`tipoPelosBytes` reconhece `%PDF-`, PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`; texto renomeado → `null`). Integração: envia PDF pequeno para um lançamento manual → linha em `anexos`, objeto existe no bucket, auditoria; `.txt` renomeado `.pdf` → "Envie um PDF, PNG ou JPEG"; 10 MB + 1 byte → "O arquivo passa de 10 MB"; dono inexistente → "Lançamento não encontrado"; `linkDoAnexo` devolve URL que baixa o mesmo conteúdo (fetch); removido → `linkDoAnexo` recusa e `listarAnexos` não mostra; consultor/operacional → "Sem permissão"; `anexos` no `rls.test.ts`.
- [ ] **Step 3: Implement** tabela, migrações, storage, actions, query, componente. Na lista de lançamentos, a linha mostra um indicador com a quantidade de anexos (uma consulta agregada por página, não uma por linha).
- [ ] **Step 4: Run** testes novos, `npm run test:integracao`, lint, typecheck, `npm run build` (a opção do next.config precisa passar no build); testar o envio no navegador.
- [ ] **Step 5: Commit** `feat: anexos em lançamentos (Supabase Storage)`.

---

### Task 4: Notas fiscais

**Files:**
- Create: `src/server/db/schema/notas-fiscais.ts`; migração gerada + custom (RLS)
- Create: `src/domain/notas-fiscais.ts` (schema Zod de entrada; reusar validação de CPF existente e acrescentar CNPJ se não houver — procure `cpf` em `src/domain/clientes.ts`)
- Create: `src/server/actions/notas-fiscais.ts` (`criarNotaFiscal`, `editarNotaFiscal`, `cancelarNotaFiscal(id, motivo)`)
- Create: `src/server/queries/notas-fiscais.ts` (`listarNotasFiscais({ de, ate, destinatario?, pagina })`, `obterNotaFiscal(id)`)
- Create: `src/app/(app)/financeiro/notas-fiscais/page.tsx` (+ formulário com anexos da Task 3, dono `nota_fiscal`)
- Modify: `src/server/actions/anexos.ts` (caso `nota_fiscal` no `switch`), `src/components/shell.tsx` (item "Notas fiscais"), `tests/integracao/rls.test.ts`
- Test: `tests/domain/notas-fiscais.test.ts`, `tests/integracao/notas-fiscais.test.ts`

**Interfaces:**
- Produces: tabela `notas_fiscais` (`id`, `numero text NOT NULL`, `emitida_em date`, `competencia text AAAA-MM`, `valor bigint > 0`, `destinatario text NOT NULL`, `documento text` (só dígitos, 11 ou 14), `fornecedor_id`/`cliente_id` opcionais (no máximo um), `viagem_id` opcional, `observacao`, `status` (`emitida|cancelada`), `motivo_cancelamento`, `criado_por`, `criado_em`); único `numero` entre as não canceladas.
- [ ] **Step 1: Failing tests:** domínio (CPF e CNPJ válidos/inválidos com máscara; competência; valor "1.234,56" → 123456n). Integração: criar → listar por período (por `emitida_em`) e por destinatário (sem acento, parcial); número repetido → "Já existe uma nota com este número"; cancelar exige motivo, nota cancelada fica na lista marcada e libera o número; anexar PDF à nota; perfis sem acesso; RLS.
- [ ] **Step 2–3: Implement** (padrão de `src/server/actions/financeiro.ts` para validação, auditoria e falhas de campo). Tela: lista com filtros, total do período, botão "Nova nota", painel lateral com formulário e anexos (layout do `notas-fiscais/page.tsx` do protótipo).
- [ ] **Step 4: Run** testes, lint, typecheck; navegador.
- [ ] **Step 5: Commit** `feat: notas fiscais com PDF anexo`.

---

### Task 5: Cartão corporativo — cadastro e compras

**Files:**
- Create: `src/server/db/schema/cartoes.ts` (`cartoes_corporativos`, `faturas_cartao`); colunas novas `lancamentos.cartao_id`, `lancamentos.fatura_cartao_id`, `pagamentos_fornecedor.cartao_id`, `pagamentos_fornecedor.fatura_cartao_id`; migrações gerada + custom (RLS, categoria de sistema `cartao_corporativo` no grupo "Despesas variáveis" do lado pagar — conferir o nome do grupo nas 27 categorias da 0020 — com DROP/ADD do CHECK `categorias_financeiras_sistema`)
- Modify: `src/domain/financeiro.ts` (`CATEGORIAS_SISTEMA` + `cartao_corporativo`)
- Create: `src/server/financeiro/cartoes.ts` (server-only: `vincularCompraNa(tx, …)`, `desvincularCompraNa(tx, …)`, `faturaDoCicloNa(tx, cartaoId, ciclo)` com `for update`)
- Create: `src/server/actions/cartoes.ts` (`criarCartao`, `editarCartao`, `desativarCartao`)
- Modify: `src/server/actions/financeiro.ts` (criar/editar lançamento manual a pagar com forma `cartao_credito` exige `cartaoId` ativo e vincula à fatura do ciclo; editar data/cartão revincula; cancelar desvincula)
- Modify: `src/domain/venda-entrada.ts` (`formaFornecedorSchema`, ramo `cartao_corporativo` ganha `cartaoId: uuid`), `src/server/actions/financeiro-viagem.ts` (`definirFormaFornecedor` grava `cartao_id` nos pagamentos e vincula; ruling 12), tela da viagem (select do cartão na forma "Cartão corporativo")
- Create: `src/app/(app)/financeiro/cartoes/page.tsx` (cadastro + faturas por cartão, com detalhe das compras)
- Modify: `src/components/shell.tsx` ("Cartões corporativos"), `tests/integracao/rls.test.ts`
- Test: `tests/integracao/cartoes.test.ts`

**Interfaces:**
- Consumes: `cicloDoCartao` (Task 1).
- Produces:
  - `cartoes_corporativos`: `id`, `nome`, `final char(4)` (4 dígitos), `dia_fechamento smallint 1..28`, `dia_vencimento smallint 1..28`, `conta_bancaria_id → contas_bancarias NOT NULL`, `centro centro_custo NOT NULL`, `ativo bool`.
  - `faturas_cartao`: `id`, `cartao_id`, `fechamento date`, `vencimento date`, `status status_lancamento default 'em_aberto'`, `pago_em date`, `valor_pago bigint`, `conta_bancaria_id`, único `(cartao_id, fechamento)`, CHECK de baixa como o de `lancamentos`.
  - Compra em fatura `baixado`: recusada com "A fatura do cartão deste período já foi paga".
- [ ] **Step 1: Failing tests:** cadastro (final com 3 dígitos recusado; dia 29 recusado; conta inativa recusada; perfis); lançamento manual com cartão: cria a fatura do ciclo certo (fechamento/vencimento pela ruling 8) e `fatura_cartao_id`; segunda compra no mesmo ciclo usa a mesma fatura; mudar a data para depois do fechamento move para a fatura seguinte; cancelar a compra desvincula; `definirFormaFornecedor` com `cartao_corporativo` + cartão vincula os pagamentos; trocar a forma de volta para à vista desvincula (fatura em aberto); auditoria em tudo.
- [ ] **Step 2–3: Implement.** Vínculo e desvínculo sempre dentro da transação da compra, travando a fatura (`for update`). Pagamento de viagem: dentro de `travarViagem`, como todo o `definirFormaFornecedor`.
- [ ] **Step 4: Run** testes, `npm run test:integracao` (os testes 3b de `definirFormaFornecedor` com cartão corporativo precisam do `cartaoId`: atualize-os e o seed `scripts/seed-vendas.ts` se usar essa forma), lint, typecheck.
- [ ] **Step 5: Commit** `feat: cartões corporativos e compras na fatura do mês`.

---

### Task 6: Fatura do cartão na lista única e no caixa

**Files:**
- Create: `drizzle/00NN_view_fatura_cartao.sql` (custom; número seguinte ao último existente)
- Modify: `src/domain/financeiro.ts` (`ORIGENS` + `fatura_cartao`; `rotuloForma` para ela: "Cartão de crédito"), `src/server/db/schema/financeiro.ts` (view: coluna `fatura_cartao_id uuid` no fim), `src/server/queries/financeiro.ts` (lista esconde linhas com `fatura_cartao_id` e mostra a linha da fatura; detalhe da fatura do cartão), `src/server/queries/caixa.ts` (tipo `cartao`), `src/domain/caixa.ts` (`tipoCaixaDaLinha`)
- Test: `tests/integracao/cartoes.test.ts` (novo bloco)

**Interfaces:**
- Produces:
  - Ramo novo do UNION `'fatura_cartao'`: `id` = fatura; lado `pagar`; vencimento = fatura; competência = `to_char(fechamento,'YYYY-MM')`; `valor_previsto` = Σ compras (manuais `valor` + pagamentos `valor_brl_previsto`, só não canceladas); `valor_baixado` = `valor_pago`; categoria `cartao_corporativo`; centro do cartão; conta = da baixa ou de débito do cartão; pessoa = `nome do cartão · final NNNN`; descrição `Fatura do cartão · <mês/ano>`; `transita_caixa` true; `exige_individual` = existe compra em moeda estrangeira; colunas de caixa = previsto/baixado/vencimento.
  - Nos ramos `manual` e `pagamento`: `fatura_cartao_id` da linha e `transita_caixa = false` quando vinculada.
  - Fatura sem compras não aparece.
- [ ] **Step 1: Failing test — invariante (Review Focus 1):** com saldo, duas compras manuais e uma compra de viagem num cartão, `listarLancamentos` totais (a pagar em aberto), `saldosDasContas` e `obterFluxoDeCaixa().meses` são iguais em valor antes de vincular (compras sem cartão, mesma data de vencimento da fatura) e depois (compras no cartão). E: a lista mostra 1 linha `fatura_cartao` com o total e nenhuma compra solta; margem real da viagem igual antes/depois.
- [ ] **Step 2–3: Implement** a migração (view inteira copiada da última, ramos alterados, ramo novo, colunas no fim) e as queries.
- [ ] **Step 4: Run** testes, `npm run test:integracao`, lint, typecheck.
- [ ] **Step 5: Commit** `feat: fatura do cartão como uma linha na lista e no caixa`.

---

### Task 7: Baixa da fatura do cartão

**Files:**
- Modify: `src/server/financeiro/baixas-viagem.ts` (ou novo `src/server/financeiro/fatura-cartao.ts` usando os helpers exportados dela): `baixarFaturaCartaoNa(tx, usuarioId, faturaId, dados)`, `desfazerFaturaCartaoNa(tx, usuarioId, faturaId)`; guarda nos núcleos existentes: pagamento/lançamento vinculado a fatura do cartão recusa baixa direta ("Compra no cartão corporativo: dê baixa na fatura do cartão")
- Create: `src/domain/financeiro-entrada.ts` (acrescentar `baixaFaturaCartaoSchema`: data, conta bancária, `estrangeiras: { pagamentoId, valorBrl }[]`)
- Modify: `src/server/actions/financeiro.ts` (`baixarLinha`/lote: origem `fatura_cartao`), `src/app/(app)/financeiro/lancamentos/baixa.tsx` (formulário da fatura com as compras estrangeiras), tela de cartões (detalhe com "Dar baixa" e "Desfazer baixa")
- Test: `tests/integracao/cartoes.test.ts` (novo bloco)

**Interfaces:**
- Consumes: `travarViagem`, `contaBancariaAtiva`, `auditarAlteracao`, `Desfazer`, `falha` de `src/server/financeiro/baixas-viagem.ts`.
- [ ] **Step 1: Failing tests:** baixa da fatura com compra manual + compra de viagem BRL → fatura `baixado` com `valor_pago` = total, manual `baixado` (conta da baixa, `transita_caixa` false), pagamento `pago` com `conta_bancaria_id` nulo, `valor_brl_pago` = previsto, `fatura_cartao_id` mantido; saldo cai só o total, uma vez; margem real da viagem = a de uma baixa direta pelo previsto; desfazer volta tudo (fatura, compras, saldo, margem); compra estrangeira sem `valorBrl` → recusa com campo; com `valorBrl` → câmbio efetivo = valorBrl ÷ original; viagem conciliada → recusa e nada gravado; duas viagens → travadas em ordem crescente (sem deadlock em teste com duas baixas concorrentes cruzadas, padrão dos testes de concorrência existentes); baixa direta de compra vinculada recusada pelos dois caminhos (viagem e lista); `definirFormaFornecedor` com fatura paga → "Desfaça a baixa da fatura do cartão antes"; lote com linha de fatura com estrangeira → recusa inteira ("baixa individual").
- [ ] **Step 2–3: Implement.** Ordem: travar a fatura (`for update`) → ler compras → travar viagens em ordem crescente → re-ler compras travadas → validar tudo → gravar → auditar.
- [ ] **Step 4: Run** testes, `npm run test:integracao`, lint, typecheck; navegador (baixa da fatura pela lista e pela tela de cartões).
- [ ] **Step 5: Commit** `feat: baixa da fatura do cartão corporativo`.

---

### Task 8: Seed local, README e HANDOFF

**Files:**
- Modify: `src/server/db/seed-financeiro-inicial.ts` ou `scripts/seed-local.ts` (um cartão corporativo com 3 compras no ciclo atual, uma nota fiscal sem anexo; idempotente)
- Modify: `README.md` (seção Financeiro: Fluxo de caixa, Reserva, Notas fiscais, Cartões corporativos, Anexos; Deploy: bucket `anexos` e `bodySizeLimit`), `docs/HANDOFF.md` (fatia 4b pronta, rulings desta fatia para conferir, números de testes, próximo passo = fatia 5 do desenho geral)
- [ ] **Step 1:** seed e `npm run seed:local` duas vezes seguidas (sem duplicar).
- [ ] **Step 2:** README e HANDOFF.
- [ ] **Step 3: Run** `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build && npm run seed:local`.
- [ ] **Step 4: Commit** `chore: seed, README e passagem de sessão da fatia 4b`.
