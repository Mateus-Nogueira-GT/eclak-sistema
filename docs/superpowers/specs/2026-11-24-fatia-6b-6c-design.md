# Fatias 6b e 6c — Conciliação OFX e integrações externas (desenho)

Data: 24/11/2026 · Base: `claude/fatia-6a-paineis` (PR #8) · Esboço anterior: `2026-11-23-fatia-6-paineis-integracoes-design.md` §6 e §7 · HANDOFF: `docs/HANDOFF.md`

Pedido do Mateus (24/11/2026): "Crie toda a estrutura do 6b e do 6c (endpoints etc.) e depois a gente só entra com as credenciais." E: a Visão geral **não** aparece para a Valeska (Financeiro operacional) — já é assim desde a 6a (`ROTAS_POR_PERFIL`), fica fechado.

## 1. Intenção

- **6b:** a Valeska importa o extrato OFX de cada conta e confere cada transação com o sistema, sem planilha. O que não bate vira aviso na Visão geral e linha no relatório "Conciliação extrato x sistema". Não depende de credencial: fica pronta e testada de ponta a ponta (com arquivos OFX sintéticos, porque ainda não há um real).
- **6c:** Trello, Google Drive, IA (chat e "Reescrever com IA"), Expedia/Infotera e o agendador (daily D-2 e fila das integrações) com o código pronto, testado contra serviços falsos, e **desligados** até as variáveis de ambiente existirem. Ligar = preencher o `.env` no Railway e clicar em "Testar conexão" em Admin › Integrações. Nenhuma conta, chave ou token é criado por nós.

## 2. Anti-objetivos (falha mesmo que "funcione")

- Status fictício: "Conectado", "Ativo" ou conversa de exemplo do protótipo. O status vem só do ambiente e do último teste real.
- Fechar venda ou aprovar roteiro falhar ou demorar por causa do Trello ou do Drive (chamada externa dentro da transação ou sob `travarViagem`).
- CPF, passaporte ou data de nascimento indo para o modelo de IA; custo, margem ou comissão indo para cartão do Trello; camada estratégica chegando a consultor ou operacional pelo chat.
- Segredo no código, no banco, em log ou na tela. Só no ambiente.
- Conciliação contando a mesma baixa duas vezes, ou conciliando compra de cartão corporativo (o banco vê a fatura).
- Endpoint inventado para Expedia/Infotera sem documentação.

## 3. Restrições

Iguais às da 6a (HANDOFF §4): centavos `bigint`, "hoje" em Cuiabá, `comPerfil` em toda action, `exigirPerfil` em toda query, auditoria na mesma transação, RLS em toda tabela nova + `rls.test.ts`, enum novo em migração própria, marca, pt-BR, desktop 1440–1920. "Sem API separada" continua: route handler só onde algo de fora chama (cron) ou onde é download; o resto é Server Action.

## 4. Fatia 6b — Extrato OFX e conciliação

### 4.1 Dados
- `extratos` — um por arquivo importado: `conta_bancaria_id`, `arquivo_nome`, `arquivo_hash` (SHA-256 dos bytes; único por conta), `banco_ofx` (BANKID/ORG lidos), `conta_ofx` (ACCTID, só os 4 últimos dígitos), `inicio`, `fim` (DTSTART/DTEND), `transacoes` (quantas novas), `repetidas` (FITID já importado), `importado_por`, `importado_em`.
- `extrato_transacoes` — `extrato_id`, `conta_bancaria_id`, `fitid`, `data` (date), `valor` (bigint com sinal: entrada positiva, saída negativa), `tipo` (TRNTYPE), `descricao` (NAME + MEMO, até 255), `situacao` (`pendente` | `conciliada` | `ignorada`), `linha_origem` + `linha_id` (a linha da view `lancamentos_financeiros`, mesmo esquema origem+id dos anexos), `conciliada_por/em`, `ignorada_motivo`, `ignorada_por/em`. Único `(conta_bancaria_id, fitid)`: reimportar não duplica. Índice único parcial `(linha_origem, linha_id) WHERE situacao = 'conciliada'`: uma baixa casa com no máximo uma transação.
- **O arquivo OFX não é guardado** (ruling R-B1): o bucket `anexos` recusa tudo que não é PDF/PNG/JPEG e o conteúdo do extrato fica todo nas tabelas; guardamos o hash para recusar o mesmo arquivo de novo.

### 4.2 Leitura do OFX (`src/domain/ofx.ts`, puro)
- Aceita OFX 1.x (SGML, tags sem fechamento) e 2.x (XML). Decodifica pelo cabeçalho: `CHARSET:1252`/`ENCODING:USASCII` → windows-1252; XML `encoding="UTF-8"` ou sem indicação → UTF-8.
- `TRNAMT` de string para centavos sem ponto flutuante, aceitando ponto ou vírgula decimal e sinal; `DTPOSTED` `AAAAMMDD[HHMMSS[.XXX]][[-3:BRT]]` → a data `AAAA-MM-DD` como escrita (sem converter fuso).
- Um arquivo com mais de uma conta (`STMTRS`) é recusado com mensagem; cartão de crédito (`CCSTMTRS`) também (fora de escopo: a fatura do cartão já é uma linha).
- Erros de leitura com mensagem em pt-BR ("O arquivo não parece um extrato OFX", "Transação sem FITID na linha N"…). Tamanho máximo 5 MB.
- Testado com arquivos sintéticos nos dois formatos e nos dialetos comuns de bancos brasileiros (sem dado real).

### 4.3 Conciliação (`src/domain/conciliacao.ts`, puro + `src/server/financeiro/conciliacao.ts`)
- Candidatas = linhas da view **baixadas**, `transita_caixa`, na mesma conta (`conta_bancaria_id`), não canceladas, ainda não conciliadas. Sinal: `receber` = entrada (+), `pagar` = saída (−). Valor comparado = `valor_caixa_baixado`. A fatura do cartão corporativo entra como uma linha só (é o que o banco vê); as compras não entram (`transita_caixa = false`).
- **Sugestão:** mesma conta, mesmo sinal, mesmo valor, `baixado_em` a até 3 dias da data da transação; a mais próxima na data (empate: nenhuma sugestão automática, mostra as opções).
- A Valeska pode: **confirmar** a sugestão; **escolher outra** linha (lista das baixas da conta a até 10 dias, de qualquer valor — se o valor diferir, a situação mostra "Diferença de R$ x"); **criar lançamento** a partir da transação (tarifa, IOF, rendimento: lançamento manual já baixado na data e na conta, categoria escolhida, conciliado na mesma transação); **ignorar** com motivo; **desfazer** (volta a pendente).
- **Desfazer a baixa de uma linha conciliada** (ruling R-B2): não mexemos nos núcleos de baixa. A conciliação só vale enquanto a linha continua baixada naquela conta e com o mesmo valor; senão a transação aparece como "A baixa mudou: confira" e o par é solto ao desfazer. A conferência é feita na leitura.
- Situação exibida: **Confere** (valor igual), **Diferença de R$ x**, **Não conciliado**, **Ignorado (motivo)**, **A baixa mudou**.

### 4.4 Telas
- `/financeiro/conciliacao` (diretor e os dois financeiros; menu Financeiro, depois de "Contas bancárias"): escolher a conta, enviar o OFX (resumo: N novas, M repetidas, período), lista das transações do período com filtro de situação, e ações por linha. Histórico das importações da conta.
- Relatório `conciliacao` em `/financeiro/relatorios` ("Conciliação extrato x sistema"): data, descrição do extrato, valor do extrato, valor do sistema, situação; totais por situação; planilha e impressão como os outros.
- Aviso `conciliacao` em "Para decidir hoje" (entre `pagar` e `aprovacao`): "N transações do extrato sem par no sistema" quando há transação pendente com data de mais de 3 dias, link para a conciliação. Responsável: Financeiro.

## 5. Fatia 6c — Integrações externas

### 5.1 Estrutura comum (`src/server/integracoes/`)
- `config.ts`: lê o ambiente e diz, por integração, `configurada` e **quais variáveis faltam** (nomes, nunca valores). Nada é lido no import (testável).
- `http.ts`: `fetch` injetável, timeout de 15 s, erro classificado (`rede`, `autenticacao`, `limite`, `recusado`, `servidor`) sem guardar corpo de resposta nem segredo.
- **Fila** `integracao_envios` (outbox): `integracao` (`trello` | `drive`), `tipo`, `viagem_id`, `chave` (única por integração: idempotência), `payload` jsonb (sem dado sensível), `situacao` (`pendente` | `enviando` | `enviado` | `falhou`), `tentativas`, `proxima_em`, `ultimo_erro` (classe + status HTTP, sem corpo), `resultado` jsonb (ids e links externos), `criado_em`, `enviado_em`. Gravada **na mesma transação** do evento (fechar venda, aprovar roteiro); **enviada fora dela**: logo depois da resposta (`after()` do Next) e, para o que falhou, pelo cron. Até 6 tentativas com espera crescente (1, 5, 15, 60, 180 min); depois "falhou" até alguém clicar em Reenviar.
- **Sem acúmulo enquanto desligada** (ruling R-C1): só entra na fila se a integração estiver configurada no momento do evento. Ao ligar depois, nada antigo é despejado; viagens já vendidas podem ser enviadas pelo botão "Enviar para o Trello" / "Criar pastas no Drive" na viagem.
- **Cron** (`/api/cron/integracoes` e `/api/cron/dailies`): `POST` com `Authorization: Bearer <CRON_SECRET>`; sem `CRON_SECRET` no ambiente, responde 503. O proxy deixa `/api/cron/` passar sem sessão (a rota confere o segredo). Ação do sistema audita com `usuario_id` nulo. No Railway, um serviço cron chama a URL (README).
- **Admin › Integrações** (`/admin/integracoes`, só Diretor): um cartão por integração com o status real ("Desligada: faltam TRELLO_API_KEY, TRELLO_TOKEN" / "Configurada · último teste ok em …" / "Configurada · último teste falhou: autenticação"), botão **Testar conexão** (chamada real, só quando configurada; resultado auditado), e a fila com pendentes e falhas (Reenviar).

### 5.2 Trello
- Variáveis: `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_LISTA_ID` (lista "Operações" do quadro).
- API REST `https://api.trello.com/1`, autenticação pelo cabeçalho `Authorization: OAuth oauth_consumer_key="…", oauth_token="…"` (documentado pela Atlassian; não vai na URL, não aparece em log).
- **Venda fechada** → um cartão por viagem na lista (`POST /1/cards`): nome `ECL-0147-01 · SOUZA · Itália · 14/08 a 01/09/2027`, descrição com o link da viagem no sistema; checklist "Tarefas da venda" com as tarefas automáticas da venda (as 5 da 5a). **Roteiro aprovado** → checklist "Tarefas do roteiro" no mesmo cartão (as 3). Nada de valor, custo, margem, CPF.
- Idempotência pela `chave` da fila (`venda:<viagem>`, `roteiro:<viagem>`); o id do cartão fica no `resultado` e é reaproveitado.
- Testar conexão: `GET /1/lists/{id}` → "Lista Operações do quadro encontrada".

### 5.3 Google Drive
- Variáveis: `GOOGLE_SA_EMAIL`, `GOOGLE_SA_CHAVE` (chave privada PEM da conta de serviço), `GOOGLE_DRIVE_PASTA_RAIZ_ID` (pasta **num drive compartilhado**: conta de serviço não tem cota própria — doc do Google).
- Token: JWT RS256 assinado com `node:crypto` → `POST https://oauth2.googleapis.com/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`), escopo `https://www.googleapis.com/auth/drive`, guardado em memória até expirar. Sem biblioteca do Google.
- **Venda fechada** → pasta `ECL-0147_SOUZA_ITALIA_20270814-20270901` na raiz com duas subpastas, "Público" e "Uso interno" (ruling R-C2: o protótipo fala em pasta pública e de uso interno; uma pasta-mãe deixa as duas juntas). `supportsAllDrives=true`. O link da pasta aparece na viagem.
- O cliente também sabe **subir arquivo** (multipart, até 5 MB) e **listar arquivos** de uma pasta, mas nenhuma tela usa isso ainda (ruling R-C3): documentos de passaporte/RG e a leitura das notas pedem decisão de LGPD e de onde fica cada coisa.
- Testar conexão: obter o token e ler a pasta raiz (`GET /drive/v3/files/{id}?supportsAllDrives=true&fields=id,name`).

### 5.4 IA (chat e "Reescrever com IA")
- Provedor padrão (ruling R-C4, o Mateus pode trocar): **Claude**, SDK oficial `@anthropic-ai/sdk`, modelo `claude-opus-5-5` (variável `IA_MODELO` para trocar), `fallbacks: "default"` (beta `server-side-fallback-2026-07-01`). Variável `ANTHROPIC_API_KEY`. Tudo atrás de uma interface `ProvedorIA` para trocar de provedor sem mexer nas telas.
- **Proteção de dados** (`src/domain/ia-privacidade.ts`, puro): antes de enviar, troca CPF, CNPJ, número de passaporte, RG e datas de nascimento conhecidas por marcadores (`[CPF]`…). As ferramentas do chat nunca devolvem esses campos.
- **Chat** (botão com balão de conversa no topo, painel lateral como no protótipo; nunca estrelinha): conversa sem persistência no banco (some ao recarregar — ruling R-C5); ferramentas **só de leitura** que chamam as queries existentes com o perfil de quem pergunta (`exigirPerfil` faz o resto): buscar viagens por código/cliente/destino, resumo da viagem (camada estratégica só para quem já vê), minhas tarefas, dailies da semana. Escrever pelo chat ("confirma antes de salvar" do protótipo) fica para depois (ruling R-C6).
- **Reescrever com IA** no roteiro (abertura, DICA ECLAK, "Por que escolhemos") e no texto do daily: mostra a sugestão ao lado; a pessoa aceita ou descarta. Nada é gravado sem o clique.
- Uso registrado em `ia_usos` (quem, quando, recurso, modelo, tokens de entrada e saída): o custo é pago pela ECLAK direto ao provedor. Sem texto da conversa no registro.
- Desligada: o botão do chat e o "Reescrever" não aparecem.

### 5.5 Expedia TAAP e Infotera (New Age)
- Sem contrato e sem documentação: só a interface `ProvedorHotelaria` (busca por destino, datas, quartos, hóspedes) e o cartão "Desligada: aguardando contrato e documentação da API" em Admin › Integrações. Nenhuma URL, nenhuma variável inventada (ruling R-C7).

### 5.6 Agendador do daily (D-2)
- `/api/cron/dailies` (uma vez por dia, de manhã em Cuiabá): para cada roteiro **aprovado** de viagem vendida, gera o daily dos dias com data = hoje + 2 que ainda não têm texto (pendente ou sem linha), com o mesmo núcleo de `gerarDaily` (extraído para `src/server/operacao/dailies.ts`), `gerado_por` nulo (sistema). Nunca sobrescreve texto gerado, revisado ou enviado. O envio ao cliente continua manual (WhatsApp).
- **Vouchers em PDF** ficam fora (ruling R-C8): não há modelo de voucher definido; o voucher do fornecedor continua anexo.

## 6. Rulings (para o Mateus conferir)

| | Decisão | Custo se errada |
|---|---|---|
| R-B1 | O arquivo OFX não é guardado; só as transações e o hash | Guardar exige bucket novo (uma migração) |
| R-B2 | Desfazer baixa não é bloqueado; a conciliação é conferida na leitura ("A baixa mudou") | Bloquear exige mexer nos 5 núcleos de baixa |
| R-B3 | Sugestão: mesmo valor de caixa (líquido) e até 3 dias; escolha manual até 10 dias | Muda duas constantes |
| R-C1 | Fila só quando a integração já está ligada; viagens antigas por botão | Um filtro na hora de enfileirar |
| R-C2 | Drive: pasta-mãe com "Público" e "Uso interno" | Nome e estrutura num lugar só |
| R-C3 | Upload e leitura no Drive prontos no cliente, sem tela | Telas novas quando decidirem |
| R-C4 | IA: Claude (`claude-opus-5-5`) pelo SDK oficial, atrás de interface | Trocar o adaptador |
| R-C5 | Chat sem histórico no banco | Tabela nova |
| R-C6 | Chat só lê; escrita fica para depois | Ferramentas de escrita com confirmação |
| R-C7 | Expedia/Infotera só interface | Implementar quando houver documentação |
| R-C8 | Vouchers em PDF fora | Modelo do voucher |

## 7. O que é testado e como

- 6b: domínio (leitor OFX, sugestão), integração (importar, reimportar, confirmar, escolher, criar lançamento, ignorar, desfazer, baixa desfeita, permissões, RLS), relatório e aviso, e navegador.
- 6c: domínio (nomes de pasta e cartão, privacidade, backoff), clientes HTTP contra `fetch` falso (formato exato das chamadas, erros 401/429/500, timeout), fila (enfileirar na transação, idempotência, reenvio, cron com e sem segredo), Admin › Integrações no navegador com tudo desligado. **Nenhuma chamada real**: "só entrar com as credenciais" fica provado só quando o primeiro "Testar conexão" real der certo.

## 8. Para ligar cada integração (vai para o README)
| Integração | Variáveis | Onde conseguir |
|---|---|---|
| Agendador | `CRON_SECRET` | gerar um valor aleatório longo; serviço cron do Railway chama `POST /api/cron/integracoes` (a cada 10 min) e `POST /api/cron/dailies` (07:00 Cuiabá) |
| Trello | `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_LISTA_ID` | Power-Up admin do Trello (chave e token da conta da ECLAK); id da lista pelo `.json` do quadro |
| Drive | `GOOGLE_SA_EMAIL`, `GOOGLE_SA_CHAVE`, `GOOGLE_DRIVE_PASTA_RAIZ_ID` | conta de serviço no Google Cloud com a Drive API ativa; adicionada como editora do drive compartilhado |
| IA | `ANTHROPIC_API_KEY`, `IA_MODELO` (opcional) | Console da Anthropic, chave da organização da ECLAK |
