# Agente do chat com Trello e Drive (desenho)

Data: 25/11/2026 · Base: `main` (depois do PR #14; o PR #16 move o botão do chat para o canto inferior direito) · HANDOFF: `docs/HANDOFF.md` · Desenho anterior do chat: `2026-11-24-fatia-6b-6c-design.md` §5.4

Pedido do Mateus (25/11/2026): "Quero que ele seja um agente que consiga fazer ações no Trello e no Drive e poder responder questões a partir de lá."

Respostas do Mateus às dúvidas (25/11/2026):
1. **Alcance:** ler tudo (o quadro do Trello e a pasta raiz do Drive inteiros); agir só nas viagens do sistema.
2. **Ações no Trello:** comentar no cartão; marcar itens de checklist (e adicionar itens); mover de lista e prazo; criar cartão avulso.
3. **Ações no Drive:** enviar arquivo anexado no chat; criar subpastas; renomear e mover. Apagar fica de fora.
4. **Conteúdo do Drive:** ler o texto dos arquivos, com máscara de dados pessoais.
5. **"Uso interno":** todos os perfis leem o conteúdo pelo chat.

Toda ação pede "Confirmar" na tela antes de executar (estava no enunciado das perguntas 2 e 3).

## 1. Intenção

Hoje o chat só lê o próprio sistema (4 ferramentas: viagens, resumo, tarefas, dailies). A equipe vive também no Trello (o andamento de cada viagem) e no Drive (os documentos de cada viagem). O agente passa a:

- **responder** com o que está no quadro do Trello e na pasta raiz do Drive ("o que falta no checklist da ECL-0021-01?", "qual é o voucher do hotel de Roma?", "quais cartões estão parados em Emissão?");
- **agir** nas viagens do sistema, sempre com confirmação de quem pediu: comentar, marcar checklist, mover cartão, definir prazo, criar cartão, guardar um arquivo na pasta da viagem, criar subpasta, renomear e mover arquivo.

Sucesso: a pessoa resolve no chat o que hoje exige abrir o Trello ou o Drive, e nada muda lá sem ela ter visto exatamente o que vai mudar.

## 2. Objetivos, não-objetivos e anti-objetivos

**Objetivos**
- Ferramentas de leitura do Trello e do Drive no chat, respeitando o alcance (§4).
- Ferramentas de ação que **propõem**; a execução acontece só quando a pessoa confirma (§6).
- Anexar arquivo no chat para guardar no Drive (§7).
- Tudo desligado enquanto a integração correspondente não estiver configurada; testado só contra serviços falsos.

**Não-objetivos (ficam para depois)**
- Microfone e voz.
- O agente ler o conteúdo do arquivo anexado no chat (ele só guarda o arquivo; depois de guardado, lê pelo Drive como qualquer outro).
- Ações no próprio sistema pelo chat (lançar item, baixar parcela etc.): o R-C6 continua valendo para os dados do sistema.
- Apagar ou arquivar qualquer coisa no Trello ou no Drive; compartilhar arquivo; mudar permissões; membros e etiquetas do Trello.
- Histórico do chat no banco (R-C5 continua: a conversa some ao recarregar).
- Ler imagem ou PDF escaneado (sem OCR).

**Anti-objetivos (falha mesmo que "funcione")**
- Qualquer escrita no Trello ou no Drive sem a confirmação da pessoa na tela, ou com conteúdo diferente do que ela viu.
- O modelo, o histórico vindo do navegador ou um texto lido de um cartão ou arquivo conseguir executar, confirmar ou alterar uma ação (texto lido é dado, nunca instrução).
- Agir fora das viagens do sistema: alterar cartão que o sistema não criou, mexer em arquivo fora da pasta de uma viagem.
- Ler ou tocar algo fora do quadro configurado ou fora da pasta raiz, mesmo que a credencial alcance.
- CPF, passaporte, RG, nascimento ou telefone chegando ao modelo sem máscara pelo texto de um cartão ou arquivo; custo, margem ou comissão indo para o Trello.
- Segredo, id interno do banco ou conteúdo de documento em log, auditoria ou `ia_usos`.
- Resposta dizendo "feito" para uma ação que só foi proposta, ou que falhou.

## 3. Restrições

As do HANDOFF §4 e da 6c continuam: `comPerfil` primeiro em toda Server Action; `exigirPerfil` em toda query; auditoria na mesma transação da gravação; RLS em toda tabela nova + `rls.test.ts`; enum novo em migração própria; segredos só em `process.env`; **nenhuma chamada externa dentro de `db.transaction`**; nenhum teste, seed ou verificação chama serviço real (o shell exporta uma `ANTHROPIC_API_KEY` verdadeira: servidor de desenvolvimento sempre com ela vazia ou falsa); marca (azul dominante, laranja só destaque, sem vermelho: ouro; sem emoji; sem ícone de estrelinha para IA).

Novas, deste desenho:
- **R-A1.** As ferramentas do Trello só existem na lista enviada ao modelo quando `configTrello()` não é nulo; as do Drive, quando `configDrive()` não é nulo. O chat continua exigindo a IA.
- **R-A2.** Toda referência externa que chega do modelo (id de cartão, lista, checklist, item, arquivo, pasta) é **reconferida no servidor contra o alcance** antes de qualquer uso, na proposta e de novo na execução.
- **R-A3.** Todo texto livre que sai do Trello ou do Drive para o modelo (nome, descrição, comentário, item, conteúdo de arquivo, caminho) passa por `protegerTexto` campo a campo, antes do `JSON.stringify`. **Os campos `id` e `link` não passam** (a máscara por padrão estragaria ids: 11 dígitos seguidos viram `[CPF]`). Todo texto que vai para o Trello ou vira nome no Drive também passa.
- **R-A4.** A máscara usa os **valores conhecidos** além dos padrões: nascimentos e documentos (RG, passaporte, CPF) de todas as `pessoas` não excluídas, lidos uma vez por pergunta, passados como `conhecidos` ao `protegerTexto`. Motivo: no "ler tudo" não há uma viagem de onde tirar os passageiros, e só o padrão não pega nascimento nem passaporte estrangeiro. Limite assumido: nascimento ou documento de quem **não** está cadastrado no sistema, escrito num cartão ou arquivo, não é mascarado (o padrão ainda pega CPF, CNPJ, RG com máscara, passaporte brasileiro e telefone).

## 4. Alcance

| | Ler | Agir |
|---|---|---|
| **Trello** | Qualquer cartão e lista do **quadro da lista configurada** (`TRELLO_LISTA_ID` → `idBoard`) | Só **cartões de viagem**: o `cartaoId` gravado no `resultado` de um envio `enviado` da fila (`integracao_envios`) de uma viagem não excluída. Exceção pedida: **criar cartão avulso**, em qualquer lista do mesmo quadro. |
| **Drive** | Qualquer arquivo ou pasta **descendente de `GOOGLE_DRIVE_PASTA_RAIZ_ID`** | Só dentro da **pasta de uma viagem**: descendente do `pastaId` gravado no `resultado` do envio `pasta_viagem` `enviado` de uma viagem não excluída. |

- **Quadro:** o `idBoard` vem de `GET /lists/{TRELLO_LISTA_ID}` e fica em memória do processo (como o token do Google); cartão ou lista de outro quadro é tratado como inexistente.
- **Descendência no Drive:** sobe por `parents` (`files.get?fields=id,name,mimeType,parents`) até achar o alvo ou acabar, no máximo 12 níveis; fora disso é inexistente. A credencial pode alcançar mais que a pasta raiz (conta de serviço Editor do drive compartilhado): por isso a conferência é do sistema, não do Google.
- **Viagem:** para agir, o alvo precisa ser de uma viagem não excluída. O sistema não tem hoje filtro de viagem por consultor (`cabecalhoDaViagem` faz `exigirPerfil()` sem perfil): qualquer pessoa ativa vê qualquer viagem, e aqui vale o mesmo. O código da viagem (ECL-0001-01) é resolvido para o id por uma query nova com `exigirPerfil`.
- **Perfis:** os cinco perfis leem e propõem ações (`PERFIS_ACAO_CHAT`); toda ação fica auditada com o nome de quem confirmou.
- **"Uso interno" (decisão do Mateus, 25/11/2026):** todos os perfis leem pelo chat o conteúdo de "Público" e de "Uso interno". A leitura usa a credencial do sistema, não a da pessoa: quem não abre um arquivo no Google pode perguntar por ele no chat, dentro da pasta raiz.

## 5. Ferramentas de leitura

Todas devolvem JSON montado campo a campo, com limites; nenhuma devolve id do banco. Os ids externos (do Trello e do Drive) saem, porque o modelo precisa deles para a volta seguinte; não são segredo (estão nos links).

**Trello**
- `trello_listas()` → listas abertas do quadro: `{ id, nome, cartoes }`.
- `trello_buscar_cartoes({ busca, lista })` (os dois opcionais; `""` = sem filtro) → até 30 cartões abertos e o total: `{ id, nome, lista, prazo, concluido, link, viagem }`. `busca` compara sem acento e sem caixa com o nome do cartão; `viagem` é o código (ECL-0001-01) quando o cartão é de viagem do sistema.
- `trello_cartao({ cartao })` → `cartao` é o código da viagem ou o id do cartão: `{ nome, lista, prazo, concluido, link, viagem, descricao (até 4.000 caracteres), checklists: [{ id, nome, itens: [{ id, nome, feito }] }], comentarios: [{ autor, data, texto }] (os 20 mais recentes, cada um até 1.000 caracteres) }`. Da descrição sai o endereço `…/viagens/<uuid>` que o sistema escreve no cartão, para nenhum id do banco chegar ao modelo.

**Drive**
- `drive_listar({ pasta })` → `pasta` é o código da viagem, o id de uma pasta ou `""` (a raiz): até 100 itens e o total: `{ id, nome, tipo ("pasta" | "arquivo"), mime, modificado, tamanho, link }`, pastas primeiro, depois por nome.
- `drive_buscar({ texto })` → até 20 arquivos da pasta raiz cujo **nome ou conteúdo** contém o texto (`fullText contains`), só os descendentes da raiz: `{ id, nome, mime, modificado, link, caminho }` (`caminho` = nomes das pastas da raiz até o arquivo).
- `drive_ler_arquivo({ arquivo })` → `{ nome, mime, texto (até 20.000 caracteres), cortado }`.
  - Google Docs: exporta `text/plain`. Google Planilhas: exporta `text/csv` (primeira aba). Google Apresentações: exporta `text/plain`.
  - PDF: baixa (até 5 MB) e extrai o texto com `unpdf` (dependência nova, só servidor; ver §9).
  - `text/plain`, `text/csv`, `text/markdown`: baixa (até 5 MB) e lê como UTF-8.
  - Qualquer outro tipo, arquivo maior que 5 MB ou PDF sem texto: erro de ferramenta com mensagem para o modelo ("Este arquivo não tem texto que eu consiga ler; o link é …").
  - O texto passa por `protegerTexto` inteiro antes de sair (R-A3).

**Limites da conversa:** `MAX_VOLTAS` sobe de 6 para 8 (ler um cartão e dois arquivos numa pergunta cabe); o prazo de 3 minutos da pergunta inteira fica. As chamadas ao Trello e ao Drive usam o `TIMEOUT_MS` de 15 s do `http.chamar` e, se o prazo da conversa estiver no fim, a ferramenta falha em vez de estourar.

**Erros:** `ErroIntegracao` vira `tool_result` com `is_error` e uma frase fixa por serviço e classe, num mapa próprio (o `ERRO_DA_CLASSE` atual fala da IA): "O Trello não respondeu agora", "O Trello recusou o acesso: avise o Diretor", "O Drive está no limite de uso: tente daqui a pouco"… O modelo relata e não tenta de novo mais de uma vez por ferramenta.

## 6. Ações: propor, confirmar, executar

### 6.1 Como funciona

1. A pessoa pede ("comenta no cartão da ECL-0021-01 que o voucher chegou").
2. O modelo chama uma ferramenta de ação. O servidor **não executa**: valida a entrada, confere o alcance (R-A2), busca os nomes reais do alvo (nome do cartão, da lista, do arquivo) e grava uma linha `pendente` em `chat_acoes` com o conteúdo exato.
3. O `tool_result` devolvido ao modelo diz só: "Proposta registrada. Nada foi executado: a pessoa precisa confirmar na tela." O modelo responde com uma frase curta e **nunca** diz que fez.
4. `conversar` devolve, além do texto, `propostas: [{ id, titulo, linhas: [rotulo, valor][], expiraEm }]`. O `titulo` e as `linhas` são montados **pelo servidor** a partir do que foi gravado, não pelo modelo.
5. A tela mostra um cartão de confirmação por proposta: título, linhas, **"Confirmar e executar"** e **"Cancelar"**.
6. "Confirmar" chama a Server Action `confirmarAcaoChat(id)`; "Cancelar", `cancelarAcaoChat(id)`. Nenhuma das duas passa pelo modelo.
7. A execução devolve `{ ok: true, texto, link }` ou a falha; a tela troca o cartão por "Feito: …" com o link, ou pela mensagem de erro em ouro.

O modelo pode propor até **3 ações por pergunta**; a quarta recebe erro de ferramenta.

### 6.2 As ações

| Ferramenta | Entrada | O que executa | Linhas da confirmação |
|---|---|---|---|
| `trello_comentar` | `cartao`, `texto` (1 a 2.000) | `POST /cards/{id}/actions/comments` com o texto começando por `[Nome da pessoa, pelo sistema] ` | Cartão, Comentário |
| `trello_marcar_item` | `cartao`, `item` (id do item), `feito` (bool) | `PUT /cards/{id}/checkItem/{item}` `state` | Cartão, Checklist, Item, Marcar como |
| `trello_adicionar_item` | `cartao`, `checklist` (id), `nome` (1 a 200) | `POST /checklists/{id}/checkItems` | Cartão, Checklist, Novo item |
| `trello_mover_cartao` | `cartao`, `lista` (id) | `PUT /cards/{id}` `idList` | Cartão, De, Para |
| `trello_definir_prazo` | `cartao`, `prazo` (`AAAA-MM-DD` ou `""` para tirar) | `PUT /cards/{id}` `due` (12h de Cuiabá do dia, em UTC) | Cartão, Prazo atual, Novo prazo |
| `trello_criar_cartao` | `lista` (id ou `""` = a configurada), `nome` (1 a 200), `descricao` (até 2.000) | `POST /cards` | Lista, Nome, Descrição |
| `drive_enviar_arquivo` | `viagem` (código), `anexo` (id do anexo do chat), `destino` (`publico`, `interno` ou id de subpasta da viagem), `nome` (opcional) | upload multipart do arquivo guardado (§7) | Viagem, Pasta, Arquivo, Tamanho |
| `drive_criar_pasta` | `viagem`, `dentroDe` (`publico`, `interno`, `raiz_da_viagem` ou id de subpasta), `nome` (1 a 120) | `criarPasta` | Viagem, Dentro de, Nova pasta |
| `drive_renomear` | `arquivo` (id), `nome` (1 a 200) | `PATCH /files/{id}` `name` | Viagem, Arquivo, Novo nome |
| `drive_mover` | `arquivo` (id), `destino` (`publico`, `interno` ou id de subpasta **da mesma viagem**) | `PATCH /files/{id}` `addParents`/`removeParents` | Viagem, Arquivo, De, Para |

Regras:
- `cartao` nas ações é o código da viagem ou o id de um cartão **de viagem**; cartão que não é de viagem → erro de ferramenta "Só altero cartões de viagens do sistema" (o agente pode responder sobre ele, não mexer).
- `item` e `checklist` precisam pertencer ao cartão; `lista`, ao quadro.
- No Drive, o arquivo ou pasta alvo e o destino precisam ser descendentes da pasta **da mesma viagem**. As três pastas criadas pelo sistema (a da viagem, "Público" e "Uso interno") não podem ser renomeadas nem movidas.
- Nome de arquivo ou pasta: sem `/` nem `\`, sem caractere de controle, aparado; a extensão do arquivo enviado é a do tipo conferido pelos bytes.
- Texto livre (comentário, nome, descrição) passa por `protegerTexto` na proposta; o que a pessoa confirma é o texto já protegido.
- O prompt do sistema passa a dizer: custo, preço do pacote, margem e comissão não vão para o Trello nem para nomes no Drive, mesmo que peçam. Não há bloqueio no servidor (não dá para reconhecer "margem" num texto livre com segurança): o controle é essa regra mais a confirmação, em que a pessoa lê o texto exato. Quem não vê a camada estratégica não recebe esses números das ferramentas, então só Diretor e financeiros poderiam pedir isso.

### 6.3 Dados

Migrações a partir da 0046 (enum numa, tabelas noutra, RLS noutra, como nas fatias anteriores):

- enum `situacao_chat_acao`: `pendente`, `executando`, `feita`, `falhou`, `cancelada`, `expirada`.
- `chat_acoes`: `id`, `usuario_id` (quem pediu; só essa pessoa confirma ou cancela), `tipo` (texto com CHECK na lista das 10 ferramentas), `viagem_id` (nulo só em `trello_criar_cartao`), `alvo` (jsonb: ids externos e os nomes lidos na proposta), `dados` (jsonb: o conteúdo exato a executar), `situacao`, `criado_em`, `expira_em` (criação + 15 min), `decidido_em`, `tomado_em` (fencing da execução), `resultado` (jsonb: `{ link }` ou `{ classe, status }`).
- `chat_anexos` (§7).
- RLS: as duas tabelas só pela service role (como `integracao_envios` e `ia_usos`), com os casos no `rls.test.ts`.

### 6.4 Execução (`confirmarAcaoChat`)

1. `comPerfil(PERFIS_ACAO_CHAT)`; id inválido ou de outra pessoa → "Ação não encontrada".
2. Numa transação: `UPDATE … SET situacao = 'executando', tomado_em = now() WHERE id = $1 AND usuario_id = $2 AND situacao = 'pendente' AND expira_em > now()`. Zero linhas → relê e responde pelo motivo: "Esta ação expirou. Peça de novo.", "Esta ação já foi executada.", "Esta ação foi cancelada."
3. **Fora da transação:** reconfere integração ligada e alcance (R-A2; o cartão pode ter sido movido de quadro, o arquivo apagado, a viagem excluída) e faz a chamada externa.
4. Numa transação: `UPDATE … WHERE id = $1 AND situacao = 'executando' AND tomado_em = $tomado` para `feita` (com `resultado.link`) ou `falhou` (com classe e status), e a **auditoria na mesma transação**: tabela `chat_acoes`, ação `criar`, `depois` = `{ tipo, viagem (código), alvo (nomes), resultado }`; **sem** o texto do comentário, da descrição ou de qualquer conteúdo de arquivo.
5. Devolve `{ ok: true, texto: "Comentário publicado no cartão ECL-0021-01", link }` ou a falha com a frase da classe do erro.

- **Sem repetição automática.** Uma ação que falhou fica `falhou`; a pessoa pede de novo. Motivo: repetir um comentário ou um upload pode duplicar.
- **`executando` preso** (o processo caiu entre os passos 3 e 4): depois de 2 minutos a linha é tratada como "resultado desconhecido"; uma nova confirmação responde "Não sei se esta ação foi concluída. Confira no Trello (ou no Drive) antes de pedir de novo." e marca `falhou` com `resultado = { classe: "desconhecido" }` (texto do `resultado`, fora de `CLASSES_ERRO`). Antes dos 2 minutos, uma segunda confirmação responde "Esta ação está em execução."
- **Expiradas:** `pendente` com `expira_em` vencido vira `expirada` na próxima leitura dela e na limpeza do agendador (`POST /api/cron/integracoes` ganha um passo que marca as expiradas e remove os anexos vencidos, §7).
- Proposta `pendente` não aparece para o modelo na volta seguinte como "feita": o histórico que vai ao modelo continua sendo só texto; a tela acrescenta ao histórico uma linha de texto fixa depois de cada decisão ("[A pessoa confirmou: comentário no cartão ECL-0021-01. Resultado: feito.]" ou "[A pessoa cancelou: …]"), para a conversa seguir coerente. Como todo o histórico, essa linha é dado não confiável e não autoriza nada.

## 7. Anexo no chat

- Botão de clipe no campo do chat (só quando o Drive está configurado). Um arquivo por vez; PDF, PNG ou JPEG conferidos **pelos bytes** (`tipoPelosBytes`), até **5 MB** (o limite do upload do Drive, `LIMITE_UPLOAD_BYTES`), mensagens no padrão de `anexos` ("Envie um PDF, PNG ou JPEG"; mensagem própria "O arquivo passa de 5 MB", porque a `MSG_TAMANHO_ANEXO` atual diz 10 MB).
- Server Action `anexarNoChat(formData)`: `comPerfil(PERFIS_ACAO_CHAT)`, sobe para o bucket `anexos` em `chat/<usuario>/<uuid>` e grava `chat_anexos`: `id`, `usuario_id`, `nome`, `mime`, `tamanho`, `caminho`, `criado_em`, `expira_em` (criação + 60 min), `usado_em`. Devolve `{ ok: true, id, nome, tamanho }`.
- A tela mostra o arquivo como uma etiqueta na mensagem da pessoa e manda ao servidor, junto com a pergunta, `anexos: [id]`. Como o histórico é remontado a cada pergunta, **a tela reenvia os ids em toda pergunta** enquanto o anexo não foi usado nem removido. O limite é do servidor: no máximo 3 anexos da pessoa não usados e não vencidos ao mesmo tempo (o quarto: "Você já tem 3 arquivos anexados esperando. Use ou remova um."). `conversar` confere que são da pessoa e não venceram e acrescenta à pergunta, para o modelo, só: "Arquivo anexado: <nome> (<tipo>, <tamanho>), referência <id>". **O conteúdo não vai para o modelo.**
- `drive_enviar_arquivo` na execução: lê os bytes do bucket, envia ao Drive, marca `usado_em` e remove o objeto do bucket. Falhou: o anexo fica até vencer, para a pessoa pedir de novo.
- Limpeza: o passo novo do agendador remove do bucket e da tabela os anexos com `expira_em` vencido.
- O bucket `anexos` só aceita PDF, PNG e JPEG: por isso os mesmos três tipos aqui.

## 8. Tela

`src/components/chat-ia.tsx` (painel lateral que já existe):
- A saudação muda para: "Posso responder sobre viagens, tarefas, dailies, o quadro do Trello e os arquivos do Drive, e fazer ações neles. Nada é alterado sem a sua confirmação." (as partes do Trello e do Drive só entram se a integração estiver ligada; sem nenhuma das duas, fica a saudação atual).
- Cartão de confirmação dentro da resposta da IA: rótulo em caixa alta com o título ("COMENTAR NO CARTÃO"), lista de linhas (rótulo e valor; texto longo com quebra, até 6 linhas e "ver tudo"), botões "Confirmar e executar" (primário, azul) e "Cancelar" (secundário). Enquanto executa, os dois ficam desabilitados e o primário diz "Executando…". Depois: "Feito: <texto>" com o link "Abrir no Trello" / "Abrir no Drive", ou a mensagem de erro com fundo ouro claro. Expirado: "Esta ação expirou. Peça de novo."
- Clipe à esquerda do campo; arquivo escolhido aparece como etiqueta com nome, tamanho e "remover" antes de enviar.
- Links `https://trello.com/…`, `https://drive.google.com/…` e `https://docs.google.com/…` no texto da IA viram link clicável (nova aba, `rel="noopener noreferrer"`); qualquer outro endereço fica como texto.
- Rodapé do painel: "Segue o seu nível de acesso. Ações no Trello e no Drive pedem a sua confirmação. A conversa some ao recarregar a página."
- Recarregar a página com uma proposta pendente: ela some da tela e expira sozinha em 15 minutos (nada é executado).

Admin › Integrações não muda, exceto a nota do Trello e do Drive: o token do Trello precisa de **leitura e escrita no quadro**; a conta de serviço, **Editor** na pasta raiz (já era assim).

## 9. Abordagens

**Como confirmar uma ação**
1. **Proposta gravada no banco, executada por uma Server Action própria (escolhida).** O conteúdo a executar fica no servidor desde a proposta; o navegador só manda o id; uma vez só, com prazo, só por quem pediu, auditada. Custa duas tabelas e migrações.
2. Proposta devolvida ao navegador com assinatura (HMAC) e reenviada na confirmação. Sem tabela, mas exige um segredo novo, não impede executar duas vezes sem guardar estado, e a auditoria perde a proposta.
3. A própria conversa confirma ("sim, pode fazer") e o modelo executa na volta seguinte. Sem tela nova, mas quem decide passa a ser o modelo lendo um histórico que vem do navegador e textos de cartões e arquivos: é o anti-objetivo deste desenho.

**Como executar**
1. **Na hora, pela Server Action, com resposta na tela (escolhida).** A pessoa vê o resultado; falha vira mensagem.
2. Pela fila `integracao_envios`, com repetição. Reaproveita a fila, mas a pessoa não vê o resultado na conversa e a repetição duplica comentário e upload.

**Como ler PDF**
1. **Extrair o texto no servidor com `unpdf` e mascarar (escolhida).** É o que a decisão 4 pede: só texto, com máscara. Dependência nova (versão fixada; 2.2.2 em 25/11/2026), usada só em `drive_ler_arquivo`.
2. Mandar o PDF inteiro ao modelo como documento. Lê tabelas e escaneados melhor, mas o arquivo vai sem máscara: contraria a decisão 4.
3. Converter no Google (cópia como Google Docs) e exportar. Sem dependência, mas cria arquivos no Drive do cliente a cada leitura.

## 10. Testes e verificação

- Domínio (puro): nomes válidos de arquivo e pasta; data do prazo em Cuiabá → UTC; montagem do título e das linhas de cada ação; busca sem acento; link clicável só dos três domínios.
- Integração (banco local + `Buscar` falso para Trello e Drive + provedor de IA falso, como hoje): cada ferramenta de leitura (campos, limites, máscara, fora do alcance = inexistente); cada ação nos caminhos proposta → confirmar → `feita` com auditoria, cancelar, expirar, confirmar duas vezes ao mesmo tempo (uma executa), confirmar de outra pessoa, falha do serviço → `falhou`; alcance reconferido na execução; anexo (tipo pelos bytes, 5 MB, de outra pessoa, vencido, removido depois do upload); ferramentas ausentes com a integração desligada; RLS das duas tabelas.
- Na tela (build local com chave de IA **falsa**): o cartão de confirmação nos quatro estados, o clipe e a etiqueta do arquivo, em 1440 e 390 de largura. Para isso, `TRELLO_API_URL`, `DRIVE_API_URL` e `GOOGLE_TOKEN_URL` (novas) e o `ANTHROPIC_BASE_URL` que o SDK já lê apontam para um servidor falso local; **as três novas só são aceitas quando o endereço é de loopback** (`127.0.0.1`, `localhost`, `[::1]`); qualquer outro valor é ignorado e vale o endereço oficial.
- O primeiro uso real continua sendo o "Testar conexão" de cada integração e, depois, um comentário de teste num cartão de viagem de teste: entra no checklist do HANDOFF §8.6.

## 11. Para o Mateus conferir (decisões minhas)

1. (Resolvido pelo Mateus em 25/11/2026: os cinco perfis leem "Uso interno" pelo chat.) Os cinco perfis também propõem ações.
2. Cartão avulso pode ser criado em qualquer lista do quadro (é a única ação fora de uma viagem).
3. Comentário sai com "[Nome, pelo sistema]" na frente, porque o Trello mostra todos como a mesma conta (a do token).
4. Proposta vale 15 minutos; anexo no chat, 60 minutos; até 3 ações por pergunta e 3 anexos por conversa.
5. Anexo no chat: PDF, PNG ou JPEG até 5 MB (limites do bucket e do upload que já existem).
6. Ação que falha não repete sozinha.
7. Voz e leitura do arquivo anexado ficam para depois.

## 12. O que fica para quem implementa

- `shell.tsx` passa ao `ChatIA` duas props novas (Trello ligado, Drive ligado), lidas no servidor.
- Onde cada função mora (`src/server/integracoes/trello.ts` e `drive.ts` ganham os métodos de leitura e escrita; as ferramentas ficam em `src/server/ia/`), nomes internos, e como o `http.chamar` baixa bytes (hoje só lê JSON).
- Parâmetros exatos das chamadas (`fields`, `filter`, paginação), respeitando os limites de §5.
- A forma do cartão de confirmação dentro do estilo do painel atual.
