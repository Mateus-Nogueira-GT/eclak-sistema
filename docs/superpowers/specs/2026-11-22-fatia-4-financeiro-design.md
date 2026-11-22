# Fatia 4 — Financeiro (desenho)

Data: 22/11/2026 · Base: `claude/fatia-3b-venda` · Desenho geral: `2026-11-18-backend-sistema-real-design.md` (seção 6, item 4) · HANDOFF: `docs/HANDOFF.md` (em `main`)

## 1. Intenção e porquê

Hoje o financeiro da ECLAK (Valeska) trabalha no Conta Azul e em planilhas (CUSTOS FIXOS.xlsx, PLANILHA NOTAS FISCAIS.xlsx). As fatias 3a/3b já põem no sistema o dinheiro **de cada viagem** (parcelas do cliente, contas do fornecedor, comissões, baixas, margem real). Falta o financeiro **da empresa**: as contas que não são de viagem (aluguel, salários, impostos, cartão corporativo), a fatura numerada que vai ao cliente, e o caixa projetado com a meta de reserva.

Retorno da Valeska (confirmado pelo Mateus em 22/11/2026): **o financeiro deve ser parecido com o Conta Azul** no que a equipe usa no dia a dia. Sucesso = a Valeska deixar de abrir o Conta Azul para contas a pagar e receber, e o Diretor ver no sistema quanto caixa terá nos próximos 12 meses e quanto falta para a reserva.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Uma **lista única de lançamentos** a pagar e a receber, no padrão do Conta Azul (abas, filtros, totais no topo, baixa individual e em lote, parcelamento, recorrência, anexos, categorias em dois níveis editáveis).
- Parcelas, contas a pagar ao fornecedor e comissões das viagens aparecem **na mesma lista**, com origem "Viagem ECL-NNNN-NN", **sem duplicar dados**; a baixa é **a mesma** de qualquer lado.
- Faturas numeradas **a partir de 1405, sem buracos**, com impressão.
- Fluxo de caixa com projeção de no mínimo 12 meses e meta de reserva de 6 meses de custo fixo.
- Notas fiscais com anexo (PDF) e faturas do cartão corporativo.

**Não-objetivos (decididos com o Mateus em 22/11/2026)**
- **Importação** de lançamentos do Conta Azul ou das planilhas. Contas em aberto e fixas são lançadas à mão (a recorrência ajuda).
- **Extrato OFX e conciliação bancária automática**: fatia 6, como no desenho geral. Integração direta com banco: fora até haver banco definido.
- Leitura automática de notas do Google Drive (fatia 6). Aqui é upload.
- DRE, relatórios gerenciais e Visão geral (fatia 6).

**Anti-objetivos (falha mesmo que "funcione")**
- A mesma parcela de viagem existir em dois lugares (lista do financeiro e viagem) com valores ou situação diferentes.
- Margem real mudar por causa desta fatia (o cálculo da 3b é a fonte e não é tocado).
- Número de fatura pulado ou repetido.
- Pagamento com cartão direto no fornecedor (`cartao_fornecedor`) contado no caixa da ECLAK.
- Consultor ou Operacional vendo contas da empresa (salários, pró-labore, distribuição de lucros).

## 3. Restrições

Todas as Global Constraints das fatias 1–3b (HANDOFF §4): centavos `bigint`, percentuais string, `arredondar` meio-para-cima, repartição truncada com a última absorvendo; "hoje" em `America/Cuiaba`; `comPerfil` no início de toda action e `exigirPerfil` em toda query; auditoria na mesma transação; exclusão lógica (lançamento nunca apagado: cancelado); RLS em toda tabela nova + `rls.test.ts`; valor novo de enum em migração própria; `travarViagem` antes de escrever em dinheiro de viagem; erros de banco logados só com o código; marca (azul dominante, laranja só destaque, sem vermelho — atrasado em `ouro` —, sem gradiente, sem emoji, sem estrelinha); textos pt-BR; desktop 1440–1920.

**Acesso:** as telas desta fatia (`/financeiro/lancamentos`, `/financeiro/faturas`, `/financeiro/caixa`, `/financeiro/notas-fiscais`, `/financeiro/categorias`) são de `diretor`, `fin_operacional` e `fin_estrategico`. Consultor e Operacional não veem. Baixas continuam só desses três perfis (já era a regra da 3b). Valores da lista são operacionais; nada da camada estratégica (margem, imposto, rateio) aparece nelas.

## 4. Abordagens consideradas

| | Abordagem | Troca |
|---|---|---|
| **Escolhida (Mateus, 22/11/2026)** | **A. Tabela nova `lancamentos` só para o que é lançado à mão + uma consulta que une as quatro fontes** (`lancamentos`, `parcelas_receber`, `pagamentos_fornecedor`, `comissoes`). Baixa de linha de viagem chama a action da 3b. | Margem real e testes da 3b intactos; dado de viagem mora num lugar só. Custo: a consulta da lista (filtros, totais, paginação) precisa funcionar sobre a união. |
| Descartada | B. Livro-caixa único; tabelas da 3b passam a apontar para `lancamentos` e a baixa muda para lá. | Lista simples, mas refaz baixas, margem real e conciliação da 3b já revisadas, com migração de dados. Risco alto. |
| Descartada | C. Copiar linhas de viagem para `lancamentos` e sincronizar. | Duplica dados (vai contra o pedido da Valeska) e as cópias divergem. |

## 5. O que foi decidido (com o Mateus)

- Padrão Conta Azul conforme o retorno da Valeska (§2). Campos do lançamento: fornecedor/cliente, descrição, categoria, centro de custo (MT/RS), competência, emissão, vencimento, valor, forma de pagamento, conta bancária, parcela "n/N", observação.
- Formas de pagamento: A prazo, Boleto bancário, Cartão de crédito, Cartão de débito, Débito em conta, Depósito bancário, Dinheiro, PIX, Transferência.
- Ponto de partida visual e de dados: `eclak-mockup/src/app/contas/page.tsx` (categorias iniciais, formas, competência, centro de custo, origem).
- Sem importação; OFX na fatia 6; **fatura começa em 1405**.
- Abordagem A.
- Divisão em duas entregas (proposta aceita): **4a** e **4b** (§7).

## 6. Desenho

### 6.1 Lista única de lançamentos

**Fontes e como cada uma vira linha da lista** (uma linha = um vencimento):

| Fonte | Lado | Linha | Categoria | Centro de custo | Pessoa | Parcela n/N |
|---|---|---|---|---|---|---|
| `lancamentos` (novo) | pagar ou receber | cada lançamento | a escolhida | o escolhido | fornecedor, cliente ou texto livre | do parcelamento/recorrência |
| `parcelas_receber` | receber | cada parcela | "Vendas de viagem" (fixa) | filial da viagem (Rondonópolis→MT, RS→RS) | nome da fatura da venda | `numero/total_parcelas` |
| `pagamentos_fornecedor` | pagar | cada pagamento | "Fornecedores de viagem" (fixa) | filial da viagem | fornecedor da conta | `numero/N da conta` |
| `comissoes` (tipo `a_receber`) | receber | cada comissão | "Comissões de hotel" (fixa; ver §9) | filial da viagem | fornecedor | — |

- Origem mostrada: "Viagem ECL-NNNN-NN" com link para a viagem (aba Entradas/Saídas); lançamentos manuais mostram "Lançado à mão".
- Linhas de viagem são **só leitura** na lista, exceto baixa / desfazer baixa e anexos. Valor, vencimento e forma se mudam na viagem (como hoje).
- Contas a pagar de viagem **ainda sem forma de pagamento ao fornecedor** (sem `pagamentos_fornecedor`) aparecem como uma linha "Forma a definir", vencimento = início da viagem, valor = `previsto_brl`, sem botão de baixa (link para a viagem). Assim o caixa não as esquece.
- `cartao_fornecedor` (cliente paga direto ao fornecedor) — **regra (a), Mateus 22/11/2026, a confirmar com a Valeska:** o cliente passa o pacote inteiro na maquininha de **um** fornecedor, que fica com o custo dele e repassa a diferença à ECLAK. A venda passa a registrar **qual fornecedor recebeu** (coluna nova em `vendas`, obrigatória para essa forma; nas vendas já existentes, pedida na tela da viagem com aviso até ser preenchida). Efeito na lista e no caixa: a parcela do cliente aparece como **"Repasse de <fornecedor>"**, a receber, pelo valor da parcela menos o previsto das contas desse fornecedor na viagem; as contas desse fornecedor ganham o selo "Pago pelo cliente no cartão do fornecedor" e ficam **fora** dos totais e do caixa. As contas dos demais fornecedores seguem normais. A margem real da 3b não muda (continua usando preço, custos e taxas como hoje).
- Pagamentos com forma `cartao_corporativo`: na 4a aparecem como linha comum com a data informada; na 4b passam a compor a fatura do cartão (§6.5) e saem da lista como linhas soltas.
- Cancelados (parcela cancelada, comissão não recebida, lançamento cancelado, pagamento de conta excluída) não entram nos totais; aparecem só com o filtro "Canceladas".

**Abas e filtros:** abas "A pagar" e "A receber" (e "Todos" com saldo). Filtros: período (por vencimento; alternável para competência e para data da baixa), situação (Em aberto, Vencidas, Vencem hoje, A vencer, Pagas/Recebidas, Canceladas), categoria (grupo ou categoria), centro de custo, conta bancária, origem (Viagem / Lançado à mão), busca por texto (descrição, pessoa, código da viagem, número da fatura). Paginação no servidor.

**Totais no topo** (do filtro, exceto situação): Vencidos, Vencem hoje, A vencer, Pagos/Recebidos (no período). Valor de linha em aberto = previsto; de linha baixada = valor efetivamente pago/recebido.

**Situação** é derivada, nunca gravada: baixada → Paga/Recebida; cancelada → Cancelada; vencimento < hoje → Vencida (tom `ouro`); = hoje → Vence hoje; senão A vencer.

**Implementação da união:** uma query em `src/server/queries/financeiro.ts` com `UNION ALL` das quatro fontes, normalizando para o mesmo formato de linha (`origem_tipo`, `origem_id`, lado, vencimento, competência, valor previsto, valor baixado, data da baixa, situação base, categoria_id, centro, conta_bancaria_id, pessoa, descrição, parcela, viagem_id/código, fatura_numero, transita_caixa). Filtros e totais aplicados sobre a união no SQL (nunca carregar tudo e filtrar em TS). Pode ser uma **view** no banco (migração custom) se simplificar; decisão do builder, desde que a regra (o que entra, categoria fixa, transita ou não) fique em um lugar só e testada.

### 6.2 Lançamentos manuais

- Tabela `lancamentos`: lado, descrição, pessoa (fornecedor_id **ou** cliente_id **ou** texto), categoria_id, centro (MT/RS), competência (mês, `AAAA-MM`), emissão, vencimento, valor (centavos), forma, conta_bancaria_id, observação, grupo (id do parcelamento/recorrência), parcela número/total, status (`em_aberto`, `baixado`, `cancelado`), dados da baixa (data, valor pago, juros/multa, desconto, conta bancária), auditoria.
- **Parcelamento:** valor total em N parcelas mensais (até 60), truncadas ao centavo, a última absorve; vencimentos mês a mês no mesmo dia (último dia do mês quando não existe — mesma regra de `cronogramaRecebimento`).
- **Recorrência:** mensal (padrão), semanal, anual; com quantidade (até 60) — gera todas as linhas de uma vez, como o Conta Azul. Editar ou cancelar oferece "só esta" ou "esta e as próximas em aberto"; linhas baixadas nunca mudam.
- **Baixa:** data (não futura), valor pago, juros/multa e desconto opcionais, conta bancária. Valor pago diferente do previsto sem juros/desconto exige observação. Desfazer baixa volta a "em aberto", com auditoria.
- **Cancelar** (no lugar de excluir): exige motivo; some dos totais.
- Excluir de verdade: não existe (lançamento financeiro nunca é apagado).

### 6.3 Baixa única e em lote

- Baixa de linha de viagem pela lista chama **as mesmas funções** de `src/server/actions/financeiro-viagem.ts` (`baixarParcela`, `baixarPagamento`, `registrarComissao` e os "desfazer"). A lógica de escrita deve ficar numa função interna compartilhada que recebe a transação, para que lote e individual usem o mesmo código.
- As três tabelas da 3b ganham `conta_bancaria_id` (nulo só para baixas antigas). **Conta bancária é obrigatória em toda baixa nova**, na lista e na tela da viagem; por isso o cadastro de contas bancárias vem antes das mudanças de baixa no plano.
- **Valor que chega ao banco:** parcela de cartão de crédito entra no caixa pelo valor recebido **menos a taxa efetiva** (líquido); na projeção, valor da parcela menos a taxa prevista. Boleto, idem com a taxa por boleto. Data: a do vencimento da parcela; se a forma for crédito **com antecipação**, a projeção põe todas as parcelas em aberto na data do primeiro vencimento (a adquirente adianta tudo).
- **Lote:** marcar várias linhas em aberto (manuais e/ou de viagem, mesmo lado) → informar data e conta bancária → cada uma é baixada pelo **valor previsto** numa única transação. Se alguma linha marcada exige dado individual, o lote inteiro é recusado e a tela diz quais linhas tirar. Exigem dado individual: pagamento em moeda estrangeira (exige câmbio efetivo), parcela de cartão com taxa a confirmar (se o builder concluir que a taxa prevista basta, pode aceitar), linhas "Forma a definir", "Não transita pelo caixa". Travas de viagem tomadas em ordem crescente de `viagem_id` para não haver impasse.
- Pendências da 3b resolvidas aqui: `baixarParcela` passa a **acrescentar** a observação em vez de sobrescrever; **botão "Cancelar parcela"** na aba Entradas da viagem (a action já existe); `definirFormaFornecedor` deixa de apagar pagamentos em aberto quando houver vínculo (fatura de cartão na 4b) — recusa com mensagem até o vínculo ser desfeito; antes disso, segue como está.

### 6.4 Faturas (4a)

- Cada venda gera **uma fatura** (como no protótipo: "Fatura 1502, parcela 3/4"). O número é dado quando o financeiro **emite a fatura** na tela Faturas ("Vendas para faturar" → "Emitir fatura"), não no fechamento da venda — é o fluxo do protótipo e a Valeska emite as faturas hoje. (Corrige o que foi dito na conversa, que era no fechamento; ver §9.)
- Numeração: tabela contadora de uma linha (`faturas_contador.proximo`), lida com `for update` dentro da transação que emite (depois da trava da viagem), incrementada e gravada; fatura com `numero` único. Sem `sequence` do Postgres (sequência pula número em rollback).
- Número inicial **1405**; o Diretor pode ajustar o próximo número em Admin › Parâmetros **enquanto nenhuma fatura tiver sido emitida**; depois só avança.
- Fatura nunca é apagada nem renumerada. Cada emissão grava um **retrato fixo** (`faturas_versoes`: dados da fatura, total, parcelas com vencimento e valor). Se as parcelas da venda mudarem depois (nova forma, cancelamento, ajuste), a tela Faturas mostra "Fatura desatualizada" e o financeiro clica **Reemitir**: nova versão, **mesmo número**. Nenhuma action da 3b precisa mexer na fatura; a comparação é feita na leitura. O PDF mostra a versão escolhida (padrão: a última), com a data de emissão. Cancelamento da venda não existe hoje; se existir, a fatura fica "cancelada" com o número preservado.
- Impressão/PDF como a proposta da 3a (página de impressão do navegador). Conteúdo mínimo: número, emissão, nome/CPF-CNPJ da fatura (já na venda), viagem e destino, valor total, forma e cronograma de parcelas com situação. **O layout final segue o modelo atual da ECLAK (FATURA_1405_ANGELOTHUM_ITALIA_….pdf)**, que ainda não foi enviado; até lá, layout do protótipo.
- As parcelas da lista mostram "Fatura 1405" na descrição quando a fatura existe.

### 6.5 Fluxo de caixa, reserva, notas fiscais e cartão corporativo (4b)

- **Contas bancárias** (cadastro simples na 4a, Admin › Contas bancárias: nome, banco, saldo inicial com data, ativa). Saldo atual = saldo inicial + baixas recebidas − baixas pagas desde a data.
- **Fluxo de caixa:** saldo atual (soma das contas) + projeção semanal nas próximas 8 semanas e mensal por **12 meses** a partir das linhas em aberto da lista única (mesma consulta, só as que transitam pelo caixa). Vencidas em aberto entram na semana atual, marcadas. Filtros: centro de custo, viagem, tipo (clientes, fornecedores, contas da empresa, cartão). Gráfico como `cash-chart.tsx` do protótipo.
- **Reserva:** meta = 6 × custo fixo mensal. Custo fixo mensal = o valor vigente em Parâmetros (o mesmo da margem; ver §9). Mostra quanto temos (saldo atual), quanto falta e em que mês da projeção a meta é atingida (texto do `reserva-projecao.tsx`).
- **Notas fiscais:** cadastro de nota (número, data, valor, destinatário, CPF/CNPJ, viagem/fatura opcional) com **PDF anexo** no Supabase Storage (bucket privado, URL assinada curta gerada no servidor). Lista com filtros por período e destinatário. Colunas da PLANILHA NOTAS FISCAIS.xlsx quando ela chegar.
- **Anexos de lançamento** (Conta Azul): mesmo mecanismo de Storage; por isso a 4a pode entregar a lista sem anexo e a 4b liga anexos a lançamentos e notas. (Se o builder preferir pôr o Storage na 4a, pode.)
- **Cartão corporativo:** cadastro do cartão (nome, final, dia de fechamento, dia de vencimento, conta bancária de débito). Compras: lançamentos manuais com forma "Cartão de crédito" + cartão, e pagamentos a fornecedor com forma `cartao_corporativo`. Cada compra cai na fatura do mês pelo dia de fechamento; a fatura do cartão aparece na lista como **uma** linha a pagar (categoria "Cartão corporativo", custo variável) com o total das compras; as compras saem da lista como linhas soltas e ficam no detalhe da fatura. Baixar a fatura do cartão quita as compras. Detalhes dos cartões são pergunta aberta no `PRODUCT.md` (quantos cartões, fechamento) — o cadastro cobre sem precisar saber.

### 6.6 Categorias

- Tabela `categorias_financeiras`: lado, grupo, nome, ativa, `sistema` (as fixas usadas pelas linhas de viagem: "Vendas de viagem", "Fornecedores de viagem", "Comissões de hotel"; podem ser renomeadas, não desativadas nem trocadas de lado).
- Dois níveis (grupo › categoria), editável por Diretor e financeiros na tela Categorias (como o card "Categorias financeiras" do protótipo). Desativar categoria em uso: ela some dos formulários, continua nos lançamentos antigos.
- Seed inicial (migração, não só seed local, pois vai para produção): as categorias de `categoriasIniciais` do protótipo. Quando o plano "seed_conta_azul_categories" chegar, substituir/complementar antes do deploy.

## 7. Divisão em entregas

**4a — Lançamentos e faturas:** categorias, contas bancárias, `lancamentos` (parcelamento, recorrência, baixa, cancelamento), lista única com as linhas de viagem, totais, filtros, baixa em lote, conta bancária nas baixas da 3b, faturas numeradas a partir de 1405 com impressão, pendências da 3b listadas em §6.3.

**4b — Caixa:** saldo das contas, fluxo de caixa 8 semanas + 12 meses, reserva, Storage com anexos de lançamentos e notas fiscais, cartão corporativo com faturas, ajuste de `definirFormaFornecedor` para o vínculo com fatura de cartão.

Cada entrega tem plano próprio em `docs/superpowers/plans/` e PR empilhado (4a com base `claude/fatia-3b-venda`; 4b com base na 4a).

## 8. Deixado ao builder

- View no banco × union na query (§6.1), desde que a regra fique num lugar só.
- Nome exato das rotas e organização do menu "Financeiro".
- Componentes visuais (reaproveitar o kit do protótipo já portado).
- Limites de paginação e tamanho máximo de anexo (sugestão: 10 MB, só PDF/imagem).
- Seed local com lançamentos fictícios (só local).
- Testes: domínio (parcelamento, recorrência, situação, totais, projeção, número de fatura) e integração (lista une as quatro fontes sem duplicar; baixa pela lista = baixa pela viagem, margem real igual; lote atômico; fatura sem buracos com emissões concorrentes; perfis sem acesso recebem "Sem permissão"; RLS das tabelas novas).

## 9. Decisões do Claude (para o Mateus conferir)

1. **Fatura numerada na emissão pelo financeiro**, não no fechamento da venda (segue o protótipo; corrige o que disse na conversa).
2. Fatura reemitida mantém o número (versão nova) quando a venda muda.
3. Comissões a receber entram como "Comissões de hotel"; se o fornecedor for operadora, deveria ser "Comissões de operadora" — o builder usa o tipo do fornecedor se existir esse dado; senão, "Comissões de hotel".
4. Conta de fornecedor sem forma definida aparece como "Forma a definir" com vencimento no início da viagem.
5. Lote recusado inteiro quando tem linha que exige dado individual (moeda estrangeira etc.).
6. Custo fixo da reserva = o valor de Parâmetros (o mesmo usado na margem). Calcular das contas fixas fica para depois, com o histórico real.
7. Telas do financeiro só para Diretor e os dois financeiros.
8. Categorias iniciais do protótipo entram por migração (vão para produção), ajustáveis.
9. Lançamentos manuais sem anexo na 4a (anexos chegam com o Storage na 4b).
10. Centro de custo das linhas de viagem = filial da **viagem** (não a do cliente).
11. Conta bancária obrigatória em toda baixa nova, inclusive na tela da viagem.
12. Cartão e boleto entram no caixa pelo líquido (menos a taxa); crédito com antecipação projetado todo no primeiro vencimento.
13. Fatura: retrato fixo por emissão, reemissão manual com o mesmo número, aviso de "desatualizada".
14. Cartão direto no fornecedor pela regra (a) acima, até a Valeska confirmar.

## 10. Pendências de material (não bloqueiam a 4a)

- Modelo atual da fatura (FATURA_1405_…pdf) → layout de impressão.
- Plano de categorias Conta Azul 2024 ("seed_conta_azul_categories") → categorias iniciais.
- CUSTOS FIXOS.xlsx → conferência das categorias e da recorrência; base para o custo fixo calculado no futuro.
- PLANILHA NOTAS FISCAIS.xlsx → colunas das notas (4b).
