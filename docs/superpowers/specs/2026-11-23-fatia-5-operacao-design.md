# Fatia 5 — Operação da viagem (desenho)

Data: 23/11/2026 · Base: `origin/main` em `1c2ba35` (fatias 1, 2, 3a, 3b e 4a) · Desenho geral: `2026-11-18-backend-sistema-real-design.md` (§6 item 5, §8) · HANDOFF: `docs/HANDOFF.md` · Resumo do protótipo usado: `fatia5-prototipo.md` (scratchpad da sessão; telas `src/app/{tarefas,roteiros,dailies}/page.tsx` do `eclak-mockup`)

**Por que a base é `main` e não a 4b.** A 5a não usa nada da 4b (PR #6, `claude/fatia-4b-caixa`, ainda aberto): não lê caixa, anexos, notas fiscais nem cartão corporativo. A 5a toca `fecharVenda` (`src/server/actions/vendas.ts`), que a 4b não altera. Conflitos esperados quando as duas estiverem em `main`, todos mecânicos:
- numeração das migrações (`main` termina em `0025`; a 4b usa `0026`–`0034`) e `drizzle/meta/_journal.json`;
- `src/components/shell.tsx` (itens de menu);
- `src/app/(app)/viagens/[id]/page.tsx` (a 4b mexe; a 5a monta a trilha aqui). A 5a **não** edita `viagem-vendida.tsx`, que a 4b altera bastante;
- `tests/integracao/rls.test.ts` (tabelas novas);
- `scripts/seed-local.ts`, `README.md`, `docs/HANDOFF.md`.

Regra para quem executar: se a 4b já estiver em `main` quando a execução começar, rebasear a branch em `origin/main` antes da Task 4. As migrações da 5a são geradas **depois da última existente**, sem número fixo no plano.

## 1. Intenção e porquê

Depois da venda, a operação da ECLAK (Operacional, Bia; Consultora, Fernanda) cuida da viagem em três documentos que hoje vivem fora do sistema:
- **TAREFAS**: controle interno do que comprar, reservar, conferir e enviar, com prazo e responsável;
- **RT**: o roteiro em PDF que vai ao cliente, com DICA ECLAK e "Por que escolhemos";
- **Dailies**: a mensagem de WhatsApp com a programação do dia seguinte, durante a viagem.

As fatias 1 a 4a já deixam no sistema o cliente, quem viaja, os itens e as datas da viagem. A fatia 5 usa esses dados para montar esses três documentos sem redigitar nada.

Sucesso:
- a Bia abre uma viagem vendida e vê o que falta fazer e o que está vencido;
- monta o RT a partir dos dias e hotéis da viagem e imprime o PDF com o nome certo;
- na véspera de cada dia, copia um daily que já passa no "Padrão do daily ECLAK".

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos (5a)**

*Tarefas por viagem vendida*
- 6 categorias fixas, com prazo fixo ou relativo ao embarque, responsável e conclusão (quem e quando).
- Tarefas automáticas na venda (5) e na aprovação do roteiro pelo cliente (3), sem duplicar.
- Lista "Minhas tarefas / Todas" entre viagens e impressão.

*Roteiro (RT) por viagem*
- Ciclo rascunho → aguardando o cliente → aprovado pelo cliente.
- Dias gerados das datas da viagem, com itens, DICA ECLAK, "Por que escolhemos" e sugestões gastronômicas.
- Hotéis e voos pré-preenchidos dos itens da viagem.
- Aviso de aniversário durante a viagem.
- Impressão/PDF com o nome `RT_<TITULAR>_<DESTINO>_<ini>-<fim>`.

*Dailies*
- Um por dia do roteiro, gerado por modelo (sem IA) a partir do dia.
- Os 6 itens do "Padrão do daily ECLAK" como indicadores.
- Estados até "Enviado" e "Copiar mensagem".
- Versão interna de plantão, com horários convertidos para Mato Grosso e Brasília.
- Texto de encerramento versionado em Admin › Parâmetros.

**Não-objetivos**
- *Fica para a 5b*: Reembolsos, Estoque, Caixa de experiência e Avisos por setor (aguardam o retorno do grupo e da Valeska; §6).
- *Fica para a fatia 6*:
  - integrações Trello (cartão com subtarefas), Google Drive (pastas, vouchers) e envio pelo WhatsApp;
  - "Reescrever com IA" e "gerar com IA";
  - mapas e plano logístico ("H > 1 > 2", tempos de deslocamento);
  - vouchers em PDF anexados ao daily.
- *Já existem (fatia 3) ou ficam para a fatia 6*: as abas do protótipo Itens e aprovação, Fornecedores da viagem, Ingressos e passeios (OP_COTACAO) e Plano logístico.
- *Fora de escopo*:
  - aviso "Aniversário" na central de Avisos (5b);
  - job agendado que gere dailies sozinho;
  - versões do roteiro (o histórico fica na auditoria).

**Anti-objetivos (falha mesmo que "funcione")**
- Tarefa automática duplicada (aprovar o roteiro duas vezes, desfazer e aprovar de novo, duas pessoas aprovando juntas) ou renascendo depois de excluída.
- Custo, valor de fornecedor, margem ou qualquer dado da camada estratégica nas telas de operação, para qualquer perfil.
- Edição simultânea do roteiro em que um salvamento apaga o outro sem aviso.
- Daily com contato de fornecedor (telefone, guia, motorista) no texto ao cliente sem o indicador acusar.
- Horário convertido errado por causa de fuso ou horário de verão do destino.

## 3. Restrições

Todas as Global Constraints acumuladas (HANDOFF §4):
- `comPerfil` no início de toda Server Action e `exigirPerfil` em toda query;
- auditoria na mesma transação de toda escrita;
- exclusão lógica;
- RLS em toda tabela nova, com entrada em `tests/integracao/rls.test.ts`;
- valor novo de enum em migração própria;
- erros de banco logados só com o código;
- "hoje" = `hojeEmCuiaba()`; datas ISO `AAAA-MM-DD`;
- marca: azul #2E5C71 dominante, laranja só destaque, **sem vermelho** (vencido/atenção em `ouro`), sem gradiente, sem emoji (inclusive nos textos ao cliente: daily e RT), sem estrelinha;
- textos pt-BR; desktop 1440–1920.

**Acesso.** Os cinco perfis veem e editam Tarefas, Roteiros e Dailies (protótipo: rotas em `todos`; PRODUCT: "quem vê também edita").
- Actions: `comPerfil([], …)`, isto é, qualquer usuário ativo, como em Clientes.
- Queries: `exigirPerfil()`.
- Nada da camada estratégica aparece nessas telas. As queries selecionam colunas explícitas e **nunca** leem `cotacoes`, `contas_pagar`, `versoes_precificacao.resultado` nem margens. Um teste confere isso.

**Escopo da viagem.** Tarefas, roteiro e dailies existem só para viagem com `status = 'vendida'`, que não pode mais ser editada (`alterarOrcamento` recusa). Por isso as datas e os itens são estáveis: os dias do roteiro e o pré-preenchimento não precisam ser ressincronizados.

## 4. Divisão e abordagens

### 4.1 Divisão (decisão do controlador)
- **5a — Operação da viagem:** Tarefas, Roteiros (RT), Dailies. É o dia a dia de uma viagem vendida, sem dinheiro.
- **5b — Estoque, caixa de experiência, reembolsos e avisos:** Reembolsos, Estoque, Caixa de experiência, Avisos por setor. Mexem em dinheiro (contas a pagar e receber, custo da viagem) e dependem do retorno do grupo e da Valeska. Aqui só há esboço e perguntas (§6).
- **6 — Integrações:** Trello, Drive, WhatsApp, IA, mapas.

### 4.2 Abordagens consideradas

| Tema | Escolhida | Descartada | Troca |
|---|---|---|---|
| Conteúdo do roteiro | **Documento `jsonb`** validado por Zod no domínio (`dias`, `hoteis`, `voos`) numa linha `roteiros` por viagem | Tabelas normalizadas (`roteiro_dias`, `roteiro_itens`, `roteiro_hoteis`, `roteiro_voos`) | O RT é editado e salvo como um documento. Um salvamento, uma checagem de concorrência, uma auditoria com antes e depois. Perde-se consulta SQL dentro do conteúdo (ex.: "todas as DICAs de Veneza"), que ninguém pediu. |
| Geração do daily | **Sob demanda:** a partir de D-2 a tela mostra "Gerar texto"; o clique grava | Job agendado que gera em D-2; ou gerar ao abrir a página | Sem infraestrutura de agendamento (Railway sem cron configurado) e sem escrita em GET (fora de `comPerfil`/auditoria). O estado "A gerar" (D-2 sem texto) deixa o atraso visível. |
| Tarefas automáticas | **Lista fixa no domínio** (5 da venda, 3 do roteiro) com chave estável e índice único por viagem | Modelos de tarefa cadastráveis | O protótipo só define essas 8. Modelos editáveis ficam para quando a equipe pedir. |
| Prazo da tarefa | **Dois tipos gravados:** data fixa **ou** "N dias antes do embarque"; data efetiva calculada no domínio | Texto livre (protótipo); ou só data | Permite ordenar e marcar vencidas. A data efetiva segue o embarque se ele mudar (hoje a viagem vendida não muda). |
| Concorrência | **Otimista por `atualizado_em`** (padrão de Clientes/Orçamentos) no roteiro, na tarefa e no daily, com a linha `for update` na transação | `travarViagem` | Não há dinheiro envolvido. O lock consultivo da viagem continua só para venda e financeiro. A única exceção é `fecharVenda`, que já trava a viagem e cria as tarefas dentro da própria transação. |

## 5. Desenho da 5a

### 5.1 Navegação e telas
- **Menu Operação:** Viagens, **Tarefas** (`/tarefas`), **Roteiros** (`/roteiros`), **Dailies** (`/dailies`), Fornecedores.
- `ROTAS_POR_PERFIL` ganha `/tarefas`, `/roteiros` e `/dailies` nos cinco perfis. As páginas da viagem ficam sob `/viagens/[id]/…`, que todos já acessam.
- **Trilha da viagem.** Na viagem vendida, uma faixa de abas "Viagem · Roteiro · Tarefas · Dailies" liga:
  - `/viagens/[id]`;
  - `/viagens/[id]/roteiro`;
  - `/viagens/[id]/tarefas`;
  - `/viagens/[id]/dailies`.

  Ela substitui o `TripHeader` fixo do protótipo; o cabeçalho mostra código, cliente, destino, período, noites e passageiros. Para viagem não vendida, as três páginas respondem "Disponível depois da venda" com link para a viagem.
- **Impressão:** `/viagens/[id]/roteiro/imprimir` e `/viagens/[id]/tarefas/imprimir`, no padrão de `viagens/[id]/proposta/page.tsx`:
  - `@page A4`;
  - botão `BotaoImprimir`;
  - `<title>` = nome do arquivo, que vira o nome sugerido do PDF.
- **Listas entre viagens:**
  - `/tarefas`: "Minhas tarefas" / "Todas", com filtros:
    - responsável: eu, um usuário, Customer care, sem responsável;
    - situação: abertas (padrão), vencidas, concluídas;
    - viagem (busca pelo código).
  - `/roteiros`: viagens vendidas ainda não terminadas (`fim >= hoje`), com a situação do roteiro: Sem roteiro / Rascunho / Aguardando o cliente / Aprovado pelo cliente.
  - `/dailies`: dailies de hoje até hoje + 3, de todas as viagens com roteiro, com estado e atalho para a viagem.

### 5.2 Modelo de dados

**`tarefas`**

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | uuid | |
| `viagem_id` | uuid FK viagens | |
| `categoria` | enum `categoria_tarefa` | `ingressos`, `transfers_passeios`, `restaurantes`, `hoteis_carro_voos`, `conferir`, `envio` |
| `dia` | date null | null = "Geral" |
| `item` | text | 1–200 |
| `fazer` | text | "O que fazer", até 2000 |
| `prazo_tipo` | enum `prazo_tarefa` null | `data` \| `dias_antes`; null = sem prazo |
| `prazo_data` | date null | obrigatório se `data` |
| `prazo_dias` | int null | 0–365; obrigatório se `dias_antes` |
| `responsavel_id` | uuid null FK usuarios | |
| `customer_care` | bool default false | no máximo um entre `responsavel_id` e `customer_care` |
| `observacao` | text null | até 2000 |
| `ordem` | int | dentro da viagem |
| `origem` | enum `origem_tarefa` | `manual`, `venda`, `roteiro` |
| `chave` | text null | só nas automáticas (ex.: `venda.whatsapp`) |
| `concluida_em`, `concluida_por` | timestamptz / uuid null | os dois juntos (CHECK) |
| `criado_por`, `criado_em`, `atualizado_em`, `excluido_em` | | |

Índice único `(viagem_id, chave) WHERE chave IS NOT NULL` **sem** filtrar `excluido_em`: a automática excluída não renasce. Índice `(responsavel_id) WHERE excluido_em IS NULL AND concluida_em IS NULL`.

**`roteiros`** (um por viagem)

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | uuid | |
| `viagem_id` | uuid FK, **único** | |
| `status` | enum `status_roteiro` | `rascunho`, `aguardando_cliente`, `aprovado` |
| `idioma` | enum `idioma_destino` | `italiano`, `espanhol`, `frances`, `ingles`, `alemao`, `portugues` |
| `fuso` | text | IANA (ex.: `Europe/Rome`), validado com `Intl` no domínio |
| `abertura` | text | "Sua viagem", até 4000 |
| `conteudo` | jsonb | `ConteudoRoteiro` (abaixo) |
| `enviado_cliente_em/por` | null | |
| `aprovado_em/por` | null | |
| `criado_por`, `criado_em`, `atualizado_em` | | |

`ConteudoRoteiro` (Zod em `src/domain/roteiro.ts`):
- `dias`: exatamente uma entrada por data de `inicio..fim`, em ordem. Cada dia tem:
  - `data`;
  - `titulo` (até 120);
  - `itens`: até 40, cada um `{ hora: "HH:MM" | null; titulo 1–160; texto até 2000; mapa: URL https | null }`;
  - `dica: { tema até 40; texto até 1000 } | null`;
  - `porque: string | null` (até 1000);
  - `gastro: string[]` (até 10 × 200; colunas separadas por " | ", como no protótipo).
- `hoteis`: até 30 entradas `{ cidade; nome; entrada: data | null; saida: data | null; horaCheckin: "HH:MM" | null; horaCheckout: "HH:MM" | null; mapa: URL | null }`, com `saida >= entrada`.
- `voos`: até 20 entradas `{ data | null; voo; trecho; saida: "HH:MM" | null; chegada: "HH:MM" | null }`.

**`dailies`** (uma linha por dia que já teve alguma ação)

| Coluna | Tipo | Regra |
|---|---|---|
| `id` | uuid | |
| `roteiro_id` | uuid FK | |
| `data` | date | único `(roteiro_id, data)` |
| `estado` | enum `estado_daily` | `pendente` (só interno preenchido), `gerado`, `revisado`, `enviado` |
| `texto` | text null | mensagem ao cliente; não nulo quando `estado <> 'pendente'` |
| `gerado_em/por`, `revisado_em/por`, `enviado_em/por` | null | |
| `plantao_id` | uuid null FK usuarios | |
| `interno` | text null | localizadores e contatos, texto livre, até 4000 |
| `atualizado_em` | | |

**Parâmetro novo:** `encerramentoDaily` em `RegrasSchema` (texto de 1 a 1000 caracteres, `.default(ENCERRAMENTO_INICIAL)`, para que as versões antigas continuem válidas). Valor inicial = `ENCERRAMENTO` do protótipo:
```
Qualquer dúvida, nosso customer care está à disposição no WhatsApp. Aproveitem o dia!
Equipe ECLAK Viagens
```
O campo entra em `CAMPOS` com o tipo novo `"texto"` e o grupo novo `"operacao"`, num card "Operação" em Admin › Parâmetros (área textarea; só o Diretor edita, como os outros parâmetros).

### 5.3 Tarefas

**Categorias** (texto exato, nesta ordem; a primeira em destaque):
1. Emitir ingressos e bilhetes com horário
2. Transfers e passeios
3. Reservar restaurantes (cortesia do concierge)
4. Hotéis, carro e voos
5. Conferir
6. Envio e acompanhamento

**Prazo efetivo** (`prazoEfetivo`, domínio):
- `data` → a própria data;
- `dias_antes` → `inicio − N` dias;
- sem prazo → null.

Rótulos:
- "Até 15/04/2027";
- "15 dias antes (30/07/2027)";
- "Sem prazo".

**Situação** (`situacaoTarefa({ prazoEfetivo, concluida }, hoje)`):
- `concluida`;
- `vencida` (prazo < hoje; tom `ouro`);
- `vence_hoje`;
- `no_prazo`;
- `sem_prazo`.

**Ordenação na tela da viagem:** categoria (ordem acima); depois `dia`, com "Geral" primeiro; depois `ordem`. Na lista entre viagens: prazo efetivo (sem prazo por último), depois viagem.

**Tarefas automáticas** (`TAREFAS_DA_VENDA`, `TAREFAS_DO_ROTEIRO`; o responsável inicial é o **consultor da viagem**, editável):

| Chave | Item (texto do protótipo) | Categoria | Prazo |
|---|---|---|---|
| `venda.whatsapp` | Criar grupo no WhatsApp | Envio e acompanhamento | data: venda + 1 dia |
| `venda.fatura` | Encaminhar informações para emissão da fatura | Conferir | data: venda + 2 dias |
| `venda.comparativo` | Fazer comparativo de valores de fornecedores | Conferir | data: venda + 7 dias |
| `venda.reservas` | Realizar reserva da hotelaria e do transfer | Hotéis, carro e voos | data: venda + 7 dias |
| `venda.drive` | Abrir pasta no Google Drive | Envio e acompanhamento | data: venda + 1 dia |
| `roteiro.passeios` | Reserva de passeios | Transfers e passeios | 60 dias antes |
| `roteiro.ingressos` | Compra de ingressos | Emitir ingressos e bilhetes com horário | 60 dias antes |
| `roteiro.trem` | Compra de trem | Emitir ingressos e bilhetes com horário | 90 dias antes |

"Venda" = `hojeEmCuiaba()` no fechamento. As datas `venda + N` nunca passam do início da viagem: se `inicio` for antes, o prazo vira o próprio `inicio`.

**Fluxos**
- **Criação na venda:** `fecharVenda`, **na mesma transação** (viagem já travada), insere as 5 com `ON CONFLICT (viagem_id, chave) DO NOTHING` e audita cada inserida.
- **Viagens vendidas antes da 5a:** a aba Tarefas mostra "Criar as tarefas da venda" quando não existe nenhuma tarefa `origem = 'venda'`. A action chama a mesma função idempotente.
- **Aprovação do roteiro pelo cliente:** cria as 3 com a mesma regra. Desfazer a aprovação não apaga nada; aprovar de novo não duplica.
- **Tarefa manual:** "Nova tarefa" abre formulário com categoria, dia (data ou "Geral"), item, o que fazer, prazo (sem prazo / até a data / N dias antes do embarque), responsável (usuários ativos + "Customer care" + ninguém) e observação.
- **Edição:** com `atualizadoEmEsperado`. Mensagem "Esta tarefa foi alterada por outra pessoa. Recarregue a página.".
- **Concluir / desfazer conclusão:** registra quem e quando. Concluir uma concluída é recusado com "Tarefa já concluída por <nome> em dd/mm/aaaa".
- **Excluir:** exclusão lógica. Vale também para as automáticas, que não voltam.
- **Tela da viagem** (protótipo):
  - subtítulo "Controle interno, não enviar ao cliente. As tarefas nascem da aprovação da proposta e do roteiro. Prazos sugeridos com folga, ajustáveis pela equipe." (o trecho "e vão para o Trello" fica para a fatia 6);
  - barra "N de M tarefas concluídas" e abas "Todas" / "Só as abertas";
  - um card por categoria com as colunas: (caixa), Dia, Item, O que fazer, Prazo, Responsável, Observações;
  - concluída riscada em cinza; vencida com selo "Vencida" em `ouro`.
- **Impressão:** mesma tabela por categoria, com o cabeçalho da viagem e "Controle interno, não enviar ao cliente.". Nome `TAREFAS_<TITULAR>_<DESTINO>_<ini>-<fim>`.

### 5.4 Roteiro (RT)

**Criação.** "Criar roteiro" na aba Roteiro pede idioma e fuso.
- Sugestão pelo destino (`sugerirIdiomaEFuso`): Itália → italiano/`Europe/Rome`; França → francês/`Europe/Paris`; Espanha → espanhol/`Europe/Madrid`; Portugal → português/`Europe/Lisbon`; Alemanha → alemão/`Europe/Berlin`; Reino Unido/Inglaterra/Escócia → inglês/`Europe/London`; Estados Unidos → inglês/`America/New_York`; Argentina → espanhol/`America/Argentina/Buenos_Aires`; Chile → espanhol/`America/Santiago`. Comparação sem acento e sem caixa, por "contém".
- Sem sugestão, o usuário escolhe.
- O sistema monta:
  - um dia por data de `inicio..fim`, com título vazio e sem itens;
  - `hoteis` dos itens `Hotelaria` não excluídos (cidade, nome = `servico`, entrada = `checkin`, saída = `checkout`);
  - `voos` dos itens `Aéreo` (data = `checkin`, trecho = `servico`; **voo, saída e chegada vazios**, porque o item não guarda esses dados).

  O pré-preenchimento é parcial e editável. "Trazer hotéis e voos da viagem" refaz as duas listas a partir dos itens, com confirmação, porque substitui o que foi digitado.
- Uma viagem tem no máximo um roteiro (único no banco). Criar de novo responde "Esta viagem já tem roteiro".

**Editor** (aba Roteiro; protótipo, sem as abas Itens/Fornecedores/Ingressos/Plano logístico):
- "Sua viagem" (abertura).
- Hotéis (tabela editável) e voos (tabela editável, com a nota fixa "Horários de voos sujeitos a alteração pela companhia aérea.").
- Um bloco por dia: título; itens (hora, título, texto, link de mapa) com adicionar, remover, subir e descer; DICA ECLAK (tema + texto, rótulo "DICA ECLAK · <TEMA>"); "POR QUE ESCOLHEMOS"; "SUGESTÕES GASTRONÔMICAS" (linhas).
- Prévia do PDF ao lado.
- "Salvar" grava o documento inteiro com `atualizadoEmEsperado`. Mensagem de conflito: "Este roteiro foi alterado por outra pessoa. Recarregue a página.".

**Status e ações**
- **"Marcar como enviado ao cliente"**: `rascunho` → `aguardando_cliente`.
- **"Marcar como aprovado pelo cliente"**: a partir de `rascunho` ou `aguardando_cliente` (o cliente pode aprovar por telefone) → `aprovado`. Grava quem e quando, cria as 3 tarefas e mostra "Roteiro aprovado. Tarefas criadas: passeios, ingressos e trem" (ou "Roteiro aprovado. As tarefas do roteiro já existiam" se nenhuma foi inserida).
- **"Desfazer aprovação"**: `aprovado` → `aguardando_cliente`. Limpa `aprovado_em/por`; as tarefas ficam.
- Selos: "Rascunho" (cinza), "Aguardando o cliente" (ouro), "Aprovado pelo cliente" (agua).
- Editar o conteúdo não muda o status. Se `atualizado_em > aprovado_em`, aparece o selo "Alterado depois da aprovação".

**Aniversário durante a viagem.** `aniversariosNaViagem(pessoas, inicio, fim, hoteis)` considera os passageiros da viagem (`viagem_passageiros`, pessoas não removidas) com `nascimento` cujo aniversário cai em `inicio..fim`. Ano virando no meio da viagem: conta. 29/02 em ano não bissexto: 28/02, a mesma regra de `proximoAniversario` em `src/domain/clientes.ts`.
- Faixa em `ouro`: "Aniversário durante a viagem: Rafael Souza faz 40 anos em 23/08/2027, dia 10 da viagem, em Sorrento (Hotel Belair)." A parte "em <cidade> (<hotel>)" só aparece se houver hotel com `entrada <= data < saida`. O trecho do protótipo "Data conferida no passaporte." sai, porque o sistema não confere.
- Botão "Incluir no dia dd/mm": acrescenta no editor (cliente) o item `{ hora: null, titulo: "Aniversário de Rafael Souza (40 anos)", texto: "" }`. A pessoa salva o roteiro. Se o dia já tem item com esse título, o botão vira "Incluído no dia dd/mm".

**Impressão (RT).** `/viagens/[id]/roteiro/imprimir`:
- cabeçalho com logo e "ROTEIRO DE VIAGEM · <DESTINO>";
- "Sua viagem", hotéis ("N noites · dd/mm a dd/mm"), voos e a nota de voos;
- um bloco por dia: "dd/mm (dia-da-semana)", título, itens com hora, DICA ECLAK com borda terracota, POR QUE ESCOLHEMOS, SUGESTÕES GASTRONÔMICAS;
- rodapé fixo, texto exato: "**ATENÇÃO:** confira sempre o horário oficial no voucher da atração e 24h antes com o nosso customer care, disponível no WhatsApp.";
- `<title>` = `nomeArquivoRoteiro(titular, destino, inicio, fim)`. Exemplo: `RT_SOUZA_ITALIA_20270814-20270901`. TITULAR é o último nome do titular e DESTINO o destino, ambos em maiúsculas, sem acento, palavras unidas por hífen.

  Sem a fonte da marca (Evaida, CA Saygon Text, não enviadas), usa a fonte do sistema.

### 5.5 Dailies

**Dias.** Um daily por dia do roteiro. A data de envio é D-1 e a geração fica disponível em D-2.

**Estado exibido** (`estadoDoDaily(data, estado, hoje)`):

| Condição | Rótulo | Tom |
|---|---|---|
| sem texto e hoje < D-2 | "Gera em dd/mm" (dd/mm = D-2) | cinza |
| sem texto e hoje ≥ D-2 | "A gerar" | ouro |
| `gerado` | "Gerado, a revisar" | ouro |
| `revisado` | "Pronto para enviar" | agua |
| `enviado` | "Enviado" | verde |

**Gerar texto.**
- Botão "Gerar texto" (de D-2 em diante; antes disso, "Gerar agora", secundário, para adiantar fim de semana). A action **nunca recusa pela data**: a data só escolhe qual botão aparece. Monta o texto com `textoDoDaily` e grava `estado = gerado`.
- "Gerar de novo" substitui o texto, com confirmação, e volta a `gerado`.
- Nada é gerado ao abrir a página.

**Modelo do texto** (`textoDoDaily`, domínio, sem IA):
```
<Saudação do idioma>, <nomes>!

Programação de amanhã, <dia-da-semana em minúsculas>, <dd/mm>.

Check-out: <hotel que sai>[, até as <hh>h]        ← se algum hotel tem saída nesse dia
Check-in: <hotel que entra>[, a partir das <hh>h] ← se algum hotel tem entrada nesse dia
<link do mapa do hotel que entra>                 ← mapa do hotel, ou https://maps.google.com/?q=<nome cidade com %20>

*<hora>*: <título>[. <texto>]                      ← itens com hora, em ordem, um parágrafo cada
[link do mapa do item]
<título>[. <texto>]                                ← itens sem hora

<encerramento vigente em Parâmetros>
```
- Saudação por idioma: italiano "Buongiorno", espanhol "¡Buenos días", francês "Bonjour", inglês "Good morning", alemão "Guten Morgen", português "Bom dia".
- Nomes: primeiros nomes dos passageiros na ordem do cadastro ("Marina e Rafael"; três: "A, B e C"). Com mais de três, o nome do grupo do cliente.
- Hora "HH:MM" vira "13h26"; minutos "00" viram "16h"; o zero à esquerda fica ("06h20").
- No texto do item, " | " vira ". ". O parágrafo termina em ponto se não terminar em pontuação.

**Padrão do daily ECLAK** (`conferirDaily(texto, { troca, idioma, encerramento })`, seis indicadores que nunca bloqueiam; nomes e dicas do protótipo, texto exato):
1. "Saudação no idioma do destino". O texto começa com a saudação **do idioma do roteiro**. O protótipo aceitava qualquer saudação menos "Bom dia"; aqui "Bom dia" vale quando o idioma é português (decisão D11). Dica: `Comece com a saudação do país, como "Buongiorno" na Itália.`
2. "Sem gerundismo". Regex do protótipo `/\b(vamos|vai|vou|estaremos|estarei|estar)\s+(estar\s+)?\w+ndo\b/i`. Dica: `Troque "<trecho>" pelo verbo direto, como "enviaremos" ou "aguardamos".`
3. Com troca de hotel: "Troca de hotel: check-out e check-in no topo, com o mapa". Sem troca: "Sem troca de hotel neste dia" (sempre ok). A regra é a do protótipo: linha `Check-out:` seguida de `Check-in:`, depois uma linha com link de mapa, tudo antes do primeiro item `*N`. O link aceita `maps.google`, `goo.gl/maps` e também `maps.app.goo.gl` (links de compartilhar atuais do Google; decisão D25). Dica do protótipo.
4. "Cada item da programação começa pelo horário". Regra do protótipo, inclusive "precisa ter ao menos uma linha de programação". Um dia sem item com hora acusa o indicador, de propósito: o daily sem horário merece revisão. Dica: `Use o formato *06h20*: partida do trem...`
5. "Sem contatos de fornecedores". Regex do protótipo `/\(\d{2}\)\s?\d|\+\d{2}\s?\d|guia:|motorista:|apoio local/i`. Dica do protótipo.
6. "Encerramento padrão da ECLAK". `texto.trim().endsWith(encerramento vigente)`. Dica: "Termine com o texto padrão, definido em Parâmetros."

"Troca" = existe hotel com `saida = data` **e** outro com `entrada = data` (`trocaDeHotel(hoteis, data)`).

**Ações**
- Salvar texto (com `atualizadoEmEsperado`).
- "Marcar como revisado" (`gerado` → `revisado`).
- "Copiar mensagem" (área de transferência, no navegador; aviso "Mensagem copiada").
- "Marcar como enviado" (quem e quando; de `gerado` ou `revisado`).
- "Desfazer envio" (→ `revisado`).
- Daily enviado não aceita edição de texto: "Daily já enviado: desfaça o envio para editar".
- `roteiros.atualizado_em` só muda quando o **conteúdo** é salvo (salvar, "Trazer hotéis e voos"). As ações de status gravam só as próprias colunas. Assim, aprovar o roteiro não dispara os avisos abaixo nem "Alterado depois da aprovação".
- Se o roteiro foi salvo depois da geração (`roteiros.atualizado_em > dailies.gerado_em`), a tela avisa "O roteiro mudou depois que este daily foi gerado." com "Gerar de novo".

**Versão interna (plantão)**, aba "Interno (plantão)":
- "Horário em <cidade do dia>" × "Horário em Mato Grosso" × "Horário em Brasília" para cada item com hora. A conversão (`converterHorario(data, hora, fusoOrigem, fusoDestino)`, com `Intl` e regras de horário de verão) vai do fuso do roteiro para `America/Cuiaba` e `America/Sao_Paulo`. Cidade do dia = cidade do hotel em que se dorme na noite do dia, senão o destino.
- "Plantão do dia": select de usuários ativos.
- "Localizadores e contatos": texto livre.
- Nota fixa: "A versão interna não é enviada ao cliente. Serve para o controle de plantão."
- Salvar a versão interna antes da geração cria a linha em `pendente`.

### 5.6 Auditoria e concorrência
Toda escrita (tarefa, roteiro, daily, mudança de status) chama `registrarAuditoria` na mesma transação, com antes e depois. A linha é lida `for update` e o `atualizado_em` é comparado quando a ação vem de um formulário. As ações de status (concluir, aprovar, enviar) não exigem `atualizadoEmEsperado`, mas recusam estado inválido com mensagem clara. A aprovação concorrente é serializada pelo `for update` do roteiro, e o índice único garante as tarefas.

## 6. Fatia 5b — esboço e perguntas abertas

Aguardando o retorno do grupo e da Valeska (HANDOFF §3). Esboço a partir do protótipo (`fatia5-prototipo.md` §4–8):

- **Reembolsos.** Caso por viagem e serviço, com:
  - valores: a cobrar do fornecedor e a devolver ao cliente, que podem diferir;
  - forma de devolução: PIX, Transferência, Abatimento na próxima parcela, Crédito para a próxima viagem;
  - dois lados independentes: pedido → recebido do fornecedor; cliente reembolsado;
  - situação derivada.

  Gera lançamentos na lista única da 4a: a pagar, categoria "Reembolso a cliente"; a receber, categoria "Reembolso de fornecedor".
- **Estoque.** Produto (uso "Caixa de experiência" ou "Papelaria"), valor unitário, quantidade e mínimo por filial (MT/RS = Rondonópolis/RS); entrada registrada gera conta a pagar. Faltam saídas manuais, histórico e custo médio.
- **Caixa de experiência.** Limite por viagem (faixa de venda ou %); montagem com itens do estoque da filial da viagem; confirmar baixa o estoque e lança custo na viagem (margem real); estourar o limite pede aprovação da diretoria.
- **Avisos por setor.** Setores Gestão/Financeiro/Comercial/Operacional/Geral, "quem recebe", resolver, dispensar com justificativa de 10 caracteres ou mais, histórico. Eventos candidatos da 5a: tarefa vencida, daily a gerar, aniversário na viagem.

**Perguntas abertas (para o grupo, a Valeska e o Augusto)**
1. Reembolso: os lançamentos nascem no registro da ocorrência ou nos marcos ("Fornecedor pagou", "Cliente reembolsado")? "Abatimento na próxima parcela" reduz a parcela da viagem ou vira lançamento à parte? Reembolso mexe na margem real da viagem?
2. Reembolso com valor a devolver maior que o cobrado (ex.: 411,45 × 385,00): a diferença é custo da viagem ou da empresa?
3. Estoque: valor unitário pelo último preço (protótipo) ou custo médio? Precisa de saída manual, ajuste e transferência MT↔RS? O mínimo é por filial ou um só?
4. Estoque: "onde foi comprado" é texto livre ou fornecedor do cadastro?
5. Caixa de experiência: regra do limite (faixas 30/60/100 mil → 100/180/260/350, ou 0,4% da venda)? Quem pode estourar e como o Diretor aprova? O custo entra como custo variável da viagem na margem real?
6. Caixa de experiência: em que status da viagem pode ser montada e até quando antes do embarque? Cancelar a caixa devolve ao estoque?
7. Avisos: lido/não lido por pessoa? Notificação fora do sistema (e-mail, WhatsApp)? O financeiro estratégico entra em que setor?
8. Avisos: quais eventos geram aviso automático (tarefa vencida, daily a gerar, estoque abaixo do mínimo, caixa a montar, reembolso)?
9. Perfis: Reembolsos e Estoque ficam abertos aos cinco perfis (como no protótipo) ou só ao financeiro e ao Diretor?

## 7. Decisões do Claude (para o Mateus conferir)

Cada decisão com o custo de trocar depois, se estiver errada.

| # | Decisão | Custo se estiver errada |
|---|---|---|
| D1 | Base em `main` (sem a 4b); migrações numeradas depois da última na hora da execução | Baixo: rebase com conflitos mecânicos (journal, menu, RLS, seed, docs) |
| D2 | Conteúdo do roteiro como documento `jsonb` validado por Zod, uma linha por viagem | Médio: relatórios dentro do RT exigiriam migrar o `jsonb` para tabelas |
| D3 | Tarefas, roteiro e dailies só para viagem vendida | Baixo: liberar para orçamento aprovado é trocar uma checagem, mas aí as datas podem mudar e os dias teriam de ser ressincronizados |
| D4 | Prazo da tarefa: sem prazo, data fixa ou "N dias antes do embarque"; sem "N dias depois da venda" nem "na abertura das vendas" | Baixo: tipo novo de prazo = valor de enum + regra no domínio |
| D5 | As 8 automáticas com as categorias e os prazos da tabela §5.3 (venda +1/+2/+7 dias; roteiro 60/60/90 dias antes), responsável inicial = consultor da viagem | Baixo: constantes no domínio; as tarefas já criadas não mudam sozinhas |
| D6 | Idempotência por `(viagem_id, chave)` incluindo as excluídas: automática excluída não volta | Baixo: se a equipe quiser recriar, ela cria a tarefa à mão |
| D7 | Viagens vendidas antes da 5a ganham as tarefas da venda pelo botão "Criar as tarefas da venda" (sem migração de dados) | Baixo |
| D8 | "Customer care" é uma marca na tarefa (`customer_care`), não um usuário; "Minhas tarefas" não o inclui | Baixo: virar um usuário ou setor exige migração simples |
| D9 | Concorrência otimista por `atualizado_em` (padrão Clientes), sem `travarViagem` fora da venda | Baixo |
| D10 | Daily gerado sob demanda ("Gerar texto"), sem job nem geração ao abrir; estado extra "A gerar" (D-2 sem texto, em ouro) | Médio: se quiserem o texto pronto sem clique, é preciso um agendador (Railway cron) chamando a mesma função |
| D11 | Indicador 1 aceita a saudação **do idioma do roteiro**, inclusive "Bom dia" para português (o protótipo recusava "Bom dia" sempre) | Baixo: uma linha no domínio |
| D12 | Indicador 4 acusa dia sem item com hora (regra do protótipo mantida) | Baixo |
| D13 | Idioma e fuso guardados no roteiro (seis idiomas da lista do protótipo), com sugestão pelo destino; sem cadastro de destinos | Médio: um cadastro de destinos depois exigiria migrar os roteiros |
| D14 | Hotel no roteiro ganha `horaCheckin`, `horaCheckout` e `mapa` opcionais; sem mapa, o link é `https://maps.google.com/?q=` + nome e cidade com `encodeURIComponent` (`%20`, não "+", para o indicador 5 não ler "+1898" como telefone) | Baixo |
| D15 | Pré-preenchimento só na criação e no botão "Trazer hotéis e voos da viagem", que substitui as listas; voos vêm sem número e horários | Baixo |
| D16 | Aprovar o roteiro é possível direto do rascunho; editar depois de aprovado não muda o status, só mostra "Alterado depois da aprovação" | Baixo |
| D17 | Daily enviado não aceita edição até "Desfazer envio"; salvar texto revisado mantém "Pronto para enviar" | Baixo |
| D18 | Nomes da saudação: primeiros nomes dos passageiros (até 3); mais de 3 → nome do grupo do cliente | Baixo |
| D19 | Nome do arquivo: último nome do titular e destino em maiúsculas, sem acento, palavras unidas por hífen (`RT_SOUZA_COSTA-AMALFITANA_…`) | Baixo |
| D20 | Encerramento do daily como parâmetro versionado (`encerramentoDaily`, grupo novo "Operação"), editável só pelo Diretor, com `.default()` para versões antigas | Baixo |
| D21 | Plantão sem telefone (usuários não têm telefone no cadastro); o telefone vai no texto livre interno | Baixo: um campo em `usuarios` resolve |
| D22 | Listas `/roteiros` (viagens vendidas não terminadas) e `/dailies` (hoje até +3) além de `/tarefas` | Baixo |
| D23 | Vouchers em PDF fora do daily (sem Storage de vouchers até a fatia 6); o modelo não cita PDFs | Baixo |
| D24 | Aniversário: só aviso na tela e item no roteiro; o aviso na central fica para a 5b | Baixo |
| D25 | Indicador 3 aceita também `maps.app.goo.gl` além de `maps.google` e `goo.gl/maps` do protótipo | Baixo: uma regex |
| D26 | O daily pode ser gerado antes de D-2 ("Gerar agora"); a action não recusa pela data | Baixo |
| D27 | Passo manual "Marcar como revisado" entre "Gerado, a revisar" e "Pronto para enviar" (o protótipo não mostra quem muda o estado) | Baixo |
| D28 | Dailies não exigem roteiro aprovado pelo cliente (alertas indicam, não bloqueiam) | Baixo |
| D29 | "Criar as tarefas da venda" em viagem antiga usa `vendida_em` (em Cuiabá) como dia da venda: as tarefas nascem já vencidas, o que mostra o atraso real | Baixo: trocar para "hoje" é uma linha |
| D30 | Prazo `venda + N` limitado ao início da viagem | Baixo |
| D31 | Textos do protótipo cortados: "e vão para o Trello" (subtítulo das tarefas, volta na fatia 6) e "Data conferida no passaporte." (aniversário; o sistema não confere) | Baixo |
| D32 | `roteiros.atualizado_em` só muda com o conteúdo; ações de status não mexem nele | Baixo |

## 8. Materiais pendentes
- **Texto oficial do encerramento do daily** (hoje provisório, o do protótipo). Entra por Admin › Parâmetros, sem código.
- **PDFs reais TAREFAS e RT** (citados em PRODUCT.md) para conferir colunas, ordem e layout da impressão. Até chegarem, vale o layout do protótipo.
- **Fontes da marca** (Evaida, CA Saygon Text) para o PDF do RT.
- **Retorno do grupo e da Valeska** sobre Reembolsos, Estoque, Caixa de experiência, Avisos por setor e Daily padrão (perguntas do §6).
- Lista de destinos frequentes e respectivos idiomas e fusos, se a equipe quiser ampliar `sugerirIdiomaEFuso`.
