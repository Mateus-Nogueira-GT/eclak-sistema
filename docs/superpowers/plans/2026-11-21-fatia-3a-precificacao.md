# Fatia 3a (Da cotação à proposta aprovada) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orçamento de viagem com itens cotados (moeda original + câmbio), precificação com a fórmula oficial, envio para aprovação com versões, decisão do Diretor e proposta imprimível liberada só após aprovação.

**Architecture:** Fórmulas puras em `src/domain/precificacao.ts` (sem I/O, testadas contra os números do protótipo). Tabelas novas `viagens`, `viagem_passageiros`, `itens_viagem`, `cotacoes`, `versoes_precificacao`. Actions com `comPerfil`, Zod e auditoria na mesma transação. A camada estratégica (custo, margem, compensação, rateio) só sai do servidor para `veCamadaEstrategica(perfil)`.

**Tech Stack:** o das fatias 1–2.

**Spec:** `docs/superpowers/specs/2026-11-18-backend-sistema-real-design.md` (seção 6, item 3). Protótipo (repositório `eclak-mockup`): `src/app/precificador/page.tsx` (caso Itália da especificação v7, tabelas `itens`, `simulador`, `avista`, `comparacao`, `porProduto`), `src/app/aprovacoes/page.tsx` (`calcular()`, `formas`, `rateios`, decisão), `src/components/trip-header.tsx`, `src/app/admin/parametros/page.tsx` (câmbio).

## Decisões desta fatia (Mateus, 21/11/2026)

- Fatia 3 dividida: **3a** (este plano) vai até a proposta aprovada; **3b** cobre fechamento da venda, parcelas, entradas/saídas reais, comissões, conciliação, margem real e o aviso de passaporte × data de volta.
- **Código da viagem:** `ECL-NNNN-NN` = código do cliente + sequencial da viagem daquele cliente (`ECL-0147-01`, `ECL-0147-02`).
- **Aéreo vendido à parte:** fica registrado na viagem (valor, comissão, tarifa fixa por bilhete), mas fora da precificação do terrestre e da margem aprovada. A proposta diz "Não inclui aéreo".
- **Moeda original:** cada cotação guarda moeda (BRL, USD, EUR, GBP, CHF), valor original, câmbio comercial e data usados; câmbio aplicado = comercial × (1 + acréscimo dos Parâmetros). Valores em reais derivados são gravados.
- Cotação automática (Expedia/New Age) fica na fatia 6: itens entram à mão.

## Decisões do plano (do Claude — conferir)

- **Câmbio comercial** mantido à mão pelo Diretor em Parâmetros (tabela USD/EUR/GBP/CHF com valor e data), dentro das versões de regras. Busca automática do câmbio fica para depois.
- **PDF da proposta** = página de impressão (`/viagens/[id]/proposta`) com CSS de impressão; o botão "Gerar PDF da proposta" abre a página e chama a impressão do navegador. Sem biblioteca de PDF.
- **Aba "Operadora (New Age)"** do protótipo fica fora (regra específica de 15% sobre o over; entra quando houver dados reais).
- **Taxa de roteiro** entra como item automático sem margem nem compensação, com venda = R$ 250,00. O protótipo mostra R$ 259,69 nessa linha; a diferença só muda a divisão da compensação, não o preço do pacote. Registrar como pergunta ao Augusto.
- **6x com antecipação:** taxa de antecipação interpolada linearmente entre 1 e 10 parcelas (Parâmetros dizem "intermediárias por interpolação"). O protótipo mostra 7,73% e preço 71.273,78, que não fecham exatamente com essa interpolação (dá 7,7367%); fica a fórmula, e a dúvida vai para o Augusto.
- **Comparação de fornecedores:** um item pode ter várias cotações. O preço é calculado pelo **pior custo** (maior custo líquido) de cada item; a cotação escolhida define o custo esperado, e a diferença aparece como "margem extra, sem mexer no preço" (como no protótipo).

## Global Constraints

- Todas as das fatias 1 e 2 (dinheiro em `bigint` centavos; percentuais como string `"19.000"`; RLS em toda tabela nova; auditoria na mesma transação; exclusão lógica; "hoje" em `America/Cuiaba`; marca: azul dominante, laranja só destaque, sem vermelho, sem gradiente, sem emoji, sem estrelinha de IA; textos pt-BR).
- **Toda Server Action começa com `comPerfil(...)`**; toda query chama `exigirPerfil(...)`.
- Quem vê e edita orçamentos e itens: todos os perfis. **Camada estratégica** (custo líquido, custo à vista, venda por item, compensação, margem, imposto, taxas financeiras, rateio, simulador, à vista, por produto): só `diretor`, `fin_operacional`, `fin_estrategico` — omitida no servidor para `consultor` e `operacional` (teste obrigatório). **Aprovar/devolver:** só `diretor`.
- Cálculo monetário em centavos inteiros com arredondamento **meio para cima em cada linha** onde o protótipo arredonda (valores por item a 2 casas; totais = soma das linhas). Percentuais e divisões em aritmética de alta precisão (usar `bigint` com escala de 10⁶ ou `decimal.js`; não `number` de ponto flutuante para dinheiro).
- Margem de referência só indica, nunca bloqueia. Único bloqueio: proposta/PDF só para versão aprovada.

## Review Focus

1. **Editar itens depois da aprovação** — a versão aprovada não muda; o orçamento volta a "Em edição" e a proposta continua mostrando a última versão aprovada até nova aprovação. Teste em Task 5.
2. **Câmbio alterado em Parâmetros depois de cotar** — cotações já lançadas mantêm o câmbio gravado; só novas cotações usam o novo. Teste em Task 4.
3. **Consultor pedindo a ficha de precificação** — resposta sem nenhum campo estratégico (nem no JSON da action). Teste em Task 4.
4. **Dois envios para aprovação simultâneos** do mesmo orçamento — uma só versão nova. Teste em Task 5.
5. **Viagem sem itens ou com item sem cotação** — envio recusado com mensagem clara ("Inclua ao menos um item cotado" / "<item> está sem cotação"). Teste em Task 5.

---

## Estrutura de arquivos

```
src/domain/precificacao.ts            fórmulas puras
src/domain/cambio.ts                  conversão e câmbio aplicado
src/domain/viagens.ts                 código ECL-NNNN-NN, dias/noites, status
src/domain/regras.ts                  + cambio (tabela) nas regras
src/server/db/schema/viagens.ts       viagens, viagem_passageiros, itens_viagem, cotacoes, versoes_precificacao
drizzle/0010_*.sql (gerado), 0011_rls_viagens.sql (custom)
src/server/queries/viagens.ts         listarOrcamentos, obterPrecificacao, listarPedidosAprovacao, obterProposta
src/server/actions/viagens.ts         criarOrcamento, alterarOrcamento, salvarItem, removerItem, salvarCotacao, removerCotacao, escolherCotacao
src/server/actions/aprovacoes.ts      enviarParaAprovacao, aprovar, aprovarComAjuste, devolver
src/app/(app)/viagens/…               lista de orçamentos, novo orçamento, precificação
src/app/(app)/aprovacoes/…            tela do Diretor
src/app/(app)/viagens/[id]/proposta/  página de impressão
src/components/bilhete.tsx            cabeçalho de viagem (TripHeader do protótipo)
tests/domain/precificacao.test.ts, cambio.test.ts, viagens.test.ts
tests/integracao/viagens.test.ts, aprovacoes.test.ts
```

---

### Task 1: Fórmulas de precificação (domínio)

**Files:**
- Create: `src/domain/precificacao.ts`, `src/domain/cambio.ts`
- Test: `tests/domain/precificacao.test.ts`, `tests/domain/cambio.test.ts`

**Interfaces:**
- Consumes: `Regras` (`src/domain/regras.ts`).
- Produces:
  - `type TipoItem = "Hotelaria" | "Trem" | "Transfer" | "Carro" | "Passeio" | "Ingresso" | "Seguro" | "Outro" | "Taxa" | "Aéreo"`.
  - `type ItemCalc = { id: string; tipo: TipoItem; nome: string; diarias: number | null; valorFornecedor: bigint; comissaoPct: string; descontoAVistaPct: string | null }` (valor em centavos BRL; `Taxa` = taxa de roteiro; `Aéreo` nunca entra no cálculo).
  - `type FormaPagamento = { tipo: "pix" | "cartao_fornecedor" | "boleto" | "credito"; parcelas: number; antecipado?: boolean }`; `FORMAS_SIMULADOR: { rotulo: string; forma: FormaPagamento }[]` = Pix / cartão direto no fornecedor; Crédito 1x; Crédito 2x a 6x (referência) (`parcelas: 6`); Crédito 7x a 10x (`parcelas: 10`); 6x com antecipação.
  - `taxaDaForma(f: FormaPagamento, r: Regras): { pct: string; fixo: bigint }` — pix/cartão fornecedor 0; crédito 1x `credito1x`; 2–6 `credito2a6x`; 7–10 `credito7a10x`; antecipado soma a antecipação interpolada linearmente entre `antecipacao1Parcela` (1) e `antecipacao10Parcelas` (10); boleto: pct 0 e `fixo = boletoPorBoleto × parcelas`.
  - `custoLiquido(i): bigint` = valor × (1 − com%); `custoAVista(i): bigint` = custoLiquido × (1 − desc%) (desc nulo = igual).
  - `vendaDoItem(i, r): bigint` — Hotelaria: se `diarias` e valor/diarias > `limiteDiariaSemReajuste` → valor do fornecedor; senão `custoLiquido / (1 − ganhoMinimoHotelPct)`. Trem: valor × (1 + `markupTremPct`). Demais (exceto Taxa/Aéreo): valor × (1 + `pctAte`) se valor ≤ `ate`, senão × (1 + `pctAcima`). Taxa: igual ao valor.
  - `precoDoPacote(custo: bigint, f, r, margemPct = r.margemAlvoPct): bigint` — resolve P em `P − C − imposto·(P − C) − pct·P − fixo = margem·P` ⇒ `P = ((1 − imposto)·C + fixo) / ((1 − imposto) − pct − margem)`, arredondado a centavo.
  - `resultadoDoPreco(precoP: bigint, custo: bigint, f, r): { imposto; taxas; margemLiquida; margemLiquidaPct: string }`.
  - `type Precificacao = { custo: bigint; custoAVista: bigint; somaVendas: bigint; porForma: { rotulo; taxaPct; compensacao; preco; imposto; taxas; margemLiquida; margemLiquidaPct; taxaServico; precoCliente; margemSemTaxaServicoPct }[]; itens: { id; custoLiquido; custoAVista; venda; compensacao; valorFinal; precoPorForma: bigint[] }[]; avista: { custoNoPrazo; desconto; custoAVista; opcaoAMargemPct: string[]; opcaoBPreco: bigint[]; opcaoBReducao: bigint[] } }`.
  - `precificar(itens: ItemCalc[], dias: number, r: Regras): Precificacao` — `Aéreo` ignorado; `taxaServico = dias × taxaServicoPorDia`; `precoCliente = preco + taxaServico`; `margemSemTaxaServicoPct` = (margem + taxa de serviço) / (preço + taxa de serviço); compensação da forma = preço − soma das vendas, distribuída proporcionalmente à venda entre os itens que **não** são `Taxa` (resto de centavos no maior item); `precoPorForma` de cada item = venda × preço/somaVendas (mesma regra de distribuição, Taxa fixa).
  - `type Rateio = "por_dia" | "por_faturamento" | "por_viagem"`; `margemDaAprovacao(precoP, custo, f, dias, rateio, r): { custo; imposto; taxa; antes; antesPct; fixo; final; finalPct; diasCobertos: string }` — imposto = imposto% × max(P − C, 0); taxa = pct·P + fixo; fixo: por_dia `custoFixoMensal / diasViagemMes × dias`; por_faturamento `P × pctFaturamento`; por_viagem `custoFixoMensal / viagensMes`; `diasCobertos = antes / (custoFixoMensal / 30)` com 1 casa.
  - `src/domain/cambio.ts`: `MOEDAS = ["BRL","USD","EUR","GBP","CHF"] as const`; `cambioAplicado(comercial: string /* "5.8930" */, acrescimoPct: string): string` (4 casas); `converter(valorOriginal: bigint /* centavos da moeda */, cambio: string): bigint` (centavos BRL, arredonda meio para cima).

- [ ] **Step 1:** Testes com o caso Itália do protótipo (`precificador/page.tsx`, array `itens`; regras = `REGRAS_INICIAIS`; 19 dias): para cada item, `custoLiquido`, `custoAVista` e `vendaDoItem` iguais às colunas "custo", "avista" e "venda" do protótipo (ex.: Palazzo Barocci 3106,00 / 4% / 4% → 2981,76 / 2862,49 / 3388,36; Il Borro → venda 10585,00 por diária acima de R$ 3.500; Carro Florença-Nápoles 1954,30 com 10% → custo 1758,87, venda 2540,59; Trem 713,00 → 998,20). Totais: `custo = 50785,53`, `custoAVista = 49795,12`, soma das vendas dos itens não-Taxa = 58384,29. `porForma` (Pix, 1x, 2x–6x, 7x–10x, 6x antecipado): taxa 0,00% / 2,19% / 3,47% / 2,89% / 7,73% (arredondado a 2 casas para exibição); para as quatro primeiras formas: preço 63825,06 / 65771,54 / 66965,18 / 66418,99; imposto 912,77 / 1049,02 / 1132,58 / 1094,34; taxas 0 / 1440,40 / 2323,69 / 1919,51; margem 12126,76 / 12496,59 / 12723,38 / 12619,61, todas 19,0%; preço ao cliente 66675,06 / 68621,54 / 69815,18 / 69268,99; margem sem taxa de serviço 22,2% / 22,0% / 21,9% / 21,9%. Taxa de serviço 2850,00. **6x antecipado:** taxa = 3,47% + antecipação interpolada (2,45% + (5,72% − 2,45%) × 5/9 = 4,2667%) = 7,7367%; assertar o preço pela fórmula (`precoDoPacote` com essa taxa), **não** o número do protótipo (71.273,78), que não fecha com a interpolação linear — pergunta registrada para o Augusto. À vista: desconto 990,41; opção A 20,4% nas quatro primeiras formas; opção B preço 62580,35 / 64488,88 / 65659,24 / 65123,70.
  - `margemDaAprovacao` com os pedidos do protótipo `aprovacoes/page.tsx` (`pedidos` p1, p2, p3: itens, preço, forma, dias) reproduz `calcular()` do protótipo para os três rateios (gerar o esperado rodando a fórmula do protótipo à mão no teste é proibido — escrever os valores esperados calculados uma vez e conferidos, com 2 casas).
  - Boleto 4x: `taxaDaForma` → pct 0, fixo 1000 centavos.
  - Câmbio: `cambioAplicado("5.8930", "4.500") === "6.1582"`; `cambioAplicado("5.4210","4.500") === "5.6649"`; `converter(100000n /* € 1.000,00 */, "6.1582") === 615820n`.
  - Item `Aéreo` não altera nenhum total.
- [ ] **Step 2:** `npm test -- precificacao cambio`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat: fórmulas de precificação e câmbio`.

### Task 2: Câmbio nos Parâmetros

**Files:**
- Modify: `src/domain/regras.ts` (`cambio: { USD; EUR; GBP; CHF }` com `{ comercial: string /* 4 casas */; data: string /* AAAA-MM-DD */ }`), `REGRAS_INICIAIS` (USD 5.4210, EUR 5.8930, GBP 6.9120, CHF 6.1040, data 2026-11-06), `src/server/queries/regras.ts` (versões antigas sem `cambio` recebem os valores iniciais na leitura), `src/app/(app)/admin/parametros/*` (tabela "Câmbio": moeda, comercial editável, com acréscimo calculado, data editável).
- Test: `tests/domain/regras.test.ts`, `tests/integracao/regras.test.ts`

- [ ] **Step 1:** Testes: schema aceita/recusa câmbio (`"5,4210"` lido com 4 casas; negativo recusado; data inválida recusada); versão gravada antes da mudança (sem `cambio`) é lida com os valores iniciais; salvar câmbio gera versão nova e linha de histórico "Câmbio EUR: 5,8930 → 6,0000".
- [ ] **Step 2:** Rodar. FAIL.
- [ ] **Step 3:** Implementar (parser de 4 casas em `src/domain/cambio.ts`: `lerCambio(texto): string`).
- [ ] **Step 4:** Rodar. PASS.
- [ ] **Step 5:** Commit `feat: câmbio nos parâmetros`.

### Task 3: Tabelas de viagens, itens, cotações e versões

**Files:**
- Create: `src/server/db/schema/viagens.ts`, `src/domain/viagens.ts`, migrações `0010_*` (gerada) e `0011_rls_viagens.sql` (custom)
- Modify: `src/server/db/schema/clientes.ts` (`proxima_viagem integer not null default 1`), `src/server/db/schema/index.ts`, `tests/integracao/rls.test.ts`
- Test: `tests/domain/viagens.test.ts`

**Interfaces:**
- Produces:
  - `src/domain/viagens.ts`: `formatarCodigoViagem(codigoCliente: number, seq: number): string` → `"ECL-0147-01"`; `diasDaViagem(inicio, fim): number` (inclusivo: 14/08–01/09 = 19); `noites(inicio, fim): number` (18); `STATUS_ORCAMENTO = ["em_edicao","aguardando_aprovacao","aprovado","devolvido"] as const` e rótulos "Em edição", "Aguardando aprovação", "Aprovado", "Devolvido".
  - `viagens`: `id uuid`, `cliente_id uuid not null references clientes on delete restrict`, `seq integer not null` (unique com cliente_id), `destino text not null`, `inicio date not null`, `fim date not null` (CHECK fim ≥ inicio), `filial filial not null`, `consultor_id uuid not null references usuarios`, `status status_orcamento not null default 'em_edicao'`, `versao_aprovada_id uuid null`, `observacoes text null`, `criado_em`, `atualizado_em`, `excluido_em`.
  - `viagem_passageiros`: `viagem_id` + `pessoa_id references pessoas on delete restrict`, PK composta.
  - `itens_viagem`: `id`, `viagem_id`, `ordem integer`, `tipo tipo_item` (10 valores de `TipoItem`), `cidade text null`, `servico text not null`, `checkin date null`, `checkout date null`, `diarias integer null`, `automatico boolean not null default false` (taxa de roteiro), `excluido_em`.
  - `cotacoes`: `id`, `item_id references itens_viagem`, `fornecedor_id uuid null references fornecedores`, `moeda moeda not null default 'BRL'`, `valor_original bigint not null` (centavos da moeda), `cambio_comercial numeric(10,4) null`, `cambio_aplicado numeric(10,4) null`, `cambio_data date null`, `valor_brl bigint not null`, `comissao_pct numeric(6,3) not null default 0`, `desconto_a_vista_pct numeric(6,3) null`, `tarifa_fixa bigint not null default 0` (aéreo), `escolhida boolean not null default false`, `criado_em`, `excluido_em`. Índice único parcial: uma escolhida por item.
  - `versoes_precificacao`: `id`, `viagem_id`, `numero integer not null` (unique com viagem_id), `status status_versao` (`aguardando`, `aprovada`, `aprovada_com_ajuste`, `devolvida`), `snapshot jsonb not null` (itens + cotações usados no cálculo), `preco bigint not null`, `forma jsonb not null`, `dias integer not null`, `regras_versao_id uuid not null references regras_versoes`, `rateio text not null`, `resultado jsonb not null` (saída de `margemDaAprovacao` serializada), `alteracao text null` ("o que mudou", escrito pelo consultor), `enviado_por`, `enviado_em`, `decidido_por null`, `decidido_em null`, `comentario text null`.
  - RLS nas 5 tabelas em `0011`; `rls.test.ts` cobre todas.
- [ ] **Step 1:** Testes de domínio (`formatarCodigoViagem(147, 1) === "ECL-0147-01"`, `(1, 12) === "ECL-0001-12"`; dias 19 e noites 18 para 2027-08-14 → 2027-09-01) e RLS das tabelas novas.
- [ ] **Step 2:** Rodar. FAIL.
- [ ] **Step 3:** Esquema, migrações, `db:migrate`; validar com `supabase db reset` + `db:migrate`.
- [ ] **Step 4:** Rodar todos os testes. PASS.
- [ ] **Step 5:** Commit `feat: tabelas de viagens, itens, cotações e versões`.

### Task 4: Orçamentos, itens e cotações (servidor)

**Files:**
- Create: `src/server/queries/viagens.ts`, `src/server/actions/viagens.ts`, `src/domain/viagens-entrada.ts` (Zod)
- Test: `tests/integracao/viagens.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `regrasVigentes`; `comPerfil`, `errosDeCampo`, `ehUuid`; `registrarAuditoria`; `veCamadaEstrategica`.
- Produces:
  - `criarOrcamento({ clienteId, destino, inicio, fim, passageiros: string[] /* pessoa ids ativas do cliente */, observacoes? })` → `{ ok, id, codigo }` — qualquer perfil; `seq` = `clientes.proxima_viagem` sob `for update` (incrementa); consultor = usuário atual; filial = do cliente; passageiro de outro cliente ou removido → "Passageiro não pertence a este cliente".
  - `alterarOrcamento(id, dados, atualizadoEmEsperado)` (mesmo controle de concorrência da fatia 2, com `conflito: true`).
  - `salvarItem(viagemId, item, itemId?)`, `removerItem(itemId)` (exclusão lógica), `salvarCotacao(itemId, cotacao, cotacaoId?)`, `removerCotacao(cotacaoId)`, `escolherCotacao(cotacaoId)`.
    - Cotação em moeda estrangeira: o servidor lê o câmbio comercial **dos Parâmetros vigentes** (o cliente não envia câmbio), calcula aplicado e `valor_brl`, e grava os três; BRL grava câmbio nulo.
    - Ao salvar um item ou cotação, mantém automaticamente o item `Taxa` de roteiro (`automatico = true`, valor `taxaRoteiro.valor`) quando houver ≥ `taxaRoteiro.minimoItens` itens não-Taxa/não-Aéreo, e o remove (exclusão lógica) abaixo disso.
    - Qualquer alteração de item/cotação de orçamento `aprovado` ou `devolvido` muda o status para `em_edicao` (a `versao_aprovada_id` permanece). Em `aguardando_aprovacao` → `{ ok:false, erro: "Orçamento aguardando aprovação. Peça ao Diretor para devolver antes de alterar." }`.
  - `listarOrcamentos(filtro?: { busca?; status? })` → código, cliente (grupo), destino, período, passageiros, consultor, status, versão aprovada (número); **preço e margem só para camada estratégica**.
  - `obterPrecificacao(viagemId)` → cabeçalho (código, cliente, destino, período, dias, noites, passageiros, consultor, status), itens com cotações (fornecedor, moeda, valor original, câmbio aplicado e data, valor BRL, comissão, desconto, escolhida), aéreo à parte, sugestão de custo de referência (média das cotações BRL de itens com mesmo `tipo` + `servico` + `cidade` em outras viagens, quando ≥ `cotacoesParaSugestao`); e, **só para camada estratégica**, `precificar(...)` com o pior custo por item, custo com as escolhidas e a margem extra.
- Mensagens: "Informe o destino", "Data inválida", "A volta não pode ser antes da ida", "Escolha ao menos um passageiro", "Informe o serviço", "Valor inválido", "Orçamento não encontrado", "Item não encontrado", "Sem permissão".

- [ ] **Step 1:** Testes: criar 2 orçamentos para o mesmo cliente (ECL-0001) → códigos `ECL-0001-01`, `ECL-0001-02`; criação concorrente (Promise.all) não repete `seq`; cotação em EUR 1.000,00 com câmbio vigente 5,8930 → `valor_brl` 615820n e câmbio gravado; **Review Focus 2:** diretor muda câmbio EUR para 6,0000 depois; a cotação antiga mantém 6.1582 e uma nova usa 6.2700; taxa de roteiro aparece com o 6º item e some ao remover; **Review Focus 3:** `obterPrecificacao` como consultor não tem as chaves `precificacao`, `custo`, `margem` em nenhum nível (`JSON.stringify` não contém `"margem"` nem `"custoLiquido"`), como `fin_operacional` tem; alterar item de orçamento aprovado → status `em_edicao`; alterar em `aguardando_aprovacao` → mensagem; passageiro de outro cliente recusado; sem sessão → "Sem permissão".
- [ ] **Step 2:** Rodar. FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar. PASS.
- [ ] **Step 5:** Commit `feat: orçamentos, itens e cotações`.

### Task 5: Envio, versões e decisão do Diretor (servidor)

**Files:**
- Create: `src/server/actions/aprovacoes.ts`; Modify: `src/server/queries/viagens.ts` (`listarPedidosAprovacao`, `obterPedido`, `obterProposta`)
- Test: `tests/integracao/aprovacoes.test.ts`

**Interfaces:**
- Produces:
  - `enviarParaAprovacao(viagemId, { preco?: string /* reais; padrão: preço calculado */, forma: FormaPagamento, alteracao: string })` — qualquer perfil; valida itens (≥1 não-Taxa/não-Aéreo com cotação; todo item com ao menos uma cotação); sob `for update` da viagem e advisory lock por viagem: cria versão `numero = max+1`, `status aguardando`, snapshot, preço, forma, dias, regras vigentes, rateio = método vigente, resultado; viagem → `aguardando_aprovacao`; auditoria.
  - `aprovar(versaoId)`, `aprovarComAjuste(versaoId, { preco, forma, itens?: { itemId; valorFornecedor?; comissaoPct? }[] , rateio? })`, `devolver(versaoId, comentario: string /* obrigatório */)` — só `diretor`; só versão `aguardando` e que seja a última da viagem; `aprovarComAjuste` cria versão nova `aprovada_com_ajuste` (snapshot ajustado) e marca a anterior `devolvida` com comentário automático "Substituída por ajuste do Diretor"; aprovar seta `viagens.versao_aprovada_id` e status `aprovado`; devolver → status `devolvido`.
  - `listarPedidosAprovacao()` — só diretor: versões `aguardando` (mais antiga primeiro) + decididas nos últimos 30 dias.
  - `obterPedido(versaoId)` — só diretor: dados do snapshot + `margemDaAprovacao` para os três rateios + referência.
  - `obterProposta(viagemId)` — qualquer perfil; só se houver `versao_aprovada_id`; devolve só dados para o cliente (código, cliente, passageiros, destino, período, itens com tipo/cidade/serviço/datas/diárias, preço do pacote + taxa de serviço, por pessoa, forma, validade "Orçamento sem caráter de reserva; os valores podem variar conforme as datas. Não inclui aéreo."), **nunca** custo, fornecedor, comissão ou margem.
- Mensagens: "Inclua ao menos um item cotado", "<serviço> está sem cotação", "Este pedido já foi decidido", "Escreva o motivo da devolução", "Proposta disponível só depois da aprovação do Diretor", "Sem permissão".

- [ ] **Step 1:** Testes: envio cria versão 1 com status e snapshot; **Review Focus 4:** dois envios simultâneos → uma versão (o segundo recebe "Orçamento aguardando aprovação…"); **Review Focus 5:** sem itens → "Inclua ao menos um item cotado"; item sem cotação → "<serviço> está sem cotação"; consultor chamando `aprovar` → "Sem permissão"; aprovar → `obterProposta` disponível e sem campos estratégicos (`JSON.stringify` sem "comissao", "custo", "margem", "fornecedor"); aprovar com ajuste de preço → versão 2 `aprovada_com_ajuste`, versão 1 `devolvida`; devolver sem comentário recusado; decidir versão já decidida → "Este pedido já foi decidido"; **Review Focus 1:** após aprovar, editar item → status `em_edicao`, `obterProposta` ainda mostra a versão aprovada; novo envio → versão 2 aguardando; snapshot guarda `regras_versao_id` e mudar parâmetros depois não altera `resultado` da versão.
- [ ] **Step 2:** Rodar. FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar. PASS.
- [ ] **Step 5:** Commit `feat: envio, versões e aprovação da precificação`.

### Task 6: Telas de orçamento e precificação

**Files:**
- Create: `src/components/bilhete.tsx`, `src/app/(app)/viagens/page.tsx` (orçamentos), `src/app/(app)/viagens/novo/page.tsx`, `src/app/(app)/viagens/[id]/page.tsx` (precificação com abas), componentes de item/cotação
- Modify: `src/domain/perfis.ts` (`/viagens` para todos), `src/components/shell.tsx` (Operação › Viagens; Comercial › Precificação aponta para `/viagens`), `src/app/(app)/clientes/[id]/page.tsx` (botão "Novo orçamento" para todos os perfis exceto financeiros, como no protótipo)

**Comportamento (visual do protótipo `precificador/page.tsx` e `trip-header.tsx`):**
- Bilhete: canhoto azul com o código `ECL-0147-01`, cliente, destino, período, noites, passageiros, consultor; etapas Precificação › Aprovação (as demais etapas do protótipo aparecem desabilitadas, sem a tag "Fase 2").
- Cartões do topo: "Valor de referência para o cliente" (preço ao cliente na forma de referência 2x a 6x, por pessoa e total, texto "Orçamento sem caráter de reserva; os valores podem variar conforme as datas. Não inclui aéreo.") para todos; para camada estratégica: margem líquida, compensação ("Só com as regras por item a viagem rende X%") e custo fixo pago (dias); para os demais: "Próximo passo" com o texto por status do protótipo.
- Abas: "Vendas da viagem" (itens com cotações; colunas estratégicas só para camada estratégica; adicionar item, adicionar cotação com moeda/valor/fornecedor/comissão/desconto; aviso de custo de referência; destaque da diária acima do limite), "Comparação de fornecedores", e só para camada estratégica "Simulador", "Fornecedor à vista", "Por produto". Seção "Aéreo (vendido à parte)" abaixo dos itens.
- Ações: "Enviar para aprovação" (forma de pagamento proposta, preço sugerido editável, campo "O que mudou nesta versão"), badge de status, "Versões" (lista de versões com status, preço, data, quem decidiu, comentário), "Gerar PDF da proposta" habilitado só com versão aprovada.
- Lista de orçamentos: busca, filtro por status; colunas código, cliente, destino, período, consultor, status, versão aprovada; preço/margem só para camada estratégica.

- [ ] **Step 1:** Teste de domínio `podeAcessar(p, "/viagens/novo")` para os 5 perfis.
- [ ] **Step 2–3:** RED, depois implementar.
- [ ] **Step 4:** lint, typecheck, test, test:integracao, build.
- [ ] **Step 5:** Playwright (`localhost`): consultor cria orçamento para "Casal Souza" com os 14 itens do caso Itália (via seed, Task 8) ou 3 itens à mão, uma cotação em EUR, vê a precificação sem colunas estratégicas e envia; fin_operacional vê simulador com os números esperados.
- [ ] **Step 6:** Commit `feat: telas de orçamento e precificação`.

### Task 7: Tela de Aprovações

**Files:**
- Create: `src/app/(app)/aprovacoes/page.tsx` e componentes
- Modify: `src/domain/perfis.ts` (`/aprovacoes` só `diretor`), `src/components/shell.tsx` (Gestão › Aprovações)

**Comportamento (visual de `aprovacoes/page.tsx`):** lista de pedidos (aguardando primeiro; badge Aguardando / Aprovada / Aprovada com ajuste / Devolvida); painel com margem já com custo fixo (número grande, R$, indicador acima/abaixo da referência com campo editável só local), barra de composição (Fornecedores, Imposto, Taxa de pagamento, Custo fixo, Margem — tons do protótipo, **margem abaixo da referência em `ouro`, nunca vermelho**), detalhamento, "Antes do rateio, esta viagem paga X dias de custo fixo"; "Simular" (preço, forma, rateio, valor/comissão por item — só no navegador, chamando as funções puras de `src/domain/precificacao.ts`); botões "Aprovar versão N", "Aprovar com ajuste" (envia a simulação), "Devolver" (comentário obrigatório); texto "A referência é só um indicador visual. Nenhuma decisão é bloqueada pelo sistema."; link "Abrir a precificação".

- [ ] **Step 1–2:** teste de rota (`/aprovacoes` só diretor) RED.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Verificações completas.
- [ ] **Step 5:** Playwright: diretor abre o pedido do Casal Souza, simula 2x a 6x → 66.965,18 / margem antes do fixo 19,0%, aprova com ajuste; consultor não vê o menu Aprovações e `/aprovacoes` → `/sem-acesso`.
- [ ] **Step 6:** Commit `feat: tela de aprovações`.

### Task 8: Proposta para impressão e seed

**Files:**
- Create: `src/app/(app)/viagens/[id]/proposta/page.tsx` (+ CSS de impressão)
- Modify: `scripts/seed-local.ts` (orçamento ECL-…-01 do "Casal Souza" com os 14 itens do caso Itália, versão 1 aguardando; um segundo orçamento aprovado; um devolvido)

**Comportamento:** página limpa com logo, código, cliente e passageiros, destino e período, itens (sem fornecedor/custo/comissão), valor do pacote + taxa de serviço, valor por pessoa, forma de pagamento aprovada, texto de validade e "Não inclui aéreo"; botão "Imprimir / salvar em PDF" (`window.print()`), escondido na impressão. Sem versão aprovada → mensagem "Proposta disponível só depois da aprovação do Diretor".

- [ ] **Step 1:** Teste de integração já cobre `obterProposta` (Task 5); aqui, teste de que a página sem aprovação mostra a mensagem (render do Server Component com `obterProposta` mockado ou Playwright).
- [ ] **Step 2–3:** Implementar página e seed (idempotente; local guard).
- [ ] **Step 4:** Verificações completas + `npm run seed:local`.
- [ ] **Step 5:** Playwright: abrir a proposta aprovada, conferir valores e ausência de "comissão"/"custo" no texto da página; `page.pdf()` gera arquivo sem erro.
- [ ] **Step 6:** Commit `feat: proposta para impressão e seed de orçamentos`.
