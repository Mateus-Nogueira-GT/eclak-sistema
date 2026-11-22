# Fatia 4a (Lançamentos e faturas) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lista única de lançamentos a pagar e a receber no padrão Conta Azul (lançamentos manuais + parcelas, pagamentos e comissões das viagens, sem duplicar), com baixa individual e em lote compartilhada com a tela da viagem, categorias em dois níveis, contas bancárias e faturas numeradas a partir de 1405.

**Architecture:** Tabela nova `lancamentos` só para o que é lançado à mão; uma **view** `lancamentos_financeiros` une as quatro fontes no formato de linha único (a regra de "o que entra, com que categoria, centro e se transita pelo caixa" mora só nela). As baixas de linhas de viagem usam o **mesmo núcleo** das actions da 3b, extraído para um módulo que recebe a transação. Faturas com contador de uma linha travado na transação e retrato fixo por emissão.

**Tech Stack:** o das fatias anteriores (Next.js 16.4, React 19.3, Drizzle, Supabase local, Zod, Vitest, Tailwind v4).

**Spec:** `docs/superpowers/specs/2026-11-22-fatia-4-financeiro-design.md` (§6.1–6.4, §6.6, §7 "4a", §9). Protótipo (`eclak-mockup`): `src/app/contas/page.tsx` (lista, formulário com abas Dados/Detalhes/Anexos, card "Categorias financeiras", `categoriasIniciais`, `formas`), `src/app/faturas/page.tsx` ("Vendas para faturar", "Emitir fatura", cronograma). HANDOFF em `main:docs/HANDOFF.md` §4 (convenções).

## Decisões desta fatia

Do Mateus (22/11/2026): padrão Conta Azul (retorno da Valeska); abordagem A; sem importação; OFX na fatia 6; fatura começa em **1405**; cartão direto no fornecedor pela regra (a) (spec §6.1); desenho aprovado.

Do Claude (spec §9, já listadas ao Mateus): fatura numerada na emissão pelo financeiro; reemissão com mesmo número e retrato fixo; centro de custo = filial da viagem; conta bancária obrigatória em toda baixa nova; "Forma a definir" com vencimento no início da viagem; lote recusado inteiro; telas só para Diretor e financeiros; categorias iniciais por migração.

Novas neste plano (conferir):
- **Repasse do cartão direto no fornecedor:** a baixa da linha "Repasse de <fornecedor>" pede data, **valor repassado** e conta bancária. Na mesma transação: baixa a parcela com `valorRecebido = valor da parcela` (o cliente pagou tudo) e `taxaEfetiva = repasse esperado − valor repassado` (o que o fornecedor reteve vira taxa da forma, que a margem real já trata), e baixa os pagamentos em aberto desse fornecedor na viagem pelo previsto, com `conta_bancaria_id` nulo e data igual. Repasse esperado = parcela − Σ (pago em BRL se pago, senão previsto) das contas ativas desse fornecedor. Valor repassado maior que o esperado é recusado ("O repasse é maior que o esperado: atualize o previsto das contas do fornecedor na viagem"). Pagamento em aberto em moeda estrangeira desse fornecedor recusa ("Dê baixa no pagamento em moeda estrangeira na viagem antes do repasse").
- **Comissão:** categoria "Comissões de operadora" quando o fornecedor tem o tipo "Operadora"; senão "Comissões de hotel".
- **Lote** aceita parcelas de cartão de crédito com a taxa prevista como efetiva.
- **Contas bancárias** ficam em Financeiro › Contas bancárias (não em Admin, que é só do Diretor).

## Global Constraints

- Todas as das fatias 1–3b: dinheiro `bigint` centavos; percentuais string; `arredondar` meio para cima; repartição truncada com a última absorvendo; "hoje" = `hojeEmCuiaba()`; datas `AAAA-MM-DD`, competência `AAAA-MM`; **toda Server Action começa com `comPerfil(...)`**, **toda query com `exigirPerfil(...)`**; auditoria (`registrarAuditoria`) na mesma transação de toda escrita; lançamento nunca apagado (cancelado); erros de banco logados só com o código.
- Toda tabela nova: `ENABLE ROW LEVEL SECURITY` numa migração custom e entrada em `tests/integracao/rls.test.ts`. A view: `WITH (security_invoker = true)` **e** `REVOKE ALL ... FROM anon, authenticated`; testada no `rls.test.ts`.
- Valor novo de enum existente em migração própria (só o `ALTER TYPE … ADD VALUE`). Enums novos podem nascer com a tabela.
- Escrita em dinheiro de viagem: `travarViagem(tx, viagemId)` antes; várias viagens na mesma transação → travar em ordem crescente de `viagem_id`, antes de qualquer outra escrita.
- Perfis das telas e actions desta fatia: `PERFIS_FINANCEIRO` = `diretor`, `fin_operacional`, `fin_estrategico` (já existe em `financeiro-viagem.ts`; mover para `src/domain/perfis.ts` e reexportar). Exceção: `fecharVenda` continua com consultor/operacional/diretor.
- Marca: azul #2E5C71 (`verde` no tema) dominante; laranja só destaque; **Vencida em tom `ouro`, nunca vermelho**; sem gradiente, sem emoji, sem estrelinha. Textos pt-BR. Desktop 1440–1920.
- Formas de pagamento (texto exato, nesta ordem): A prazo, Boleto bancário, Cartão de crédito, Cartão de débito, Débito em conta, Depósito bancário, Dinheiro, PIX, Transferência.
- Centro de custo: `MT` (filial Rondonópolis) e `RS` (filial RS).

## Review Focus

1. **Duas emissões de fatura ao mesmo tempo** (vendas diferentes) → números consecutivos (1405, 1406), nenhum repetido; emissão que falha depois de ler o contador não consome número. Teste em Task 7.
2. **A mesma parcela baixada pela lista e pela tela da viagem ao mesmo tempo** → uma baixa só; a outra recebe "Parcela já recebida". Teste em Task 6.
3. **Lote com uma linha que não pode entrar no meio** (pagamento em EUR, ou já baixada por outra pessoa) → nada gravado, resposta lista as linhas. Teste em Task 6.
4. **Parcelamento/recorrência a partir de 31/01 e de 29/02** e valor que não divide (R$ 100,00 em 3 → 33,33 / 33,33 / 33,34) → datas no último dia do mês, soma exata. Teste em Task 1.
5. **"Esta e as próximas" com parcelas já baixadas no meio** → só as em aberto a partir desta mudam; baixadas e canceladas intactas. Teste em Task 3.

---

## Estrutura de arquivos

```
src/domain/financeiro.ts                 formas, centros, lados, parcelamento, recorrência, centroDaFilial, situação (rótulos)
src/domain/financeiro-entrada.ts         Zod: lançamento, baixa, cancelamento, categoria, conta bancária, filtro, lote, repasse
src/domain/perfis.ts                     + PERFIS_FINANCEIRO, rotas /financeiro
src/server/db/schema/financeiro.ts       categorias_financeiras, contas_bancarias, lancamentos, faturas, faturas_versoes, faturas_contador, view lancamentosFinanceiros (.existing())
src/server/db/schema/vendas.ts           + vendas.fornecedor_cartao_id; conta_bancaria_id em parcelas_receber, pagamentos_fornecedor, comissoes
drizzle/0019_*.sql (gerada), 0020_financeiro.sql (custom: RLS, seeds de categorias e contador, índices), 0021_view_lancamentos.sql (custom)
src/server/financeiro/baixas-viagem.ts   núcleo das baixas da 3b (recebe tx; sem "use server")
src/server/actions/financeiro-viagem.ts  actions da 3b passam a chamar o núcleo
src/server/actions/financeiro.ts         categorias, contas bancárias, lançamentos, lote, repasse, fornecedor do cartão
src/server/actions/faturas.ts            emitir, reemitir, próximo número
src/server/queries/financeiro.ts         listarLancamentos, categorias, contas bancárias
src/server/queries/faturas.ts            vendasParaFaturar, listarFaturas, obterFatura
src/app/(app)/financeiro/lancamentos/…   lista única (abas, filtros, totais, seleção, formulário, baixa, lote)
src/app/(app)/financeiro/faturas/…       vendas para faturar, faturas, impressão
src/app/(app)/financeiro/categorias/…    categorias em dois níveis
src/app/(app)/financeiro/contas-bancarias/…
src/app/(app)/viagens/[id]/viagem-vendida.tsx  conta bancária nas baixas, Cancelar parcela, fornecedor do cartão
src/components/shell.tsx                 área "Financeiro"
scripts/seed-financeiro.ts               seed local
tests/domain/financeiro.test.ts, financeiro-entrada.test.ts
tests/integracao/financeiro.test.ts, lancamentos-lista.test.ts, faturas.test.ts (+ ajustes em financeiro-viagem.test.ts, vendas.test.ts, rls.test.ts)
tests/helpers/venda.ts                   fixture `vendida()` extraída de financeiro-viagem.test.ts
```

---

### Task 1: Domínio do financeiro

**Files:** Create `src/domain/financeiro.ts`, `src/domain/financeiro-entrada.ts`; Modify `src/domain/perfis.ts`; Test `tests/domain/financeiro.test.ts`, `tests/domain/financeiro-entrada.test.ts`, `tests/domain/perfis.test.ts`

**Interfaces (Produces):**
- `FORMAS_FINANCEIRO` (as 9 formas, texto exato da Global Constraints) `as const`; `LADOS = ["pagar","receber"] as const`; `CENTROS = ["MT","RS"] as const`; `centroDaFilial(f: Filial): Centro` (Rondonópolis→MT, RS→RS).
- `ORIGENS = ["manual","parcela","pagamento","comissao"] as const` (tipo da linha da view).
- `SITUACOES = ["vencida","vence_hoje","a_vencer","baixada","cancelada"] as const` e `rotuloSituacao(s, lado)` → "Vencida", "Vence hoje", "A vencer", "Paga"/"Recebida", "Cancelada". (O cálculo da situação mora na view/query, não aqui.)
- `dividirEmParcelas(total: bigint, n: number, primeiro: string): { numero: number; total: number; vencimento: string; valor: bigint }[]` — mensal, mesmo dia ou último do mês, truncado, última absorve. Reusar `cronogramaRecebimento` de `src/domain/venda.ts` (mesma regra) em vez de reescrever.
- `datasRecorrentes(primeiro: string, frequencia: "semanal"|"mensal"|"anual", quantidade: number): string[]` — mensal/anual: dia original (ou último do mês, sem "deslizar": 31/01 → 28/02 → 31/03); semanal: +7 dias.
- `competenciaDe(data: string): string` (`AAAA-MM`).
- `PERFIS_FINANCEIRO = ["diretor","fin_operacional","fin_estrategico"] as const` em `perfis.ts`; `ROTAS_POR_PERFIL` ganha `"/financeiro"` nesses três.
- `financeiro-entrada.ts` (Zod, mensagens pt-BR, reusar `reais`, `data`, `texto` de `venda-entrada.ts` exportando-os se preciso):
  - `lancamentoSchema`: `{ lado; descricao (1–200); fornecedorId?|clienteId?|pessoaTexto? (no máximo um); categoriaId uuid; centro; competencia AAAA-MM; emissao; vencimento; valor > 0; forma ∈ FORMAS_FINANCEIRO; contaBancariaId?; observacao? (≤2000); repeticao: { tipo: "unica" } | { tipo: "parcelado"; parcelas: 2–60 } | { tipo: "recorrente"; frequencia; quantidade: 2–60 } }`.
  - `baixaLancamentoSchema(hoje)`: `{ data (≤ hoje); valorPago > 0; juros? ≥ 0; desconto? ≥ 0; contaBancariaId uuid; observacao? }`.
  - `loteSchema(hoje)`: `{ itens: { origem: "manual"|"parcela"|"pagamento"|"comissao"; id: uuid }[] (1–200, sem repetidos); data; contaBancariaId }`.
  - `repasseSchema(hoje)`: `{ data; valorRepassado ≥ 0; contaBancariaId }`.
  - `categoriaSchema`, `contaBancariaSchema` (`{ nome 1–80; banco? ≤80; saldoInicial (pode ser negativo, "-1.234,56"); saldoInicialEm }`), `filtroLancamentosSchema` (`{ lado: "pagar"|"receber"|"todos"; de; ate; base: "vencimento"|"competencia"|"baixa"; situacao?; categoriaId?; grupo?; centro?; contaBancariaId?; origem?: "viagem"|"manual"; busca? ≤100; pagina ≥1 }`).

- [ ] **Step 1: Testes que falham** (`tests/domain/financeiro.test.ts`)
  - `dividirEmParcelas(10000n, 3, "2027-01-31")` → valores `[3333n, 3333n, 3334n]`, vencimentos `["2027-01-31","2027-02-28","2027-03-31"]`, `numero/total` 1/3…3/3.
  - `dividirEmParcelas(100n, 60, "2028-02-29")` → soma 100n, nenhum negativo, 13º vencimento "2029-02-28".
  - `datasRecorrentes("2027-01-31","mensal",4)` → `["2027-01-31","2027-02-28","2027-03-31","2027-04-30"]`; `("2028-02-29","anual",2)` → `["2028-02-29","2029-02-28"]`; `("2026-12-28","semanal",2)` → `["2026-12-28","2027-01-04"]`.
  - `centroDaFilial("Rondonópolis") === "MT"`, `("RS") === "RS"`; `competenciaDe("2026-11-22") === "2026-11"`.
  - `rotuloSituacao("baixada","pagar") === "Paga"`, `("baixada","receber") === "Recebida"`.
- [ ] **Step 2: Testes de entrada** (`tests/domain/financeiro-entrada.test.ts`): lançamento com fornecedor **e** cliente → erro no campo `pessoa` ("Escolha só um: fornecedor, cliente ou nome"); valor "0,00" → "Informe um valor maior que zero"; parcelado com 61 → erro; competência "2026-13" → erro; baixa com data amanhã → "A data não pode ser futura"; lote com item repetido → "Linha repetida no lote"; forma "Cheque" → "Forma de pagamento inválida".
- [ ] **Step 3: `tests/domain/perfis.test.ts`**: `podeAcessar("fin_operacional","/financeiro/lancamentos")` true; `podeAcessar("consultor","/financeiro/faturas")` false; `podeAcessar("operacional","/financeiro")` false.
- [ ] **Step 4:** `npm test -- financeiro perfis` → FAIL.
- [ ] **Step 5:** Implementar.
- [ ] **Step 6:** `npm test` → PASS (todos os de domínio).
- [ ] **Step 7:** Commit `feat: domínio do financeiro (parcelamento, recorrência, entradas)`.

---

### Task 2: Esquema, migrações, RLS e menu

**Files:** Create `src/server/db/schema/financeiro.ts`, `drizzle/0019_*.sql` (gerada), `drizzle/0020_financeiro.sql`, `drizzle/0021_view_lancamentos.sql`; Modify `src/server/db/schema/index.ts`, `src/server/db/schema/vendas.ts`, `src/components/shell.tsx`, `src/proxy.ts` (só se o mapa não cobrir `/financeiro/*`), `tests/integracao/rls.test.ts`, `tests/helpers/db.ts`, `tests/domain/proxy-caminhos.test.ts`; Test `tests/integracao/financeiro-schema.test.ts`

**Interfaces (Produces):**
- `categoriasFinanceiras`: `id uuid; lado lado_financeiro; grupo text; nome text; ativa bool default true; sistema text null` (`"vendas_viagem" | "fornecedores_viagem" | "comissoes_hotel" | "comissoes_operadora"`, único quando não nulo); único `(lado, grupo, nome)`.
- `contasBancarias`: `id; nome (único entre ativas); banco null; saldoInicial bigint; saldoInicialEm date; ativa bool; excluidoEm`.
- `lancamentos`: `id; lado; descricao; fornecedorId null FK; clienteId null FK; pessoaTexto null; categoriaId FK; centro centro_custo; competencia text (check `^\d{4}-(0[1-9]|1[0-2])$`); emissao date; vencimento date; valor bigint (>0); forma forma_financeiro (enum das 9, com os textos exatos como rótulo no domínio e valores slug: `a_prazo, boleto, cartao_credito, cartao_debito, debito_conta, deposito, dinheiro, pix, transferencia`); contaBancariaId null FK; observacao null; grupoId uuid null; parcelaNumero int null; parcelaTotal int null; status status_lancamento (`em_aberto|baixado|cancelado`) default em_aberto; baixadoEm date null; valorPago bigint null; juros bigint null; desconto bigint null; baixaContaBancariaId null FK; motivoCancelamento null; criadoPor; criadoEm`. Check: no máximo uma de fornecedor/cliente/pessoaTexto; baixado ⇔ baixadoEm/valorPago/baixaContaBancariaId não nulos. Índices: `(vencimento) where status='em_aberto'`, `(grupoId)`, `(categoriaId)`.
- `faturasContador`: `id smallint pk check (id = 1); proximo int not null check (proximo >= 1)`.
- `faturas`: `id; vendaId FK único; numero int único; emitidaEm timestamptz; emitidaPor FK`.
- `faturasVersoes`: `id; faturaId FK; versao int; emitidaEm; emitidaPor; dados jsonb` (`{ nome; documento; codigoViagem; destino; inicio; fim; total: string; forma: string; parcelas: { numero; total; vencimento; valor: string }[] }`, centavos como string); único `(faturaId, versao)`.
- `vendas.fornecedorCartaoId` uuid null FK fornecedores; `pagamentosFornecedor.repasseParcelaId` uuid null FK parcelas_receber; `parcelasReceber.contaBancariaId`, `pagamentosFornecedor.contaBancariaId`, `comissoes.contaBancariaId` uuid null FK.
- View `lancamentos_financeiros` (colunas): `origem` (ORIGENS), `id` (da linha de origem), `lado`, `vencimento date`, `competencia text`, `valor_previsto bigint`, `valor_baixado bigint null`, `baixado_em date null`, `status_base` (`em_aberto|baixado|cancelado`), `categoria_id`, `centro`, `conta_bancaria_id null`, `pessoa text`, `descricao text`, `parcela_numero null`, `parcela_total null`, `viagem_id null`, `viagem_codigo null`, `fatura_numero null`, `transita_caixa bool`, `taxa bigint` (0 fora das parcelas), `forma text`, `exige_individual bool`, `repasse bool`. Regras (spec §6.1):
  - manual: os campos do lançamento.
  - parcela: lado receber; categoria `sistema='vendas_viagem'`; centro pela filial da viagem; pessoa = `vendas.fatura_nome`; competência = mês do vencimento; `status_base` de `status_parcela` (recebida→baixado, cancelada→cancelado); `valor_baixado` = `valor_recebido` (bruto, como no Conta Azul); coluna `taxa` = taxa efetiva se recebida, senão taxa prevista (o líquido do caixa, spec §6.3, é calculado na 4b com ela); **cartão direto no fornecedor**: `repasse = true`, descrição "Repasse de <fornecedor>", `valor_previsto` = parcela − Σ contas ativas do `fornecedor_cartao_id` (pago BRL ou previsto); sem `fornecedor_cartao_id` → descrição "Repasse: escolha o fornecedor na viagem", `exige_individual = true`.
  - pagamento: lado pagar; categoria `fornecedores_viagem`; pessoa = fornecedor; `valor_previsto` = `valor_brl_previsto`; `exige_individual` quando a moeda da conta ≠ BRL; da conta excluída → cancelado; pagamentos de contas do `fornecedor_cartao_id` em venda `cartao_fornecedor` → `transita_caixa = false`, descrição com sufixo " (pago pelo cliente no cartão do fornecedor)".
  - comissao (só `comissoes`, todas são a receber): categoria `comissoes_operadora` se o fornecedor tem tipo "Operadora", senão `comissoes_hotel`; vencimento = `prevista_para`; não recebida → cancelado.
  - Todas as de viagem: `fatura_numero` = número da fatura da venda, se houver; aéreo incluso (é saída de caixa).
  - `forma` (texto) das linhas de viagem: parcela = rótulo de `ROTULO_MEIO` da 3b (Boleto bancário → "Boleto", PIX, Cartão de crédito, Cartão direto no fornecedor — usar os rótulos existentes); pagamento = rótulo da forma ao fornecedor (À vista, Parcelado, Cartão corporativo); comissão = "Transferência".
  - `fornecedor_id` nulo (ex.: aéreo sem fornecedor): pessoa = descrição da conta; comissão sem fornecedor → `comissoes_hotel`.
  - Status: conta `cancelada` **ou** `excluido_em` preenchido → seus pagamentos em aberto saem como cancelado; comissão `nao_recebida` ou `cancelada` → cancelado.
  - Não existe conta sem pagamento: `fecharVenda` cria o pagamento à vista de toda conta e `definirFormaFornecedor` troca as linhas na mesma transação (conferido em `src/server/actions/vendas.ts`).
- Shell: área "Financeiro" com Lançamentos (`/financeiro/lancamentos`), Faturas, Categorias, Contas bancárias.

- [ ] **Step 1: Teste que falha** `tests/integracao/financeiro-schema.test.ts`: depois de `limparBanco()`, existem as categorias do protótipo (`categoriasIniciais` de `eclak-mockup/src/app/contas/page.tsx`, 27 linhas) com as quatro `sistema` preenchidas (Vendas de viagem, Fornecedores de viagem, Comissões de hotel, Comissões de operadora); `faturas_contador.proximo = 1405`; inserir segunda linha no contador falha; lançamento com fornecedor e cliente juntos falha na check. Ajustar `limparBanco` (tests/helpers/db.ts) para, depois de truncar, **reinserir** as categorias iniciais e o contador em 1405 (mesmos dados da 0020, importados de um único módulo `src/server/db/seed-financeiro-inicial.ts` que a migração replica literalmente; teste confere que os dois coincidem).
- [ ] **Step 1b: Testes da view** (no mesmo arquivo, com `vendida()` — por isso a extração da fixture para `tests/helpers/venda.ts` acontece **aqui**, não na Task 4): `select` direto da view para uma viagem vendida (boleto 2x) + 2 lançamentos manuais → 2 parcelas + 1 pagamento por conta + 1 comissão + 2 manuais, nenhum `(origem, id)` repetido; parcela com categoria `vendas_viagem`, centro da filial da viagem, `pessoa` = nome da fatura; pagamento em EUR com `exige_individual`; aéreo sem fornecedor com pessoa = descrição; pagamento de conta excluída como cancelado.
- [ ] **Step 2: `rls.test.ts`**: acrescentar as seis tabelas e a view `lancamentos_financeiros` (anon não lê).
- [ ] **Step 3:** `npm run test:integracao -- financeiro-schema rls` → FAIL.
- [ ] **Step 4:** Schema Drizzle + `npm run db:generate` (0019); `npx drizzle-kit generate --custom --name financeiro` (0020: RLS das seis tabelas, `INSERT` das categorias e do contador 1405); `--custom --name view_lancamentos` (0021: `CREATE VIEW ... WITH (security_invoker = true)`, `REVOKE ALL ON lancamentos_financeiros FROM anon, authenticated`). No Drizzle, `pgView("lancamentos_financeiros", {...}).existing()`.
- [ ] **Step 5:** Validar do zero (`npx supabase db reset && npm run db:migrate`) e sobre banco populado (`npm run seed:local` antes de migrar).
- [ ] **Step 6:** Shell com a área Financeiro (só aparece para quem `podeAcessar`). Testes: `tests/domain/proxy-caminhos.test.ts` — consultor e operacional em `/financeiro/lancamentos` são bloqueados como nas outras rotas; `fin_estrategico` passa.
- [ ] **Step 7:** `npm run typecheck && npm test && npm run test:integracao -- financeiro-schema rls` → PASS.
- [ ] **Step 8:** Commit `feat: esquema do financeiro, view da lista única e RLS`.

---

### Task 3: Categorias, contas bancárias e lançamentos manuais

**Files:** Create `src/server/actions/financeiro.ts`, `src/server/queries/financeiro.ts`, `src/app/(app)/financeiro/categorias/*`, `src/app/(app)/financeiro/contas-bancarias/*`; Test `tests/integracao/financeiro.test.ts`

**Interfaces:**
- Consumes: Task 1 (schemas, `dividirEmParcelas`, `datasRecorrentes`), Task 2 (tabelas).
- Produces (todas `comPerfil([...PERFIS_FINANCEIRO])`, retorno `{ ok: true; id? } | Falha` no padrão de `financeiro-viagem.ts`):
  - `salvarCategoria(dados, id?)`, `alternarCategoria(id, ativa)` — categoria `sistema` pode ser renomeada, não desativada nem trocar de lado ("Categoria usada pelas viagens: não pode ser desativada").
  - `salvarContaBancaria(dados, id?)`, `desativarContaBancaria(id)`.
  - `criarLancamento(dados): { ok: true; ids: string[] }` — única/parcelada/recorrente; parcelado divide o valor; recorrente repete o valor; todos com o mesmo `grupoId`, `parcelaNumero/Total`; descrição recebe o mesmo texto (o "n/N" é coluna).
  - `editarLancamento(id, dados, alcance: "esta" | "proximas")` — "proximas" = mesmo `grupoId`, `parcelaNumero >= ` o desta, `status = em_aberto`; recusa lançamento baixado ("Desfaça a baixa para editar") ou cancelado. Edição de valor no parcelado não redistribui as outras.
  - `baixarLancamento(id, dados)`; `desfazerBaixaLancamento(id)`; `cancelarLancamento(id, motivo, alcance)`. Baixa: `valorPago ≠ valor + juros − desconto` exige observação ("Explique a diferença do valor pago"). Linhas travadas com `for update`.
  - Queries (`exigirPerfil(...PERFIS_FINANCEIRO)`): `listarCategorias(lado?)` (agrupadas), `listarContasBancarias({ ativas? })`.
  - Auditoria em toda escrita (`registrarAuditoria`).

- [ ] **Step 1: Testes que falham** (`tests/integracao/financeiro.test.ts`):
  - parcelado R$ 1.000,00 em 3 a partir de 31/01/2027 → 3 linhas 333,33/333,33/333,34, vencimentos 31/01, 28/02, 31/03, mesmo `grupoId`.
  - recorrente mensal R$ 4.200,00 × 12 → 12 linhas de 420000n.
  - **Review Focus 5:** recorrente de 6; baixar a 3ª; cancelar a 5ª; editar a 2ª com "proximas" (valor 500,00) → 2ª, 4ª e 6ª com 50000n; 1ª, 3ª (baixada) e 5ª (cancelada) intactas.
  - baixa com data futura → erro de campo; baixa com valor diferente sem observação → "Explique a diferença do valor pago"; desfazer volta a `em_aberto` e zera os campos da baixa; auditoria com antes/depois.
  - consultor chamando `criarLancamento`, `baixarLancamento`, `salvarCategoria` → `{ ok: false, erro: "Sem permissão" }` e nada gravado; consultor chamando `listarCategorias` lança `ErroAcesso`.
  - desativar categoria `sistema` → recusado.
- [ ] **Step 2:** `npm run test:integracao -- tests/integracao/financeiro.test.ts` → FAIL.
- [ ] **Step 3:** Implementar actions e queries.
- [ ] **Step 4:** Telas Categorias (card do protótipo "Categorias financeiras": abas pagar/receber, grupos com suas categorias, adicionar, renomear, ativar/desativar) e Contas bancárias (lista + formulário).
- [ ] **Step 5:** Testes PASS; `npm run lint && npm run typecheck`.
- [ ] **Step 6:** Verificar no navegador (Playwright): criar categoria, conta bancária. Commit `feat: categorias, contas bancárias e lançamentos manuais`.

---

### Task 4: Núcleo compartilhado das baixas da viagem

**Files:** Create `src/server/financeiro/baixas-viagem.ts`; Modify `src/server/actions/financeiro-viagem.ts`, `src/domain/venda-entrada.ts`, `src/app/(app)/viagens/[id]/viagem-vendida.tsx`, `tests/integracao/financeiro-viagem.test.ts`

**Interfaces:**
- Produces (módulo `import "server-only"`, **sem** `"use server"`, como `trava-viagem.ts`):
  - `baixarParcelaNa(tx, usuarioId, parcelaId, dados: BaixaParcelaValidada): Promise<Ok | Falha>`, `baixarPagamentoNa(tx, usuarioId, pagamentoId, dados)`, `registrarComissaoNa(tx, usuarioId, comissaoId, dados)` — cada um descobre a viagem, chama `travarViagem` (reentrante na mesma transação), checa vendida/não conciliada, grava, audita. Os três **retornam** `Falha` (nunca lançam por regra de negócio); a action individual devolve a falha, e o lote lança `Desfazer(falha)` para desfazer a transação inteira.
  - As actions `baixarParcela`, `baixarPagamento`, `registrarComissao` (e os "desfazer") passam a ser `comPerfil` + parse + `db.transaction(tx => núcleo)` + `revalidar`.
  - `baixaParcelaSchema`, `baixaPagamentoSchema`, `comissaoRecebidaSchema` ganham `contaBancariaId` **obrigatório** (uuid de conta bancária ativa; inexistente/inativa → "Escolha a conta bancária"). O núcleo grava `conta_bancaria_id`.
  - `baixarParcela` **acrescenta** a observação à existente (separador `"\n"`) em vez de sobrescrever; `desfazerBaixaParcela` mantém a observação de cancelamento/histórico (só limpa os campos da baixa).
  - Tela da viagem: campo "Conta bancária" (select de `listarContasBancarias({ ativas: true })`) nas três baixas; botão **"Cancelar parcela"** na aba Entradas (parcela em aberto; pede motivo; chama `cancelarParcela`, que já existe).
  - `tests/helpers/venda.ts` (criado na Task 2) ganha `contaBancaria(uid): Promise<string>`.

- [ ] **Step 1:** Extrair o núcleo sem mudar comportamento; `npm run test:integracao -- financeiro-viagem vendas` → PASS (refatoração pura).
- [ ] **Step 2: Testes que falham:** baixa de parcela sem `contaBancariaId` → erro de campo "Escolha a conta bancária"; com conta → `parcelas_receber.conta_bancaria_id` gravado; observação acrescentada (baixar com "A", desfazer, baixar com "B" → contém "B" e o motivo anterior se houver); margem real idêntica à de antes para o mesmo cenário (comparar `estrategico()` do teste existente).
- [ ] **Step 3:** Atualizar os testes existentes da 3b para passar a conta bancária (constantes `BAIXA_PARCELA`, `BAIXA_PAGAMENTO` e as da comissão).
- [ ] **Step 4:** Implementar o núcleo e religar as actions; tela da viagem.
- [ ] **Step 5:** `npm run test:integracao` (suíte inteira) → PASS; os 179 da 3b continuam verdes.
- [ ] **Step 6:** Navegador: baixar parcela na viagem com conta bancária; cancelar parcela. Commit `refactor: núcleo compartilhado das baixas da viagem e conta bancária obrigatória`.

---

### Task 5: Cartão direto no fornecedor (regra a)

**Files:** Modify `src/domain/venda-entrada.ts` (`fechamentoSchema`), `src/server/actions/vendas.ts`, `src/app/(app)/vendas/painel.tsx`, `src/server/actions/financeiro.ts`, `src/app/(app)/viagens/[id]/viagem-vendida.tsx`; Test `tests/integracao/vendas.test.ts`, `tests/integracao/financeiro.test.ts`

**Interfaces:**
- Consumes: Task 4 (`baixarParcelaNa`, `baixarPagamentoNa`), Task 2 (`vendas.fornecedorCartaoId`).
- Produces:
  - `fechamentoSchema` ganha `fornecedorCartaoId?: uuid`; `fecharVenda` exige quando a forma é `cartao_fornecedor` e o fornecedor tem conta ativa na viagem ("Escolha o fornecedor que recebeu no cartão"); ignora nas outras formas.
  - `definirFornecedorCartao(viagemId, fornecedorId)` (`PERFIS_FINANCEIRO`), para vendas antigas; recusa se a parcela já foi baixada.
  - `baixarRepasse(parcelaId, dados: RepasseEntrada)` (`PERFIS_FINANCEIRO`): regra da seção "Decisões" (taxa efetiva = esperado − repassado, baixa dos pagamentos do fornecedor pelo previsto). Uma transação, `travarViagem` primeiro; o **repasse esperado é lido da linha da view** depois da trava (fonte única; nunca recalculado na action). Pagamentos baixados assim ganham `pagamentos_fornecedor.repasse_parcela_id` (coluna nova, uuid null FK `parcelas_receber`, na migração da Task 2).
  - `desfazerRepasse(parcelaId)`: na mesma transação, desfaz a parcela e todos os pagamentos com `repasse_parcela_id = parcelaId` (voltam a `a_pagar`, `repasse_parcela_id` nulo).
  - **Caminho direto bloqueado:** `baixarParcela`/`desfazerBaixaParcela` (e os núcleos) recusam parcela de meio `cartao_fornecedor` com "Use o repasse do fornecedor para esta parcela"; `baixarPagamentoNa`/desfazer recusam pagamento com `repasse_parcela_id` preenchido ("Pagamento quitado pelo repasse: desfaça o repasse"). Na tela da viagem, a parcela de cartão direto mostra "Registrar repasse" / "Desfazer repasse" no lugar de "Dar baixa".
  - Na tela da viagem: aviso "Escolha o fornecedor que recebeu no cartão" com select quando falta; no fechamento da venda, select de fornecedores da viagem quando a forma é "Cartão direto no fornecedor".

- [ ] **Step 1: Testes que falham:** fechar venda `cartao_fornecedor` sem fornecedor → erro de campo; com o hotel → `vendas.fornecedor_cartao_id` gravado. `baixarRepasse` com repassado = esperado → parcela recebida com `valorRecebido = valor`, `taxaEfetiva = 0`, pagamentos do hotel pagos; repassado = esperado − 100,00 → `taxaEfetiva = 10000n` e margem real cai exatamente essa taxa × (preço ÷ total a receber); repassado > esperado → recusado com a mensagem exata; pagamento em EUR do fornecedor em aberto → recusado com a mensagem exata; `baixarParcela` direto nessa parcela → "Use o repasse do fornecedor para esta parcela"; `desfazerRepasse` → parcela e pagamentos do fornecedor de volta em aberto, margem real igual à de antes do repasse; esperado da view = parcela − Σ contas do fornecedor (conferido no teste).
- [ ] **Step 2:** FAIL → implementar → PASS (`npm run test:integracao -- vendas financeiro`).
- [ ] **Step 3:** Commit `feat: repasse do cartão direto no fornecedor`.

---

### Task 6: Lista única, baixa pela lista e lote

**Files:** Modify `src/server/queries/financeiro.ts`, `src/server/actions/financeiro.ts`; Create `src/app/(app)/financeiro/lancamentos/{page.tsx,lista.tsx,formulario.tsx,baixa.tsx}`; Test `tests/integracao/lancamentos-lista.test.ts`

**Interfaces:**
- Consumes: Task 2 (view), Task 3 (lançamentos), Task 4 (núcleo), Task 5 (repasse).
- Produces:
  - `listarLancamentos(filtro: FiltroLancamentos): Promise<{ linhas: LinhaLancamento[]; totalLinhas: number; totais: Record<"pagar" | "receber", { vencidos: bigint; venceHoje: bigint; aVencer: bigint; baixados: bigint }> }>` — os dois lados sempre; a aba A pagar mostra os cartões de `pagar`, A receber os de `receber`, Todos mostra os dois e o saldo (receber − pagar) de cada cartão — `exigirPerfil(...PERFIS_FINANCEIRO)`; tudo no SQL sobre a view; situação calculada no SQL com `hoje = hojeEmCuiaba()` (cancelado → cancelada; baixado → baixada; vencimento < hoje → vencida; = hoje → vence_hoje; senão a_vencer); **totais respeitam todos os filtros menos a situação** e só contam `transita_caixa = true` e não canceladas; "baixados" usa `valor_baixado` com `baixado_em` no período; ordenação por vencimento, depois `id`; 50 por página. Canceladas só aparecem com `situacao = "cancelada"`.
  - `LinhaLancamento` = colunas da view + `situacao` + `categoria` (`{ grupo; nome }`) + `contaBancaria` (nome).
  - `baixarLinha(origem, id, dados)` — despacha: manual → `baixarLancamento`; parcela → `baixarParcelaNa` (com `taxaEfetiva` nula = prevista, `valorRecebido` = informado); pagamento → `baixarPagamentoNa`; comissao → `registrarComissaoNa`; parcela com `repasse` → recusa e aponta para `baixarRepasse`. `desfazerBaixaLinha(origem, id)` análogo.
  - `baixarEmLote(dados: LoteEntrada): Promise<Ok | { ok: false; erro: string; linhas?: { origem; id; motivo }[] }>` — lê as linhas na view; se alguma `exige_individual`, `repasse`, não está em aberto, ou é de lados diferentes → recusa inteira com `linhas`; senão uma transação: trava as viagens envolvidas em ordem crescente de `viagem_id`, depois baixa cada linha pelo **valor previsto** (parcela: `valorRecebido = valor`, taxa prevista; pagamento BRL: `valorOriginalPago = valor_original`), data e conta do lote. Qualquer falha → rollback total.
  - Tela (padrão do protótipo `contas/page.tsx`): abas A pagar / A receber / Todos; filtros da `filtroLancamentosSchema` na URL (searchParams); 4 cartões de total no topo (Vencidos em `ouro`); tabela Código, Vencimento, Descrição (pessoa + "n/N" + "Fatura NNNN"), Categoria, Forma, Valor, Situação, Origem (link "Viagem ECL-…" ou "Lançado à mão"); caixa de seleção por linha e barra "Baixar selecionadas (N)"; botão Dar baixa / Desfazer baixa por linha (diálogo com os campos da baixa conforme a origem; moeda estrangeira pede câmbio); "Novo lançamento" (formulário com abas Dados e Detalhes; repetição única/parcelado/recorrente; editar com "só esta / esta e as próximas"). Linhas de viagem: sem editar, com link para a viagem.

- [ ] **Step 1: Testes que falham** (`tests/integracao/lancamentos-lista.test.ts`, usando `vendida()` de `tests/helpers/venda.ts`):
  - uma viagem vendida (boleto 2x, 4 contas, 1 comissão) + 2 lançamentos manuais → lista "todos" tem exatamente 2 parcelas + N pagamentos + 1 comissão + 2 manuais; nenhum id repetido; parcelas com categoria "Vendas de viagem" e centro "RS" (filial da viagem do fixture).
  - depois de `definirFormaFornecedor` (parcelado em 2), a conta aparece com as 2 linhas novas e a linha à vista antiga não aparece.
  - venda `cartao_fornecedor`: pagamentos do fornecedor do cartão com `transita_caixa = false` e fora dos totais; parcela como "Repasse de …" com o valor esperado.
  - totais: com hoje fixado (mock de `hojeEmCuiaba` ou datas relativas a hoje), um vencido, um hoje, um futuro, um baixado → cada total correto; filtro por centro e por categoria muda os totais; cancelado fora dos totais.
  - **mesma baixa:** baixar a parcela 1 por `baixarLinha` → `obterViagemVendida` mostra recebida e a margem real igual à da baixa pela viagem com os mesmos dados.
  - **Review Focus 2:** `Promise.all([baixarLinha("parcela", p1, …), baixarParcela(p1, …)])` → um ok e um `{ ok: false, erro: "Parcela já recebida" }` (texto exato de `MSG_PARCELA_RECEBIDA`).
  - **Review Focus 3:** lote com 2 manuais + pagamento em EUR → recusado, `linhas` aponta o EUR, nada baixado; lote com 2 manuais + 1 parcela + 1 pagamento BRL de duas viagens → tudo baixado com a mesma data e conta; lote em que uma linha foi baixada entre a leitura e a escrita (baixar antes dentro do teste) → rollback total.
  - consultor: `listarLancamentos` lança `ErroAcesso`; `baixarEmLote` → "Sem permissão".
- [ ] **Step 2:** FAIL → implementar query e actions → PASS.
- [ ] **Step 3:** Tela; `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 4:** Navegador como `fin.operacional@eclak.local`: filtros, totais, baixa individual de linha manual e de viagem (conferir na viagem), lote, novo lançamento parcelado. Commit `feat: lista única de lançamentos com baixa individual e em lote`.

---

### Task 7: Faturas numeradas

**Files:** Create `src/server/actions/faturas.ts`, `src/server/queries/faturas.ts`, `src/app/(app)/financeiro/faturas/{page.tsx,[id]/imprimir/page.tsx}`; Modify `src/app/(app)/admin/parametros/*` (próximo número); Test `tests/integracao/faturas.test.ts`

**Interfaces:**
- Consumes: Task 2 (`faturas`, `faturasVersoes`, `faturasContador`).
- Produces:
  - `emitirFatura(vendaId): Promise<{ ok: true; numero: number } | Falha>` (`PERFIS_FINANCEIRO`): transação → `travarViagem(viagem da venda)` → recusa se já existe fatura ("Esta venda já tem a fatura NNNN") → `select proximo from faturas_contador where id = 1 for update` → insere `faturas` com esse número e a versão 1 (`dados` = retrato da venda e das parcelas não canceladas) → `update faturas_contador set proximo = proximo + 1` → auditoria. Nunca `sequence`.
  - `reemitirFatura(faturaId)`: nova versão `max + 1` com o retrato atual, mesmo número; recusa se não está desatualizada ("A fatura já está atualizada").
  - `definirProximoNumeroFatura(numero: number)` (**só `diretor`**): recusa se existe alguma fatura ("Já há faturas emitidas: a numeração só avança"); 1 ≤ numero ≤ 999999.
  - Queries: `vendasParaFaturar()` (vendas sem fatura, com cliente, viagem, forma, total, data da venda); `listarFaturas()` (número, cliente, viagem, total, emissão, recebido = Σ parcelas recebidas, `desatualizada: boolean` = retrato da última versão ≠ parcelas atuais não canceladas em número/vencimento/valor); `obterFatura(id, versao?)`; `proximoNumeroFatura()`.
  - Tela (protótipo `faturas/page.tsx`): "Vendas para faturar" com "Emitir fatura"; lista de faturas com selo "Fatura desatualizada" (tom `ouro`) e "Reemitir"; detalhe com cronograma e situação das parcelas; "Imprimir" abre a página de impressão (mesmo padrão de `viagens/[id]/proposta/imprimir.tsx`): número, versão e data de emissão, nome e CPF/CNPJ, código e destino da viagem, datas, total, forma, parcelas (n/N, vencimento, valor). Layout provisório do protótipo até chegar o modelo FATURA_1405.
  - Admin › Parâmetros: card "Numeração de faturas" com o próximo número (editável só sem faturas).
  - Parcelas na lista única mostram "Fatura NNNN" (já vem da view).

- [ ] **Step 1: Testes que falham:**
  - primeira emissão → 1405; segunda (outra venda) → 1406; contador = 1407.
  - **Review Focus 1:** três vendas, `Promise.all` de três `emitirFatura` → números {1405, 1406, 1407} sem repetição; emissão que falha depois de ler o contador (forçar erro: venda que já tem fatura dentro da corrida, ou mock que lança após o `select for update`) → contador não avança.
  - emitir duas vezes a mesma venda → recusada com a mensagem exata.
  - `cancelarParcela` depois da emissão → `listarFaturas` marca `desatualizada`; `reemitirFatura` → versão 2, mesmo número, `desatualizada = false`; `obterFatura(id, 1)` ainda mostra a parcela cancelada (retrato fixo).
  - `definirProximoNumeroFatura(2000)` sem faturas → ok e a próxima é 2000; depois de emitir → recusado; fin_operacional chamando → "Sem permissão".
  - consultor chamando `emitirFatura` → "Sem permissão".
- [ ] **Step 2:** FAIL → implementar → PASS.
- [ ] **Step 3:** Telas e impressão; navegador: emitir, cancelar parcela na viagem, ver "desatualizada", reemitir, imprimir.
- [ ] **Step 4:** Commit `feat: faturas numeradas a partir de 1405 com retrato por emissão`.

---

### Task 8: Seed local e verificação final

**Files:** Create `scripts/seed-financeiro.ts`; Modify `scripts/seed-local.ts`, `README.md` (seção curta "Financeiro": lista única, faturas, contador)

- [ ] **Step 1:** Seed local (só com `local-guard`): 2 contas bancárias fictícias ("Banco do Brasil", "Bradesco PJ"), ~15 lançamentos manuais do protótipo (`contasIniciais`: aluguel recorrente 12x, celular 6x, seguro, reembolso), alguns baixados; faturas emitidas para metade das vendas do seed. Idempotente (rodar duas vezes não duplica).
- [ ] **Step 2:** `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build` → tudo verde; anotar os números de testes.
- [ ] **Step 3:** `npm run seed:local`; navegador com os cinco perfis: consultor/operacional sem Financeiro; financeiros e diretor com as quatro telas; baixa pela lista refletida na viagem e vice-versa.
- [ ] **Step 4:** Commit `chore: seed do financeiro e README`.

---

## Para a 4b

- Saldo das contas bancárias e fluxo de caixa (8 semanas + 12 meses) sobre a mesma view (`transita_caixa`, `valor_previsto` líquido da taxa prevista; crédito antecipado no primeiro vencimento).
- Reserva (6 × custo fixo de Parâmetros), Storage com anexos de lançamentos e notas fiscais, cartão corporativo com faturas (pergunta aberta: IOF/valor em reais por compra), `definirFormaFornecedor` recusando quando houver vínculo com fatura de cartão.
- Layout da fatura pelo modelo FATURA_1405 e categorias do Conta Azul quando o material chegar.
