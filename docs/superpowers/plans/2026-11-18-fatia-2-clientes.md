# Fatia 2 (Clientes) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cadastro real de clientes (grupo, titular e quem viaja junto, contato, preferências), com ficha, busca, avisos de documento e aniversário, código `ECL-NNNN` e auditoria — sobre a base da fatia 1.

**Architecture:** Mesmo padrão da fatia 1: regras puras em `src/domain/clientes.ts`; tabelas `clientes` + `pessoas` via Drizzle com RLS; Server Actions com `comPerfil` (`src/server/acesso.ts`), Zod e `registrarAuditoria` na mesma transação; páginas em `src/app/(app)/clientes/` no visual do protótipo.

**Tech Stack:** o da fatia 1 (Next.js 16.4, React 19.3, Tailwind v4, Supabase, Drizzle, Zod, Vitest).

**Spec:** `docs/superpowers/specs/2026-11-18-backend-sistema-real-design.md` (seção 6, item 2). Protótipo de referência: repositório `eclak-mockup` — `src/lib/cadastros.ts` (tipos `Cliente`, `Pessoa`, `clientesIniciais`), `src/lib/clientes.ts` (`alertasDoCliente`, `idade`, `nomesTipoCliente`), `src/app/clientes/page.tsx`, `src/app/clientes/[id]/page.tsx`, `src/app/clientes/novo/page.tsx`, `src/components/cliente-form.tsx`.

## Decisões desta fatia (Mateus, 18/11/2026)

- Código do cliente começa em **ECL-0001** (sequência no banco, 4 dígitos com zero à esquerda, sem buracos por rollback não é exigido — usar `sequence`; buraco por transação abortada é aceitável).
- **Sem upload de documentos** nesta fatia: cópias de passaporte e RG continuam no Drive manualmente até a fatia 6. O cadastro guarda só dados (número e validade do passaporte, CPF).
- Avisos que dependem de viagem (passaporte vencendo menos de 6 meses depois da volta, próxima viagem, total comprado, "Vence nos próximos dias") entram na fatia 3. Nesta fatia: **sem passaporte**, **passaporte vencido** (validade < hoje) e **aniversário nos próximos 30 dias**.

## Global Constraints

- Todas as da fatia 1 (`docs/superpowers/plans/2026-11-18-fatia-1-base.md`, seção Global Constraints), em especial: RLS em toda tabela nova; auditoria na mesma transação; exclusão lógica; textos em português-BR; marca (azul #2E5C71, laranja #F26531 só destaque, texto #333132, sem vermelho, sem gradiente, sem emoji, sem estrelinha de IA).
- **Toda Server Action começa com `comPerfil(...)`**; toda query chama `exigirPerfil(...)`. Actions são alcançáveis por POST de qualquer caminho.
- Acesso: **todos os perfis** veem e editam clientes (matriz do Augusto: Clientes = todos). Excluir: só `diretor`.
- "Hoje" é a data em `America/Cuiaba`.
- CPF guardado só com dígitos (11); exibido `000.000.000-00`. Telefone guardado só com dígitos (10 ou 11); exibido `(66) 9 9999-9999` / `(66) 9999-9999`.

## Review Focus

1. **Dois usuários editando o mesmo cliente** — o segundo a salvar não pode sobrescrever em silêncio: recebe "Este cliente foi alterado por outra pessoa. Recarregue a página." Teste em Task 3.
2. **CPF repetido** em outra pessoa de cliente ativo — recusado com "CPF já cadastrado em <grupo>"; CPF inválido (dígito verificador) recusado com "CPF inválido". Teste em Tasks 1 e 3.
3. **Aniversário em 29/02** em ano não bissexto e aniversário na virada do ano (hoje 20/12, nascimento 05/01) — aviso aparece corretamente. Teste em Task 1.
4. **Remover uma pessoa da família na edição** — a pessoa some da ficha e a auditoria registra antes/depois com a lista de pessoas. Teste em Task 3.
5. **Busca por CPF ou telefone digitados com máscara** ("123.456.789-09", "(66) 9 9123") — encontra o cliente. Teste em Task 3.

---

## Estrutura de arquivos

```
src/domain/clientes.ts                   CPF, telefone, código, nome do grupo, idade, alertas
src/server/db/schema/clientes.ts         clientes + pessoas
drizzle/0006_*.sql (gerado), 0007_rls_clientes.sql (custom)
src/server/queries/clientes.ts           listarClientes, obterCliente
src/server/actions/clientes.ts           salvarCliente, excluirCliente
src/app/(app)/clientes/page.tsx          lista
src/app/(app)/clientes/novo/page.tsx     cadastro
src/app/(app)/clientes/[id]/page.tsx     ficha
src/app/(app)/clientes/[id]/editar/page.tsx
src/app/(app)/clientes/formulario.tsx    formulário (client) compartilhado entre novo e editar
src/domain/perfis.ts                     + "/clientes" para todos os perfis
src/components/shell.tsx                 + Comercial › Clientes no menu
scripts/seed-local.ts                    + clientes fictícios do protótipo
tests/domain/clientes.test.ts
tests/integracao/clientes.test.ts
```

---

### Task 1: Domínio de clientes

**Files:**
- Create: `src/domain/clientes.ts`
- Test: `tests/domain/clientes.test.ts`

**Interfaces:**
- Produces:
  - `TIPOS_CLIENTE = ["familia", "casal", "individual", "grupo"] as const`; `type TipoCliente`; `NOMES_TIPO_CLIENTE: Record<TipoCliente, string>` = Família, Casal, Individual, Grupo.
  - `normalizarCpf(texto: string): string` — só dígitos; `cpfValido(digitos: string): boolean` (11 dígitos, dígitos verificadores, recusa todos iguais); `formatarCpf(digitos: string): string`.
  - `normalizarTelefone(texto: string): string`; `telefoneValido(digitos: string): boolean` (10 ou 11 dígitos); `formatarTelefone(digitos: string): string`.
  - `formatarCodigoCliente(n: number): string` → `"ECL-0001"`; acima de 9999 mantém todos os dígitos (`"ECL-10000"`).
  - `nomeDoGrupo(tipo: TipoCliente, titular: string, informado?: string): string` — regra do `cliente-form.tsx` do protótipo: informado (trim) se houver; senão família → "Família <último sobrenome>", casal → "Casal <último sobrenome>", demais → nome do titular.
  - `idade(nascimento: string, hoje: string): number` (anos completos, datas ISO `AAAA-MM-DD`).
  - `type AlertaCliente = { tipo: "sem_passaporte" | "passaporte_vencido" | "aniversario"; pessoa: string; texto: string }`.
  - `alertasDoCliente(c: { tipo: TipoCliente; pessoas: { nome: string; titular: boolean; nascimento: string | null; validadePassaporte: string | null }[] }, hoje: string): AlertaCliente[]` — para `grupo`, documento só do titular (como no protótipo); aniversário de qualquer pessoa entre hoje e hoje+30 dias; 29/02 em ano não bissexto conta como 28/02.
  - `hojeEmCuiaba(agora?: Date): string` — data ISO no fuso `America/Cuiaba`.
  - Textos: `"<nome> não tem passaporte cadastrado."`, `"Passaporte de <nome> venceu em dd/mm/aaaa."`, `"<nome> faz aniversário em dd/mm."` + `" (hoje)"` quando for hoje.

- [ ] **Step 1:** Testes:
  - `cpfValido("52998224725") === true`; `cpfValido("52998224724") === false`; `cpfValido("11111111111") === false`; `formatarCpf("52998224725") === "529.982.247-25"`; `normalizarCpf("529.982.247-25") === "52998224725"`.
  - `formatarTelefone("66991234567") === "(66) 9 9123-4567"`; `formatarTelefone("6634211234") === "(66) 3421-1234"`; `telefoneValido("669912") === false`.
  - `formatarCodigoCliente(1) === "ECL-0001"`; `formatarCodigoCliente(153) === "ECL-0153"`; `formatarCodigoCliente(10000) === "ECL-10000"`.
  - `nomeDoGrupo("familia", "Carlos Ribeiro") === "Família Ribeiro"`; `nomeDoGrupo("casal", "Marina Souza") === "Casal Souza"`; `nomeDoGrupo("individual", "Ana Lima") === "Ana Lima"`; `nomeDoGrupo("familia", "Carlos Ribeiro", " Ribeiro e amigos ") === "Ribeiro e amigos"`.
  - `idade("1986-03-09", "2026-11-18") === 40`; `idade("1986-11-19", "2026-11-18") === 39`.
  - **Review Focus 3:** nascimento `"2000-02-29"`, hoje `"2027-02-20"` → aviso de aniversário com `"28/02"`; nascimento `"1990-01-05"`, hoje `"2026-12-20"` → aviso com `"05/01"`; hoje `"2026-11-18"`, nascimento `"1980-11-18"` → texto termina com `"(hoje)"`; nascimento `"1980-12-19"`, hoje `"2026-11-18"` → sem aviso (31 dias).
  - Grupo com titular sem passaporte e membro sem passaporte → só um aviso `sem_passaporte` (titular). Família → um por pessoa.
  - Validade `"2026-11-17"`, hoje `"2026-11-18"` → `passaporte_vencido` com `"venceu em 17/11/2026"`; validade igual a hoje → sem aviso.
  - `hojeEmCuiaba(new Date("2026-11-19T03:30:00Z")) === "2026-11-18"` (Cuiabá é UTC−4).
- [ ] **Step 2:** `npm test -- clientes`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** `npm test`. Esperado: PASS.
- [ ] **Step 5:** Commit `feat: regras de domínio de clientes`.

### Task 2: Tabelas de clientes e pessoas

**Files:**
- Create: `src/server/db/schema/clientes.ts`, migração gerada `drizzle/0006_*.sql`, custom `drizzle/0007_rls_clientes.sql`
- Modify: `src/server/db/schema/index.ts`, `tests/integracao/rls.test.ts`

**Interfaces:**
- Consumes: `TIPOS_CLIENTE` (Task 1), `FILIAIS` (`src/domain/perfis.ts`).
- Produces:
  - Enum `tipo_cliente` (4 valores de `TIPOS_CLIENTE`).
  - Sequência `cliente_codigo_seq` começando em 1.
  - `clientes`: `id uuid PK`, `codigo integer not null unique default nextval('cliente_codigo_seq')`, `grupo text not null`, `tipo tipo_cliente not null`, `filial filial not null`, `telefone text not null` (dígitos), `email text null`, `pref_quarto text null`, `pref_alimentacao text null`, `pref_assento text null`, `observacoes text null`, `cliente_desde date not null default current_date`, `criado_em`, `atualizado_em timestamptz not null default now()`, `excluido_em timestamptz null`.
  - `pessoas`: `id uuid PK`, `cliente_id uuid not null references clientes(id)`, `titular boolean not null default false`, `ordem integer not null`, `nome text not null`, `parentesco text null`, `nascimento date null`, `cpf text null` (11 dígitos), `passaporte text null`, `validade_passaporte date null`.
  - Em `0007`: RLS nas duas tabelas; índice único parcial `pessoas_um_titular` em `(cliente_id) where titular`; índice em `pessoas(cpf) where cpf is not null`; CHECK `cpf ~ '^\d{11}$'` e `telefone ~ '^\d{10,11}$'`.
- `rls.test.ts` passa a cobrir `clientes` e `pessoas`.

- [ ] **Step 1:** Estender `rls.test.ts` (anon não lê `clientes` nem `pessoas` com linhas inseridas).
- [ ] **Step 2:** `npm run test:integracao -- rls`. Esperado: FAIL.
- [ ] **Step 3:** Esquema, `npm run db:generate`, `drizzle-kit generate --custom --name rls_clientes`, `npm run db:migrate`.
- [ ] **Step 4:** Rodar. Esperado: PASS. Também `npx supabase db reset` + `npm run db:migrate` do zero sem erro.
- [ ] **Step 5:** Commit `feat: tabelas de clientes e pessoas`.

### Task 3: Consultas e ações de clientes

**Files:**
- Create: `src/server/queries/clientes.ts`, `src/server/actions/clientes.ts`
- Test: `tests/integracao/clientes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `comPerfil`, `errosDeCampo`, `ehUuid` (`src/server/acesso.ts`); `registrarAuditoria`; `exigirPerfil`.
- Produces:
  - `type PessoaEntrada = { nome: string; parentesco?: string; nascimento?: string; cpf?: string; passaporte?: string; validadePassaporte?: string }`.
  - `type ClienteEntrada = { tipo: TipoCliente; grupo?: string; filial: Filial; telefone: string; email?: string; prefQuarto?: string; prefAlimentacao?: string; prefAssento?: string; observacoes?: string; titular: PessoaEntrada; acompanhantes: PessoaEntrada[] }` (Zod `strictObject`; datas `AAAA-MM-DD`; até 60 acompanhantes).
  - `type ClienteFicha = { id; codigo: string /* "ECL-0001" */; grupo; tipo; filial; telefone /* formatado */; email; prefs…; clienteDesde: string; atualizadoEm: string /* ISO, para controle de concorrência */; pessoas: { id; nome; titular; parentesco; nascimento; cpf /* formatado */; passaporte; validadePassaporte }[]; alertas: AlertaCliente[]; excluidoEm: string | null }`.
  - `type ClienteLista = { id; codigo; grupo; tipo; filial; titular: string; acompanhantes: number; telefone; email; alertas: AlertaCliente[] }`.
  - `listarClientes(filtro?: { busca?: string; tipo?: TipoCliente; aviso?: "documentos" | "aniversario" }): Promise<ClienteLista[]>` — login; sem excluídos; busca sem acento e sem caixa em grupo, nomes das pessoas e e-mail, e por dígitos em CPF e telefone (só quando a busca tem ≥ 3 dígitos); `%`/`_` escapados; ordem por grupo.
  - `obterCliente(id: string): Promise<ClienteFicha | null>` — login; id não-UUID → `null`.
  - `salvarCliente(dados: ClienteEntrada, id?: string, atualizadoEmEsperado?: string): Promise<{ ok: true; id: string; codigo: string } | { ok: false; erro: string; campos?: Record<string, string> }>` — qualquer perfil; normaliza CPF/telefone; grupo via `nomeDoGrupo`; em edição exige `atualizadoEmEsperado` igual ao gravado (comparação em ms), senão `"Este cliente foi alterado por outra pessoa. Recarregue a página."`; substitui o conjunto de pessoas (titular `ordem 0`, acompanhantes na ordem recebida); auditoria `criar`/`alterar` com antes/depois do agregado (cliente + pessoas); tudo numa transação com `select … for update` do cliente.
  - `excluirCliente(id: string): Promise<{ ok: true } | { ok: false; erro: string }>` — só `diretor`; exclusão lógica + auditoria `excluir`.
- Mensagens: `"Informe o nome do titular"`, `"Informe o telefone"`, `"Telefone inválido"`, `"CPF inválido"`, `"CPF já cadastrado em <grupo>"`, `"E-mail inválido"`, `"Data inválida"`, `"Cliente não encontrado"`, `"Sem permissão"`.

- [ ] **Step 1:** Testes (com `vi.mock("@/server/supabase", …mockSupabase())` e `comSessao`, padrão da fatia 1):
  - Consultor cria família com titular "Carlos Ribeiro", telefone "(66) 9 9123-4567", CPF "529.982.247-25" e 2 acompanhantes → `codigo === "ECL-0001"`, grupo "Família Ribeiro", telefone gravado `"66991234567"`, 3 pessoas, 1 linha de auditoria `criar`. Segundo cliente → `"ECL-0002"`.
  - **Review Focus 2:** outro cliente com pessoa de CPF "52998224725" → `{ ok:false, erro: "CPF já cadastrado em Família Ribeiro" }`; CPF repetido dentro do mesmo cliente também recusado; CPF de cliente excluído pode ser reutilizado; "52998224724" → `campos.cpf === "CPF inválido"` (chave do titular: `titular.cpf`; de acompanhante: `acompanhantes`).
  - **Review Focus 1:** obter ficha (A), salvar edição com `atualizadoEmEsperado` de A → ok; salvar de novo com o mesmo `atualizadoEmEsperado` antigo → erro de concorrência, nada muda.
  - **Review Focus 4:** editar removendo um acompanhante → ficha com 2 pessoas; auditoria `alterar` com `antes.pessoas.length === 3` e `depois.pessoas.length === 2`.
  - **Review Focus 5:** `listarClientes({ busca: "529.982" })` e `({ busca: "(66) 9 9123" })` encontram; `({ busca: "ribeiro" })` encontra por nome de acompanhante "Lúcia Ribeiro" com acento; `({ busca: "100%_" })` → `[]`.
  - `aviso: "aniversario"` filtra só clientes com aviso de aniversário (usar `hojeEmCuiaba`; nos testes, criar nascimento = hoje).
  - Sem sessão → `"Sem permissão"`; `excluirCliente` por consultor → `"Sem permissão"`; por diretor → some da lista, `obterCliente` devolve com `excluidoEm`; editar cliente excluído → `"Cliente não encontrado"`.
  - Zod: campos desconhecidos (`id`, `codigo`) recusados.
- [ ] **Step 2:** `npm run test:integracao -- clientes`. Esperado: FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Rodar. Esperado: PASS.
- [ ] **Step 5:** Commit `feat: consultas e ações de clientes`.

### Task 4: Telas de clientes, menu e seed

**Files:**
- Create: `src/app/(app)/clientes/page.tsx`, `novo/page.tsx`, `[id]/page.tsx`, `[id]/editar/page.tsx`, `formulario.tsx`
- Modify: `src/domain/perfis.ts` (`"/clientes"` em `ROTAS_POR_PERFIL` de todos os perfis), `src/components/shell.tsx` (área Comercial › Clientes), `scripts/seed-local.ts` (clientes do protótipo), `tests/domain/perfis.test.ts`

**Interfaces:**
- Consumes: Task 3.
- Comportamento:
  - Lista no visual de `clientes/page.tsx` do protótipo: título "<n> clientes", busca "Nome, CPF, telefone ou e-mail", filtro de tipo, chips "Documentos pendentes <n>" e "Aniversário em 30 dias <n>", colunas Cliente (grupo, titular + n, filial, código), Contato, Atenção (badges). **Sem** "Vence nos próximos dias", "Próxima viagem", "Viagens", "Total comprado" e filtro de embarque (fatia 3). Badge de documento em `ouro` (sem vermelho). Linha vazia com "Cadastrar novo cliente".
  - Ficha no visual de `clientes/[id]/page.tsx`: código, tipo · filial · cliente desde, Contato, Preferências, "Quem viaja" (nome, titular/parentesco, idade, passaporte, validade), bloco "Resolver antes do embarque" com os avisos de documento (tom `ouro`), avisos de aniversário; botões "Editar" e, para diretor, "Excluir" (confirmação). **Sem** "Novo orçamento" e lista de viagens (fatia 3).
  - Formulário (novo/editar) com os campos de `cliente-form.tsx`/`clientes/novo` do protótipo: tipo, nome do grupo (opcional, mostra o sugerido), filial, telefone, e-mail, titular (nome, nascimento, CPF, passaporte, validade), acompanhantes (adicionar/remover: nome, parentesco, nascimento, CPF, passaporte, validade), preferências. Erros por campo. Na edição envia `atualizadoEmEsperado`. Após salvar vai para a ficha. Texto de apoio: "Cópias de passaporte e RG ficam na pasta de uso interno do cliente, no Drive."
  - Seed: os 30 clientes de `clientesIniciais` do protótipo (copiados como literal), com CPF válido gerado (os do protótipo não têm dígito verificador correto — gerar CPFs válidos determinísticos), idempotente por `grupo`.

- [ ] **Step 1:** Teste de domínio: `podeAcessar(p, "/clientes/novo") === true` para os 5 perfis.
- [ ] **Step 2:** `npm test -- perfis`. Esperado: FAIL.
- [ ] **Step 3:** Implementar rotas, menu, telas e seed.
- [ ] **Step 4:** `npm run lint && npm run typecheck && npm test && npm run test:integracao && npm run build`. Esperado: tudo verde.
- [ ] **Step 5:** Verificação manual (Playwright, `npx next dev -p 3990`, após `npm run seed:local`): consultor cria cliente com 2 acompanhantes, vê a ficha com código, edita removendo um, busca por CPF com máscara; operacional abre a ficha; diretor exclui. Registrar o que viu.
- [ ] **Step 6:** Commit `feat: telas de clientes, menu e seed`.
