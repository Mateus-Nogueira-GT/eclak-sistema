# Fatia 6 — Painéis e integrações (desenho)

Data: 23/11/2026 · Base: `claude/fatia-5a-operacao` (PR #7, ainda não mergeado) · Desenho geral: `2026-11-18-backend-sistema-real-design.md` §6 item 6 · HANDOFF: `docs/HANDOFF.md`

## 1. Intenção e porquê

As fatias 1–5a puseram no sistema o dinheiro de cada viagem (margem real), o financeiro da empresa (lista única, faturas, caixa, reserva, cartão) e a operação. Falta a leitura de cima: o Diretor e a gestão financeira abrirem o sistema e verem **o que pede decisão hoje**, o caixa das próximas semanas, a margem do período e os relatórios que hoje saem do Conta Azul e de planilhas (DRE, contas a pagar e a receber, volume por banco, margem por viagem, vendas por consultor).

Depois vêm as integrações (Trello, Google Drive, extrato OFX, chat com IA, Expedia/Infotera). Elas dependem de contas, credenciais e decisões de fora do código; por isso a fatia é dividida:

- **6a — Painéis** (este desenho, detalhado): Visão geral e Relatórios. Só leitura, sem tabela nova, sem migração.
- **6b — Extrato OFX e conciliação** (esboço §6): importa o arquivo OFX que a Valeska baixa do banco e confere com a lista única. Não precisa de credencial, mas precisa de um OFX real e do banco.
- **6c — Integrações externas** (esboço §7): Trello, Drive, IA, Expedia/Infotera, agendador do daily. Cada uma precisa de conta e de "sim" do Mateus.

## 2. Objetivos, não-objetivos e anti-objetivos (6a)

**Objetivos**
- **Visão geral** (`/visao-geral`): frase de topo sobre o caixa das próximas 8 semanas; "Para decidir hoje" com avisos tirados dos dados reais; "No período" (vendido, margem real × planejada, recebido de clientes, pago a fornecedores, resultado de caixa); reserva de caixa; saldo semana a semana (8 semanas); viagens que mais perderam margem.
- **Relatórios** (`/financeiro/relatorios`): DRE, Contas a pagar, Contas a receber, Volume por banco, Margem por viagem, Vendas por consultor. Período escolhido na tela, exportação em planilha (CSV) e impressão (PDF pelo navegador). Cada linha abre o que forma o valor (lista de lançamentos filtrada ou a viagem).

**Não-objetivos**
- Conciliação com extrato OFX (6b). O relatório "Conciliação extrato x planilha" do protótipo não entra na 6a, e o aviso de "pagamento não conciliado" também não.
- Avisos por setor e a tela de notificações (5b). A Visão geral não liga para `/notificacoes`.
- Relatórios salvos, agendados ou enviados por e-mail; gráficos além do semana a semana.
- A tela "Planilha x Sistema" (fora de escopo desde o desenho geral).

**Anti-objetivos (falha mesmo que "funcione")**
- Margem calculada fora de `src/domain/venda.ts` (`margemReal`, via `margensVendidas`). O número do relatório e da Visão geral tem de ser igual ao da tela da viagem.
- DRE contando a mesma coisa duas vezes: custo fixo rateado nas viagens **e** as contas fixas reais; linhas de viagem da lista única **e** a margem das viagens; a fatura do cartão corporativo **e** as compras dela.
- Consultor ou Operacional vendo Visão geral ou Relatórios (camada estratégica).
- Aviso, número ou texto fictício copiado do protótipo (avisos fixos, "33% da meta", "Números de exemplo").

## 3. Restrições

As Global Constraints das fatias anteriores (HANDOFF §4) valem iguais: centavos `bigint`; percentuais string; "hoje" em `America/Cuiaba`; `exigirPerfil` em toda query; marca (azul #2E5C71 dominante, laranja #F26531 só destaque, texto #333132, sem vermelho — o que é ruim vai em `ouro` —, sem gradiente, sem emoji, sem estrelinha); textos pt-BR; desktop 1440–1920.

**Acesso.** `/visao-geral`: `diretor` e `fin_estrategico` (como no protótipo) e passa a ser a **primeira tela** deles depois do login. `/financeiro/relatorios`: os três perfis do financeiro (`diretor`, `fin_operacional`, `fin_estrategico`), que já têm a camada estratégica. Consultor e Operacional não veem nenhuma das duas.

## 4. Abordagens consideradas

| | Abordagem | Troca |
|---|---|---|
| **Escolhida** | **Leitura sobre o que já existe**: margem por `margensVendidas` (domínio da 3b), dinheiro pela view `lancamentos_financeiros` (4a/4b), caixa e reserva por `obterFluxoDeCaixa`. Montagem dos números (DRE, avisos, períodos) em `src/domain/paineis.ts`, puro e testado. | Sem migração, sem segunda fórmula. Custo: relatórios fazem algumas leituras em lote por pedido, aceitável para o volume da ECLAK (dezenas de viagens por mês). |
| Descartada | Views materializadas ou tabelas de resumo no banco | Mais rápido em volume grande, mas duplica a regra da margem em SQL (anti-objetivo do desenho geral) e cria migração em cima de PR não mergeado. |
| Descartada | Biblioteca de relatórios/BI externa (Metabase etc.) | Mais um serviço, outro login, fora da autorização por perfil do servidor. |

## 5. Desenho da 6a

### 5.1 Critérios de período (decisões do Claude, para o Mateus conferir)
Um lugar só (`src/domain/paineis.ts`), escrito na tela ao lado de cada número:
- **Vendido, margem e vendas por consultor:** viagens com **aceite** (`vendas.aceite_em`) no período.
- **Recebido, pago, resultado de caixa e volume por banco:** linhas **baixadas** (`baixado_em`) no período, só as que transitam pelo caixa, pelo **valor de caixa** (`valor_caixa_baixado`, líquido de taxa — a mesma regra do fluxo de caixa; se a Valeska mudar a regra do líquido, muda num lugar só).
- **DRE:** regime de competência. Bloco das viagens no mês do aceite; bloco da empresa pela competência do lançamento (`AAAA-MM`).
- **Contas a pagar e a receber:** pelo vencimento, com a situação de cada linha (como a lista única).
- Períodos na Visão geral: últimos 30 dias (padrão), últimos 90 dias, mês atual, mês anterior, ano atual; período anterior de mesma duração para a variação do vendido. Relatórios: um mês ou um intervalo de meses (padrão: mês atual).

### 5.2 DRE (sem dupla contagem)
1. **Receita de viagens** = Σ `receita` da margem real das viagens com aceite no período.
2. **(−) Custo dos fornecedores** = Σ `custo` (já líquido de comissões recebidas e com a taxa de roteiro).
3. **(=) Margem bruta.**
4. **(−) Imposto sobre a margem** = Σ `imposto` (por viagem, das regras da versão; não o 7% fixo do protótipo).
5. **(−) Taxas financeiras** = Σ `taxas`.
6. **(=) Margem das viagens antes do custo fixo.** O `fixo` rateado da margem **não entra**: o custo fixo real vem do bloco da empresa.
7. **Bloco da empresa**: lançamentos **manuais** (`origem = manual`, inclusive compras no cartão corporativo, que são lançamentos manuais com cartão) **não cancelados**, pela competência, agrupados por grupo › categoria, receitas somando e despesas subtraindo. Ficam de fora: as linhas de viagem da view (`parcela`, `pagamento`, `comissao`, já dentro da margem) e a linha `fatura_cartao` (o total das compras, que já entram uma a uma). Valor = valor previsto do lançamento.
8. **(=) Resultado do período.**
Viagem cuja margem não calcula entra numa nota ("N viagens sem margem calculada, fora da DRE") com link, e não soma.

### 5.3 Visão geral — "Para decidir hoje"
Avisos derivados, nesta ordem, com responsável e link:
1. Caixa: cada semana das próximas 8 com saldo projetado negativo → `/financeiro/caixa`. Responsável: Gestão.
2. Margem: viagem vendida, não conciliada, com margem real abaixo da **margem de referência** (`margemReferenciaPct` vigente) → viagem. Gestão.
3. Parcela de cliente vencida e em aberto → lista filtrada (a receber, vencidas). Financeiro.
4. Comissão de fornecedor vencida e não recebida → lista filtrada. Financeiro.
5. Pagamento a fornecedor ou conta da empresa vencida ou vencendo nos próximos 7 dias → lista filtrada. Financeiro.
6. Só para o Diretor: pedidos aguardando aprovação → `/aprovacoes`. Gestão.
Mostra até 8; se houver mais, "e mais N avisos", cada grupo com seu link. Sem avisos: "Nada pede decisão agora."

### 5.4 Relatórios
| Relatório | Linhas | Abre |
|---|---|---|
| DRE | §5.2 | categoria → lista por competência e categoria; viagens → Margem por viagem |
| Contas a pagar | linhas a pagar com vencimento no período, não canceladas: vencimento, pessoa, descrição, categoria, origem, valor, situação; total por situação | lista filtrada / viagem |
| Contas a receber | idem, a receber | idem |
| Volume por banco | por conta bancária: entradas, saídas e saldo do período (baixas no período) + saldo atual | lista filtrada pela conta e pela data da baixa |
| Margem por viagem | viagens com aceite no período: código, cliente, destino, valor vendido (o mesmo número da tela da viagem), margem planejada, margem real, diferença em pontos | viagem |
| Vendas por consultor | por consultor da viagem: viagens fechadas, valor vendido, margem real média (ponderada pela receita) | Margem por viagem filtrada |

Exportar: "Planilha" baixa CSV (UTF-8 com BOM, `;` como separador, valores em reais com vírgula, para abrir direto no Excel em pt-BR); "PDF" abre a versão para impressão do mesmo relatório.

## 6. Fatia 6b — Extrato OFX e conciliação (esboço)
- Upload do OFX por conta bancária (Storage da 4b); leitura das transações (data, valor, descrição, FITID); FITID único por conta (reimportar não duplica).
- Conciliação: sugere o par na lista única (mesmo valor de caixa, data ±3 dias, mesma conta); a Valeska confirma, ou cria lançamento a partir da transação (tarifa, IOF), ou marca "ignorar". Situações: Confere / Diferença de R$ x / Não conciliado.
- Relatório "Conciliação extrato x sistema" e o aviso "pagamento não conciliado" na Visão geral.
- **Precisa:** um OFX real de cada banco (sem dados sensíveis, ou com autorização), quais bancos/contas, e a confirmação da regra do valor líquido de cartão (pendente com a Valeska).

## 7. Fatia 6c — Integrações externas (esboço)
Cada uma é independente e precisa de conta e de "sim" do Mateus antes de criar credencial:
- **Trello:** cartões das tarefas automáticas (a `chave` estável da 5a evita duplicar). Precisa: quadro, conta, token de API.
- **Google Drive:** pastas `ECL-NNNN_TITULAR_DESTINO_ini-fim`, documentos de passaporte/RG, leitura de notas. Precisa: conta Google da ECLAK, conta de serviço ou OAuth, pasta raiz.
- **Chat e "Reescrever com IA":** precisa: provedor e chave, regra do que pode ir ao modelo (LGPD: nada de CPF/passaporte).
- **Expedia/Infotera:** precisa: contrato e documentação da API.
- **Agendador do daily (D-2) e vouchers em PDF:** precisa do deploy (Railway cron).

## 8. Perguntas para o Mateus (não bloqueiam a 6a)
1. Critérios de período do §5.1 (principalmente DRE pelo mês do aceite e não pelo mês da viagem).
2. A Visão geral também para o Financeiro operacional (Valeska)? No protótipo, não. **Respondida: a Visão geral não aparece para a Valeska (Mateus, 24/11/2026).**
3. 6b: quais bancos e um OFX de exemplo.
4. 6c: qual integração primeiro.
