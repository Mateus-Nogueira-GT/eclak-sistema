# Fatia 6a — Painéis (Visão geral e Relatórios) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao Diretor e à gestão financeira a Visão geral (o que pede decisão hoje, caixa das próximas 8 semanas, números do período, reserva, viagens que perderam margem) e seis relatórios (DRE, Contas a pagar, Contas a receber, Volume por banco, Margem por viagem, Vendas por consultor) com exportação CSV e impressão.

**Architecture:** Só leitura, **sem migração e sem tabela nova**. Números de margem vêm de `margensVendidas` (`src/server/queries/vendas.ts`, domínio `margemReal`); dinheiro vem da view `lancamentos_financeiros`; caixa e reserva de `obterFluxoDeCaixa`. A montagem (períodos, DRE, avisos, agregações) é pura em `src/domain/paineis.ts`; as leituras ficam em `src/server/queries/paineis.ts`.

**Tech Stack:** Next.js 16.4 App Router (leia `node_modules/next/dist/docs` antes de escrever route handler ou página), React 19.3, Tailwind v4, Drizzle, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-23-fatia-6-paineis-integracoes-design.md` (§5 é a 6a). Desenho geral: `docs/superpowers/specs/2026-11-18-backend-sistema-real-design.md`. Contexto do projeto: `docs/HANDOFF.md`.

**Branch:** `claude/fatia-6a-paineis`, criada a partir de `claude/fatia-5a-operacao` (3bff5fb), porque o PR #7 (5a) ainda não foi mergeado. O PR da 6a terá base `claude/fatia-5a-operacao` até o #7 entrar.

## Global Constraints

- Dinheiro em centavos `bigint`; percentuais como string ("19.000"); formatação com `formatarReais` (`src/domain/dinheiro.ts`).
- "Hoje" sempre por `hojeEmCuiaba()` (`src/domain/clientes.ts`), fuso `America/Cuiaba`.
- Toda query começa com `exigirPerfil(...)` (`src/server/auth.ts`); nenhuma Server Action nova nesta fatia (se surgir, começa com `comPerfil`).
- Margem: **só** por `margensVendidas` / `margemReal` de `src/domain/venda.ts`. Proibido recalcular margem em SQL ou em TS novo.
- `/visao-geral`: perfis `diretor` e `fin_estrategico`. `/financeiro/relatorios` (e subrotas): `diretor`, `fin_operacional`, `fin_estrategico` (já cobertos pelo prefixo `/financeiro`). Consultor e Operacional: nada.
- Marca: azul #2E5C71 (`verde`/`petroleo` nos tokens) dominante; laranja #F26531 (`terracota`) só destaque; texto #333132; **sem vermelho** — número ruim, semana negativa e aviso em `ouro` (#D9A441); sem gradiente; sem emoji; sem ícone de estrelinha. Não existe token `alerta` neste repositório.
- Textos pt-BR, sem "Números de exemplo", sem tag "Fase 2", sem dado fictício do protótipo.
- Desktop 1440–1920 px; usar o kit existente (`src/components/ui.tsx`, `src/components/kit.tsx`).
- Testes de integração truncam o banco: rodar só por `npm run test:integracao`; depois `npm run seed:local`.
- Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca `git stash` sem tag. Nunca `pkill` global: parar só o próprio servidor pelo PID.

## Decisões (rulings do controlador, para o Mateus conferir)

- **R1 Período do vendido/margem/consultor:** `vendas.aceite_em` no período. *Se errado:* trocar o filtro em `paineis.ts` (um lugar).
- **R2 Recebido/pago/resultado de caixa/volume por banco:** `baixado_em` no período, `status_base = 'baixado'`, `transita_caixa`, valor = `valor_caixa_baixado` (líquido, mesma regra do fluxo de caixa). "Recebido de clientes" = origem `parcela`; "Pago a fornecedores" = origem `pagamento`. *Se errado:* a Valeska decide bruto × líquido; muda na view (4b), não aqui.
- **R3 DRE:** competência. Viagens no mês do aceite, valores de `margemReal` (`receita`, `custo`, `imposto`, `taxas`; **sem** `fixo`). Empresa: `origem = 'manual'`, `status_base <> 'cancelado'`, pela `competencia`, `valor_previsto`, por grupo › categoria; receita soma, despesa subtrai. Exclui origens `parcela`, `pagamento`, `comissao`, `fatura_cartao`. Viagem com margem em erro fica fora e é contada numa nota.
- **R4 Margem do período:** ponderada pela receita: Σ `final` ÷ Σ `receita` (real) e Σ `final` planejado ÷ Σ preço planejado (receita planejada = preço da versão). Diferença em pontos percentuais com uma casa.
- **R5 Valor vendido** de uma viagem = o mesmo número que a tela da viagem chama de "Vendido" (`obterViagemVendida(...).resumo.vendido` — o implementador confirma o campo e reutiliza a mesma fonte, sem fórmula nova).
- **R6 Avisos "Para decidir hoje":** spec §5.3, nesta ordem: caixa (semanas negativas das 8), margem abaixo de `margemReferenciaPct` vigente (viagens vendidas não conciliadas), parcelas de cliente vencidas, comissões vencidas, contas a pagar (fornecedor ou empresa) vencidas ou vencendo em até 7 dias, pedidos aguardando aprovação (só Diretor). No máximo 8 na tela + "e mais N avisos". Agregar por tipo quando houver muitas linhas do mesmo tipo (ex.: "5 parcelas de cliente vencidas, R$ x" com link para a lista filtrada) em vez de uma linha por parcela — uma linha por item só para caixa, margem e aprovações.
- **R7 Primeira tela:** `/visao-geral` passa a ser o primeiro item de `ROTAS_POR_PERFIL` de `diretor` e `fin_estrategico` (é para onde `/` redireciona e para onde o logo leva).
- **R8 Menu:** área "Gestão" ganha "Visão geral" (antes de "Aprovações"); área "Financeiro" ganha "Relatórios" (depois de "Fluxo de caixa").
- **R9 Exportação:** CSV UTF-8 com BOM, separador `;`, decimal com vírgula, sem separador de milhar, datas `dd/mm/aaaa`, por route handler `GET /financeiro/relatorios/planilha?rel=…&de=…&ate=…` com `exigirPerfil`. PDF = página `/financeiro/relatorios/imprimir?…` no padrão de `src/app/(app)/financeiro/faturas/[id]/imprimir/page.tsx` (o navegador imprime).
- **R10 Períodos da Visão geral:** `30d` (padrão), `90d`, `mes`, `mes_anterior`, `ano`, via `?periodo=`; período anterior de mesma duração (spec §5.1 vence a versão anterior deste ruling): `30d`/`90d` os dias logo antes; `mes` o mesmo trecho do mês anterior (1–23/11 → 1–23/10, dia limitado ao fim do mês); `ano` o mesmo trecho do ano anterior (1/1–23/11/2025); `mes_anterior` o mês inteiro antes dele; para a variação do vendido. Relatórios: `?de=AAAA-MM&ate=AAAA-MM` (padrão: mês atual; máximo 24 meses).

## Review Focus

1. **Dupla contagem na DRE** com cartão corporativo: uma compra manual no cartão (com `fatura_cartao_id`) entra uma vez pela categoria; a linha `fatura_cartao` não entra. Teste de integração na Task 4.
2. **Margem divergente da tela da viagem:** a margem real de uma viagem no relatório e na Visão geral é igual à de `obterViagemVendida(...).estrategico`. Teste na Task 2.
3. **Período sem dados** (mês sem venda, sem baixa, sem conta bancária): telas mostram zeros e frases vazias, sem divisão por zero (`finalPct` de receita 0, variação com período anterior 0 → "sem base de comparação"). Testes de domínio na Task 1.
4. **Perfil errado:** consultor/operacional/fin_operacional em `/visao-geral` → `/sem-acesso`; consultor/operacional em relatórios, CSV e impressão → recusa (o route handler devolve 403, não o CSV). Testes nas Tasks 2, 3 e 5.
5. **CSV abrindo no Excel pt-BR:** BOM, `;`, vírgula decimal, texto com `;` ou aspas escapado entre aspas. Teste de domínio na Task 1.

---

### Task 1: Domínio dos painéis

**Files:**
- Create: `src/domain/paineis.ts`
- Test: `tests/domain/paineis.test.ts`

**Interfaces:**
- Consumes: `hojeEmCuiaba` não (funções recebem `hoje: string`); `somarDias`, `somarMeses`, `lerData` de `src/domain/venda.ts`; `MargemReal`/`MargemPlanejada` de `src/domain/venda.ts`; `formatarReais` de `src/domain/dinheiro.ts`.
- Produces:
  - `type PeriodoPainel = "30d" | "90d" | "mes" | "mes_anterior" | "ano"`; `PERIODOS_PAINEL`; `ROTULO_PERIODO: Record<PeriodoPainel, string>`
  - `type Intervalo = { de: string; ate: string }` (datas ISO inclusivas)
  - `intervaloDoPeriodo(p: PeriodoPainel, hoje: string): Intervalo`; `intervaloAnterior(p: PeriodoPainel, atual: Intervalo): Intervalo`
  - `intervaloDeMeses(de: string /*AAAA-MM*/, ate: string): Intervalo` — lança `Error("Período inválido")` se `de > ate` ou mais de 24 meses
  - `variacaoPct(atual: bigint, anterior: bigint): string | null` (null se anterior = 0; uma casa, "12.5")
  - `margemPonderada(itens: { final: bigint; receita: bigint }[]): string | null` (null se Σ receita = 0; uma casa)
  - `type LinhaEmpresaDre = { lado: "pagar" | "receber"; grupo: string; categoria: string; categoriaId: string; valor: bigint }`
  - `type BlocoViagensDre = { receita: bigint; custo: bigint; imposto: bigint; taxas: bigint; semMargem: number }`
  - `type LinhaDre = { rotulo: string; valor: bigint; nivel: "total" | "grupo" | "categoria"; categoriaId?: string }`
  - `montarDre(viagens: BlocoViagensDre, empresa: LinhaEmpresaDre[]): { linhas: LinhaDre[]; resultado: bigint }`
  - `type Aviso = { tipo: "caixa" | "margem" | "parcela" | "comissao" | "pagar" | "aprovacao"; titulo: string; detalhe: string; href: string; responsavel: "Gestão" | "Financeiro" }`; `ordenarAvisos(avisos: Aviso[]): Aviso[]`; `RESPONSAVEL_AVISO`
  - `paraCsv(cabecalho: string[], linhas: (string | bigint | null)[][]): string` — bigint vira reais com vírgula ("1234,56", "-10,00"), null vira vazio

- [ ] **Step 1: Testes que falham** em `tests/domain/paineis.test.ts`:
  - `intervaloDoPeriodo("30d", "2026-11-23")` → `{ de: "2026-10-25", ate: "2026-11-23" }`; `"mes"` → `2026-11-01..2026-11-23`; `"mes_anterior"` → `2026-10-01..2026-10-31`; `"ano"` → `2026-01-01..2026-11-23`; `"90d"` → `de: "2026-08-26"`.
  - `intervaloAnterior("30d", {de:"2026-10-25",ate:"2026-11-23"})` → `{ de: "2026-09-25", ate: "2026-10-24" }`; `intervaloAnterior("mes", {de:"2026-11-01",ate:"2026-11-23"})` → `2026-10-01..2026-10-23`; `"ano"` → `2025-01-01..2025-11-23`; `"mes_anterior"` → o mês inteiro antes.
  - `intervaloDeMeses("2026-02","2026-02")` → `2026-02-01..2026-02-28`; `("2026-03","2026-01")` lança; `("2024-01","2026-01")` lança (25 meses).
  - `variacaoPct(1100n, 1000n)` → `"10.0"`; `(0n, 0n)` → `null`; `(500n, 1000n)` → `"-50.0"`.
  - `margemPonderada([{final:190n,receita:1000n},{final:10n,receita:1000n}])` → `"10.0"`; `([])` → `null`.
  - `montarDre`: viagens `{receita:100000n,custo:70000n,imposto:2100n,taxas:3000n,semMargem:0}` + empresa `[{lado:"pagar",grupo:"Despesas administrativas",categoria:"Aluguel",categoriaId:"a",valor:5000n},{lado:"pagar",grupo:"Despesas administrativas",categoria:"Internet",categoriaId:"b",valor:200n},{lado:"receber",grupo:"Outras receitas",categoria:"Rendimentos",categoriaId:"c",valor:300n}]` → linhas na ordem: "Receita de viagens" 100000, "(-) Custo dos fornecedores" -70000, "(=) Margem bruta" 30000, "(-) Imposto sobre a margem" -2100, "(-) Taxas financeiras" -3000, "(=) Margem das viagens" 24900, grupo "Outras receitas" 300 com categoria "Rendimentos" 300, grupo "Despesas administrativas" -5200 com "Aluguel" -5000 e "Internet" -200, "(=) Resultado do período" 20000; `resultado === 20000n`. Grupos de receita antes dos de despesa; dentro, alfabético.
  - `ordenarAvisos` põe caixa, margem, parcela, comissao, pagar, aprovacao nessa ordem, estável dentro do tipo.
  - `paraCsv(["Nome","Valor"], [["A; B", 123456n], ['Diz "oi"', -1000n], ["x", null]])` começa com `"﻿"`, linhas separadas por `"\r\n"`, e contém `"\"A; B\";1234,56"`, `"\"Diz \"\"oi\"\"\";-10,00"`, `"x;"`.
- [ ] **Step 2:** `npx vitest run tests/domain/paineis.test.ts` → FAIL (módulo não existe).
- [ ] **Step 3:** Implementar `src/domain/paineis.ts` (puro, sem I/O, sem `server-only`).
- [ ] **Step 4:** `npm test` → PASS; `npm run typecheck` → ok.
- [ ] **Step 5:** Commit `feat(paineis): domínio de períodos, DRE, avisos e CSV`.

### Task 2: Leituras da Visão geral

**Files:**
- Create: `src/server/queries/paineis.ts`
- Test: `tests/integracao/paineis.test.ts`
- Modify (se preciso, só para expor sem duplicar): `src/server/queries/caixa.ts`, `src/server/queries/vendas.ts`

**Interfaces:**
- Consumes: Task 1; `margensVendidas(ids)` (sem checagem de acesso — só depois de `exigirPerfil`); `obterFluxoDeCaixa({})`; `regrasVigentes()`; `listarPedidosAprovacao` (ou contagem equivalente) para o aviso de aprovação; `statusDaViagem`; view `lancamentosFinanceiros`.
- Produces:
  - `obterVisaoGeral(periodo: PeriodoPainel): Promise<VisaoGeral>` com `exigirPerfil("diretor", "fin_estrategico")`, onde `VisaoGeral = { hoje; intervalo: Intervalo; vendido: bigint; viagensVendidas: number; variacaoVendidoPct: string | null; margemRealPct: string | null; margemPlanejadaPct: string | null; recebido: bigint; pago: bigint; resultadoCaixa: bigint; semanas: PeriodoCaixa[] /* 8 */; primeiraNegativa: PeriodoCaixa | null; reserva: FluxoDeCaixa["reserva"]; avisos: Aviso[]; avisosRestantes: number; perdas: { viagemId; codigo; cliente; destino; vendido: bigint; planejadaPct: string; realPct: string; diferencaPp: string }[] /* até 6, maior perda primeiro, só não conciliadas */ ; margemReferenciaPct: string }`.
  - Helper interno reutilizável pela Task 4: `viagensVendidasNoIntervalo(i: Intervalo): Promise<{ viagemId; codigo; cliente; destino; consultorId; consultorNome; aceiteEm; vendido: bigint; margens: MargensVendida }[]>` (exportado, documentado "sem checagem de acesso").

- [ ] **Step 1: Testes de integração que falham** (montar dados como `tests/integracao/vendas.test.ts` e `caixa.test.ts` fazem; reutilizar os helpers de fábrica existentes):
  - Acesso: consultor, operacional e fin_operacional → `ErroAcesso`; diretor e fin_estrategico → ok.
  - Duas viagens vendidas com aceite no período e uma fora: `vendido` e `viagensVendidas` só das duas; `margemRealPct` = `margemPonderada` das margens reais dessas duas; **a margem real de cada viagem em `perdas` é igual a `obterViagemVendida(id).estrategico` (finalPct da real)**.
  - Uma parcela baixada no período (pix) e um pagamento a fornecedor baixado no período: `recebido`, `pago`, `resultadoCaixa` = recebido − pago; pagamento com forma `cartao_fornecedor` (não transita) não entra.
  - Parcela vencida em aberto gera aviso `parcela`; viagem com margem real abaixo da referência gera `margem`; pedido aguardando aprovação gera `aprovacao` só para o diretor (fin_estrategico não recebe).
  - Banco vazio (após truncate, só regras): tudo zero, `margemRealPct === null`, `avisos` vazio, sem exceção.
- [ ] **Step 2:** `npm run test:integracao -- paineis` (ou o padrão de filtro do script) → FAIL.
- [ ] **Step 3:** Implementar. Leituras em lote (uma `margensVendidas` para todas as viagens do intervalo e das não conciliadas); nada de N+1 por viagem.
- [ ] **Step 4:** `npm run test:integracao` → PASS; `npm run typecheck`, `npm run lint` → ok.
- [ ] **Step 5:** Commit `feat(paineis): leituras da visão geral`.

### Task 3: Tela Visão geral, acesso e menu

**Files:**
- Create: `src/app/(app)/visao-geral/page.tsx` (e componentes locais se preciso)
- Modify: `src/domain/perfis.ts` (R7), `src/components/shell.tsx` (R8), `tests/domain/perfis.test.ts`, `tests/domain/proxy-caminhos.test.ts` se cobrir rotas
- Referência visual: protótipo `eclak-mockup/src/app/visao-geral/page.tsx` (clonado em `$SCRATCH/ref`; o controlador passa o caminho)

**Interfaces:**
- Consumes: `obterVisaoGeral` (Task 2), `ROTULO_PERIODO`/`PERIODOS_PAINEL` (Task 1).

- [ ] **Step 1: Testes que falham:** em `perfis.test.ts`: `ROTAS_POR_PERFIL.diretor[0] === "/visao-geral"`, `ROTAS_POR_PERFIL.fin_estrategico[0] === "/visao-geral"`; `podeAcessar("fin_operacional", "/visao-geral") === false`, idem consultor e operacional; `podeAcessar("fin_operacional", "/financeiro/relatorios") === true`; `podeAcessar("consultor", "/financeiro/relatorios") === false`.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implementar `perfis.ts`, menu e a página. Página: `exigirPerfil` com redirect para `/sem-acesso` em `ErroAcesso` (padrão de `src/app/(app)/vendas/page.tsx`); `?periodo=` validado contra `PERIODOS_PAINEL` (inválido → `30d`); layout do protótipo (coluna principal com frase de topo + "Para decidir hoje"; lateral com "No período", rótulo do intervalo e do critério — "pelo aceite da venda", "pelas baixas no período" —, reserva com barra de progresso real de `reserva`; faixa das 8 semanas; tabela das perdas). Seletor de período por links (`?periodo=`), sem estado no cliente. Frase de topo: "O caixa fica negativo na semana de {rótulo}." ou "O caixa fica positivo nas próximas 8 semanas."; segunda frase sobre viagens abaixo da margem de referência. Cores ruins em `ouro`. Variação nula: "sem base de comparação". Links: avisos (href do aviso), "Abrir o fluxo de caixa" → `/financeiro/caixa`, "Ver todas as viagens" → `/viagens`, cada perda → `/viagens/{id}`.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` → ok. Smoke no navegador com o seed (`npm run seed:local`, diretor e fin_estrategico; consultor recebe `/sem-acesso`).
- [ ] **Step 5:** Commit `feat(paineis): tela visão geral e acesso`.

### Task 4: Leituras dos relatórios

**Files:**
- Modify: `src/server/queries/paineis.ts`
- Test: `tests/integracao/paineis.test.ts`

**Interfaces:**
- Consumes: Task 1, `viagensVendidasNoIntervalo` (Task 2), view `lancamentosFinanceiros`, `categoriasFinanceiras`, `contasBancarias`, `saldosDasContas` ou `saldoAtualSql`.
- Produces (todas com `exigirPerfil(...PERFIS_FINANCEIRO)`, recebem `Intervalo`):
  - `relatorioDre(i): Promise<{ linhas: LinhaDre[]; resultado: bigint; semMargem: { viagemId; codigo }[] }>` (R3)
  - `relatorioContas(lado: "pagar" | "receber", i): Promise<{ linhas: { origem; id; vencimento; pessoa; descricao; categoria; viagemId: string | null; viagemCodigo: string | null; valor: bigint; situacao: string }[]; totais: Record<string, bigint> }>` — vencimento no intervalo, não canceladas; `situacao` com os mesmos rótulos da lista única (reutilizar a função/SQL de situação da lista, não reescrever)
  - `relatorioBancos(i): Promise<{ contas: { contaId; nome; entradas: bigint; saidas: bigint; saldoPeriodo: bigint; saldoAtual: bigint }[]; total: { entradas; saidas; saldoPeriodo } }>` (R2)
  - `relatorioMargens(i, consultorId?: string): Promise<{ viagemId; codigo; cliente; destino; vendido; planejadaPct; realPct: string | null; diferencaPp: string | null; erro: string | null }[]>`
  - `relatorioConsultores(i): Promise<{ consultorId; nome; viagens: number; vendido: bigint; margemPct: string | null }[]>` + total
  - `type Relatorio = "dre" | "pagar" | "receber" | "bancos" | "margens" | "consultores"`; `RELATORIOS` com nome e descrição (texto do protótipo, sem o de conciliação)

- [ ] **Step 1: Testes de integração que falham:**
  - Acesso: consultor e operacional → `ErroAcesso` em cada relatório; fin_operacional → ok.
  - **DRE sem dupla contagem:** uma viagem vendida no mês (receita/custo/imposto/taxas iguais a `margemReal` dela, sem `fixo`); um lançamento manual de aluguel (pagar, competência do mês); uma compra manual no cartão corporativo (categoria "Combustível" ou outra de despesa, ligada a uma fatura de cartão) → a categoria aparece uma vez com o valor da compra e **nenhuma** linha corresponde ao total da `fatura_cartao`; um lançamento cancelado não entra; um lançamento de outra competência não entra; `resultado` = margem das viagens − aluguel − compra.
  - Contas a pagar: linha manual e conta de fornecedor de viagem no intervalo aparecem, com `viagemCodigo` na de viagem; cancelada não aparece; totais por situação batem com a soma.
  - Bancos: baixa de receber e de pagar em duas contas no intervalo → entradas/saídas por conta; baixa fora do intervalo não entra; `saldoAtual` igual a `saldosDasContas()`.
  - Margens e consultores: duas viagens de consultores diferentes; `realPct` de cada = `obterViagemVendida(...).estrategico`; consultores com `viagens` e `vendido` corretos; filtro por `consultorId` devolve só as dele.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar (agregações no SQL para lançamentos; margens por `viagensVendidasNoIntervalo`).
- [ ] **Step 4:** `npm run test:integracao`, `npm run typecheck`, `npm run lint` → ok.
- [ ] **Step 5:** Commit `feat(paineis): leituras dos relatórios`.

### Task 5: Tela Relatórios, CSV e impressão

**Files:**
- Create: `src/app/(app)/financeiro/relatorios/page.tsx`, `src/app/(app)/financeiro/relatorios/planilha/route.ts`, `src/app/(app)/financeiro/relatorios/imprimir/page.tsx`, componente compartilhado das tabelas (ex.: `src/app/(app)/financeiro/relatorios/tabelas.tsx`) usado pela tela e pela impressão
- Test: `tests/integracao/paineis.test.ts` (CSV) e/ou `tests/domain` se a montagem das linhas do CSV ficar pura
- Referência visual: protótipo `eclak-mockup/src/app/relatorios/page.tsx`

**Interfaces:**
- Consumes: Task 4, `paraCsv`, `intervaloDeMeses`.

- [ ] **Step 1: Testes que falham:** função pura `linhasCsv(rel: Relatorio, dados): { cabecalho; linhas }` (em `src/domain/paineis.ts` ou num módulo da rota) com um caso por relatório (cabeçalhos exatos em pt-BR iguais aos da tela); integração: o handler `GET` com sessão de consultor devolve 403 e sem corpo CSV; com fin_operacional devolve `content-type: text/csv; charset=utf-8`, `content-disposition: attachment; filename="relatorio-dre-2026-11.csv"` (padrão `relatorio-{rel}-{de}[_{ate}].csv`). Se o handler não for testável por integração no projeto, extrair `gerarCsv(rel, intervalo)` server-only testado com `comSessao` e deixar o handler fino.
- [ ] **Step 2:** rodar → FAIL.
- [ ] **Step 3:** Implementar. Tela: lista dos seis relatórios à esquerda (links `?rel=`), período por dois `<select>` de mês (`de`, `ate`) num `<form method="get">`, botões "Planilha" (link para o handler com os mesmos parâmetros) e "PDF" (link para `imprimir`, abre em nova aba). Período inválido → mês atual com aviso. Drill-down: categoria da DRE → `/financeiro/lancamentos?base=competencia&de=…&ate=…&categoriaId=…` (conferir os nomes reais de `filtroLancamentosSchema` em `src/domain/financeiro-entrada.ts`); linha com viagem → `/viagens/{id}`; conta bancária → lista com `contaBancariaId` e `base` da baixa; consultor → `?rel=margens&consultor=…`. Nota da DRE para viagens sem margem calculada. Rodapé: "Os relatórios seguem o nível de acesso de quem abre." (sem "Números de exemplo").
- [ ] **Step 4:** `npm test`, `npm run test:integracao`, `npm run typecheck`, `npm run lint`, `npm run build` → ok. Smoke no navegador: cada relatório abre, o CSV baixa e abre com acentos, a impressão mostra só a tabela.
- [ ] **Step 5:** Commit `feat(paineis): tela de relatórios, planilha e impressão`.

### Task 6: Seed, documentação e passada final

**Files:**
- Modify: `scripts/seed-*.ts` só se o seed atual não produzir dados para todos os painéis (vendas em meses diferentes, baixas no mês, compra no cartão, lançamento fixo) — preferir ajustar o seed existente a criar outro; `README.md` (telas novas), `docs/HANDOFF.md` (6a pronta, rulings R1–R10, perguntas do spec §8, 6b/6c)

- [ ] **Step 1:** `npm run seed:local` duas vezes (idempotente); abrir Visão geral e cada relatório com diretor, fin_operacional e fin_estrategico; consultor e operacional recebem `/sem-acesso`.
- [ ] **Step 2:** Atualizar README e HANDOFF.
- [ ] **Step 3:** Gate completo: `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build` → ok; `npm run seed:local` no fim.
- [ ] **Step 4:** Commit `docs: fatia 6a no README e no HANDOFF`.

## Para a 6b e a 6c

Ver spec §6 e §7. A 6b acrescenta o relatório de conciliação e o aviso de "pagamento não conciliado" na lista de `RELATORIOS` e em `ordenarAvisos` (tipo novo `conciliacao`, entre `pagar` e `aprovacao`).
