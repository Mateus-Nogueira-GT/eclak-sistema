# Fatia 6c — Integrações externas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deixar Trello, Google Drive, IA (chat e "Reescrever com IA"), Expedia/Infotera (só interface) e o agendador (fila das integrações e daily D-2) prontos no código, testados contra serviços falsos e desligados até as variáveis de ambiente existirem; Admin › Integrações mostra o status real e testa a conexão.

**Architecture:** `src/server/integracoes/` com `config.ts` (lê o ambiente), `http.ts` (fetch injetável), um módulo por integração e a fila `integracao_envios` (outbox gravada na transação do evento, enviada fora dela por `after()` e pelo cron). Cron por route handlers `POST /api/cron/*` com `Authorization: Bearer CRON_SECRET`, liberados no proxy. IA pelo SDK oficial `@anthropic-ai/sdk` atrás da interface `ProvedorIA`.

**Tech Stack:** Next.js 16.4 (leia `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` e os guias de route handler antes de escrever), Drizzle, Zod, Vitest, `@anthropic-ai/sdk` (dependência nova, só na Task 5).

**Spec:** `docs/superpowers/specs/2026-11-24-fatia-6b-6c-design.md` §5, §6 (R-C1..R-C8), §7 e §8. Contexto: `docs/HANDOFF.md`.

**Branch:** `claude/fatia-6c-integracoes`, a partir de `claude/fatia-6b-conciliacao` (migrações em sequência, sem colisão de número).

## Global Constraints

- **Nenhuma chamada real a serviço externo** em teste, seed ou verificação; nenhuma conta, chave ou token criado. Testes usam `fetch` falso / provedor falso.
- Segredos só em `process.env`; nunca em código, banco, log, auditoria, mensagem de erro ou tela. A tela mostra **nomes** de variáveis que faltam, nunca valores. Log de erro externo: integração, classe do erro e status HTTP, nunca corpo.
- `config.ts` lê o ambiente **na chamada** (não no import).
- Nenhuma chamada externa dentro de `db.transaction` nem sob `travarViagem`. Enfileirar sim (na mesma transação do evento).
- Enfileirar só quando a integração está configurada no momento do evento (R-C1).
- Toda Server Action com `comPerfil(...)`; toda query com `exigirPerfil(...)`; auditoria na mesma transação; ação do sistema (cron) audita com `usuarioId: null` (a coluna aceita nulo).
- Tabela nova: RLS em migração custom + `tests/integracao/rls.test.ts`; enum novo em migração própria; migrações depois das da 6b.
- Dados que **não** saem do sistema: para o Trello e o Drive nada de valor, custo, margem, comissão, CPF, passaporte, nascimento; para a IA, CPF/CNPJ/passaporte/RG/nascimento trocados por marcadores antes do envio; camada estratégica só para quem já a vê (`veCamadaEstrategica`).
- Marca: azul #2E5C71 dominante, laranja só destaque, texto #333132, sem vermelho (falha em `ouro`), sem gradiente, sem emoji, **sem ícone de estrelinha para IA** (chat usa balão de conversa: `MessageCircle`/`MessagesSquare` do lucide). Sem status fictício ("Conectado", "Ativo") e sem conversa de exemplo.
- pt-BR; desktop 1440–1920; kit existente (`src/components/ui.tsx`, `kit.tsx`).
- Testes de integração só por `npm run test:integracao` (truncam o banco; depois `npm run seed:local`).
- Commits em português terminando com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Nunca `git stash` sem tag. Nunca `pkill` global.

## Decisões (valores exatos)

- Variáveis (exatamente estes nomes): `CRON_SECRET`; `TRELLO_API_KEY`, `TRELLO_TOKEN`, `TRELLO_LISTA_ID`; `GOOGLE_SA_EMAIL`, `GOOGLE_SA_CHAVE`, `GOOGLE_DRIVE_PASTA_RAIZ_ID`; `ANTHROPIC_API_KEY`, `IA_MODELO` (opcional, padrão `claude-opus-5-5`). `GOOGLE_SA_CHAVE` aceita `\n` literais (troca por quebra de linha).
- Integrações: `INTEGRACOES = ["trello","drive","ia","hotelaria","agendador"] as const`. Fila só para `trello` e `drive` (`INTEGRACOES_FILA`).
- Fila: situações `pendente | enviando | enviado | falhou`; `MAX_TENTATIVAS = 6`; espera depois da tentativa n (1-based): `[1, 5, 15, 60, 180]` minutos (a 6ª falha vira `falhou`); `enviando` há mais de 10 min volta a `pendente` (processo caiu). Lote do cron: 20 envios. Tomada de envio com `FOR UPDATE SKIP LOCKED`.
- Chaves de idempotência: Trello `venda:<viagemId>` e `roteiro:<viagemId>`; Drive `pasta:<viagemId>`.
- Timeout HTTP: 15 s. Classes de erro: `rede` (falha/timeout), `autenticacao` (401/403), `limite` (429), `recusado` (outros 4xx), `servidor` (5xx). `recusado` e `autenticacao` não esperam: vão direto a `falhou` (repetir não resolve).
- Trello: base `https://api.trello.com/1`; cabeçalho `Authorization: OAuth oauth_consumer_key="<key>", oauth_token="<token>"`; criar cartão `POST /1/cards` (JSON `{ idList, name, desc }`) → usa `id`, `shortUrl`; checklist `POST /1/checklists` (JSON `{ idCard, name }`) → `id`; item `POST /1/checklists/{id}/checkItems` (JSON `{ name }`); teste `GET /1/lists/{id}` → `name`. Nome do cartão: `<código> · <SOBRENOME DO TITULAR em maiúsculas> · <destino> · dd/mm a dd/mm/aaaa`; descrição: `Viagem no sistema: <NEXT_PUBLIC_SITE_URL>/viagens/<id>`. Checklists: "Tarefas da venda" (itens = `item` das tarefas automáticas da venda) e "Tarefas do roteiro".
- Drive: token `POST https://oauth2.googleapis.com/token` (form `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<jwt>`), JWT RS256 (`node:crypto` `createSign("RSA-SHA256")`), claims `iss`=email, `scope`=`https://www.googleapis.com/auth/drive`, `aud`=`https://oauth2.googleapis.com/token`, `iat`, `exp`=iat+3600; cache em memória até 60 s antes de expirar. Pasta: `POST https://www.googleapis.com/drive/v3/files?supportsAllDrives=true&fields=id,webViewLink` com `{ name, mimeType: "application/vnd.google-apps.folder", parents: [pai] }`. Nome: `ECL-NNNN_SOBRENOME_DESTINO_AAAAMMDD-AAAAMMDD` (maiúsculas, sem acento, espaços → nada; código do **cliente**), subpastas "Público" e "Uso interno". Upload multipart `POST https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true` (≤ 5 MB); listar `GET /drive/v3/files?q='<id>' in parents and trashed = false&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,webViewLink)`; teste `GET /drive/v3/files/<raiz>?supportsAllDrives=true&fields=id,name`.
- IA: `new Anthropic({ apiKey })`, `model` = `IA_MODELO ?? "claude-opus-5-5"`, `client.beta.messages.create` com `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, `output_config: { effort: "low" }` no reescrever e `"medium"` no chat, `max_tokens: 4000`; checar `stop_reason === "refusal"` antes de ler o texto ("A IA não respondeu a este pedido"). Chat: laço manual de ferramentas (máximo 6 voltas), ferramentas com `strict: true`, `tool_choice` `auto` (forçado dá 400 neste modelo). Referência do SDK copiada para o workspace do SDD (o controlador passa o caminho).
- IA: timeout por pedido 60 s, sem nova tentativa, prazo total 90 s (o modelo sempre pensa; 15 s não basta).
- Agendador do daily: roda para `hoje + 2` (Cuiabá); só roteiro `aprovado` de viagem `vendida`; só dia do roteiro sem linha ou com `estado = pendente`; `gerado_por = null`.

## Review Focus

1. **Integração desligada:** sem nenhuma variável, fechar venda, aprovar roteiro, abrir a viagem, o roteiro, o daily e Admin › Integrações funcionam como hoje; nada entra na fila; nenhum botão de IA aparece. Testes nas Tasks 2, 3, 5 e navegador na Task 4.
2. **Serviço fora do ar ou lento** (timeout, 500, 429) no meio do envio: a venda já está gravada; o envio fica `pendente` com próxima tentativa; nada é enviado duas vezes (cartão do Trello criado mas checklist falhou → a próxima tentativa reaproveita o id do cartão do `resultado`). Testes na Task 2.
3. **Cron chamado sem segredo, com segredo errado ou com `CRON_SECRET` vazio no ambiente:** 401 / 401 / 503, nada roda; o proxy não manda para o login. Testes na Task 1.
4. **Dado sensível escapando:** CPF com e sem máscara, passaporte e nascimento num texto de roteiro mandado para reescrever chegam ao provedor falso como marcadores; o cartão do Trello e o nome da pasta não têm valor nem documento. Testes nas Tasks 2, 3 e 5.
5. **Perfil errado:** só o Diretor abre Admin › Integrações, testa conexão e reenvia; o chat de um consultor nunca devolve custo ou margem. Testes nas Tasks 4 e 6.

---

### Task 1: Base das integrações, fila e cron

**Files:**
- Create: `src/server/integracoes/config.ts`, `src/server/integracoes/http.ts`, `src/server/integracoes/fila.ts` (server-only), `src/domain/integracoes.ts`, `src/server/db/schema/integracoes.ts`, migrações (enums em migração própria; tabela; custom RLS + índice único `(integracao, chave)` + índice `(situacao, proxima_em)`), `src/app/api/cron/integracoes/route.ts`, `src/server/cron.ts` (conferência do segredo), `tests/domain/integracoes.test.ts`, `tests/integracao/integracoes-fila.test.ts`
- Modify: `src/server/proxy-caminhos.ts` (+ `MATCHER_PROXY`) para não proteger `/api/cron/`, `tests/domain/proxy-caminhos.test.ts`, `tests/integracao/rls.test.ts`, `.env.example`

**Interfaces:**
- `src/domain/integracoes.ts`: `INTEGRACOES`, `INTEGRACOES_FILA`, `SITUACOES_ENVIO`, `MAX_TENTATIVAS`, `ESPERAS_MIN`, `proximaTentativa(tentativas: number, agora: Date): Date | null`, `type ClasseErro`, `classificarStatus(status: number): ClasseErro`, `repete(classe: ClasseErro): boolean`.
- `config.ts`: `VARIAVEIS: Record<Integracao, readonly string[]>` (hotelaria: `[]` e sempre desligada), `estadoIntegracao(i: Integracao, env = process.env): { configurada: boolean; faltam: string[] }`, leitores tipados `configTrello()`, `configDrive()`, `configIA()` (null quando desligada).
- `http.ts`: `type Buscar = typeof fetch`; `chamar(buscar: Buscar, url: string, init: RequestInit & { timeoutMs?: number }): Promise<{ ok: true; status: number; json: unknown } | { ok: false; classe: ClasseErro; status: number | null }>`; `class ErroIntegracao extends Error { classe; status }`.
- `fila.ts`: `enfileirar(tx: Transacao, e: { integracao: IntegracaoFila; tipo: string; viagemId: string | null; chave: string; payload: unknown }): Promise<void>` (só se configurada; `ON CONFLICT (integracao, chave) DO NOTHING`); `registrarProcessador(i: IntegracaoFila, fn: (envio, deps) => Promise<unknown /* resultado */>)` ou um mapa estático preenchido nas Tasks 2–3; `processarFila(opts?: { limite?: number; agora?: Date; buscar?: Buscar }): Promise<{ enviados: number; falhas: number }>` (toma com `SKIP LOCKED`, marca `enviando`, chama fora da transação, grava `enviado`+`resultado` ou a falha e a próxima tentativa); `processarDepois()` = `after(() => processarFila())` com try/catch que só loga; `reenviar(envioId)` (volta a `pendente`, zera `tentativas`, `proxima_em = agora`).
- Rota: `POST /api/cron/integracoes` → `exigirCron(request)` (`src/server/cron.ts`: 503 sem `CRON_SECRET`; 401 sem/errado; comparação em tempo constante) → `processarFila()` → `{ enviados, falhas }`. `GET` → 405.

- [ ] **Step 1: Testes de domínio** — `proximaTentativa(1, t)` = t+1 min … `(5,t)` = t+180 min, `(6,t)` = null; `classificarStatus(401)`=`autenticacao`, `429`=`limite`, `404`=`recusado`, `503`=`servidor`; `estadoIntegracao("trello", {})` → `{ configurada:false, faltam:["TRELLO_API_KEY","TRELLO_TOKEN","TRELLO_LISTA_ID"] }`; com as três → configurada; variável só com espaços conta como faltando; `deveProteger("/api/cron/integracoes")` = false e `deveProteger("/api/cronograma")` = true; `chamar` com fetch falso: 200 JSON, 500, rejeição, timeout (AbortSignal) → classes certas e nenhum corpo no erro.
- [ ] **Step 2: Testes de integração** — `enfileirar` desligada não grava; ligada grava uma vez (duas chamadas, mesma chave); `processarFila` com processador falso: sucesso → `enviado` + `resultado`; erro `servidor` → `pendente`, `tentativas=1`, `proxima_em` +1 min; erro `autenticacao` → `falhou`; sexta falha → `falhou`; `enviando` velho volta; envio com `proxima_em` no futuro não é tomado; `reenviar`; rota: sem `CRON_SECRET` 503, sem header 401, errado 401, certo 200.
- [ ] **Step 3: Implementar; passar** (`npm test`, `npm run test:integracao`, `npm run typecheck`, `npm run lint`).
- [ ] **Step 4: Commit** — `feat(integracoes): configuração, fila de envios e cron protegido por segredo`.

### Task 2: Trello

**Files:**
- Create: `src/server/integracoes/trello.ts`, `src/domain/trello.ts` (nome do cartão, puro), `tests/domain/trello.test.ts`, `tests/integracao/trello.test.ts`
- Modify: `src/server/actions/vendas.ts` (enfileirar `venda:<viagemId>` na transação do fechamento, junto de `criarTarefasAutomaticas`; `processarDepois()` depois do commit), `src/server/actions/roteiros.ts` (idem `roteiro:<viagemId>` ao aprovar), `src/server/integracoes/fila.ts` (processador `trello`)

**Interfaces:**
- `nomeDoCartao(v: { codigo: string; titular: string; destino: string; inicio: string; fim: string }): string`
- `clienteTrello(cfg: ConfigTrello, buscar: Buscar)`: `criarCartao({ nome, descricao }) → { id, url }`, `criarChecklist(cartaoId, nome) → { id }`, `adicionarItem(checklistId, nome)`, `testar() → { ok: true; lista: string } | { ok: false; classe }`.
- Processador `trello`: `tipo: "cartao_viagem"` (payload `{ viagemId, nome, descricao, itens: string[] }`) cria cartão (se `resultado.cartaoId` ainda não existe — gravar o `resultado` parcial logo depois de criar o cartão, antes do checklist) + checklist "Tarefas da venda" + itens; `tipo: "checklist_roteiro"` (payload `{ viagemId, itens }`) procura o `cartaoId` no envio `venda:<viagemId>` enviado; sem cartão ainda → erro `servidor` (tenta de novo depois).
- `enviarViagemAoTrello(viagemId)` Server Action (`comPerfil(["diretor"])`) para viagens já vendidas: enfileira `venda:<id>` com as tarefas automáticas atuais da viagem; recusa se desligada ("O Trello não está configurado").

- [ ] **Step 1: Testes** — nome do cartão (`ECL-0147-01 · SOUZA · Itália · 14/08 a 01/09/2027`); `clienteTrello` com fetch falso confere método, URL, cabeçalho `Authorization` exato, corpo JSON, e que `key`/`token` **não** aparecem na URL; fechar venda com Trello ligado enfileira 1 envio cujo payload não contém nenhum valor monetário nem CPF (procurar dígitos de CPF e `R$`); desligado não enfileira; processar com falha depois do cartão e antes do checklist → próxima tentativa não cria segundo cartão; aprovar roteiro enfileira `roteiro:`; fechar venda continua funcionando se `processarDepois` lançar.
- [ ] **Step 2: Implementar; passar; commit** — `feat(integracoes): Trello cria o cartão da viagem com as tarefas`.

### Task 3: Google Drive

**Files:**
- Create: `src/server/integracoes/google.ts` (token por JWT), `src/server/integracoes/drive.ts`, `src/domain/drive.ts` (nome da pasta), `tests/domain/drive.test.ts`, `tests/integracao/drive.test.ts`
- Modify: `src/server/actions/vendas.ts` (enfileirar `pasta:<viagemId>`), `src/server/integracoes/fila.ts` (processador `drive`), `src/server/queries/operacao.ts` ou a query do cabeçalho da viagem (link da pasta quando houver envio `pasta:` enviado), cabeçalho da viagem (link "Pasta no Drive")

**Interfaces:**
- `nomeDaPasta(v: { codigoCliente: string; titular: string; destino: string; inicio: string; fim: string }): string` → `ECL-0147_SOUZA_ITALIA_20270814-20270901`.
- `tokenGoogle(cfg, buscar, agora?)`; `clienteDrive(cfg, buscar)`: `criarPasta(nome, paiId) → { id, link }`, `enviarArquivo(pastaId, nome, mime, bytes) → { id, link }` (recusa > 5 MB), `listarArquivos(pastaId)`, `testar()`.
- Processador `drive` `tipo: "pasta_viagem"`: cria a pasta-mãe (grava `resultado.pastaId` parcial) e as duas subpastas; `resultado = { pastaId, link, publicaId, internaId }`.
- `criarPastasNoDrive(viagemId)` Server Action (`comPerfil(["diretor"])`), como `enviarViagemAoTrello`.

- [ ] **Step 1: Testes** — nome da pasta com acento e espaço ("São Paulo" → `SAOPAULO`, titular "Conceição" → `CONCEICAO`); JWT gerado com uma chave RSA de teste criada no próprio teste (`generateKeyPairSync`): header `{alg:"RS256",typ:"JWT"}`, claims exatas, assinatura verificável com a chave pública; `GOOGLE_SA_CHAVE` com `\n` literal funciona; token reaproveitado até 60 s antes de expirar; `criarPasta` manda `supportsAllDrives=true`, `Authorization: Bearer`, corpo certo; multipart com boundary e as duas partes; fechar venda com Drive ligado enfileira `pasta:`; retomada depois de criar a pasta-mãe não cria outra.
- [ ] **Step 2: Implementar; passar; commit** — `feat(integracoes): Drive cria as pastas da viagem`.

### Task 4: Admin › Integrações e botões na viagem

**Files:**
- Create: `src/app/(app)/admin/integracoes/page.tsx` (+ componente cliente), `src/server/actions/integracoes.ts`, `src/server/queries/integracoes.ts`, `tests/integracao/integracoes-admin.test.ts`
- Modify: `src/domain/perfis.ts` (`/admin/integracoes` só no `diretor`), `tests/domain/perfis.test.ts`, `src/components/shell.tsx` (item "Integrações" em Administração), cabeçalho/página da viagem vendida (botões "Enviar para o Trello" e "Criar pastas no Drive" só para o Diretor e só quando ligada e ainda não enviado; link do cartão e da pasta quando enviados)

**Interfaces:**
- `obterIntegracoes(): { cartoes: { integracao; nome; descricao; estado: { configurada; faltam }; ultimoTeste: { ok; em; classe? } | null }[]; fila: { pendentes: EnvioLista[]; falhas: EnvioLista[]; enviadosRecentes: EnvioLista[] } }` (`exigirPerfil("diretor")`). Último teste = última auditoria `tabela = "integracoes"`, `registro_id = <integracao>`.
- Actions (`comPerfil(["diretor"])`): `testarConexao(integracao)` (só configurada; chama `testar()` do cliente; audita `{ ok, classe }` sem segredo), `reenviarEnvio(envioId)`.
- Textos: título "Integrações", subtítulo "Ligações do sistema com as ferramentas que a equipe já usa."; cartão desligado: "Desligada. Para ligar, preencha no ambiente: TRELLO_API_KEY, TRELLO_TOKEN, TRELLO_LISTA_ID"; hotelaria: "Desligada. Aguardando o contrato e a documentação da API da Expedia TAAP e da Infotera."; agendador: estado do `CRON_SECRET` e as duas URLs.

- [ ] **Step 1: Testes** — consultor/operacional/financeiros → `Sem permissão` / `ErroAcesso`; `testarConexao` desligada → "Integração desligada"; com cliente falso → audita e aparece em `ultimoTeste`; `reenviarEnvio`.
- [ ] **Step 2: Implementar; navegador** (Playwright headless, Diretor, tudo desligado): Admin › Integrações mostra os cinco cartões "Desligada" com os nomes das variáveis; viagem vendida sem botões; captura 1440 px. Consultor em `/admin/integracoes` → `/sem-acesso`.
- [ ] **Step 3: Gate; commit** — `feat(integracoes): Admin › Integrações com status real, teste de conexão e fila`.

### Task 5: IA — provedor, privacidade e "Reescrever com IA"

**Files:**
- Create: `src/server/integracoes/ia.ts` (`ProvedorIA` + adaptador Claude), `src/domain/ia-privacidade.ts`, `src/server/db/schema/ia.ts` + migração (`ia_usos`) + RLS, `src/server/actions/ia.ts`, `tests/domain/ia-privacidade.test.ts`, `tests/integracao/ia.test.ts`
- Modify: `package.json` (`@anthropic-ai/sdk`, versão atual publicada há mais de duas semanas, fixada), editor do roteiro (abertura, DICA ECLAK, "Por que escolhemos") e do daily (texto): botão "Reescrever com IA" só quando ligada, sugestão ao lado com "Usar este texto" / "Descartar"; `tests/integracao/rls.test.ts`

**Interfaces:**
- `interface ProvedorIA { responder(p: { sistema: string; mensagens: MensagemIA[]; ferramentas?: FerramentaIA[]; esforco: "low" | "medium" }): Promise<RespostaIA> }` com uso de tokens no retorno; `provedorIA(): ProvedorIA | null` (null desligada); `definirProvedorIAParaTestes(p | null)`.
- `protegerTexto(texto: string, conhecidos?: { nascimentos?: string[]; documentos?: string[] }): string` — CPF (`000.000.000-00` e 11 dígitos), CNPJ, passaporte (2 letras + 6/7 dígitos), RG com máscara, datas de `nascimentos` em `dd/mm/aaaa` e ISO → `[CPF]`, `[CNPJ]`, `[PASSAPORTE]`, `[RG]`, `[NASCIMENTO]`. Não troca datas de viagem nem valores.
- `reescreverTexto(dados: { texto: string; finalidade: "abertura" | "dica" | "porque" | "daily"; idioma })` (`comPerfil([])`; 1–4000 caracteres; texto protegido; sistema em pt-BR com o tom ECLAK — direto, acolhedor, sem emoji, sem exagero, mantém fatos, datas e nomes; devolve `{ ok: true; texto }`; grava `ia_usos` com recurso `reescrever:<finalidade>`, modelo e tokens; desligada → "A IA não está configurada").
- `ia_usos`: `usuario_id`, `em`, `recurso`, `modelo`, `tokens_entrada`, `tokens_saida`. Sem texto.

- [ ] **Step 1: Testes** — `protegerTexto` (cada padrão; "14/08/2027" de viagem fica; "R$ 1.234,56" fica); `reescreverTexto` com provedor falso: o texto que chega ao provedor tem `[CPF]`, a resposta volta, `ia_usos` gravado; recusa (`stop_reason` refusal simulada) → mensagem; desligada → mensagem e nada gravado; adaptador Claude testado com um `fetch` falso injetado no SDK (`new Anthropic({ apiKey, fetch })`): confere `model`, `betas`/cabeçalho `anthropic-beta`, `fallbacks`, `output_config.effort`.
- [ ] **Step 2: Implementar; navegador** (desligada: nenhum botão "Reescrever com IA" no roteiro nem no daily); **Step 3: gate; commit** — `feat(ia): provedor Claude, proteção de dados e Reescrever com IA`.

### Task 6: IA — chat

**Files:**
- Create: `src/server/ia/ferramentas.ts` (ferramentas só de leitura), `src/server/actions/chat.ts`, `src/components/chat-ia.tsx`, `tests/integracao/chat.test.ts`
- Modify: `src/components/shell.tsx` (botão com balão de conversa no topo, só quando a IA está ligada — a página do layout passa o booleano do servidor)

**Interfaces:**
- Ferramentas (nome, descrição pt-BR, `input_schema` com `additionalProperties: false`, `strict: true`): `buscar_viagens({ busca })` (usa `listarOrcamentos`/listagem de viagens existente), `resumo_da_viagem({ codigo })` (dados operacionais; custo/margem só se `veCamadaEstrategica(perfil)`), `minhas_tarefas({})` (`listarTarefas` do usuário), `dailies_da_semana({})` (`listarDailies`). Todas chamam as queries existentes (que já fazem `exigirPerfil`); saída JSON enxuta, sem CPF/passaporte/nascimento/telefone, e passada por `protegerTexto`.
- `conversar(mensagens: { de: "eu" | "ia"; texto: string }[])` (`comPerfil([])`; até 30 mensagens, cada uma ≤ 4000): laço de ferramentas até 6 voltas; sistema: quem pergunta (nome, perfil), "hoje", regras (só responde com dados das ferramentas, não inventa, diz quando não pode ver algo, não salva nada); grava `ia_usos` (`recurso: "chat"`, soma dos tokens); devolve `{ ok: true; texto }`.
- Painel lateral como o do protótipo (`eclak-mockup/src/components/chat-ia.tsx` — copiar só a estrutura visual): cabeçalho azul "Chat com IA" + "Acesso de <perfil>", sem mensagens de exemplo; primeira mensagem fixa: "Posso responder perguntas sobre viagens, tarefas e dailies com o que o seu perfil pode ver. Por enquanto eu só leio: nada é salvo pelo chat."; sem anexo e sem microfone (fora de escopo).

- [ ] **Step 1: Testes** — com provedor falso que pede `resumo_da_viagem`: como consultor, o `tool_result` não tem custo nem margem; como diretor, tem; ferramenta com código inexistente → resultado de erro (`is_error`) e a conversa segue; laço para em 6 voltas com mensagem; desligada → recusa.
- [ ] **Step 2: Implementar; navegador** (desligada: sem botão; com provedor falso não dá para ligar no navegador — registrar no relatório); **Step 3: gate; commit** — `feat(ia): chat só de leitura respeitando o perfil`.

### Task 7: Agendador do daily, hotelaria e documentação

**Files:**
- Create: `src/server/operacao/dailies.ts` (núcleo de gerar o daily extraído de `src/server/actions/dailies.ts`, sem `comPerfil`, com `usuarioId: string | null`), `src/app/api/cron/dailies/route.ts`, `src/server/integracoes/hotelaria.ts` (só `interface ProvedorHotelaria` + `provedorHotelaria(): null`), `tests/integracao/cron-dailies.test.ts`
- Modify: `src/server/actions/dailies.ts` (`gerarDaily` passa a chamar o núcleo; comportamento igual — os testes de `tests/integracao/dailies.test.ts` continuam verdes sem mudança), `.env.example`, `README.md` (seção "Integrações": tabela do spec §8, como ligar cada uma, Railway cron, o que nunca sai do sistema), `docs/HANDOFF.md` (fatia 6c, rulings R-C1..R-C8, migrações, números dos testes, "testado só contra serviços falsos")

**Interfaces:**
- `gerarDailiesDoDia(data: string): Promise<{ gerados: number; pulados: number }>` — roteiros aprovados de viagens vendidas com dia `data`; pula dia com texto (`gerado`, revisado, `enviado`); gera o resto com `geradoPor: null`; cada um na própria transação; audita com `usuarioId: null`.
- Rota `POST /api/cron/dailies` → `exigirCron` → `gerarDailiesDoDia(somarDias(hojeEmCuiaba(), 2))` → `{ gerados, pulados }`.

- [ ] **Step 1: Testes** — roteiro aprovado com dia D+2 sem daily → gera (estado `gerado`, `gerado_por` nulo, auditoria com usuário nulo); daily já gerado/enviado → não mexe; roteiro em rascunho → não gera; rota sem segredo 401; `dailies.test.ts` inalterado e verde.
- [ ] **Step 2: Implementar; passar.**
- [ ] **Step 3: Documentação** — `.env.example` com todas as variáveis vazias e comentadas; README; HANDOFF.
- [ ] **Step 4: Gate completo** `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build`; `npm run seed:local` duas vezes; commit `feat(operacao): agendador do daily D-2, interface de hotelaria e documentação das integrações`.
