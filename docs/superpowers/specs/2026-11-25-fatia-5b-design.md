# Fatia 5b — Estoque, Caixa de experiência, Reembolsos e Avisos (desenho)

Data: 25/11/2026 · Base: `main` (depois do PR #17) · Esboço anterior: `2026-11-23-fatia-5-operacao-design.md` §6 · Protótipo: `eclak-mockup/src/app/{estoque,caixa-experiencia,reembolsos,notificacoes}` · HANDOFF: `docs/HANDOFF.md`

Pedido do Mateus (25/11/2026): "Construa 5b". As nove perguntas do esboço seguem sem resposta da Valeska e do grupo; o Mateus decidiu quatro e as demais seguem o protótipo (§10). Cada regra abaixo foi escrita para ser trocada num lugar só.

Decisões do Mateus (25/11/2026):
1. **Reembolso:** a diferença entre o devolvido ao cliente e o recebido do fornecedor é **custo da viagem** (entra na margem real).
2. **Caixa de experiência:** o custo dos itens **entra na margem real** da viagem.
3. **Limite da caixa:** **sem limite por enquanto**; a tela só mostra o total. Nada de aprovação.
4. **Perfis:** Reembolsos e Estoque **só para Diretor e financeiros**. Consultor e operacional só montam a caixa de experiência na viagem.

## 1. Intenção

- **Estoque:** a ECLAK compra brindes e papelaria, guarda em duas filiais (MT = Rondonópolis, RS) e hoje controla em planilha. O sistema passa a saber o que tem, quanto custou e quando está acabando; a compra vira conta a pagar.
- **Caixa de experiência:** cada viagem vendida ganha uma caixa montada com itens do estoque da filial dela. Confirmar a caixa baixa o estoque e o custo aparece na margem real.
- **Reembolsos:** quando o fornecedor falha, a ECLAK cobra dele e devolve ao cliente. As duas pontas têm prazos próprios e hoje se perdem; o caso passa a ter dono, datas e lançamentos no financeiro.
- **Avisos:** uma central para os cinco perfis, por setor, com o próximo passo de cada aviso; dispensar exige justificativa.

## 2. Não-objetivos e anti-objetivos

**Não-objetivos:** limite e aprovação da caixa (decisão 3); transferência de estoque entre filiais; inventário com contagem; aviso por e-mail ou WhatsApp; lido/não lido por pessoa; reduzir a parcela do cliente automaticamente no "abatimento"; crédito do cliente como saldo reutilizável; reembolso em moeda estrangeira (tudo em reais).

**Anti-objetivos (falha mesmo que "funcione"):**
- Estoque negativo, ou dois confirmando a mesma caixa e baixando duas vezes.
- A caixa ou o reembolso contando duas vezes no DRE (uma na margem das viagens, outra na categoria do financeiro).
- Margem real mudando para viagens sem caixa e sem reembolso (a conta atual não pode se mexer).
- Consultor ou operacional vendo Reembolsos, Estoque, margem ou o efeito da caixa na margem.
- Lançamento de reembolso editado ou cancelado direto na lista, deixando o caso incoerente.
- Aviso que some sem registro de quem dispensou e por quê.

## 3. Restrições

As do HANDOFF §4: dinheiro em centavos `bigint`; "hoje" em Cuiabá; `comPerfil` primeiro em toda Server Action; `exigirPerfil` em toda query; auditoria na mesma transação; RLS em toda tabela nova + `rls.test.ts`; enum novo em migração própria (a partir da `0046`); viagem `conciliada` não aceita alteração; travas na ordem viagem → filhos; marca (azul dominante, laranja só destaque, ouro no lugar de vermelho, sem emoji).

## 4. Estoque

### 4.1 Dados
- enum `uso_estoque`: `caixa_experiencia`, `papelaria`. enum `tipo_movimento_estoque`: `entrada`, `saida`, `ajuste`, `caixa`, `devolucao_caixa`.
- `produtos_estoque`: `nome` (único entre os ativos, sem diferenciar caixa), `uso`, `minimo_mt`, `minimo_rs` (inteiros ≥ 0), `ativo`, `criado_em`.
- `estoque_saldos`: um por (`produto_id`, `filial` MT|RS): `quantidade` (inteiro ≥ 0, CHECK), `custo_medio` (centavos ≥ 0). Linha travada (`for update`) em toda movimentação.
- `estoque_movimentos`: `produto_id`, `filial`, `tipo`, `quantidade` (inteiro com sinal, ≠ 0), `custo_unitario` (centavos), `fornecedor_id` ou `fornecedor_texto` (no máximo um; só na entrada), `lancamento_id` (a conta a pagar da entrada), `caixa_id`, `motivo` (obrigatório em `saida` e `ajuste`, 5 a 200 caracteres), `usuario_id`, `criado_em`. Nunca é alterado nem apagado.
- A filial usa o `centro` que já existe (`MT`, `RS`); a viagem tem `filial` (`Rondonópolis` → `MT`, `RS` → `RS`).

### 4.2 Regras
- **Entrada** (compra): produto, filial, quantidade (≥ 1), valor unitário, onde foi comprado (fornecedor do cadastro ou texto livre), vencimento, forma de pagamento e, se a forma pedir, o cartão corporativo (as mesmas regras do lançamento manual). Na mesma transação: movimento, saldo e **uma conta a pagar** pelo núcleo de lançamentos manuais (`valor = quantidade × unitário`, categoria "Caixa de experiência" ou "Papelaria" conforme o uso do produto, centro = filial, descrição "Estoque: <quantidade> × <produto>").
  - Custo médio novo = (quantidade atual × custo médio + quantidade × unitário) ÷ quantidade nova, arredondado ao centavo (meio para cima).
  - A conta a pagar fica ligada ao movimento (`lancamentos.estoque_movimento_id`, coluna nova): na lista única ela pode ser baixada normalmente, mas **não editada nem cancelada** ali ("Lançamento de entrada de estoque: desfaça a entrada no Estoque").
  - **Desfazer entrada:** só se a conta não foi baixada e o saldo da filial tem a quantidade; cancela a conta (motivo "Entrada de estoque desfeita"), grava um movimento `ajuste` negativo ao mesmo custo unitário da entrada e recalcula o custo médio pelo inverso da fórmula (saldo zerado → custo médio volta a 0).
- **Saída manual** (uso interno, brinde avulso, perda): quantidade ≤ saldo, motivo; sai ao custo médio; não gera lançamento.
- **Ajuste** (contagem): quantidade nova da filial e motivo; o movimento guarda a diferença ao custo médio; não gera lançamento.
- **Abaixo do mínimo:** `quantidade < mínimo` da filial (mínimo 0 = sem aviso).
- Produto desativado some das escolhas e mantém o histórico; só desativa com saldo 0 nas duas filiais.

### 4.3 Tela — `/financeiro/estoque` (Diretor e financeiros)
- Cartões: valor em estoque (Σ quantidade × custo médio, as duas filiais), produtos abaixo do mínimo.
- Filtros: uso, filial, "só abaixo do mínimo". Tabela: produto, uso, MT (quantidade e mínimo), RS, custo médio, valor total; quantidade abaixo do mínimo em ouro com "Repor".
- Ações por produto: "Entrada", "Saída", "Ajustar", "Histórico" (movimentos mais recentes primeiro: data, tipo, filial, quantidade, custo, quem, motivo ou viagem). "Novo produto" e "Editar" (nome, uso, mínimos).

## 5. Caixa de experiência

### 5.1 Dados
- enum `situacao_caixa`: `rascunho`, `confirmada`, `cancelada`.
- `caixas_experiencia`: `viagem_id`, `filial`, `situacao`, `custo_total` (centavos; gravado na confirmação), `confirmada_em`, `confirmada_por`, `cancelada_em`, `cancelada_por`, `motivo_cancelamento`, `criado_por`, `criado_em`, `atualizado_em`. Índice único parcial: **uma caixa não cancelada por viagem**.
- `caixa_itens`: `caixa_id`, `produto_id` (único por caixa), `quantidade` (≥ 1), `custo_unitario` (nulo no rascunho; o custo médio da filial no instante da confirmação).

### 5.2 Regras
- Só em viagem **vendida e não conciliada**; a filial é a da viagem.
- **Rascunho:** escolhe produtos de uso "Caixa de experiência" ativos e as quantidades; não mexe no estoque. A tela mostra o disponível na filial e o total estimado pelo custo médio atual.
- **Confirmar:** trava a viagem, a caixa e os saldos (em ordem de `produto_id`); recusa se algum item passa do saldo ("Estoque insuficiente de <produto> em <filial>: há <n>"); grava um movimento `caixa` por item, o `custo_unitario` de cada item e o `custo_total`. Caixa sem itens não confirma.
- **Cancelar a caixa confirmada** (motivo obrigatório): devolve ao estoque com movimentos `devolucao_caixa` ao custo gravado (o custo médio da filial é recalculado como numa entrada); a viagem pode ganhar outra caixa.
- **Editar** só no rascunho; para mudar uma confirmada, cancela e monta outra.
- **Sem limite** (decisão 3): nenhuma regra de valor.
- **Margem real:** `custo_total` da caixa confirmada entra em `ajustes` (§7).

### 5.3 Tela
- Bloco "Caixa de experiência" na página da viagem vendida, para os cinco perfis (consultor e operacional montam, confirmam e cancelam). Mostra itens, quantidades, valor de cada item e total; **não** mostra margem nem o efeito na margem para quem não vê a camada estratégica.
- Para Diretor e financeiros, a ponte da margem real ganha a linha "Caixa de experiência".
- `/financeiro/estoque` ganha a aba "Caixas": viagens vendidas com embarque nos próximos 60 dias, com a situação da caixa (sem caixa, rascunho, confirmada) e link para a viagem.

## 6. Reembolsos

### 6.1 Dados
- enum `forma_devolucao`: `pix`, `transferencia`, `abatimento`, `credito`. enum `situacao_reembolso`: `aberto`, `concluido`, `cancelado`.
- `reembolsos`: `viagem_id`, `conta_pagar_id` (o serviço: uma conta de fornecedor da viagem; opcional), `servico` (texto, obrigatório; preenchido com o da conta quando escolhida), `fornecedor_id` (opcional; vem da conta), `ocorrido_em` (data), `ocorrido` (texto, 10 a 1.000), `valor_cobrar` (centavos ≥ 0), `valor_devolver` (centavos ≥ 0; pelo menos um dos dois > 0), `forma_devolucao`, `prazo_cliente` (data), `previsto_fornecedor` (data, obrigatória se `valor_cobrar` > 0), `pedido_em`, `protocolo`, `recebido_em`, `valor_recebido`, `reembolsado_em`, `valor_devolvido`, `situacao`, `motivo_cancelamento`, `criado_por`, `criado_em`, `atualizado_em`.
- `lancamentos.reembolso_id` (coluna nova): liga as duas contas ao caso.

### 6.2 Regras
- Viagem **vendida** (conciliada ou não: o problema costuma aparecer depois da viagem; ver §7 sobre a margem de viagem conciliada).
- **Registrar** cria, na mesma transação, pelo núcleo de lançamentos manuais:
  - se `valor_cobrar` > 0: conta **a receber**, categoria "Reembolso de fornecedor", vencimento = `previsto_fornecedor`, fornecedor do caso, centro = filial da viagem, descrição "Reembolso <código da viagem>: <serviço>";
  - se `valor_devolver` > 0 e a forma é `pix` ou `transferencia`: conta **a pagar**, categoria "Reembolso a cliente", vencimento = `prazo_cliente`, cliente da viagem, mesma descrição.
  - Formas `abatimento` e `credito` não geram conta a pagar (não sai dinheiro).
- **Marcos:**
  - "Marcar como pedido" (data e protocolo): só registro.
  - "Fornecedor pagou": é a **baixa** da conta a receber (data, valor recebido, conta bancária), pelo mesmo núcleo de baixa da lista; grava `recebido_em` e `valor_recebido`. Sem conta a receber (valor a cobrar 0), o lado do fornecedor nasce concluído.
  - "Cliente reembolsado": com `pix`/`transferencia`, é a **baixa** da conta a pagar (data, valor, conta bancária); com `abatimento`/`credito`, só a data. Grava `reembolsado_em` e `valor_devolvido`.
  - A baixa também pode ser feita na lista única: o caso lê o estado das contas (a baixa na lista preenche os mesmos campos do caso, na mesma transação). Desfazer a baixa na lista reabre o marco.
- Na lista única, conta ligada a reembolso **não é editada nem cancelada** ("Lançamento de reembolso: altere pelo caso em Reembolsos").
- **Editar o caso:** texto, prazos e protocolo sempre; valores e forma só enquanto o lado correspondente não foi baixado (a conta em aberto acompanha o novo valor e vencimento; trocar a forma cria ou cancela a conta a pagar).
- **Situação exibida** (derivada): "Pedir ao fornecedor" (cobrar > 0, sem `pedido_em`), "Aguardando fornecedor e cliente", "Aguardando o fornecedor", "Reembolsar o cliente", "Concluído" (os dois lados fechados → `concluido`), "Cancelado".
- **Cancelar o caso** (motivo): só sem nenhuma baixa; cancela as contas em aberto.
- **Margem real:** §7.

### 6.3 Tela — `/financeiro/reembolsos` (Diretor e financeiros)
- Como no protótipo: cartões (casos abertos, a receber de fornecedores, a devolver a clientes), abas Abertos / Concluídos, "Registrar ocorrência", e um cartão por caso com os dois lados e os passos. Comprovantes pelo componente de anexos que já existe (dono novo `reembolso`).
- Na página da viagem vendida, para Diretor e financeiros: bloco "Reembolsos" com os casos da viagem e link.

## 7. Margem real: a linha "ajustes da viagem"

`margemReal` ganha a entrada opcional `ajustes: { caixa: bigint; reembolsos: bigint }` (padrão `0n` nos dois) e devolve `ajustes` (a soma). **`receita`, `custo`, `imposto`, `taxas` e `fixo` continuam exatamente como hoje**; só muda `final = receita − custo − imposto − taxas − fixo − ajustes` (e `finalPct`).

- `caixa` = `custo_total` da caixa confirmada da viagem (0 sem caixa).
- `reembolsos` = Σ dos casos não cancelados da viagem de (`devolver` − `cobrar`), em que:
  - `cobrar` = `valor_recebido` se o fornecedor pagou, senão `valor_cobrar`;
  - `devolver` = `valor_devolvido` se reembolsado, senão `valor_devolver`; **0 quando a forma é `abatimento`** (o efeito aparece na parcela recebida a menor, que a margem real já conta; contar aqui dobraria).
  - Pode ser negativo (o fornecedor devolveu mais do que foi repassado ao cliente): aumenta a margem.
- **Imposto:** os ajustes não entram na base do imposto sobre a margem (decisão minha, §10).
- **DRE e Visão geral:** o DRE soma `receita`, `custo`, `imposto` e `taxas` das viagens e, à parte, as categorias do financeiro. A compra do estoque e as contas de reembolso já aparecem nas categorias ("Caixa de experiência", "Papelaria", "Reembolso a cliente", "Reembolso de fornecedor"); como `custo` não muda, **nada conta duas vezes**. A margem real média da Visão geral usa `final` e passa a refletir os ajustes.
- **Ponte da margem** (planejada → real) na viagem: duas linhas novas, "Caixa de experiência" e "Reembolsos", quando diferentes de zero.
- **Viagem conciliada:** a margem real de uma conciliada pode mudar por um reembolso registrado depois; a tela da viagem mostra "Margem alterada por reembolso depois da conciliação" nesse caso. A caixa não muda depois da conciliação.

## 8. Avisos

### 8.1 O que é
Uma página `/avisos` para os cinco perfis, mais um contador no topo (ao lado do nome). Dois tipos:
- **Automáticos:** calculados na hora a partir dos dados (como os da Visão geral hoje); somem sozinhos quando a condição acaba.
- **Comunicados:** escritos por alguém para um setor ou para todos; ficam até alguém do destino resolver.

### 8.2 Setores e quem recebe
Setores: Gestão, Financeiro, Comercial, Operacional, Geral.

| Perfil | Recebe |
|---|---|
| Diretor | Gestão, Financeiro, Comercial, Operacional, Geral (com filtro por setor) |
| Financeiro estratégico | Gestão, Financeiro, Geral |
| Financeiro operacional | Financeiro, Geral |
| Consultor | Comercial, Operacional, Geral |
| Operacional | Operacional, Geral |

Aviso que cita valor da camada estratégica (margem, caixa) só existe nos setores Gestão e Financeiro.

### 8.3 Avisos automáticos
Os sete da Visão geral (caixa, margem, parcela, comissão, pagar, conciliação, aprovação), com os mesmos textos e setores (Gestão ou Financeiro), mais:

| Tipo | Condição | Setor | Próximo passo |
|---|---|---|---|
| `tarefa_vencida` | tarefa aberta com prazo anterior a hoje (uma linha por viagem, com a contagem) | Operacional | Abrir as tarefas da viagem |
| `daily_a_gerar` | daily de hoje ou de amanhã sem texto, de viagem vendida com roteiro aprovado | Operacional | Gerar o daily |
| `aniversario` | passageiro faz aniversário durante uma viagem vendida que começa nos próximos 60 dias ou está em andamento | Comercial | Combinar a surpresa e incluir no roteiro |
| `estoque_minimo` | produto abaixo do mínimo numa filial | Financeiro | Repor o estoque |
| `caixa_a_montar` | viagem vendida com embarque em até 30 dias sem caixa confirmada | Operacional | Montar a caixa na viagem |
| `reembolso_pedir` | caso aberto com valor a cobrar e sem pedido | Financeiro | Pedir o reembolso ao fornecedor |
| `reembolso_fornecedor` | pedido feito, não recebido, previsto vencido | Financeiro | Cobrar o fornecedor |
| `reembolso_cliente` | cliente não reembolsado e prazo em até 3 dias (ou vencido) | Financeiro | Reembolsar o cliente |

Cada aviso tem uma **chave estável** (`tipo:id do alvo`, por exemplo `caixa_a_montar:<viagem>`), título, detalhe, próximo passo, setor e link. A Visão geral continua mostrando os sete dela (sem mudança).

### 8.4 Dispensar e resolver
- **Dispensar** (qualquer pessoa que recebe o aviso): justificativa de 10 a 500 caracteres; grava `avisos_dispensados` (`chave`, `tipo`, `titulo` e `detalhe` como estavam, `usuario_id`, `justificativa`, `criado_em`). O aviso some para todos enquanto a dispensa existir; "Desfazer dispensa" (quem dispensou ou o Diretor) traz de volta. A aba "Dispensados" lista os dos últimos 90 dias, com quem e por quê. Aviso de **caixa negativo** não pode ser dispensado.
- **Comunicado:** `avisos_comunicados` (`setor`, `texto` 5 a 500, `passo` até 200, `criado_por`, `criado_em`, `resolvido_por`, `resolvido_em`). Cria: qualquer perfil, para um setor ou Geral. "Resolver": quem recebe ou quem criou. Resolvidos saem da lista (ficam no banco).
- Avisos automáticos não têm "Resolver": resolvem-se fazendo o próximo passo.

### 8.5 Tela
- Abas "Abertos" e "Dispensados"; filtro "Para mim" (padrão) e, para o Diretor, "Todos os setores" e cada setor. Cartão: tipo em caixa alta, texto, "Próximo passo: …", "Para: <setor>", link "Abrir", botões "Dispensar" (e "Resolver" nos comunicados). "Novo aviso" abre o formulário do comunicado.
- Contador no topo: quantos abertos "para mim"; link para `/avisos`. Calculado no servidor a cada página (sem tempo real).

## 9. Navegação e perfis

- Menu **Financeiro** ganha "Estoque" e "Reembolsos" (`/financeiro/…`, já restrito a Diretor e financeiros).
- `/avisos` entra nas rotas dos cinco perfis; o contador fica no topo do `Shell`.
- Caixa de experiência: bloco na viagem vendida, cinco perfis.
- Seed local: 11 produtos do protótipo com saldos nas duas filiais, uma entrada com conta a pagar, uma caixa confirmada, uma em rascunho, três reembolsos (os três estados do protótipo) e dois comunicados.

## 10. Para o Mateus conferir (decisões minhas, uma por pergunta aberta do esboço)

1. Os lançamentos do reembolso nascem **no registro da ocorrência**, em aberto, e as baixas acontecem nos marcos.
2. "Abatimento na próxima parcela" **não muda a parcela sozinho**: a Valeska dá baixa na parcela pelo valor menor, e é por aí que a margem sente; o caso só guarda a data. "Crédito para a próxima viagem" conta como custo desta viagem e não vira saldo do cliente no sistema.
3. Estoque pelo **custo médio**; saída manual e ajuste com motivo; mínimo **por filial**; sem transferência entre filiais (quem mudar itens de filial faz um ajuste em cada uma, com o motivo).
4. "Onde foi comprado": fornecedor do cadastro **ou** texto livre.
5. Caixa só em viagem vendida e não conciliada, sem prazo antes do embarque; cancelar devolve ao estoque.
6. Os ajustes (caixa e reembolso) **não reduzem a base do imposto** sobre a margem.
7. Avisos: sem lido/não lido por pessoa e sem notificação fora do sistema; o financeiro estratégico recebe Gestão e Financeiro; consultor recebe Comercial e Operacional.
8. Eventos automáticos: a tabela de §8.3. Caixa a montar avisa a 30 dias do embarque; aniversário, a 60.
9. Reembolso pode ser registrado em viagem já conciliada (muda a margem real dela, com aviso na tela).

## 11. Abordagens

**Onde somar caixa e reembolso na margem**
1. **Linha própria "ajustes", fora do `custo` (escolhida).** A conta atual não muda para quem não tem ajuste, e o DRE (que soma `custo` e também as categorias) não conta duas vezes.
2. Dentro do `custo`. Mais simples de explicar, mas dobra no DRE e muda a base do imposto de todas as viagens com caixa.
3. Só no financeiro, sem tocar a margem. Contraria as decisões 1 e 2.

**Como o reembolso conversa com o financeiro**
1. **Contas na lista única, ligadas ao caso, com a mesma baixa (escolhida).** Aparece no fluxo de caixa, na conciliação do extrato e no DRE sem código novo de dinheiro.
2. Tabela própria de valores, fora da lista. Exigiria somar reembolsos à parte no caixa, na conciliação e nos relatórios.

**Como guardar o saldo do estoque**
1. **Saldo e custo médio gravados por filial, com movimentos imutáveis (escolhida).** Leitura simples e trava numa linha só por produto e filial.
2. Saldo sempre calculado dos movimentos. Sem risco de divergir, mas o custo médio depende da ordem e toda leitura refaz a conta.

**Avisos automáticos**
1. **Calculados na hora, com a dispensa guardada por chave (escolhida).** Igual ao que a Visão geral já faz; nada fica desatualizado.
2. Gravados por um agendador. Permitiria "lido por pessoa" e histórico, mas exige manter os avisos em dia com os dados e depende do cron.

## 12. Testes e verificação

- Domínio: custo médio (entrada, desfazer, devolução, arredondamento); situação do reembolso; ajustes da margem (sem ajuste = resultado idêntico ao atual, bit a bit; abatimento não conta; negativo aumenta a margem); chaves e setores dos avisos; quem recebe o quê.
- Integração: cada action com perfis (consultor e operacional recusados em Estoque e Reembolsos; aceitos na caixa); entrada cria a conta e trava edição na lista; duas confirmações simultâneas da mesma caixa → uma; duas caixas disputando o último item → uma recusa, saldo nunca negativo; reembolso: registrar, baixar pelo caso e pela lista, desfazer, editar, cancelar; DRE igual antes e depois de caixa e reembolso, exceto pelas categorias; margem real de viagem sem ajuste inalterada; avisos por perfil; dispensa; RLS de todas as tabelas novas.
- Na tela (build local, dados do seed): Estoque, Caixa na viagem como consultor e como Diretor, Reembolsos, Avisos como cada perfil; 1440 e 390 de largura.

## 13. O que fica para quem implementa

Nomes internos, a divisão em arquivos seguindo o padrão das fatias 4 e 5 (`src/domain`, `src/server/{actions,queries}`, `src/app/(app)`), os textos de erro não citados aqui (no tom dos existentes) e o desenho fino das telas dentro do estilo atual, com o protótipo como referência.

## 14. Precisões depois da conferência com o código (valem sobre o texto acima em caso de conflito)

**Núcleo do financeiro**
- Hoje só `criarLancamentosNa` e `baixarLancamentoNa` (`src/server/financeiro/lancamentos.ts`) aceitam uma transação. Esta fatia **extrai** para o mesmo arquivo, sem mudar o comportamento: desfazer baixa, cancelar e alterar valor e vencimento de um lançamento em aberto. As actions atuais passam a chamar o núcleo.
- Contas do reembolso: `emissao` = hoje, `competencia` = mês de hoje (o do registro), `forma` = `transferencia` na conta a receber e `pix` ou `transferencia` (a do caso) na conta a pagar.
- A baixa com valor diferente do previsto exige observação, como na lista: os marcos "Fornecedor pagou" e "Cliente reembolsado" têm o campo "Observação" (obrigatório só nesse caso).
- Entrada de estoque com valor unitário 0 (doação, brinde recebido) é aceita e **não gera conta**.
- Entrada no **cartão corporativo** é aceita: a conta entra na fatura do ciclo e é paga pela fatura, como qualquer compra no cartão. "Desfazer entrada" usa o cancelamento do núcleo (que tira a compra da fatura) e é recusado se a fatura já foi paga.

**Reembolso: o caso lê as contas, não as copia**
- `reembolsos` **não** guarda `recebido_em`, `valor_recebido` nem `valor_devolvido`, e não tem a coluna `situacao`: o estado de cada lado vem da conta ligada (`status`, `baixado_em`, `valor_pago`). Ficam no caso só `reembolsado_em` (usado quando a forma é `abatimento` ou `credito`, que não têm conta) e `cancelado_em`/`cancelado_por`/`motivo_cancelamento`. O enum `situacao_reembolso` não é criado.
- Assim a baixa pode ser feita pelo caso ou pela lista sem gancho: as duas mexem na mesma conta. O caso não trava a viagem (não altera nada dela).
- A view `lancamentos_financeiros` ganha duas colunas no ramo manual, `estoque_movimento_id` e `reembolso_id` (nulas nos outros ramos), numa migração nova que copia a versão atual (`0045`). A lista usa essas colunas para esconder "Editar" e "Cancelar" e as actions de editar e cancelar recusam pelo mesmo critério.
- **Benefício em dobro:** se o financeiro também reduzir o previsto da conta do serviço que falhou, o mesmo dinheiro melhora a margem duas vezes. O formulário do caso avisa: "Se o fornecedor vai abater na conta dele em vez de devolver, deixe o valor a cobrar em 0." Não há bloqueio.

**Categorias**
- As quatro categorias viram categorias de sistema (não podem ser desativadas nem trocadas de lado): slugs `reembolso_cliente`, `reembolso_fornecedor`, `caixa_experiencia`, `papelaria`, numa migração que atualiza as linhas da `0020` pelo (lado, grupo, nome), cria as que faltarem e amplia o CHECK.

**Margem**
- `ponteDaMargem` também recebe os ajustes e ganha as duas linhas; a soma das linhas continua fechando com `real.final − planejada.final`.

**Estoque**
- Todo movimento grava `custo_medio_antes` (o custo médio da filial antes dele). "Desfazer entrada" só quando ela é o **último movimento** daquele produto naquela filial, e volta o saldo ao `custo_medio_antes` gravado (a fórmula inversa perderia centavos no arredondamento). Depois de qualquer outro movimento: "Faça um ajuste de estoque."
- Conciliar a viagem é recusado com a caixa em rascunho ("Confirme ou cancele a caixa de experiência antes"). Reembolso aberto não impede a conciliação.
- **Valores da caixa:** consultor e operacional veem itens, quantidades e o disponível na filial, **sem valores** (custo é camada estratégica no HANDOFF §4). Valor por item e total aparecem só para Diretor e financeiros.

**Avisos**
- Os sete avisos de hoje estão montados dentro de `obterVisaoGeral`, só para Diretor e financeiro estratégico. Esta fatia os **extrai** para um módulo próprio (`src/server/avisos/`), uma função por aviso, cada uma com o seu `exigirPerfil`; a Visão geral passa a chamá-las e continua mostrando o mesmo que hoje. O financeiro operacional passa a receber parcela, comissão, pagar e conciliação em `/avisos`.
- **Chaves:** aviso de um alvo só usa `tipo:id` (`margem:<viagem>`, `caixa_a_montar:<viagem>`, `estoque_minimo:<produto>:<filial>`, `reembolso_pedir:<caso>`…). Os avisos que resumem vários (parcela, comissão, pagar, conciliação, aprovação) usam só o `tipo`. Em `/avisos` a margem é um aviso por viagem, sem o corte de três.
- **Validade da dispensa:** vale enquanto o `detalhe` do aviso for igual ao do momento da dispensa, por no máximo 30 dias. Mudou o texto (por exemplo, de 3 para 4 parcelas vencidas) ou passaram 30 dias: o aviso volta.
- `daily_a_gerar`: dia de hoje ou de amanhã sem linha de daily ou com ela `pendente`. Com o agendador ligado, quase nunca aparece (ele gera sozinho).
- **Contador:** o `Shell` fica no layout e não é refeito a cada navegação. O contador é um pequeno componente de cliente que chama a action `contarAvisos()` ao montar e a cada troca de rota; a action guarda o resultado por pessoa durante 60 segundos na memória do processo. A página `/avisos` calcula sempre na hora.
- "Para mim" é por setor (o sistema não separa viagens por consultor).
