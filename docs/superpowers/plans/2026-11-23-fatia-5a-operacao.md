# Fatia 5a (Operação da viagem) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar a cada viagem vendida:
- tarefas de operação (6 categorias, prazo fixo ou relativo ao embarque, responsável, conclusão; 5 automáticas na venda e 3 na aprovação do roteiro, sem duplicar), com lista entre viagens e impressão;
- o roteiro (RT) do cliente, com dias das datas da viagem, DICA ECLAK, "Por que escolhemos", hotéis e voos pré-preenchidos, aviso de aniversário e PDF `RT_<TITULAR>_<DESTINO>_<ini>-<fim>`;
- os dailies gerados por modelo, com os 6 indicadores do "Padrão do daily ECLAK", estados até "Enviado" e versão interna de plantão com horário de Mato Grosso e Brasília.

**Architecture:** Três tabelas novas:
- `tarefas`, relacional, com índice único `(viagem_id, chave)` para as automáticas;
- `roteiros`, uma linha por viagem, com o conteúdo num `jsonb` validado por Zod no domínio;
- `dailies`, uma linha por dia que já teve ação.

Toda regra (prazo efetivo, situação, dias, pré-preenchimento, aniversário, modelo do daily, indicadores, fuso) é função pura em `src/domain/{tarefas,roteiro,daily}.ts`. As actions só validam, travam a linha, gravam e auditam. As tarefas da venda nascem **dentro** da transação de `fecharVenda`; as do roteiro, dentro da transação da aprovação. O texto de encerramento do daily é um parâmetro novo versionado em `RegrasSchema`.

**Tech Stack:** o das fatias anteriores (Next.js 16.4, React 19.3, Drizzle, Supabase local, Zod, Vitest, Tailwind v4).

**Spec:** `docs/superpowers/specs/2026-11-23-fatia-5-operacao-design.md` (§5 inteiro; decisões D1–D32 no §7). Protótipo (`eclak-mockup`, só leitura): `src/app/tarefas/page.tsx`, `src/app/roteiros/page.tsx`, `src/app/dailies/page.tsx`, `src/app/admin/integracoes/page.tsx` (`tasksProposta`, `tasksRoteiro`). Padrão de impressão: `src/app/(app)/viagens/[id]/proposta/{page.tsx,imprimir.tsx}`. Padrão de concorrência: `salvarCliente` em `src/server/actions/clientes.ts`. HANDOFF §4 (convenções).

**Base:** `origin/main` (`1c2ba35`). Não depende da 4b (PR #6). Se a 4b entrar em `main` antes da Task 4, fazer `git fetch && git rebase origin/main` antes de gerar migrações.

## Global Constraints

- Todas as das fatias 1–4a:
  - "hoje" = `hojeEmCuiaba()`; datas ISO `AAAA-MM-DD`;
  - **toda Server Action começa com `comPerfil(...)`**, **toda query com `exigirPerfil(...)`**;
  - `registrarAuditoria` na mesma transação de toda escrita;
  - exclusão lógica (`excluido_em`);
  - erros de banco logados só com o código.
- **Acesso:** os cinco perfis. Actions usam `comPerfil([], …)` (qualquer usuário ativo); queries usam `exigirPerfil()`.
- **Camada estratégica:** as queries desta fatia selecionam colunas explícitas e **nunca** leem `cotacoes`, `contas_pagar`, `pagamentos_fornecedor`, `comissoes`, `parcelas_receber`, `versoes_precificacao`.
- Toda tabela nova: `ENABLE ROW LEVEL SECURITY` numa migração custom e entrada em `tests/integracao/rls.test.ts`. Enums novos nascem com a tabela. Valor novo de enum existente vai em migração própria.
- **Migrações:** número seguinte ao último arquivo em `drizzle/` no momento da execução (o plano não fixa números). Validar do zero (`npx supabase db reset && npm run db:migrate`) e sobre banco populado.
- Tarefas, roteiro e dailies só para viagem com `status = 'vendida'`. Fora disso a mensagem é "A viagem ainda não foi vendida".
- **Concorrência otimista:** ler a linha `for update`, comparar `atualizado_em` com `atualizadoEmEsperado` (ISO em milissegundos, como `FichaPrecificacao.atualizadoEm`) e responder com as mensagens exatas:
  - "Esta tarefa foi alterada por outra pessoa. Recarregue a página.";
  - "Este roteiro foi alterado por outra pessoa. Recarregue a página.";
  - "Este daily foi alterado por outra pessoa. Recarregue a página.".

  Todas com `conflito: true`, como em Clientes.
- **Marca:** azul #2E5C71 dominante; laranja só destaque; vencido/atenção em `ouro`, **nunca vermelho**; sem gradiente, sem emoji (também nos textos ao cliente), sem estrelinha. Textos pt-BR. Desktop 1440–1920.
- **Textos exatos** (categorias, nomes e dicas dos indicadores, rodapé do RT, nota dos voos, encerramento inicial, rótulos de estado): copiar do spec §5.3–5.5 sem reescrever.
- Testes de integração truncam o banco: rodar `npm run seed:local` no fim de cada tarefa que rodou integração.

## Review Focus

1. **Tarefas automáticas sem duplicar:** `fecharVenda` cria exatamente 5. Aprovar → desfazer → aprovar e duas aprovações em `Promise.all` deixam exatamente 3 do roteiro. A automática excluída não renasce. Testes na Task 5 e na Task 6.
2. **Edição simultânea do roteiro:** dois `salvarRoteiro` com o mesmo `atualizadoEmEsperado` resultam em um ok e um `conflito` com a mensagem exata; o conteúdo final é o do vencedor, inteiro. Teste na Task 6.
3. **Datas e fusos:**
   - "15 dias antes" de 14/08/2027 = 30/07/2027;
   - D-2 de 16/08/2027 = 14/08/2027;
   - 13h26 em `Europe/Rome` em 16/08/2027 → 07h26 MT e 08h26 Brasília;
   - em 20/01/2027 → 08h26 e 09h26.

   Testes nas Tasks 1 e 3.
4. **Modelo × indicadores:** o texto gerado pelo modelo para um dia com troca de hotel e itens com hora passa nos 6 indicadores com o encerramento vigente; cada indicador tem um exemplo que falha. Teste na Task 3; com o parâmetro alterado, na Task 7.
5. **Nada estratégico e todos os perfis:** consultor e operacional leem e escrevem tarefas, roteiro e dailies. O JSON devolvido pelas queries de operação não contém `valorBrl`, `valorOriginal`, `margem`, `custo` nem `comissao`. Anon não lê as três tabelas. Testes nas Tasks 4–7.

---

## Rulings desta fatia (Claude, para o Mateus conferir)

As decisões D1–D32 do spec (§7) valem. As que mudam código estão detalhadas abaixo.

1. **Prazo** (D4): `Prazo = { tipo: "data"; data } | { tipo: "dias_antes"; dias: 0–365 } | null`. A data efetiva é calculada no domínio, nunca gravada.
2. **Automáticas** (D5–D7): tabela do spec §5.3, com o responsável inicial = `viagens.consultor_id`, `origem` `venda`/`roteiro`, `chave` estável e `fazer` vazio. Inserção com `onConflictDoNothing({ target: [tarefas.viagemId, tarefas.chave], where: sql`chave is not null` })` (o índice único é parcial, então o alvo do conflito repete o predicado; conferir o nome da opção na versão instalada do Drizzle). Auditoria só das inseridas (`returning`).
3. **Roteiro em `jsonb`** (D2): o servidor recusa `dias` que não sejam exatamente `datasDaViagem(inicio, fim)` com "Os dias do roteiro não batem com as datas da viagem".
4. **Daily sob demanda** (D10): `gerarDaily` é a única escrita que cria texto. A página nunca grava ao abrir.
5. **Indicador 1** (D11): aceita a saudação do idioma do roteiro, inclusive "Bom dia" em português.
6. **Encerramento** (D20): `encerramentoDaily: z.string().trim().min(1, "Informe o texto de encerramento").max(1000, "Texto muito longo").default(ENCERRAMENTO_INICIAL)`. `TipoCampo` ganha `"texto"` e `GrupoCampo` ganha `"operacao"`. O card "Operação" em Parâmetros usa textarea.
7. **Nome de arquivo** (D19): `nomeArquivo("RT" | "TAREFAS", titular, destino, inicio, fim)`. Exemplo: `RT_SOUZA_ITALIA_20270814-20270901`.
8. **Customer care** (D8): coluna booleana. "Minhas tarefas" = `responsavel_id = eu`.
9. **Rotas:** `/tarefas`, `/roteiros` e `/dailies` entram em `ROTAS_POR_PERFIL` dos cinco perfis. As páginas por viagem ficam em `/viagens/[id]/{tarefas,roteiro,dailies}` (+ `/imprimir` em tarefas e roteiro).

---

## Estrutura de arquivos

```
src/domain/tarefas.ts                    categorias, Prazo, prazoEfetivo, rotuloPrazo, situacaoTarefa, automáticas, tarefaSchema
src/domain/roteiro.ts                    idiomas/saudações/fusos, datasDaViagem, conteudoRoteiroSchema, roteiroInicial, nomeArquivo, aniversariosNaViagem, rotuloDiaRoteiro
src/domain/daily.ts                      formatarHora, nomesDaSaudacao, trocaDeHotel, textoDoDaily, conferirDaily, estadoDoDaily, converterHorario
src/domain/regras.ts                     + encerramentoDaily, TipoCampo "texto", GrupoCampo "operacao"
src/domain/perfis.ts                     + /tarefas, /roteiros, /dailies nos cinco perfis
src/server/db/schema/operacao.ts         tarefas, roteiros, dailies + enums
drizzle/<n>_*.sql (gerada), drizzle/<n+1>_operacao_rls.sql (custom: RLS, índices parciais, CHECKs)
src/server/operacao/tarefas-automaticas.ts   criarTarefasAutomaticas(tx, …) (server-only, sem "use server")
src/server/actions/tarefas.ts, roteiros.ts, dailies.ts
src/server/actions/vendas.ts             fecharVenda chama criarTarefasAutomaticas
src/server/queries/operacao.ts           cabeçalho da viagem, tarefas, roteiro, dailies, listas entre viagens
src/app/(app)/viagens/[id]/trilha.tsx    abas Viagem · Roteiro · Tarefas · Dailies + cabeçalho
src/app/(app)/viagens/[id]/tarefas/{page.tsx,tarefas.tsx,imprimir/page.tsx}
src/app/(app)/viagens/[id]/roteiro/{page.tsx,editor.tsx,previa.tsx,imprimir/page.tsx}
src/app/(app)/viagens/[id]/dailies/{page.tsx,dailies.tsx}
src/app/(app)/{tarefas,roteiros,dailies}/page.tsx
src/app/(app)/admin/parametros/formulario.tsx   card "Operação"
src/components/shell.tsx                 itens Tarefas, Roteiros, Dailies na área Operação
scripts/seed-operacao.ts                 seed local
tests/domain/tarefas.test.ts, roteiro.test.ts, daily.test.ts (+ regras.test.ts, perfis.test.ts, proxy-caminhos.test.ts)
tests/integracao/operacao-schema.test.ts, tarefas.test.ts, roteiros.test.ts, dailies.test.ts (+ rls.test.ts, vendas.test.ts)
```

---

### Task 1: Domínio das tarefas e rotas

**Files:** Create `src/domain/tarefas.ts`; Modify `src/domain/perfis.ts`; Test `tests/domain/tarefas.test.ts`, `tests/domain/perfis.test.ts`

**Interfaces (Produces):**
- `CATEGORIAS_TAREFA = ["ingressos","transfers_passeios","restaurantes","hoteis_carro_voos","conferir","envio"] as const`; `type CategoriaTarefa`. `ROTULO_CATEGORIA: Record<CategoriaTarefa, string>` com os 6 textos exatos do spec §5.3.
- `type Prazo = { tipo: "data"; data: string } | { tipo: "dias_antes"; dias: number }`.
- `prazoEfetivo(prazo: Prazo | null, inicio: string): string | null`.
- `rotuloPrazo(prazo: Prazo | null, inicio: string): string`.
- `SITUACOES_TAREFA = ["concluida","vencida","vence_hoje","no_prazo","sem_prazo"] as const`; `situacaoTarefa(t: { prazoEfetivo: string | null; concluida: boolean }, hoje: string): SituacaoTarefa`; `ROTULO_SITUACAO_TAREFA`.
- `type TarefaAutomatica = { chave: string; categoria: CategoriaTarefa; item: string; fazer: string; prazo: Prazo | null }`.
- `tarefasDaVenda(diaDaVenda: string, inicio: string): TarefaAutomatica[]` (5, ordem do spec; `venda + N` limitado a `inicio`).
- `tarefasDoRoteiro(): TarefaAutomatica[]` (3).
- `ordenarTarefas<T extends { categoria; dia: string | null; ordem: number }>(ts: T[]): T[]`: categoria, depois "Geral" (dia null) primeiro, depois dia, depois ordem.
- `type TarefaEntrada = z.input<typeof tarefaSchema>`.
- `tarefaSchema` (Zod, mensagens pt-BR): `{ categoria; dia: data | null; item 1–200 ("Informe o item"); fazer ≤2000; prazo: Prazo | null (dias inteiros 0–365: "Informe de 0 a 365 dias"); responsavel: { tipo: "usuario"; id: uuid } | { tipo: "customer_care" } | null; observacao ≤2000 | null }`.
- `perfis.ts`: `"/tarefas"`, `"/roteiros"`, `"/dailies"` em `ROTAS_POR_PERFIL` dos cinco perfis.

- [ ] **Step 1: Testes que falham** (`tests/domain/tarefas.test.ts`):
  - `prazoEfetivo({ tipo: "dias_antes", dias: 15 }, "2027-08-14") === "2027-07-30"`; `({ tipo: "dias_antes", dias: 60 }, "2027-08-14") === "2027-06-15"`; `({ tipo: "dias_antes", dias: 0 }, "2027-08-14") === "2027-08-14"`; `({ tipo: "data", data: "2027-04-15" }, …) === "2027-04-15"`; `(null, …) === null`.
  - `rotuloPrazo({ tipo: "data", data: "2027-04-15" }, "2027-08-14") === "Até 15/04/2027"`; `({ tipo: "dias_antes", dias: 15 }, "2027-08-14") === "15 dias antes (30/07/2027)"`; `({ tipo: "dias_antes", dias: 1 }, …) === "1 dia antes (13/08/2027)"`; `(null, …) === "Sem prazo"`.
  - `situacaoTarefa({ prazoEfetivo: "2026-11-22", concluida: false }, "2026-11-23") === "vencida"`; mesmo dia → `"vence_hoje"`; depois → `"no_prazo"`; null → `"sem_prazo"`; concluída e vencida → `"concluida"`.
  - `tarefasDaVenda("2026-11-23", "2027-08-14")`:
    - chaves `["venda.whatsapp","venda.fatura","venda.comparativo","venda.reservas","venda.drive"]`;
    - itens com os textos exatos de `tasksProposta`;
    - prazos `2026-11-24`, `2026-11-25`, `2026-11-30`, `2026-11-30`, `2026-11-24`.
  - `tarefasDaVenda("2027-08-10", "2027-08-14")`: prazo de `venda.reservas` = `{ tipo: "data", data: "2027-08-14" }` (limitado ao início).
  - `tarefasDoRoteiro()`: chaves `["roteiro.passeios","roteiro.ingressos","roteiro.trem"]`; categorias `transfers_passeios`, `ingressos`, `ingressos`; prazos 60, 60 e 90 dias antes.
  - `ordenarTarefas`: `[{categoria:"conferir",dia:null,ordem:1},{categoria:"ingressos",dia:"2027-08-16",ordem:2},{categoria:"ingressos",dia:null,ordem:3}]` → ingressos/null, ingressos/16-08, conferir/null.
  - `tarefaSchema`: item vazio → "Informe o item"; `prazo.dias = 366` → "Informe de 0 a 365 dias"; responsável `{ tipo: "usuario", id: "x" }` → erro no campo `responsavel`.
- [ ] **Step 2: `tests/domain/perfis.test.ts`:** `podeAcessar(p, "/tarefas")`, `"/roteiros"` e `"/dailies/x"` true para os cinco perfis.
- [ ] **Step 3:** `npm test -- tarefas perfis` → FAIL.
- [ ] **Step 4:** Implementar. Reaproveitar `somarDias`/`dataBr` de `src/domain/clientes.ts`, exportando-as se preciso, sem duplicar.
- [ ] **Step 5:** `npm test` → PASS (todos os de domínio).
- [ ] **Step 6:** Commit `feat: domínio das tarefas da operação`.

---

### Task 2: Domínio do roteiro e parâmetro de encerramento

**Files:** Create `src/domain/roteiro.ts`; Modify `src/domain/regras.ts`; Test `tests/domain/roteiro.test.ts`, `tests/domain/regras.test.ts`

**Interfaces (Produces):**
- `IDIOMAS = ["italiano","espanhol","frances","ingles","alemao","portugues"] as const`; `type Idioma`; `ROTULO_IDIOMA` ("Italiano", "Espanhol", "Francês", "Inglês", "Alemão", "Português"); `SAUDACAO: Record<Idioma, string>` ("Buongiorno", "¡Buenos días", "Bonjour", "Good morning", "Guten Morgen", "Bom dia").
- `fusoValido(f: string): boolean` (via `Intl.DateTimeFormat(undefined, { timeZone: f })` em try/catch). `FUSOS_SUGERIDOS: { id: string; rotulo: string }[]` (as 9 do spec + `America/Sao_Paulo`).
- `sugerirIdiomaEFuso(destino: string): { idioma: Idioma; fuso: string } | null` (sem acento, sem caixa, "contém").
- `datasDaViagem(inicio: string, fim: string): string[]`.
- `rotuloDiaRoteiro(data: string): string` → `"14/08 (sábado)"`.
- Tipos `ItemRoteiro`, `DiaRoteiro`, `HotelRoteiro`, `VooRoteiro`, `ConteudoRoteiro` (spec §5.2).
- `conteudoRoteiroSchema(inicio: string, fim: string)`: Zod do conteúdo + refine "Os dias do roteiro não batem com as datas da viagem". `hora` no formato `^([01]\d|2[0-3]):[0-5]\d$` ("Hora inválida"); `mapa` `https://…` ("Link inválido"); hotel com `saida < entrada` → "A saída não pode ser antes da entrada".
- `roteiroInicial(v: { inicio: string; fim: string; itens: { tipo: TipoItem; cidade: string | null; servico: string; checkin: string | null; checkout: string | null }[] }): ConteudoRoteiro`.
- `hoteisEVoosDosItens(itens): { hoteis: HotelRoteiro[]; voos: VooRoteiro[] }` (usado na criação e em "Trazer hotéis e voos da viagem").
- `noitesDoHotel(h: HotelRoteiro): string | null` → `"2 noites · 14/08 a 16/08"`, `"1 noite · …"`, null sem datas.
- `nomeArquivo(prefixo: "RT" | "TAREFAS", titular: string, destino: string, inicio: string, fim: string): string`.
- `type Aniversario = { pessoaId: string; nome: string; data: string; idade: number; diaDaViagem: number; onde: string | null }`.
- `aniversariosNaViagem(pessoas: { id: string; nome: string; nascimento: string | null }[], inicio: string, fim: string, hoteis: HotelRoteiro[]): Aniversario[]`.
- `textoAniversario(a: Aniversario): string`.
- `regras.ts`:
  - `ENCERRAMENTO_INICIAL` (texto exato do spec, com `\n`);
  - `RegrasSchema` ganha `encerramentoDaily` (Ruling 6);
  - `REGRAS_INICIAIS.encerramentoDaily = ENCERRAMENTO_INICIAL`;
  - `TipoCampo` ganha `"texto"`; `GrupoCampo` ganha `"operacao"`;
  - `CAMPOS` ganha `c("encerramentoDaily", "Encerramento do daily", "texto", "operacao", "Dailies", "Última parte de toda mensagem diária ao cliente.")`;
  - `formatarValor("texto", v)` devolve o texto.

- [ ] **Step 1: Testes que falham** (`tests/domain/roteiro.test.ts`):
  - `datasDaViagem("2027-08-14","2027-09-01")` tem 19 datas, primeira `"2027-08-14"`, última `"2027-09-01"`; `("2027-12-30","2028-01-02")` → `["2027-12-30","2027-12-31","2028-01-01","2028-01-02"]`.
  - `rotuloDiaRoteiro("2027-08-14") === "14/08 (sábado)"`; `("2027-08-16") === "16/08 (segunda-feira)"`.
  - `sugerirIdiomaEFuso("Itália")` → `{ idioma: "italiano", fuso: "Europe/Rome" }`; `("Costa Amalfitana, ITALIA")` → idem; `("Japão")` → `null`.
  - `fusoValido("Europe/Rome")` true; `fusoValido("Marte/Base")` false.
  - `roteiroInicial` com itens `[{tipo:"Hotelaria",cidade:"Veneza",servico:"Palazzo Barocci",checkin:"2027-08-14",checkout:"2027-08-16"},{tipo:"Aéreo",cidade:null,servico:"GRU-VCE",checkin:"2027-08-13",checkout:null},{tipo:"Passeio",cidade:"Roma",servico:"Coliseu",checkin:null,checkout:null}]` e 14/08–01/09:
    - 19 dias com `titulo: ""`, `itens: []`, `dica: null`, `porque: null`, `gastro: []`;
    - `hoteis = [{ cidade: "Veneza", nome: "Palazzo Barocci", entrada: "2027-08-14", saida: "2027-08-16", horaCheckin: null, horaCheckout: null, mapa: null }]`;
    - `voos = [{ data: "2027-08-13", voo: "", trecho: "GRU-VCE", saida: null, chegada: null }]`;
    - o passeio não entra.
  - `conteudoRoteiroSchema("2027-08-14","2027-09-01")`:
    - com 18 dias → "Os dias do roteiro não batem com as datas da viagem";
    - item `hora: "25:00"` → "Hora inválida";
    - `mapa: "javascript:alert(1)"` → "Link inválido".
  - `noitesDoHotel` de 14/08 a 16/08 → `"2 noites · 14/08 a 16/08"`.
  - `nomeArquivo("RT","Marcos Souza","Itália","2027-08-14","2027-09-01") === "RT_SOUZA_ITALIA_20270814-20270901"`; `("TAREFAS","Ana Conceição","Costa Amalfitana","2027-05-02","2027-05-10") === "TAREFAS_CONCEICAO_COSTA-AMALFITANA_20270502-20270510"`.
  - `aniversariosNaViagem`:
    - `[{ id:"r", nome:"Rafael Souza", nascimento:"1987-08-23" }]`, 14/08–01/09/2027, hotel `{ cidade:"Sorrento", nome:"Hotel Belair", entrada:"2027-08-22", saida:"2027-08-25" }` → `[{ pessoaId:"r", nome:"Rafael Souza", data:"2027-08-23", idade:40, diaDaViagem:10, onde:"Sorrento (Hotel Belair)" }]`;
    - `textoAniversario` desse → `"Rafael Souza faz 40 anos em 23/08/2027, dia 10 da viagem, em Sorrento (Hotel Belair)."`;
    - ano virando: nascimento `"1990-01-02"`, viagem 28/12/2027–05/01/2028 → data `"2028-01-02"`, idade 38;
    - 29/02: nascimento `"2000-02-29"`, viagem 25/02–02/03/2027 → data `"2027-02-28"`, idade 27;
    - sem nascimento ou fora do período → `[]`.
- [ ] **Step 2: `tests/domain/regras.test.ts`:**
  - `REGRAS_INICIAIS.encerramentoDaily === "Qualquer dúvida, nosso customer care está à disposição no WhatsApp. Aproveitem o dia!\nEquipe ECLAK Viagens"`;
  - `normalizarRegras` de uma versão sem o campo → igual a `REGRAS_INICIAIS`;
  - `encerramentoDaily: "  "` → recusado;
  - `diferencasRegras` com o texto alterado → `[{ campo: "Encerramento do daily", antes: <inicial>, depois: <novo> }]`;
  - o teste existente "todo campo de CAMPOS tem valor em REGRAS_INICIAIS" continua verde.
- [ ] **Step 3:** `npm test -- roteiro regras` → FAIL.
- [ ] **Step 4:** Implementar. Para o 29/02, reaproveitar a regra de `proximoAniversario` (`src/domain/clientes.ts`), extraindo a ocorrência por ano para uma função exportada.
- [ ] **Step 5:** `npm test` → PASS; `npm run typecheck` (o formulário de Parâmetros compila: o tipo `"texto"` cai no `default` de `lerCampo`).
- [ ] **Step 6:** Commit `feat: domínio do roteiro e parâmetro de encerramento do daily`.

---

### Task 3: Domínio do daily

**Files:** Create `src/domain/daily.ts`; Test `tests/domain/daily.test.ts`

**Interfaces:**
- Consumes: Task 2 (`Idioma`, `SAUDACAO`, `DiaRoteiro`, `HotelRoteiro`).
- Produces:
  - `formatarHora(hhmm: string): string`.
  - `nomesDaSaudacao(nomes: string[], grupo: string): string`.
  - `diaDaSemana(data: string): string` (minúsculas: "segunda-feira").
  - `trocaDeHotel(hoteis: HotelRoteiro[], data: string): { sai: HotelRoteiro | null; entra: HotelRoteiro | null; troca: boolean }`.
  - `linkMapaHotel(h: HotelRoteiro): string`: `h.mapa` ou `https://maps.google.com/?q=` + `encodeURIComponent(`${nome} ${cidade}`)` (espaço vira `%20`; spec D14).
  - `textoDoDaily(e: { data: string; idioma: Idioma; nomes: string; dia: DiaRoteiro; hoteis: HotelRoteiro[]; encerramento: string }): string` (modelo do spec §5.5; parágrafos separados por linha em branco).
  - `type Indicador = { nome: string; ok: boolean; dica: string }`; `conferirDaily(texto: string, o: { troca: boolean; idioma: Idioma; encerramento: string }): Indicador[]` (6, na ordem, nomes e dicas exatos).
  - `dataDeGeracao(data: string): string` (D-2); `dataDeEnvio(data: string): string` (D-1).
  - `ESTADOS_DAILY = ["pendente","gerado","revisado","enviado"] as const`; `estadoDoDaily(data: string, estado: EstadoDaily | null, hoje: string): { rotulo: string; tom: "cinza" | "ouro" | "agua" | "verde"; noPrazoDeGerar: boolean }`. `noPrazoDeGerar` só escolhe o botão ("Gerar texto" × "Gerar agora"); nada recusa pela data (spec D26).
  - `converterHorario(data: string, hora: string, de: string, para: string): string` ("HH:MM").

- [ ] **Step 1: Testes que falham** (`tests/domain/daily.test.ts`):
  - `formatarHora("13:26") === "13h26"`, `("16:00") === "16h"`, `("06:20") === "06h20"`.
  - `nomesDaSaudacao(["Marina Souza","Rafael Souza"], "Família Souza") === "Marina e Rafael"`; três → `"Ana, Bia e Caio"`; quatro → `"Família Souza"`; um → `"Marina"`.
  - `diaDaSemana("2027-08-16") === "segunda-feira"`.
  - **Modelo (Review Focus 4).** `textoDoDaily` com:
    - data `"2027-08-16"`, idioma `"italiano"`, nomes `"Marina e Rafael"`;
    - hotéis `[{ cidade:"Veneza", nome:"Palazzo Barocci", entrada:"2027-08-14", saida:"2027-08-16", horaCheckin:null, horaCheckout:"11:00", mapa:null }, { cidade:"Florença", nome:"Orto de' Medici", entrada:"2027-08-16", saida:"2027-08-19", horaCheckin:"16:00", horaCheckout:null, mapa:"https://maps.google.com/?q=Orto+de+Medici+Firenze" }]`;
    - itens `[{ hora:"13:26", titulo:"Partida do trem de alta velocidade para Florença, da estação Venezia Santa Lucia", texto:"Recomendamos chegar com 30 minutos de antecedência.", mapa:null }, { hora:"16:00", titulo:"Check-in no Orto de' Medici", texto:"", mapa:null }]`;
    - encerramento inicial.

    Resultado exato:
    `"Buongiorno, Marina e Rafael!\n\nProgramação de amanhã, segunda-feira, 16/08.\n\nCheck-out: Palazzo Barocci, até as 11h\nCheck-in: Orto de' Medici, a partir das 16h\nhttps://maps.google.com/?q=Orto+de+Medici+Firenze\n\n*13h26*: Partida do trem de alta velocidade para Florença, da estação Venezia Santa Lucia. Recomendamos chegar com 30 minutos de antecedência.\n\n*16h*: Check-in no Orto de' Medici.\n\nQualquer dúvida, nosso customer care está à disposição no WhatsApp. Aproveitem o dia!\nEquipe ECLAK Viagens"`.
    `conferirDaily(esse, { troca: true, idioma: "italiano", encerramento: inicial })` → os 6 com `ok: true`, nomes na ordem do spec.
  - Sem mapa no hotel novo: `linkMapaHotel({ nome:"Hotel Belair", cidade:"Sorrento", … }) === "https://maps.google.com/?q=Hotel%20Belair%20Sorrento"`; texto com check-in em `"Hotel 1898"`/`"Barcelona"` sem mapa → indicador 5 `ok: true`.
  - Item `{ hora: "11:20", titulo: "Chegada a Veneza", texto: "Barco privativo do aeroporto ao hotel | Cerca de 35 minutos", mapa: null }` → linha `"*11h20*: Chegada a Veneza. Barco privativo do aeroporto ao hotel. Cerca de 35 minutos."`.
  - **Exemplos que falham, um por indicador:**
    1. `"Bom dia, Marina!"` com idioma italiano → [0].ok false e dica `Comece com a saudação do país, como "Buongiorno" na Itália.`. Com idioma português → [0].ok true.
    2. `"… Vamos estar enviando o voucher …"` → [1].ok false, dica `Troque "Vamos estar enviando" pelo verbo direto, como "enviaremos" ou "aguardamos".`.
    3. Troca com `Check-in:` antes de `Check-out:` → [2].ok false, nome `"Troca de hotel: check-out e check-in no topo, com o mapa"`. Link `https://maps.app.goo.gl/abc` → ok true (D25). Sem troca → nome `"Sem troca de hotel neste dia"`, ok true.
    4. Linha `"13h26 partida"` → [3].ok false. Texto sem nenhuma linha de programação → [3].ok false.
    5. `"Motorista: João"` → [4].ok false. `"(39) 3333-0000"` → [4].ok false.
    6. Texto que termina em `"Equipe ECLAK"` → [5].ok false, dica `Termine com o texto padrão, definido em Parâmetros.`.
  - `trocaDeHotel(hoteis acima, "2027-08-16").troca === true`; `("2027-08-15").troca === false`.
  - `dataDeGeracao("2027-08-16") === "2027-08-14"`; `dataDeEnvio("2027-08-16") === "2027-08-15"`.
  - `estadoDoDaily("2027-08-16", null, "2027-08-13")` → `{ rotulo: "Gera em 14/08", tom: "cinza", noPrazoDeGerar: false }`; `(…, null, "2027-08-14")` → `{ rotulo: "A gerar", tom: "ouro", noPrazoDeGerar: true }`; `"gerado"` → "Gerado, a revisar"/ouro; `"revisado"` → "Pronto para enviar"/agua; `"enviado"` → "Enviado"/verde; `"pendente"` segue a regra de sem texto.
  - **Fuso (Review Focus 3):**
    - `converterHorario("2027-08-16","13:26","Europe/Rome","America/Cuiaba") === "07:26"`;
    - `(…,"America/Sao_Paulo") === "08:26"`;
    - `("2027-01-20","13:26","Europe/Rome","America/Cuiaba") === "08:26"`;
    - `(…,"America/Sao_Paulo") === "09:26"`;
    - virada de dia: `("2027-08-16","02:00","Europe/Rome","America/Cuiaba") === "20:00"`.
- [ ] **Step 2:** `npm test -- daily` → FAIL.
- [ ] **Step 3:** Implementar. Copiar as regex do protótipo literalmente (spec §5.5), exceto o link do indicador 3 (D25) e a saudação do indicador 1 (D11). `converterHorario` sem biblioteca: achar o instante UTC cujo horário local em `de` é `data hora`, com duas iterações de `Intl.DateTimeFormat(…, { timeZone, hourCycle: "h23" }).formatToParts`, e formatar em `para`.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat: domínio do daily (modelo, padrão ECLAK e fusos)`.

---

### Task 4: Esquema, migrações, RLS, menu e trilha

**Files:** Create `src/server/db/schema/operacao.ts`, `drizzle/<n>_*.sql` (gerada), `drizzle/<n+1>_operacao_rls.sql` (custom), `src/app/(app)/viagens/[id]/trilha.tsx`, `src/server/queries/operacao.ts` (só `cabecalhoDaViagem`); Modify `src/server/db/schema/index.ts`, `src/components/shell.tsx`, `tests/integracao/rls.test.ts`, `tests/domain/proxy-caminhos.test.ts`, `src/app/(app)/viagens/[id]/page.tsx` (monta a `Trilha` acima de `ViagemVendidaView` quando vendida; **não** editar `viagem-vendida.tsx`, que a 4b altera); Test `tests/integracao/operacao-schema.test.ts`

**Interfaces (Produces):**
- Enums `categoria_tarefa`, `prazo_tarefa` (`data`, `dias_antes`), `origem_tarefa` (`manual`, `venda`, `roteiro`), `status_roteiro` (`rascunho`, `aguardando_cliente`, `aprovado`), `idioma_destino` (IANA à parte), `estado_daily`, a partir das constantes do domínio.
- `tarefas`, `roteiros` e `dailies` com as colunas do spec §5.2.
  - `roteiros.conteudo` é `jsonb().$type<ConteudoRoteiro>()`; `roteiros.viagem_id` é único.
  - `dailies` tem único `(roteiro_id, data)`.
- Migração custom:
  - RLS nas três;
  - `CREATE UNIQUE INDEX tarefas_viagem_chave_unica ON tarefas (viagem_id, chave) WHERE chave IS NOT NULL`;
  - índice `tarefas_abertas_responsavel_idx` (spec);
  - índice `tarefas_viagem_idx (viagem_id) WHERE excluido_em IS NULL`;
  - CHECKs:
    - prazo coerente (`prazo_tipo IS NULL AND prazo_data IS NULL AND prazo_dias IS NULL` | `data` com só `prazo_data` | `dias_antes` com só `prazo_dias` entre 0 e 365);
    - `NOT (responsavel_id IS NOT NULL AND customer_care)`;
    - `(concluida_em IS NULL) = (concluida_por IS NULL)`;
    - `dailies`: `estado = 'pendente' OR texto IS NOT NULL`.
- `cabecalhoDaViagem(viagemId): Promise<CabecalhoViagem | null>` (`exigirPerfil()`):
  - `{ id; codigo; cliente; grupo; titular; destino; inicio; fim; noites; passageiros: { id; nome; nascimento: string | null }[]; consultor: { id; nome }; vendida: boolean }`;
  - só colunas de `viagens`, `clientes`, `pessoas`, `viagem_passageiros`, `usuarios`.
- `Trilha({ viagem: CabecalhoViagem; ativa: "viagem" | "roteiro" | "tarefas" | "dailies" })`: cabeçalho (código, cliente, destino, "dd/mm/aaaa a dd/mm/aaaa", "N noites", passageiros, consultor) e abas como links.
- Shell, área Operação: Viagens, Tarefas (`/tarefas`), Roteiros (`/roteiros`), Dailies (`/dailies`), Fornecedores.

- [ ] **Step 1: Teste que falha** (`tests/integracao/operacao-schema.test.ts`, com `vendida()` de `tests/helpers/venda.ts`):
  - inserir duas tarefas com a mesma `(viagem_id, chave)` falha; com `chave` nula, passa;
  - tarefa com `prazo_tipo = 'data'` e `prazo_data` nulo falha;
  - `responsavel_id` com `customer_care = true` falha;
  - segundo roteiro da mesma viagem falha;
  - daily `gerado` sem texto falha;
  - `cabecalhoDaViagem` como consultor devolve código `ECL-…-01`, 2 passageiros, `noites = 18`, `vendida = true`;
  - `JSON.stringify` do resultado não contém `"valor"`, `"margem"`, `"custo"` nem `"comissao"`.
- [ ] **Step 2: `rls.test.ts`:** acrescentar `tarefas`, `roteiros`, `dailies` (anon não lê).
- [ ] **Step 3:** `npm run test:integracao -- operacao-schema rls` → FAIL.
- [ ] **Step 4:** Schema Drizzle; `npm run db:generate`; `npx drizzle-kit generate --custom --name operacao_rls` (RLS, índices parciais, CHECKs). Validar do zero e sobre banco populado (`npm run seed:local` antes de migrar).
- [ ] **Step 5:** Shell e trilha. Testes em `tests/domain/proxy-caminhos.test.ts`: consultor e operacional passam em `/tarefas`, `/roteiros`, `/dailies` e `/viagens/x/roteiro/imprimir`.
- [ ] **Step 6:** `npm run lint && npm run typecheck && npm test && npm run test:integracao -- operacao-schema rls` → PASS.
- [ ] **Step 7:** Commit `feat: esquema da operação (tarefas, roteiros, dailies), RLS e menu`.

---

### Task 5: Tarefas (automáticas na venda, tela por viagem, lista e impressão)

**Files:** Create `src/server/operacao/tarefas-automaticas.ts`, `src/server/actions/tarefas.ts`, `src/app/(app)/viagens/[id]/tarefas/{page.tsx,tarefas.tsx,imprimir/page.tsx}`, `src/app/(app)/tarefas/page.tsx`; Modify `src/server/actions/vendas.ts`, `src/server/queries/operacao.ts`; Test `tests/integracao/tarefas.test.ts`, `tests/integracao/vendas.test.ts`

**Interfaces:**
- Consumes: Task 1 (domínio), Task 4 (tabelas, `cabecalhoDaViagem`, `Trilha`).
- Produces:
  - `criarTarefasAutomaticas(tx: Transacao, usuarioId: string, viagem: { id: string; consultorId: string }, lista: TarefaAutomatica[], origem: "venda" | "roteiro"): Promise<number>`:
    - `import "server-only"`, sem `"use server"`;
    - `ordem` a partir do `max(ordem) + 1` da viagem;
    - `onConflictDoNothing` na chave;
    - audita cada inserida e devolve quantas inseriu.
  - `fecharVenda`: depois de `mudarViagem(... "vendida" ...)`, na mesma transação, `criarTarefasAutomaticas(tx, usuario.id, v, tarefasDaVenda(hojeEmCuiaba(), v.inicio), "venda")`.
  - Actions (`comPerfil([], …)`, retorno `{ ok: true; id? } | Falha`; `Falha` com `campos?` e `conflito?`):
    - `criarTarefa(viagemId, dados: TarefaEntrada)`: viagem vendida; responsável usuário ativo, senão "Escolha um responsável ativo";
    - `editarTarefa(id, dados, atualizadoEmEsperado)`;
    - `concluirTarefa(id)`: "Tarefa já concluída por <nome> em dd/mm/aaaa";
    - `desfazerConclusao(id)`;
    - `excluirTarefa(id)`;
    - `criarTarefasDaVenda(viagemId)`: `{ ok: true; criadas: number }`, idempotente, usa `viagens.vendida_em` em Cuiabá como "dia da venda".
  - Queries (`exigirPerfil()`):
    - `tarefasDaViagem(viagemId): Promise<{ cabecalho: CabecalhoViagem; tarefas: TarefaLinha[]; temDaVenda: boolean; usuarios: { id; nome }[] }>`;
    - `TarefaLinha = { id; categoria; dia; item; fazer; prazo: Prazo | null; prazoEfetivo; rotuloPrazo; situacao; responsavel: { tipo: "usuario"; id; nome } | { tipo: "customer_care" } | null; observacao; origem; concluidaEm; concluidaPor: string | null; atualizadoEm: string }`, ordenadas com `ordenarTarefas`;
    - `listarTarefas(filtro: { visao: "minhas" | "todas"; responsavel?: string | "customer_care" | "ninguem"; situacao: "abertas" | "vencidas" | "concluidas"; viagem?: string }): Promise<(TarefaLinha & { viagem: { id; codigo; destino; inicio } })[]>`:
      - só viagens vendidas;
      - prazo efetivo calculado no SQL (`CASE prazo_tipo … inicio - prazo_dias`) para filtrar "vencidas" com `hoje = hojeEmCuiaba()`;
      - ordenadas por prazo efetivo (nulos por último) e código da viagem.
  - Telas:
    - `/viagens/[id]/tarefas` (spec §5.3: barra de progresso, abas, cards por categoria, formulário de nova tarefa e edição, conclusão por caixa, botão "Criar as tarefas da venda" quando `!temDaVenda`);
    - `/viagens/[id]/tarefas/imprimir` (`<title>` = `nomeArquivo("TAREFAS", …)`);
    - `/tarefas` (Minhas / Todas, filtros na URL).

- [ ] **Step 1: Testes que falham** (`tests/integracao/tarefas.test.ts`, com `vendida()`):
  - **Review Focus 1:**
    - depois de `vendida()` existem exatamente 5 tarefas `origem = 'venda'`, responsável = consultor, prazo de `venda.whatsapp` = `hojeEmCuiaba() + 1`;
    - `criarTarefasDaVenda` → `{ ok: true, criadas: 0 }`;
    - excluir `venda.drive` e chamar de novo → continua excluída, `criadas: 0`;
    - viagem vendida sem tarefas (apagar as 5 direto no banco no teste) → `criadas: 5`.
  - `vendas.test.ts` (teste do fechamento existente): `contagem("tarefas")` = 5.
  - Consultor cria tarefa manual `{ categoria: "ingressos", dia: "2027-08-16", item: "Trem Veneza > Florença", prazo: { tipo: "dias_antes", dias: 15 }, responsavel: { tipo: "customer_care" } }` → ok; `tarefasDaViagem` traz `rotuloPrazo = "15 dias antes (30/07/2027)"` e `responsavel = { tipo: "customer_care" }`.
  - Operacional conclui → `concluidaPor` = nome do operacional; concluir de novo → erro que começa com "Tarefa já concluída por"; `desfazerConclusao` limpa os dois campos.
  - `editarTarefa` com `atualizadoEmEsperado` velho → `{ ok: false, conflito: true, erro: "Esta tarefa foi alterada por outra pessoa. Recarregue a página." }`.
  - `criarTarefa` em viagem não vendida → "A viagem ainda não foi vendida".
  - `listarTarefas({ visao: "minhas", situacao: "abertas" })` como consultor → só as dele; com tarefa de prazo `data` ontem → aparece em `situacao: "vencidas"`.
  - fin_estrategico lê e cria (todos os perfis).
  - Auditoria: criar, concluir, excluir gravam `tabela = "tarefas"` com antes e depois.
- [ ] **Step 2:** `npm run test:integracao -- tarefas vendas` → FAIL.
- [ ] **Step 3:** Implementar o núcleo, as actions, as queries e a chamada em `fecharVenda`.
- [ ] **Step 4:** Telas e impressão; `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 5:** `npm run test:integracao` (suíte inteira) → PASS.
- [ ] **Step 6:** Navegador (Playwright) como `operacional@eclak.local`: viagem vendida do seed → aba Tarefas, criar, concluir, desfazer, imprimir; `/tarefas` com filtros. Rodar `npm run seed:local`.
- [ ] **Step 7:** Commit `feat: tarefas da viagem, automáticas na venda e lista entre viagens`.

---

### Task 6: Roteiro (editor, aprovação com tarefas, aniversário, impressão)

**Files:** Create `src/server/actions/roteiros.ts`, `src/app/(app)/viagens/[id]/roteiro/{page.tsx,editor.tsx,previa.tsx,imprimir/page.tsx}`, `src/app/(app)/roteiros/page.tsx`; Modify `src/server/queries/operacao.ts`; Test `tests/integracao/roteiros.test.ts`

**Interfaces:**
- Consumes: Task 2 (domínio do roteiro), Task 4, Task 5 (`criarTarefasAutomaticas`).
- Produces:
  - Actions (`comPerfil([], …)`):
    - `criarRoteiro(viagemId, dados: { idioma: Idioma; fuso: string }): { ok: true; id } | Falha`:
      - viagem vendida;
      - itens não excluídos da viagem (só as colunas `tipo, cidade, servico, checkin, checkout`) → `roteiroInicial`;
      - violação do único → "Esta viagem já tem roteiro";
      - fuso inválido → erro no campo `fuso`, "Fuso inválido".
    - `salvarRoteiro(roteiroId, dados: { idioma; fuso; abertura: string; conteudo: ConteudoRoteiro }, atualizadoEmEsperado): { ok: true; atualizadoEm: string } | Falha`: `conteudoRoteiroSchema(inicio, fim)`, concorrência otimista, auditoria com antes e depois.
    - `trazerHoteisEVoos(roteiroId, atualizadoEmEsperado)`: substitui `hoteis` e `voos` por `hoteisEVoosDosItens`.
    - Só `salvarRoteiro` e `trazerHoteisEVoos` mudam `roteiros.atualizado_em`; as ações de status gravam só as próprias colunas (D32).
    - `marcarEnviadoAoCliente(roteiroId)`: só de `rascunho`.
    - `aprovarRoteiro(roteiroId): { ok: true; tarefasCriadas: number } | Falha`: `for update` no roteiro; já aprovado → "Roteiro já aprovado pelo cliente"; grava `aprovado_em/por`; `criarTarefasAutomaticas(tx, …, tarefasDoRoteiro(), "roteiro")` na mesma transação.
    - `desfazerAprovacao(roteiroId)`: → `aguardando_cliente`; não aprovado → "O roteiro não está aprovado".
  - Queries (`exigirPerfil()`):
    - `roteiroDaViagem(viagemId): Promise<{ cabecalho: CabecalhoViagem; roteiro: RoteiroTela | null; aniversarios: Aniversario[]; sugestao: { idioma; fuso } | null }>`;
    - `RoteiroTela = { id; status; idioma; fuso; abertura; conteudo; enviadoClienteEm; aprovadoEm; aprovadoPor: string | null; alteradoDepoisDaAprovacao: boolean; atualizadoEm: string }`;
    - `listarRoteiros(): Promise<{ viagemId; codigo; cliente; destino; inicio; fim; situacao: "sem_roteiro" | StatusRoteiro }[]>`: vendidas com `fim >= hoje`, por início.
  - Telas:
    - `/viagens/[id]/roteiro`: sem roteiro → formulário idioma/fuso com sugestão; com roteiro → editor do spec §5.4 (estado local do documento, "Salvar", conflito com aviso e "Recarregar"), faixa de aniversário com "Incluir no dia dd/mm", selos de status, botões de status, prévia;
    - `/viagens/[id]/roteiro/imprimir`: `generateMetadata` → `title = nomeArquivo("RT", titular, destino, inicio, fim)`; rodapé e nota dos voos com o texto exato;
    - `/roteiros`.

- [ ] **Step 1: Testes que falham** (`tests/integracao/roteiros.test.ts`, com `vendida()`; o hotel do fixture não tem `checkin`, então o teste atualiza `itens_viagem.checkin/checkout` do hotel para 14/08–16/08 antes de criar):
  - `criarRoteiro` como operacional → 19 dias; `hoteis[0] = { cidade: "Roma", nome: "Palazzo Barocci", entrada: "2027-08-14", saida: "2027-08-16", … }`; `voos[0].trecho = "GRU-FCO"` e `voos[0].voo = ""`. Criar de novo → "Esta viagem já tem roteiro".
  - **Review Focus 2:** dois `salvarRoteiro` em `Promise.all` com o mesmo `atualizadoEmEsperado` (conteúdos com títulos "A" e "B" no dia 1) → exatamente um ok e um `{ ok: false, conflito: true, erro: "Este roteiro foi alterado por outra pessoa. Recarregue a página." }`. O banco tem o conteúdo inteiro do vencedor.
  - `salvarRoteiro` com 18 dias → "Os dias do roteiro não batem com as datas da viagem".
  - **Review Focus 1:**
    - `aprovarRoteiro` → `tarefasCriadas: 3`, status `aprovado`;
    - `desfazerAprovacao` → `aguardando_cliente`, as 3 tarefas continuam;
    - `aprovarRoteiro` de novo → `tarefasCriadas: 0`;
    - em outra viagem, `Promise.all` de duas aprovações → um ok com `tarefasCriadas: 3` e outro "Roteiro já aprovado pelo cliente"; 3 tarefas `origem = 'roteiro'` no total.
  - Logo depois de aprovar → `alteradoDepoisDaAprovacao: false` e `atualizadoEm` igual ao de antes da aprovação. Salvar depois da aprovação → `alteradoDepoisDaAprovacao: true`, status continua `aprovado`.
  - Aniversário: atualizar `pessoas.nascimento` da Júlia Souza para `"1987-08-23"` → `roteiroDaViagem(...).aniversarios[0]` = `{ nome: "Júlia Souza", data: "2027-08-23", idade: 40, diaDaViagem: 10 }`.
  - Sem estratégico (Review Focus 5): `JSON.stringify(await roteiroDaViagem(id))` como consultor não contém `valorBrl`, `valorOriginal`, `margem`, `custo`, `comissao`.
  - `criarRoteiro` em viagem não vendida → "A viagem ainda não foi vendida".
  - `trazerHoteisEVoos` repõe os hotéis apagados no editor.
  - Auditoria de criar, salvar e aprovar com `tabela = "roteiros"`.
- [ ] **Step 2:** `npm run test:integracao -- roteiros` → FAIL.
- [ ] **Step 3:** Implementar actions e queries.
- [ ] **Step 4:** Editor, prévia, impressão e `/roteiros`; `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 5:** Navegador como `consultor@eclak.local`: criar roteiro, preencher dois dias (item com hora, DICA, POR QUE ESCOLHEMOS, gastronomia), salvar, aprovar (conferir as 3 tarefas na aba Tarefas), imprimir (conferir o nome sugerido do PDF), editar em duas abas para ver o conflito. Rodar `npm run seed:local`.
- [ ] **Step 6:** Commit `feat: roteiro da viagem com aprovação, aniversário e impressão`.

---

### Task 7: Dailies e parâmetro de encerramento na tela

**Files:** Create `src/server/actions/dailies.ts`, `src/app/(app)/viagens/[id]/dailies/{page.tsx,dailies.tsx}`, `src/app/(app)/dailies/page.tsx`; Modify `src/server/queries/operacao.ts`, `src/app/(app)/admin/parametros/formulario.tsx`; Test `tests/integracao/dailies.test.ts`, `tests/integracao/regras.test.ts`

**Interfaces:**
- Consumes: Task 3 (domínio do daily), Task 2 (`encerramentoDaily`), Task 6 (roteiro).
- Produces:
  - Actions (`comPerfil([], …)`; todas recusam data fora do roteiro com "Dia fora do roteiro" e roteiro inexistente com "Crie o roteiro antes dos dailies"):
    - `gerarDaily(roteiroId, data, atualizadoEmEsperado?: string)`:
      - nunca recusa pela data (D26);
      - lê roteiro, passageiros (ordem do cadastro) e `regrasVigentes().valores.encerramentoDaily`;
      - monta com `textoDoDaily`;
      - upsert em `(roteiro_id, data)` com `estado = gerado`, `gerado_em/por`;
      - daily `enviado` → "Daily já enviado: desfaça o envio para editar";
      - linha existente exige `atualizadoEmEsperado`.
    - `salvarTextoDaily(dailyId, texto (1–8000), atualizadoEmEsperado)`: mantém o estado; `enviado` → recusa com a mesma mensagem.
    - `marcarRevisado(dailyId)`: `pendente` → "Gere o texto antes de marcar como revisado".
    - `marcarEnviado(dailyId)`: de `gerado`/`revisado`; grava `enviado_em/por`.
    - `desfazerEnvio(dailyId)`: → `revisado`.
    - `salvarInterno(roteiroId, data, dados: { plantaoId: uuid | null; interno: string ≤4000 }, atualizadoEmEsperado?)`: cria em `pendente` se não existe; plantão = usuário ativo.
  - Queries (`exigirPerfil()`):
    - `dailiesDaViagem(viagemId): Promise<{ cabecalho; roteiro: { id; idioma; fuso; atualizadoEm } | null; encerramento: string; usuarios: { id; nome }[]; dias: DailyTela[] }>`;
    - `DailyTela = { data; rotuloDia; cidade; troca: boolean; dataEnvio; estado: ReturnType<typeof estadoDoDaily>; daily: { id; texto; estado; geradoEm; enviadoEm; enviadoPor; plantao; interno; atualizadoEm } | null; indicadores: Indicador[] | null; roteiroMudou: boolean; horarios: { hora: string; titulo: string; destino: string; mt: string; brasilia: string }[] }`;
    - `listarDailies(): Promise<(DailyTela & { viagem: { id; codigo; cliente } })[]>`: hoje até hoje + 3, ordenado por data e código.
  - Telas:
    - `/viagens/[id]/dailies`: lista de dias à esquerda (data, dia da semana, cidade, selo) e painel com as abas "Para o cliente" / "Interno (plantão)" (spec §5.5). "Enviar no dia anterior: dd/mm". "Gerar texto" / "Gerar agora" / "Gerar de novo". Textarea, indicadores (ok com ícone de check em verde; falha com ícone de alerta em ouro e a dica), "Copiar mensagem", "Marcar como revisado", "Marcar como enviado", "Desfazer envio". Versão interna com a tabela de horários, plantão, localizadores e a nota fixa.
    - `/dailies`.
    - Parâmetros: card "Operação" com textarea para os campos `tipo === "texto"` e as linhas preservadas.

- [ ] **Step 1: Testes que falham** (`tests/integracao/dailies.test.ts`, com `vendida()` + roteiro criado e salvo):
  - Dia 16/08 com os 2 hotéis e 2 itens do teste do domínio.
  - Passageiros "Marcos Souza" e "Júlia Souza"; idioma italiano.
  - `gerarDaily(r, "2027-08-16")` → texto começa com `"Buongiorno, Marcos e Júlia!\n\nProgramação de amanhã, segunda-feira, 16/08."` e termina com o encerramento inicial. `dailiesDaViagem` traz `estado.rotulo = "Gerado, a revisar"` e os 6 indicadores ok.
  - **Review Focus 4:** o Diretor salva Parâmetros com `encerramentoDaily = "Boa viagem!\nEquipe ECLAK Viagens"`. O daily antigo passa a ter o indicador 6 `ok: false`. `gerarDaily` em 17/08 termina com o texto novo e o indicador 6 fica `ok: true`.
  - `marcarRevisado` → "Pronto para enviar"; `marcarEnviado` → "Enviado" com `enviadoPor` = nome. `salvarTextoDaily` → "Daily já enviado: desfaça o envio para editar". `desfazerEnvio` → "Pronto para enviar".
  - Concorrência: `salvarTextoDaily` com `atualizadoEmEsperado` velho → `conflito: true`, "Este daily foi alterado por outra pessoa. Recarregue a página.".
  - Aprovar o roteiro depois da geração → `roteiroMudou: false`. Salvar o conteúdo depois da geração → `roteiroMudou: true` no dia 16/08.
  - `salvarInterno` antes de gerar → linha `pendente`. `marcarRevisado` nela → "Gere o texto antes de marcar como revisado".
  - Horários (fuso `Europe/Rome`): item 13:26 de 16/08 → `{ destino: "13h26", mt: "07h26", brasilia: "08h26" }`.
  - `gerarDaily(r, "2027-09-02")` → "Dia fora do roteiro".
  - Todos os perfis: operacional gera; fin_operacional marca enviado.
  - `tests/integracao/regras.test.ts`: versão de regras gravada antes (sem o campo) continua lida por `regrasVigentes` com o encerramento inicial.
- [ ] **Step 2:** `npm run test:integracao -- dailies regras` → FAIL.
- [ ] **Step 3:** Implementar actions e queries.
- [ ] **Step 4:** Telas e card de Parâmetros; `npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 5:** Navegador como `operacional@eclak.local`: gerar, editar com um gerúndio (indicador em ouro), corrigir, copiar, marcar enviado, versão interna. Como diretor: alterar o encerramento em Parâmetros e conferir o histórico. Rodar `npm run seed:local`.
- [ ] **Step 6:** Commit `feat: dailies com padrão ECLAK, plantão e encerramento em Parâmetros`.

---

### Task 8: Seed local, README, HANDOFF e verificação final

**Files:** Create `scripts/seed-operacao.ts`; Modify `scripts/seed-local.ts`, `README.md` (seção curta "Operação"), `docs/HANDOFF.md`

- [ ] **Step 1:** Seed local (só com `local-guard`):
  - as vendas do seed ganham as 5 tarefas pela mesma função (`criarTarefasAutomaticas`), mais ~10 tarefas manuais do protótipo (`tarefas/page.tsx`: trem Veneza > Florença, Uffizi, Coliseu, barco VCE, restaurantes, "Confirmar AZ 1465" com Customer care, "Nomes, bilhetes e fatura"), algumas concluídas e uma vencida;
  - uma viagem com roteiro aprovado no estilo do protótipo (dias de Veneza e Florença, DICA ECLAK · VAPORETTO, DICA ECLAK · TREM, POR QUE ESCOLHEMOS, gastronomia, 2 hotéis com troca, voos), com dois dailies (um "Pronto para enviar", um "Gerado, a revisar");
  - um passageiro com aniversário dentro da viagem.

  Idempotente: rodar duas vezes não duplica, por `chave`/único do roteiro e por item+viagem nas manuais.
- [ ] **Step 2:** README: rotas da operação, regra D-2/D-1 dos dailies, onde muda o encerramento. HANDOFF:
  - §1, §2 (branch e PR da 5a), §5 (o que a 5a entrega), §6 (decisões D1–D32 resumidas, "conferir");
  - §8 (próximo passo: 5b esperando o retorno do grupo, com as perguntas do spec §6);
  - pendências menores encontradas na execução.

  Se a 4b já estiver em `main`, partir do HANDOFF dela.
- [ ] **Step 3:** `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build` → tudo verde; anotar os números de testes no HANDOFF.
- [ ] **Step 4:** `npm run seed:local`; navegador com os cinco perfis: todos veem Tarefas, Roteiros e Dailies no menu e editam; nenhum valor de custo ou margem nessas telas; impressão do RT e das tarefas com o nome de arquivo certo.
- [ ] **Step 5:** Commit `chore: seed da operação, README e passagem de sessão da fatia 5a`.

---

## Para a 5b e a fatia 6

- **5b** (depois do retorno do grupo e da Valeska; perguntas no spec §6):
  - Reembolsos e Estoque com lançamentos na lista única da 4a (categorias "Reembolso a cliente", "Reembolso de fornecedor", "Caixa de experiência", "Papelaria");
  - Caixa de experiência como custo da viagem na margem real (mexe em `margemReal`: exige decisão explícita);
  - Avisos por setor, com os eventos candidatos da 5a (tarefa vencida, daily "A gerar", aniversário na viagem).
- **Fatia 6:**
  - Trello (as tarefas automáticas já têm `chave` estável para o cartão);
  - Drive (pastas `ECL-NNNN_TITULAR_DESTINO_ini-fim` com o mesmo `nomeArquivo`);
  - vouchers em PDF no daily (Storage da 4b);
  - "Reescrever com IA";
  - plano logístico e mapas;
  - agendador que gere os dailies em D-2 chamando a mesma função de `gerarDaily`.
