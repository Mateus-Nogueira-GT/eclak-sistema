# Fatia 3b (Da venda fechada à margem real) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fechar a venda a partir do orçamento aprovado, gerar parcelas a receber, contas a pagar e comissões, dar baixa (só Diretor e financeiro), conciliar orçado × realizado e mostrar margem planejada × real com a mesma fórmula da aprovação.

**Architecture:** Funções puras em `src/domain/venda.ts` (cronograma, contas a pagar a partir do snapshot, margem real, ponte, status derivado, aviso de passaporte). Tabelas `vendas`, `parcelas_receber`, `contas_pagar`, `pagamentos_fornecedor`, `comissoes`. Actions com `comPerfil`, Zod, auditoria e trava da viagem (advisory + `for update`, mesma ordem da 3a).

**Tech Stack:** o das fatias anteriores.

**Spec:** `docs/superpowers/specs/2026-11-18-backend-sistema-real-design.md` (seção 6, item 3). Protótipo (`eclak-mockup`): `src/app/vendas/page.tsx` (fechamento), `src/app/viagens/[id]/page.tsx` (Entradas, Saídas, Conciliação, ponte de margem), `src/lib/mock-data.ts` (`ribeiro`: entradas, saídas, comissão), `src/lib/calc.ts` (`resumoRibeiro`), `src/lib/clientes.ts` (aviso de passaporte × volta), `PRODUCT.md` (comissão por reserva; Expedia TAAP paga no mês seguinte ao check-out).

## Decisões desta fatia

Do Mateus (22/11/2026):
- **Baixa simples já na 3b**: marcar parcela recebida e pagamento de fornecedor pago (data, valor efetivo, câmbio efetivo, taxa efetiva). Só `diretor`, `fin_operacional`, `fin_estrategico` dão baixa. A fatia 4 acrescenta fatura numerada, nota fiscal, extrato OFX e fluxo de caixa.
- **Venda só com `viagens.status = 'aprovado'`** (decisão da 3a).

Do Claude (conferir):
- **Fechar a venda** registra: data do aceite, forma e parcelas acordadas, primeiro vencimento, fatura em nome de (nome + CPF/CNPJ), observação para o financeiro, comprovante do aceite como texto (sem upload). Quem fecha: `consultor`, `operacional`, `diretor`.
- **Forma acordada diferente da aprovada** → nova versão `aguardando` com o snapshot e o preço da versão aprovada e a nova forma ("Nova forma de pagamento acordada com o cliente"); viagem volta a `aguardando_aprovacao`. Depois da aprovação, a venda é fechada normalmente.
- **Cliente pediu ajustes** → viagem volta para `em_edicao` com a nota do cliente gravada (`nota_cliente`) e mostrada na precificação.
- **Total a receber = preço ao cliente da versão aprovada** (pacote + taxa de serviço). Parcelas mensais no mesmo dia a partir do primeiro vencimento (dia inexistente → último dia do mês); valor = total ÷ n truncado ao centavo e a última absorve a diferença (regra `cronograma()` do protótipo). Meio por forma: Pix, Boleto, Cartão de crédito, Cartão direto no fornecedor.
- **Contas a pagar** geradas da versão aprovada: uma por item não-Taxa (Taxa de roteiro é receita, não conta), usando a **cotação escolhida** (fornecedor, moeda, valor original, câmbio aplicado, valor BRL, comissão, desconto). Aéreo também gera conta (vendido à parte, fica fora da margem).
- **Comissão por reserva** (`PRODUCT.md`): cada conta tem `comissao_tipo` = `descontada` (paga-se o líquido: previsto = valor × (1 − comissão)) ou `a_receber` (paga-se o valor cheio e nasce um registro em `comissoes` com valor = valor BRL × comissão e data prevista). Padrão: fornecedor com modalidade `comissionado` → `a_receber`, prevista para o dia 15 do mês seguinte ao fim da viagem; demais → `descontada`. Editável até a primeira baixa.
- **Forma de pagamento ao fornecedor** por conta: `a_vista` (com desconto à vista da cotação aplicado ao previsto, se houver), `parcelado` (n parcelas com datas e valores), `cartao_corporativo` (fatura do cartão; a conta fica "No cartão" e é baixada como paga na data da fatura). Gera 1..n linhas em `pagamentos_fornecedor`. Editável até a primeira baixa.
- **Realizado diferente do orçado**: "Atualizar valor previsto" com motivo obrigatório (ex.: hotel cobrou R$ 1.840 a mais); "Contestar com o fornecedor" registra texto e data e marca a conta como contestada.
- **Margem real = mesma conta de `margemDaAprovacao`**, com: preço = preço da versão aprovada; custo = Σ contas não-Aéreo (pago efetivo em BRL quando pago, senão previsto atual) − Σ comissões **recebidas**; imposto = imposto% × max(P − custo, 0) com as regras da versão; taxas financeiras = Σ parcelas (taxa efetiva se recebida, senão taxa prevista pela forma) × P ÷ total a receber (arredondado meio para cima); custo fixo = o `fixo` gravado no `resultado` da versão. **Margem planejada** = `resultado.final`/`finalPct` da versão aprovada.
- **Ponte da margem** (Conciliação): planejada → margem extra dos fornecedores escolhidos → diferença por conta (previsto atual − previsto na venda) → diferença de câmbio nas contas pagas → comissões pendentes → diferença de taxas financeiras → real.
- **Status da viagem** (exibição, derivado): `vendida` (status gravado) + datas → "Vendida" (antes do início), "Em viagem" (entre início e fim), "Recebendo" (depois do fim, com algo em aberto), "Conciliada" (`conciliada_em` preenchido). `conciliar` só com tudo baixado (parcelas recebidas ou canceladas, pagamentos pagos, comissões recebidas ou marcadas "não será recebida"); só Diretor e financeiro.
- **Viagem vendida não aceita mudança de itens/cotações/precificação** ("Viagem vendida: ajustes de valor vão em Contas a pagar").
- **Aviso de passaporte × volta** (pendência da fatia 2): para viagens `aprovado`/`vendida` com `internacional = true` e data de volta ≥ hoje, passageiro sem validade ou com validade < volta + 182 dias. Novo campo `viagens.internacional` (padrão `true`, editável no orçamento). O aviso aparece na ficha do cliente, no chip "Documentos pendentes" e na viagem.

Do Controller (revisão final, a confirmar com o Mateus):
- **Recebimento a menos ou parcela cancelada**: a baixa com valor recebido diferente do valor da parcela exige observação ("Explique a diferença do valor recebido"). A receita da margem real = preço da versão − Σ (valor − valor recebido) das parcelas recebidas (positivo = recebido a menos; negativo = a mais) − Σ valor das parcelas canceladas, cada diferença **na parte do pacote** (× preço ÷ total a receber, meio para cima), para a taxa de serviço não contar como receita do pacote; o imposto é recalculado sobre a nova base. A ponte ganha "Recebido a menos", "Recebido a mais" e "Parcela cancelada: n de N" com esse efeito (soma continua exata). O cartão "Recebido" continua sendo o caixa; "A receber" mostra "Diferença no recebimento" quando ≠ 0. As divergências contam as parcelas recebidas com diferença e as canceladas.
- **Previsto acima do já pago sem linha em aberto**: o aumento vira uma linha nova em aberto (vence hoje em Cuiabá; na moeda pelo câmbio da conta) e a conta volta a `a_pagar`; a linha é o aumento do previsto, sem passar do novo previsto menos o já pago (com desconto à vista pago, não cobra o desconto de volta).

## Para a fatia 4

- Cartão direto no fornecedor: parcelas e contas marcadas "não transita pelo caixa" no fluxo de caixa.
- `definirFormaFornecedor` apaga as linhas de pagamento em aberto: vai conflitar com as FKs futuras (boletos, faturas de cartão); trocar por cancelamento lógico ou recusar quando houver vínculo.
- `fatura_numero` a partir de 1502 sem buracos: linha contadora travada dentro da trava da viagem.
- `travarViagemEdicao`/`alterarOrcamento` sem o lock consultivo (seguro hoje).
- `internacional` editável depois da venda; `excluirCliente` com viagens vendidas; texto de "A pagar" sobre o desconto.

## Global Constraints

- Todas as das fatias 1–3a (centavos `bigint`, percentuais string, RLS, auditoria na mesma transação, exclusão lógica, "hoje" em `America/Cuiaba`, marca sem vermelho/gradiente/emoji/estrelinha, textos pt-BR, `comPerfil` no início de toda action, `exigirPerfil` em toda query).
- **Camada estratégica** (margem planejada/real, ponte, imposto, taxas, custo fixo): só `veCamadaEstrategica`; montada só para esses perfis. Valores de parcelas, contas a pagar e comissões são operacionais (visíveis a todos).
- **Baixas, desfazer baixa, atualizar previsto, contestar, comissão recebida/não recebida, conciliar:** só `diretor`, `fin_operacional`, `fin_estrategico`.
- Trava: advisory lock da viagem + `for update` na viagem antes de qualquer escrita em venda/parcelas/contas/pagamentos/comissões (mesma ordem da 3a).

## Review Focus

1. **Fechar a venda duas vezes ao mesmo tempo** → uma venda só; a segunda recebe "Esta viagem já foi vendida". Teste em Task 3.
2. **Fechar venda de orçamento editado depois da aprovação** (status `em_edicao` com `versao_aprovada_id`) → recusado com "O orçamento mudou depois da aprovação. Envie a nova versão para o Diretor." Teste em Task 3.
3. **Soma das parcelas = total exato** para qualquer n (1–10) e totais com centavos ímpares; primeiro vencimento em 31/01 → 28/02 (ou 29/02), 31/03… Teste em Task 1.
4. **Baixa por perfil sem permissão** (consultor chamando a action direto) → "Sem permissão", nada gravado. Teste em Task 4.
5. **Desfazer baixa e baixar de novo** com valor diferente → margem real e auditoria corretas, sem duplicar. Teste em Task 4.

---

## Estrutura de arquivos

```
src/domain/venda.ts                    cronograma, contas do snapshot, margem real, ponte, status, avisos
src/domain/venda-entrada.ts            Zod das actions
src/domain/clientes.ts                 + aviso de passaporte × volta (entrada com viagens)
src/server/db/schema/vendas.ts         vendas, parcelas_receber, contas_pagar, pagamentos_fornecedor, comissoes
drizzle/0013_*.sql (gerado), 0014_venda.sql (custom: ADD VALUE 'vendida', RLS, índices)
src/server/actions/vendas.ts           fecharVenda, pedirNovaForma, registrarAjustesCliente
src/server/actions/financeiro-viagem.ts  formas de pagamento ao fornecedor, comissão, baixas, previsto, contestação, conciliar
src/server/queries/vendas.ts           listarPropostas, obterViagemVendida
src/app/(app)/vendas/…                 Fechamento da venda
src/app/(app)/viagens/[id]/…           abas Entradas, Saídas, Conciliação quando vendida
tests/domain/venda.test.ts
tests/integracao/vendas.test.ts, financeiro-viagem.test.ts
```

---

### Task 1: Domínio da venda

**Files:** Create `src/domain/venda.ts`; Modify `src/domain/clientes.ts`; Test `tests/domain/venda.test.ts`, `tests/domain/clientes.test.ts`

**Interfaces (Produces):**
- `MEIOS_RECEBIMENTO = ["pix","boleto","cartao_credito","cartao_fornecedor"] as const`; `meioDaForma(f: FormaPagamento)`.
- `cronogramaRecebimento(total: bigint, n: number, primeiro: string /* AAAA-MM-DD */): { numero; vencimento; valor }[]` — mensal, mesmo dia (ou último do mês), truncado ao centavo, última absorve.
- `taxaPrevistaParcela(valor: bigint, forma: FormaPagamento, regras: Regras): bigint` — pct da forma × valor + (boleto) taxa fixa por boleto; arredonda meio para cima.
- `COMISSAO_TIPOS = ["descontada","a_receber"] as const`; `FORMAS_PAGAMENTO_FORNECEDOR = ["a_vista","parcelado","cartao_corporativo"] as const`.
- `contasDoSnapshot(s: Snapshot, modalidadePorFornecedor: Record<string, "net"|"comissionado">, fimViagem: string): ContaGerada[]` — uma por item não-Taxa (Aéreo incluído, marcado `aereo: true`), com a cotação **escolhida**; `previstoBrl` = líquido se `descontada`, valor cheio se `a_receber`; `comissao` (valor e `previstaPara` = dia 15 do mês seguinte ao fim) quando `a_receber` e comissão > 0.
- `aplicarFormaFornecedor(conta, forma: { tipo: "a_vista" } | { tipo: "parcelado"; parcelas: { vencimento: string; valorOriginal: bigint }[] } | { tipo: "cartao_corporativo"; vencimento: string }, descontoAVistaPct)` → linhas de pagamento (soma das parcelas = valor original previsto; à vista aplica o desconto).
- `margemReal(entrada: { preco; totalReceber; contas: { aereo; previstoBrl; pagoBrl: bigint | null }[]; comissoesRecebidas: bigint; parcelas: { valor; recebida; taxaEfetiva: bigint | null; taxaPrevista: bigint }[]; fixo: bigint; impostoPct: string }): { custo; imposto; taxas; fixo; final; finalPct }`.
- `ponteDaMargem(…)`: linhas `{ rotulo; valor }` da planejada à real, somando exatamente `real.final − planejada.final`.
- `statusDaViagem({ status; inicio; fim; conciliadaEm; hoje; emAberto: boolean })` → `"orcamento" | "vendida" | "em_viagem" | "recebendo" | "conciliada"` e `ROTULO_STATUS_VIAGEM` (Orçamento, Vendida, Em viagem, Recebendo, Conciliada).
- `clientes.ts`: `alertasDoCliente(c, hoje, viagens?: { destino; fim; internacional; passageiros: string[] /* pessoa ids */ }[])` acrescenta `passaporte_volta` ("Passaporte de <nome> vence em dd/mm/aaaa, menos de 6 meses depois da volta de <destino>.") e `sem_passaporte` com destino ("<nome> não tem passaporte cadastrado para <destino> (dd/mm/aaaa).").

- [ ] **Step 1:** Testes: **Review Focus 3** — `cronogramaRecebimento(100000n, 3, "2026-11-20")` → 33333/33333/33334, 20/11, 20/12, 20/01; total 1001n em 10 parcelas soma 1001n; primeiro 2027-01-31 → 31/01, 28/02, 31/03; 2028-01-31 → 29/02. Caso Ribeiro do protótipo (`mock-data.ts` `ribeiro`): contas net e comissionada, comissão 10% de 9500 = 950 prevista; margem real com Florença 4100→5940 e comissão não recebida fica menor que a planejada pela soma exata das linhas da ponte. Passaporte: validade 2027-06-30, volta 2027-01-29 → aviso (182 dias); volta 2026-12-01 → sem aviso; viagem não internacional → sem aviso.
- [ ] **Step 2–4:** RED, implementar, GREEN.
- [ ] **Step 5:** Commit `feat: regras de domínio da venda e da margem real`.

### Task 2: Tabelas da venda

**Files:** Create `src/server/db/schema/vendas.ts`; migrações `0013_*` (gerada) e `0014_venda.sql` (custom); Modify `src/server/db/schema/viagens.ts` (`internacional boolean not null default true`, `nota_cliente text null`, `vendida_em timestamptz null`, `conciliada_em timestamptz null`; enum `status_orcamento` + `'vendida'`), `rls.test.ts`

- `vendas`: `id`, `viagem_id unique`, `versao_id references versoes_precificacao`, `aceite_em date`, `forma jsonb`, `parcelas int`, `primeiro_vencimento date`, `total bigint`, `fatura_nome text`, `fatura_documento text` (CPF 11 ou CNPJ 14 dígitos), `comprovante text null`, `observacao text null`, `criado_por`, `criado_em`.
- `parcelas_receber`: `id`, `viagem_id`, `venda_id`, `numero`, `total_parcelas`, `vencimento date`, `valor bigint`, `meio meio_recebimento`, `taxa_prevista bigint`, `status` (`a_receber`,`recebida`,`cancelada`), `recebida_em date null`, `valor_recebido bigint null`, `taxa_efetiva bigint null`, `observacao`.
- `contas_pagar`: `id`, `viagem_id`, `item_id`, `cotacao_id`, `fornecedor_id null`, `descricao`, `aereo bool`, `moeda`, `valor_original bigint`, `cambio_aplicado numeric(10,4) null`, `previsto_venda_brl bigint` (fixo, base da ponte), `previsto_brl bigint` (atual), `comissao_pct`, `comissao_tipo`, `desconto_a_vista_pct null`, `forma forma_pagamento_fornecedor null`, `status` (`a_pagar`,`paga`,`cancelada`), `contestacao text null`, `contestada_em null`, `motivo_previsto text null`, `excluido_em`.
- `pagamentos_fornecedor`: `id`, `conta_id`, `numero`, `vencimento date`, `valor_original bigint`, `valor_brl_previsto bigint`, `status` (`a_pagar`,`pago`), `pago_em date null`, `valor_original_pago bigint null`, `cambio_efetivo numeric(10,4) null`, `valor_brl_pago bigint null`.
- `comissoes`: `id`, `viagem_id`, `conta_id`, `fornecedor_id null`, `base_brl bigint`, `pct numeric(6,3)`, `valor_previsto bigint`, `prevista_para date`, `status` (`prevista`,`recebida`,`nao_recebida`), `recebida_em null`, `valor_recebido null`, `motivo text null`.
- RLS e índices por `viagem_id`/`conta_id`; CHECKs: valores ≥ 0, documento só dígitos 11 ou 14.
- [ ] **Step 1:** RLS para as 5 tabelas novas (RED).
- [ ] **Step 2–3:** Esquema, migrações (o `ALTER TYPE … ADD VALUE` fica sozinho na migração custom, fora de transação se o drizzle-kit exigir), `db:migrate`; validar do zero e sobre banco populado.
- [ ] **Step 4:** Todos os testes + `seed:local`. PASS.
- [ ] **Step 5:** Commit `feat: tabelas da venda, parcelas, contas a pagar e comissões`.

### Task 3: Fechamento da venda (servidor)

**Files:** Create `src/server/actions/vendas.ts`, `src/server/queries/vendas.ts`, `src/domain/venda-entrada.ts`; Modify `src/server/actions/viagens.ts` e `aprovacoes.ts` (recusar mutações/envio em `vendida`: "Viagem vendida: ajustes de valor vão em Contas a pagar"), `src/domain/viagens-entrada.ts` (+ `internacional`), `src/server/queries/viagens.ts` (expor `internacional`, `notaCliente`)
Test: `tests/integracao/vendas.test.ts`

- `fecharVenda(viagemId, { aceiteEm, forma, parcelas, primeiroVencimento, faturaNome, faturaDocumento, comprovante?, observacao? })` — `comPerfil(["consultor","operacional","diretor"])`; trava; exige `status = 'aprovado'` (**Review Focus 2**: em `em_edicao` → mensagem da seção); `forma` deve ser igual à da versão aprovada (tipo, antecipado; parcelas ≤ as aprovadas no caso de cartão/boleto? → regra: tipo e antecipado iguais e parcelas iguais; diferente → "A forma acordada é diferente da aprovada. Envie a nova forma para o Diretor."); cria venda, parcelas (`cronogramaRecebimento` do total = preço ao cliente gravado no `resultado` da versão), contas + pagamentos à vista padrão + comissões (`contasDoSnapshot`); viagem → `vendida`, `vendida_em`; auditoria.
- `pedirNovaForma(viagemId, { forma, nota })` — mesmos perfis; exige `aprovado`; nova versão `aguardando` (snapshot, preço, dias, regras e rateio da aprovada; `alteracao` = "Nova forma de pagamento acordada com o cliente: <nota>"); viagem → `aguardando_aprovacao`.
- `registrarAjustesCliente(viagemId, nota)` — mesmos perfis; exige `aprovado`; viagem → `em_edicao`, `nota_cliente = nota`.
- `listarPropostas()` — login; viagens `aprovado` (aguardando resposta do cliente) + `vendida` nos últimos 30 dias + `em_edicao` com `nota_cliente`; campos do protótipo (código, versão, cliente, destino, período, passageiros, consultor, preço ao cliente, forma aprovada, aprovado em/por).
- Mensagens: "Esta viagem já foi vendida", "Informe a data do aceite", "Informe o primeiro vencimento", "Informe o nome da fatura", "CPF ou CNPJ inválido", "Escreva o pedido do cliente", "Sem permissão".
- [ ] **Step 1:** Testes: fechar venda gera N parcelas somando o total, contas = itens não-Taxa, comissões só `a_receber`; **Review Focus 1** (Promise.all de duas vendas → uma; outra "Esta viagem já foi vendida"); **Review Focus 2**; forma diferente recusada; `pedirNovaForma` cria versão aguardando com o mesmo preço e a nova forma; `registrarAjustesCliente` volta a `em_edicao` com nota; salvar item em viagem vendida recusado; financeiro chamando `fecharVenda` → "Sem permissão".
- [ ] **Step 2–4:** RED, implementar, GREEN.
- [ ] **Step 5:** Commit `feat: fechamento da venda`.

### Task 4: Baixas, contas a pagar e conciliação (servidor)

**Files:** Create `src/server/actions/financeiro-viagem.ts`; Modify `src/server/queries/vendas.ts` (`obterViagemVendida`); Test `tests/integracao/financeiro-viagem.test.ts`

- Actions (todas `comPerfil(["diretor","fin_operacional","fin_estrategico"])`, trava da viagem, auditoria):
  - `definirFormaFornecedor(contaId, forma)` — só sem pagamento baixado; refaz as linhas de pagamento.
  - `definirComissaoTipo(contaId, tipo, previstaPara?)` — só sem pagamento baixado; recalcula previsto e cria/cancela comissão.
  - `atualizarPrevisto(contaId, valorBrl, motivo)` — motivo obrigatório.
  - `contestar(contaId, texto)`.
  - `baixarParcela(parcelaId, { recebidaEm, valorRecebido, taxaEfetiva? })`, `desfazerBaixaParcela(parcelaId)`, `cancelarParcela(parcelaId, motivo)`.
  - `baixarPagamento(pagamentoId, { pagoEm, valorOriginalPago, cambioEfetivo? /* obrigatório se moeda ≠ BRL */ })` → `valor_brl_pago` = conversão; conta `paga` quando todas as linhas pagas; `desfazerBaixaPagamento`.
  - `registrarComissao(comissaoId, { recebidaEm, valorRecebido })`, `comissaoNaoRecebida(comissaoId, motivo)`, `desfazerComissao(comissaoId)`.
  - `conciliar(viagemId)` — tudo baixado (senão "Ainda há valores em aberto: <lista curta>"), grava `conciliada_em`.
- `obterViagemVendida(viagemId)` — login; resumo (valor vendido = total a receber, recebido, a receber, pago a fornecedores, a pagar, status derivado), parcelas, contas com pagamentos e comissões, divergências (contas com `previsto_brl ≠ previsto_venda_brl`, contestadas, comissões pendentes); **só para camada estratégica**: margem planejada (da versão) e real (`margemReal`), ponte.
- [ ] **Step 1:** Testes: **Review Focus 4** (consultor em cada action → "Sem permissão", nada gravado); **Review Focus 5** (baixar, desfazer, baixar com outro valor → um registro, auditoria com 3 linhas, margem real com o último valor); pagamento em EUR com câmbio efetivo maior que o da venda → `valor_brl_pago` maior e ponte mostra "Diferença de câmbio"; comissão `a_receber` pendente aparece na ponte e entra na margem real só quando recebida; conciliar com algo em aberto recusado e com tudo baixado grava a data; consultor em `obterViagemVendida` não recebe chaves de margem (`JSON.stringify` sem "margem", "ponte", "imposto").
- [ ] **Step 2–4:** RED, implementar, GREEN.
- [ ] **Step 5:** Commit `feat: baixas, contas a pagar e conciliação da viagem`.

### Task 5: Tela de Fechamento da venda

**Files:** Create `src/app/(app)/vendas/**`; Modify `src/domain/perfis.ts` (`/vendas` para todos, ações conforme servidor), `src/components/shell.tsx` (Comercial › Fechamento da venda), página da viagem (botão "Registrar resposta do cliente" quando `aprovado`)

Visual de `vendas/page.tsx` do protótipo: lista de propostas (badges "Aguardando resposta do cliente" ouro, "Venda confirmada, com o financeiro" agua, "Cliente pediu ajustes" cinza); painel com preço, forma e aprovação; "Resposta do cliente" (Cliente aprovou / Cliente pediu ajustes); formulário do aceite com cronograma ao vivo (mesma função de domínio) e aviso de forma diferente com o botão "Enviar a nova forma para aprovação"; texto "Ao confirmar, o sistema faz sozinho:" com só o que esta fatia faz (muda a viagem para Vendida; lança parcelas a receber e contas a pagar; avisa o financeiro — o aviso é a própria lista "Venda confirmada" até a fatia de Avisos; **sem** Trello/Drive/fatura). Card "Enviada ao financeiro" após confirmar.
- [ ] Teste de rota RED/GREEN; implementar; verificações completas; Playwright (localhost) com o orçamento aprovado do seed: forma diferente → nova versão aguardando; mesma forma → venda confirmada, parcelas certas. Commit `feat: tela de fechamento da venda`.

### Task 6: Tela da viagem vendida

**Files:** `src/app/(app)/viagens/[id]/**` (quando `vendida`: resumo + abas Entradas, Saídas, Conciliação, e Precificação somente leitura), `src/app/(app)/viagens/page.tsx` (status derivado e coluna "Margem planejada × real" só estratégica)

Visual de `viagens/[id]/page.tsx` do protótipo: cards Valor vendido, Recebido, A receber, Pago a fornecedores, A pagar, e (estratégico) "Margem planejada × real" com seta e diferença em p.p. (abaixo da referência em `ouro`); Entradas (parcela, forma, vencimento, valor, status; botão "Dar baixa" só para financeiro/diretor com data, valor e taxa efetiva); Saídas (fornecedor/cidade, descrição, valor previsto e "orçado R$ X" quando divergente, vencimento, forma, status Pago/A pagar/No cartão/Contestada; ações para financeiro: forma de pagamento, tipo de comissão, dar baixa com câmbio efetivo, atualizar previsto com motivo, contestar); Conciliação (frase "Margem planejada de X, margem real de Y", ponte, tabela orçado × realizado com situação, comissões pendentes com "Marcar recebida"/"Não será recebida", botão "Conciliar viagem"). Badge de divergências na aba em `ouro`. Sem vermelho.
- [ ] Implementar; verificações completas; Playwright: financeiro baixa parcela e pagamento em EUR, atualiza previsto com motivo, marca comissão recebida, vê a ponte mudar; consultor vê entradas/saídas sem margem e sem botões de baixa. Commit `feat: tela da viagem vendida`.

### Task 7: Aviso de passaporte × volta e seed

**Files:** `src/server/queries/clientes.ts` (passar viagens `aprovado`/`vendida` futuras do cliente para `alertasDoCliente`; chip "Documentos pendentes" conta esses avisos), página da viagem (bloco "Resolver antes do embarque"), formulário do orçamento (`internacional`), `scripts/seed-orcamentos.ts` (caso Ribeiro do protótipo: viagem vendida com entradas 1 recebida + 5 boletos, contas com Florença divergente e contestada, comissão Mediterrânea pendente; uma viagem conciliada; fornecedores do caso Itália ligados aos fornecedores semeados quando existirem)
- [ ] Testes de integração do aviso (cliente com viagem vendida e passaporte vencendo antes de volta + 182 dias → aviso e chip); implementar; verificações completas; `seed:local` duas vezes; Playwright rápido na ficha do cliente. Commit `feat: aviso de passaporte pela data de volta e seed de vendas`.
