# Sistema real ECLAK Viagens — desenho do back-end

Data: 18/11/2026 · Base: protótipo navegável (`eclak-mockup`, 31 telas, publicado em 17/11/2026)

## 1. Intenção

Transformar o protótipo (dados em memória, `useStore`) em um sistema que a equipe da ECLAK usa no dia a dia com dados reais, começando pelo fluxo que dá ao diretor a **margem real de cada viagem** antes de aprovar. As regras de negócio, os perfis e o visual já estão validados no protótipo; o back-end persiste, protege e calcula essas regras no servidor.

Fontes de verdade sobre o produto: `PRODUCT.md`, `DESIGN.md` e o código de `src/lib/` do protótipo (`calc.ts`, `mock-data.ts`, `cadastros.ts`, `store.tsx`).

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Persistência real, login individual e autorização por perfil no servidor.
- Margem real (com rateio de custo fixo e taxas da forma de pagamento) calculada no servidor a partir de lançamentos reais.
- Entregar em fatias (seção 6); cada fatia é usável sozinha.

**Não-objetivos**
- Multi-agência / SaaS. O sistema é só da ECLAK.
- API pública ou app mobile. Não haverá API separada.
- Importação das planilhas atuais. Os dados entram pelo sistema (cadastro manual).
- Integrações (Trello, Google Drive, OFX, Expedia/Infotera, chat com IA) antes da fatia 6.

**Anti-objetivos** (falha mesmo que "funcione")
- Margem calculada em dois lugares com resultados diferentes (ex.: SQL e TypeScript).
- Perfil Consultor enxergando custo ou margem que hoje o protótipo esconde dele, por falha de autorização no servidor.
- Valores monetários com erro de arredondamento de ponto flutuante.
- Dado fictício do protótipo misturado com dado real.

## 3. Restrições

- Protótipo continua intacto na Vercel (`prototipo-financeiro-six.vercel.app`) como vitrine. O sistema real nasce em **repositório novo**.
- Regras de marca do `DESIGN.md` valem igual: azul #2E5C71 dominante, laranja #F26531 só em destaque, texto #333132, sem vermelho, sem gradiente, sem ícone de estrelinha para IA.
- Precificação é sigilosa: custos, comissões e margens só para perfis autorizados.
- Dados pessoais de clientes (CPF, passaporte, nascimento) estão sob LGPD.
- Layout desktop 1440–1920 px (igual ao protótipo).

## 4. Abordagens consideradas

| | Abordagem | Troca |
|---|---|---|
| **Escolhida** | **Next.js fullstack** (Server Actions / Route Handlers) + **Supabase** (Postgres, Auth, Storage) acessado só pelo servidor via **Drizzle**, deploy no **Railway** | Uma linguagem, `calc.ts` reaproveitado, um deploy. Expor API depois exigiria trabalho extra (não previsto). |
| Descartada | Supabase como back completo (supabase-js no navegador + RLS com a regra) | Mais rápido no início, mas divide a regra entre SQL e TS; viola o anti-objetivo da margem em dois lugares. |
| Descartada | API separada (NestJS/FastAPI) | Dois deploys e o dobro de cerimônia sem consumidor externo. Decisão do Mateus: não precisa. |

Decisões do Mateus nesta conversa: Postgres no Supabase; deploy no Railway; sem API separada; só ECLAK; repositório novo; protótipo separado; sem importação de planilhas; ordem de entrega da seção 6.

## 5. Arquitetura

### 5.1 Stack
- Next.js 16 (App Router), React 19, Tailwind v4, TypeScript estrito — mesmas versões do protótipo.
- Railway: serviço Node com `output: "standalone"`; **um único ambiente** (produção) ligado a um único projeto Supabase (decisão do Mateus em 18/11/2026). Desenvolvimento e teste de migrações rodam localmente com o Supabase CLI (Postgres local em Docker), nunca contra o banco de produção. Backups diários do Supabase ativos.
- Supabase:
  - **Postgres**: banco único. App conecta pelo connection pooler (transaction mode) via Drizzle.
  - **Auth**: e-mail e senha; sessão por cookie (`@supabase/ssr`). Cadastro de usuário só pelo Diretor (tela Admin › Usuários); sem auto-cadastro.
  - **Storage**: bucket privado; arquivos servidos por URL assinada de curta duração gerada no servidor.
- Drizzle ORM + `drizzle-kit` para migrações versionadas no repositório. Ninguém altera esquema pelo painel.
- Zod para validar toda entrada de Server Action.
- RLS **ligado em todas as tabelas sem políticas para `anon`/`authenticated`** — bloqueia qualquer acesso direto pelo navegador; o servidor usa conexão própria. A autorização real é feita no código (5.3).

### 5.2 Organização do código
```
src/
  app/                 telas (copiadas do protótipo e ligadas ao servidor)
  server/
    db/schema/*.ts     esquema Drizzle por domínio
    db/client.ts
    auth.ts            sessão, usuário atual, exigirPerfil()
    actions/*.ts       Server Actions por domínio (validam com Zod, checam perfil, gravam auditoria)
    queries/*.ts       leituras por domínio, já filtradas por perfil
  domain/              regras puras, sem I/O: calc (margem, caixa, precificação, taxas)
  components/          kit visual do protótipo
```
`domain/` é a **fórmula única** da margem. Fórmula oficial confirmada pelo Mateus em 18/11/2026: `calcular()` de `src/app/aprovacoes/page.tsx` do protótipo (a mais completa) — custo = itens líquidos de comissão + taxa de roteiro; imposto sobre o spread; taxa da forma de pagamento (% do cartão + R$ por boleto); margem antes do fixo; rateio do custo fixo; margem final. Constantes (imposto, taxa de roteiro, faixas de cartão, custo por boleto, custo fixo mensal, método de rateio) vêm de `regras`, nunca do código. Utilitários de `src/lib/calc.ts` (datas, formatação, caixa) são reaproveitados; as versões de margem de `calc.ts` e do precificador são descartadas. Valores em centavos. Roda no servidor; o front pode importar as mesmas funções para simulação instantânea (ex.: precificador), mas o valor gravado é sempre o recalculado no servidor.

### 5.3 Perfis e autorização
Perfis (iguais ao protótipo): `diretor`, `consultor`, `operacional`, `fin_operacional`, `fin_estrategico`. Usuário tem `perfil` e `filial` (`Rondonópolis` | `RS`).

- Acesso por rota segue `perfis[...].rotas` de `src/lib/store.tsx` do protótipo; vira um mapa único no servidor usado por middleware (bloqueio de página) e por `exigirPerfil()` em toda action/query.
- Quem vê uma área também edita (não há perfil só leitura).
- Duas camadas de dado, como no protótipo: **operacional** (valor do fornecedor e comissão, visível a quem cota) e **estratégica** (imposto, rateio do custo fixo, margem antes e depois do fixo). Camada estratégica: `diretor`, `fin_operacional` e `fin_estrategico` (decisão do Mateus em 18/11/2026; o protótipo mostrava só ao Diretor). Camada operacional: todos os perfis. Queries omitem a camada estratégica no servidor para `consultor` e `operacional`, e há teste de autorização para isso.
- Aprovação de viagem: **somente o Diretor** (igual ao protótipo).
- Filial: todos os perfis veem as duas filiais com filtro; a filial é atributo do dado, não barreira de acesso.

### 5.4 Convenções de dados
- Dinheiro: `bigint` em **centavos**; percentuais em `numeric(6,3)`.
- Datas de negócio: `date`; eventos: `timestamptz`; fuso `America/Cuiaba` para "hoje".
- IDs: `uuid`. Código de viagem legível `ECL-NNNN` por sequência própria; fatura numerada por sequência que começa em **1502**, sem buracos.
- **Auditoria**: tabela `auditoria` (quem, quando, tabela, id, antes/depois em JSON) gravada por toda action que altera valor monetário, status ou regra.
- Exclusão lógica (`excluido_em`) em cadastros; lançamentos financeiros nunca são apagados, só estornados/cancelados.

## 6. Ordem de entrega

Cada fatia termina usável em produção. Entidades listadas são o mínimo; o builder detalha colunas a partir dos tipos do protótipo indicados.

1. **Base** — login, `usuarios` (perfil, filial), Admin › Usuários, Admin › Parâmetros (`regras`: margem de referência, imposto, taxa de roteiro, custo por boleto R$ 2,50, faixas de taxa de cartão Cielo até 10x, **custo fixo mensal informado à mão** e **método de rateio** — por dia, por faturamento ou fixo por viagem —, todos versionados com data de vigência), Fornecedores (tipo `Fornecedor`), auditoria, layout/menu por perfil. Banco começa vazio exceto parâmetros iniciais tirados do `PRODUCT.md` e de `aprovacoes/page.tsx` (não de `regrasIniciais`, que diverge: boleto em %, cartão até 12x).
2. **Clientes** — `clientes` + `pessoas` (titular e família, tipos `Cliente`/`Pessoa`), preferências. Código do cliente `ECL-NNNN` a partir de ECL-0001. Sem upload de documentos nesta fatia: cópias de passaporte e RG continuam no Drive até a fatia 6 (decisão do Mateus em 18/11/2026).
3. **Viagem ponta a ponta** — cotação, precificador, envio para aprovação com versões (tela Aprovações: aprovada / aprovada com ajuste / devolvida, histórico de versões), conversão em viagem, viagem com itens/saídas (tipo `Saida`), entradas (tipo `Entrada`), comissões por reserva, opções de pagamento à vista × parcelado (tipo `OpcaoPagamento`), conciliação e margem real. Margem de referência só indica, nunca bloqueia (princípio 2 do `PRODUCT.md`). O único bloqueio é o do protótipo: o PDF da proposta só é liberado depois da aprovação do Diretor. A viagem guarda a versão das `regras` usada no cálculo aprovado.
4. **Financeiro** — faturas (sequência 1502), parcelas e baixa, contas a pagar e receber com categorias, notas fiscais (anexo), lançamentos operacionais e contas fixas (tipo `LancamentoOperacional`), faturas de cartão corporativo (custo variável), fluxo de caixa e projeção mínima de 12 meses, meta de reserva de 6 meses de custo fixo.
5. **Operação** — tarefas, roteiros (RT com DICA ECLAK e "Por que escolhemos"), dailies (texto de encerramento ainda pendente do cliente), reembolsos, estoque por filial (tipo `Produto`), caixa de experiência, avisos por setor (notificações).
6. **Painéis e integrações** — visão geral, relatórios, vendas; depois Trello, Google Drive, extrato OFX, chat com IA, Expedia/Infotera. Tela "Planilha x Sistema" sai de escopo (sem importação de planilhas).

## 7. Decisões deixadas ao builder

- Nome do repositório novo e estrutura de CI (lint, typecheck, migração testada no Postgres local antes de rodar em produção).
- Detalhe de colunas e índices a partir dos tipos do protótipo.
- Biblioteca de formulários e padrão de feedback (toasts do protótipo podem ser mantidos).
- Estratégia de testes: obrigatório teste unitário para tudo em `domain/` (margem, taxas, caixa) com casos de referência tirados dos pedidos ECL-0147, ECL-0152 e ECL-0139 de `aprovacoes/page.tsx` (resultado da `calcular()` do protótipo = resultado esperado, em cada forma de pagamento e método de rateio); testes de autorização por perfil nas actions.
- Seed de desenvolvimento com dados fictícios (só no ambiente local, nunca em produção).

## 8. Pendências que não bloqueiam o início

- Texto oficial de encerramento do daily (fatia 5).
- Retorno do grupo e da Valeska sobre Contas a pagar e receber, Reembolsos, Estoque, Caixa de experiência, Avisos por setor e Daily padrão (fatias 4 e 5).
- Método de rateio do custo fixo: "a definir com a gestão" (Admin › Parâmetros do protótipo); por isso fica configurável, padrão "por dia de viagem".
- Custo fixo mensal na fatia 3 é um número informado em Parâmetros; a partir da fatia 4 pode passar a ser calculado das contas fixas (decisão futura).
- Em aberto no `PRODUCT.md`: modelo de fatura, detalhes dos cartões corporativos, percentual do alerta de preço, API do Sakura Click.
