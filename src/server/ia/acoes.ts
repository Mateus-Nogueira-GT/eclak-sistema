import "server-only";
import { and, eq, gt, isNull } from "drizzle-orm";
import { tamanhoLegivel } from "@/domain/anexos";
import {
  ENTRADAS_ACAO,
  linhasDaAcao,
  MAX_PROPOSTAS_POR_PERGUNTA,
  nomeNoDrive,
  prazoParaUtc,
  TIPOS_ACAO_CHAT,
  tituloDaAcao,
  VALIDADE_PROPOSTA_MIN,
  type Proposta,
  type TipoAcaoChat,
} from "@/domain/chat-acoes";
import { dataEmCuiaba } from "@/domain/clientes";
import { protegerTexto } from "@/domain/ia-privacidade";
import { linkHttps, TIMEOUT_MS } from "@/domain/integracoes";
import { PERFIS_VALORES, type Perfil } from "@/domain/perfis";
import { ehUuid } from "@/server/acesso";
import { db } from "@/server/db/client";
import { chatAcoes, chatAnexos, usuarios, type ChatAcao } from "@/server/db/schema";
import { configDrive, configTrello } from "@/server/integracoes/config";
import { clienteDrive, MIME_PASTA, type ClienteDrive, type ItemDrive } from "@/server/integracoes/drive";
import { ErroIntegracao, type Buscar } from "@/server/integracoes/http";
import { clienteTrello, type CartaoDetalhe } from "@/server/integracoes/trello";
import { descendeDe, refsDaViagem, refsDaViagemPorId, viagemDoCartao, viagemDoItem, type RefsDaViagem } from "./alcance";
import { ERRO_DO_SERVICO } from "./erros-servico";
import type { ContextoFerramenta } from "./ferramentas";

// Propostas de ação do agente do chat (spec §6.1 e §6.2). NENHUMA chamada externa de escrita acontece aqui:
// `proporAcao` valida a entrada, confere o alcance (R-A2), lê os nomes reais, protege texto livre (R-A3) e grava
// uma linha `pendente` em `chat_acoes`. A execução só acontece em `confirmarAcaoChat` (Task 8).

export const PERFIS_ACAO_CHAT: readonly Perfil[] = [...PERFIS_VALORES];

export const MSG_PROPOSTA_REGISTRADA = "Proposta registrada. Nada foi executado: a pessoa precisa confirmar na tela.";

const CODIGO_VIAGEM_RE = /^ECL-\d+-\d+$/i;

export function ehTipoAcaoChat(nome: string): nome is TipoAcaoChat {
  return (TIPOS_ACAO_CHAT as readonly string[]).includes(nome);
}

function formatarDataBr(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

function timeoutDe(prazoAte: number): number | null {
  const restante = prazoAte - Date.now();
  return restante < 1000 ? null : Math.min(TIMEOUT_MS, restante);
}

function ehPastaDoSistema(refs: RefsDaViagem, itemId: string): boolean {
  return itemId === refs.pastaId || itemId === refs.publicaId || itemId === refs.internaId;
}

const EXT_POR_MIME: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
};
const EXT_CONHECIDA_RE = /\.(pdf|png|jpe?g|gif|webp|txt|csv|docx?|xlsx?)$/i;

/** Garante que o nome do arquivo enviado termine na extensão do tipo conferido pelos bytes (spec §6.2). */
function garantirExtensao(nome: string, mime: string): string {
  const permitidas = EXT_POR_MIME[mime];
  if (!permitidas) return nome;
  const baixo = nome.toLowerCase();
  if (permitidas.some((e) => baixo.endsWith(e))) return nome;
  const padrao = permitidas[0];
  const base = EXT_CONHECIDA_RE.test(nome) ? nome.replace(EXT_CONHECIDA_RE, "") : nome;
  return `${base || "arquivo"}${padrao}`;
}

async function resolverPastaDaViagem(
  drive: ClienteDrive,
  raizId: string,
  refs: RefsDaViagem,
  destino: string,
  permiteRaizDaViagem: boolean,
  cache: Map<string, ItemDrive | null>,
): Promise<{ id: string; nome: string } | { erro: string }> {
  if (!refs.pastaId) return { erro: "Esta viagem não tem pasta no Google Drive." };
  if (!(await descendeDe(drive, refs.pastaId, raizId, cache))) {
    return { erro: "A pasta desta viagem não está mais na pasta raiz do Drive." };
  }
  let alvoId: string | null = null;
  let nomePadrao: string | null = null;
  if (destino === "publico") {
    alvoId = refs.publicaId;
    nomePadrao = "Público";
  } else if (destino === "interno") {
    alvoId = refs.internaId;
    nomePadrao = "Uso interno";
  } else if (permiteRaizDaViagem && destino === "raiz_da_viagem") {
    alvoId = refs.pastaId;
    nomePadrao = "Pasta da viagem";
  } else {
    alvoId = destino;
  }
  if (!alvoId) return { erro: "Pasta de destino não encontrada nesta viagem." };
  if (!(await descendeDe(drive, alvoId, refs.pastaId, cache))) {
    return { erro: "Pasta de destino não pertence a esta viagem." };
  }
  const item = cache.get(alvoId) ?? (await drive.obter(alvoId));
  cache.set(alvoId, item);
  if (!item || item.mime !== MIME_PASTA) return { erro: "Pasta de destino não encontrada nesta viagem." };
  return { id: item.id, nome: item.nome || nomePadrao || "" };
}

export async function proporAcao(
  ctx: ContextoFerramenta,
  tipo: TipoAcaoChat,
  entrada: unknown,
): Promise<{ proposta: Proposta } | { erro: string }> {
  if ((ctx.propostasNaPergunta ?? 0) >= MAX_PROPOSTAS_POR_PERGUNTA) {
    return { erro: "Limite de 3 ações propostas por pergunta atingido." };
  }
  const v = ENTRADAS_ACAO[tipo].safeParse(entrada);
  if (!v.success) return { erro: `Entrada inválida para ${tipo}.` };

  const timeoutMs = timeoutDe(ctx.prazoAte);
  if (timeoutMs === null) return { erro: "O tempo da resposta está no fim. Tente uma pergunta mais específica." };

  const prot = (s: string) => protegerTexto(s, ctx.conhecidos);
  const ehTrello = tipo.startsWith("trello_");

  try {
    let viagemId: string | null = null;
    let alvo: Record<string, unknown> = {};
    let dados: Record<string, unknown> = {};

    if (ehTrello) {
      const cfg = configTrello();
      if (!cfg) return { erro: "O Trello não está configurado." };
      const trello = clienteTrello(cfg, ctx.buscar, { timeoutMs });

      const resolverCartao = async (
        cartaoInput: string,
      ): Promise<{ refs: RefsDaViagem; card: CartaoDetalhe } | { erro: string }> => {
        let refs: RefsDaViagem | null;
        if (CODIGO_VIAGEM_RE.test(cartaoInput)) {
          refs = await refsDaViagem(cartaoInput);
          if (!refs) return { erro: "Viagem não encontrada." };
          if (!refs.cartaoId) return { erro: "Esta viagem não tem cartão no Trello." };
        } else {
          refs = await viagemDoCartao(cartaoInput);
          if (!refs?.cartaoId) return { erro: "Só altero cartões de viagens do sistema" };
        }
        const card = await trello.cartao(refs.cartaoId);
        if (!card) return { erro: "Cartão não encontrado." };
        return { refs, card };
      };

      if (tipo === "trello_comentar") {
        const d = v.data as { cartao: string; texto: string };
        const res = await resolverCartao(d.cartao);
        if ("erro" in res) return res;
        viagemId = res.refs.viagemId;
        alvo = { cartaoId: res.card.id, cartao: prot(res.card.nome), link: res.card.link, viagem: res.refs.codigo };
        dados = { texto: prot(d.texto) };
      } else if (tipo === "trello_marcar_item") {
        const d = v.data as { cartao: string; item: string; feito: boolean };
        const res = await resolverCartao(d.cartao);
        if ("erro" in res) return res;
        let achado: { chkId: string; chkNome: string; itemId: string; itemNome: string } | null = null;
        for (const chk of res.card.checklists) {
          const it = chk.itens.find((x) => x.id === d.item);
          if (it) {
            achado = { chkId: chk.id, chkNome: chk.nome, itemId: it.id, itemNome: it.nome };
            break;
          }
        }
        if (!achado) return { erro: "Item de checklist não encontrado neste cartão." };
        viagemId = res.refs.viagemId;
        alvo = {
          cartaoId: res.card.id,
          cartao: prot(res.card.nome),
          checklistId: achado.chkId,
          checklist: prot(achado.chkNome),
          itemId: achado.itemId,
          item: prot(achado.itemNome),
          link: res.card.link,
          viagem: res.refs.codigo,
        };
        dados = { feito: d.feito };
      } else if (tipo === "trello_adicionar_item") {
        const d = v.data as { cartao: string; checklist: string; nome: string };
        const res = await resolverCartao(d.cartao);
        if ("erro" in res) return res;
        const chk = res.card.checklists.find((x) => x.id === d.checklist);
        if (!chk) return { erro: "Checklist não encontrado neste cartão." };
        viagemId = res.refs.viagemId;
        alvo = {
          cartaoId: res.card.id,
          cartao: prot(res.card.nome),
          checklistId: chk.id,
          checklist: prot(chk.nome),
          link: res.card.link,
          viagem: res.refs.codigo,
        };
        dados = { nome: prot(d.nome) };
      } else if (tipo === "trello_mover_cartao") {
        const d = v.data as { cartao: string; lista: string };
        const res = await resolverCartao(d.cartao);
        if ("erro" in res) return res;
        const listas = await trello.listas();
        const destino = listas.find((l) => l.id === d.lista);
        if (!destino) return { erro: "Lista não encontrada no quadro." };
        const origem = listas.find((l) => l.id === res.card.listaId)?.nome ?? "";
        viagemId = res.refs.viagemId;
        alvo = {
          cartaoId: res.card.id,
          cartao: prot(res.card.nome),
          deListaId: res.card.listaId,
          de: prot(origem),
          listaId: destino.id,
          para: prot(destino.nome),
          link: res.card.link,
          viagem: res.refs.codigo,
        };
        dados = { listaId: destino.id };
      } else if (tipo === "trello_definir_prazo") {
        const d = v.data as { cartao: string; prazo: string };
        const res = await resolverCartao(d.cartao);
        if ("erro" in res) return res;
        const prazoAtual = res.card.prazo ? formatarDataBr(dataEmCuiaba(new Date(res.card.prazo))) : "";
        viagemId = res.refs.viagemId;
        alvo = {
          cartaoId: res.card.id,
          cartao: prot(res.card.nome),
          prazoAtual,
          link: res.card.link,
          viagem: res.refs.codigo,
        };
        dados = { prazo: d.prazo };
      } else if (tipo === "trello_criar_cartao") {
        const d = v.data as { lista: string; nome: string; descricao: string };
        const listas = await trello.listas();
        const listaId = d.lista || cfg.listaId;
        const listaObj = listas.find((l) => l.id === listaId);
        if (!listaObj) return { erro: "Lista não encontrada no quadro." };
        viagemId = null;
        alvo = { listaId: listaObj.id, lista: prot(listaObj.nome) };
        dados = { nome: prot(d.nome), descricao: prot(d.descricao) };
      }
    } else {
      const cfg = configDrive();
      if (!cfg) return { erro: "O Google Drive não está configurado." };
      const drive = clienteDrive(cfg, ctx.buscar, { timeoutMs });
      const cache = new Map<string, ItemDrive | null>();

      if (tipo === "drive_enviar_arquivo") {
        const d = v.data as { viagem: string; anexo: string; destino: string; nome?: string };
        const refs = await refsDaViagem(d.viagem);
        if (!refs) return { erro: "Viagem não encontrada." };
        if (!ehUuid(d.anexo)) return { erro: "Anexo não encontrado ou expirado." };
        const [anexo] = await db
          .select()
          .from(chatAnexos)
          .where(
            and(
              eq(chatAnexos.id, d.anexo),
              eq(chatAnexos.usuarioId, ctx.usuario.id),
              isNull(chatAnexos.usadoEm),
              gt(chatAnexos.expiraEm, new Date()),
            ),
          )
          .limit(1);
        if (!anexo) return { erro: "Anexo não encontrado ou expirado." };
        const pasta = await resolverPastaDaViagem(drive, cfg.pastaRaizId, refs, d.destino, false, cache);
        if ("erro" in pasta) return pasta;
        const baseBruta = d.nome && d.nome.trim() !== "" ? nomeNoDrive(d.nome) : nomeNoDrive(anexo.nome);
        const nomeProtegido = nomeNoDrive(prot(baseBruta ?? "arquivo"));
        if (!nomeProtegido) return { erro: "Nome de arquivo inválido." };
        const nomeFinal = garantirExtensao(nomeProtegido, anexo.mime);
        viagemId = refs.viagemId;
        alvo = {
          viagem: refs.codigo,
          pastaId: pasta.id,
          pasta: prot(pasta.nome),
          anexoId: anexo.id,
          arquivo: nomeFinal,
          tamanho: tamanhoLegivel(anexo.tamanho),
        };
        dados = { anexoId: anexo.id, pastaId: pasta.id, nome: nomeFinal, mime: anexo.mime, tamanho: anexo.tamanho };
      } else if (tipo === "drive_criar_pasta") {
        const d = v.data as { viagem: string; dentroDe: string; nome: string };
        const refs = await refsDaViagem(d.viagem);
        if (!refs) return { erro: "Viagem não encontrada." };
        const dentro = await resolverPastaDaViagem(drive, cfg.pastaRaizId, refs, d.dentroDe, true, cache);
        if ("erro" in dentro) return dentro;
        const nomePasta = nomeNoDrive(prot(d.nome));
        if (!nomePasta) return { erro: "Nome de pasta inválido." };
        viagemId = refs.viagemId;
        alvo = { viagem: refs.codigo, dentroDeId: dentro.id, dentroDe: prot(dentro.nome) };
        dados = { paiId: dentro.id, nome: nomePasta };
      } else if (tipo === "drive_renomear") {
        const d = v.data as { arquivo: string; nome: string };
        const item = await drive.obter(d.arquivo);
        cache.set(d.arquivo, item);
        if (!item || !(await descendeDe(drive, item.id, cfg.pastaRaizId, cache))) {
          return { erro: "Arquivo ou pasta não encontrado." };
        }
        const refs = await viagemDoItem(drive, item.id, cache);
        if (!refs) return { erro: "Só altero arquivos dentro da pasta de uma viagem do sistema." };
        if (ehPastaDoSistema(refs, item.id)) return { erro: "As pastas padrão da viagem não podem ser renomeadas." };
        const novoNome = nomeNoDrive(prot(d.nome));
        if (!novoNome) return { erro: "Nome inválido." };
        viagemId = refs.viagemId;
        alvo = { viagem: refs.codigo, arquivoId: item.id, arquivo: prot(item.nome), link: item.link };
        dados = { arquivoId: item.id, nome: novoNome };
      } else if (tipo === "drive_mover") {
        const d = v.data as { arquivo: string; destino: string };
        const item = await drive.obter(d.arquivo);
        cache.set(d.arquivo, item);
        if (!item || !(await descendeDe(drive, item.id, cfg.pastaRaizId, cache))) {
          return { erro: "Arquivo ou pasta não encontrado." };
        }
        const refs = await viagemDoItem(drive, item.id, cache);
        if (!refs) return { erro: "Só movo arquivos dentro da pasta de uma viagem do sistema." };
        if (ehPastaDoSistema(refs, item.id)) return { erro: "As pastas padrão da viagem não podem ser movidas." };
        const destino = await resolverPastaDaViagem(drive, cfg.pastaRaizId, refs, d.destino, false, cache);
        if ("erro" in destino) return destino;
        if (item.mime === MIME_PASTA && (await descendeDe(drive, destino.id, item.id, cache))) {
          return { erro: "Não é possível mover uma pasta para dentro dela mesma." };
        }
        const deId = item.pais[0];
        if (!deId) return { erro: "Não foi possível identificar a pasta atual do item." };
        const paiAtual = cache.get(deId) ?? (await drive.obter(deId));
        cache.set(deId, paiAtual);
        viagemId = refs.viagemId;
        alvo = {
          viagem: refs.codigo,
          arquivoId: item.id,
          arquivo: prot(item.nome),
          deId,
          de: prot(paiAtual?.nome ?? ""),
          paraId: destino.id,
          para: prot(destino.nome),
          link: item.link,
        };
        dados = { arquivoId: item.id, deId, paraId: destino.id };
      }
    }

    const expiraEm = new Date(Date.now() + VALIDADE_PROPOSTA_MIN * 60_000);
    const [linha] = await db
      .insert(chatAcoes)
      .values({
        usuarioId: ctx.usuario.id,
        tipo,
        viagemId,
        alvo,
        dados,
        expiraEm,
      })
      .returning({ id: chatAcoes.id, expiraEm: chatAcoes.expiraEm });

    const alvoStr: Record<string, string> = {};
    for (const [k, val] of Object.entries(alvo)) {
      if (typeof val === "string") alvoStr[k] = val;
    }
    return {
      proposta: {
        id: linha.id,
        titulo: tituloDaAcao(tipo),
        linhas: linhasDaAcao(tipo, alvoStr, dados),
        expiraEm: linha.expiraEm.toISOString(),
      },
    };
  } catch (e) {
    if (e instanceof ErroIntegracao) {
      return { erro: ERRO_DO_SERVICO[ehTrello ? "trello" : "drive"][e.classe] };
    }
    console.error("Erro ao propor ação no chat", { tipo, code: (e as { code?: string } | null)?.code });
    return { erro: ERRO_DO_SERVICO[ehTrello ? "trello" : "drive"].servidor };
  }
}

/** Falha de alcance, alvo ausente ou integração desligada ao reconferir na execução (R-A2). */
export class ErroAlcance extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ErroAlcance";
  }
}

const strCampo = (obj: Record<string, unknown>, k: string): string | null => {
  const v = obj[k];
  return typeof v === "string" && v !== "" ? v : null;
};

const CHAVES_ALVO_AUDITORIA = [
  "cartao",
  "checklist",
  "item",
  "de",
  "para",
  "lista",
  "viagem",
  "pasta",
  "dentroDe",
  "arquivo",
  "tamanho",
  "prazoAtual",
] as const;

/** Extrai só os nomes seguros do alvo para auditoria e montagem do resumo (nunca texto livre de dados). */
export function nomesDoAlvo(alvo: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHAVES_ALVO_AUDITORIA) {
    const v = alvo[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Executa uma proposta já tomada (`executando`) fora de transação. Reconfere integração ligada e alcance (R-A2)
 * antes de qualquer escrita externa. Lança `ErroAlcance` ou `ErroIntegracao`.
 */
export async function executarAcao(
  acao: ChatAcao,
  buscar: Buscar,
  usuarioNome?: string,
): Promise<{ link: string | null }> {
  const alvo = (acao.alvo ?? {}) as Record<string, unknown>;
  const dados = (acao.dados ?? {}) as Record<string, unknown>;

  if (acao.tipo.startsWith("trello_")) {
    const cfg = configTrello();
    if (!cfg) throw new ErroAlcance("O Trello não está configurado.");
    const trello = clienteTrello(cfg, buscar);

    if (acao.tipo === "trello_criar_cartao") {
      const listaId = strCampo(alvo, "listaId");
      const listas = await trello.listas();
      if (!listaId || !listas.some((l) => l.id === listaId)) {
        throw new ErroAlcance("A lista de destino não existe mais no quadro.");
      }
      const criado = await trello.criarCartaoEm(listaId, {
        nome: typeof dados.nome === "string" ? dados.nome : "",
        descricao: typeof dados.descricao === "string" ? dados.descricao : "",
      });
      return { link: linkHttps(criado.url) };
    }

    const refs = acao.viagemId ? await refsDaViagemPorId(acao.viagemId) : null;
    const cartaoId = strCampo(alvo, "cartaoId");
    if (!refs || !refs.cartaoId || !cartaoId || refs.cartaoId !== cartaoId) {
      throw new ErroAlcance("A viagem ou o cartão não está mais disponível.");
    }
    const card = await trello.cartao(cartaoId);
    if (!card) throw new ErroAlcance("O cartão não foi encontrado no quadro configurado.");

    if (acao.tipo === "trello_comentar") {
      let nome = usuarioNome;
      if (!nome) {
        const [u] = await db.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, acao.usuarioId)).limit(1);
        nome = u?.nome ?? "Equipe";
      }
      const texto = typeof dados.texto === "string" ? dados.texto : "";
      await trello.comentar(cartaoId, `[${nome}, pelo sistema] ${texto}`);
    } else if (acao.tipo === "trello_marcar_item") {
      const itemId = strCampo(alvo, "itemId");
      if (!itemId || !card.checklists.some((k) => k.itens.some((it) => it.id === itemId))) {
        throw new ErroAlcance("O item do checklist não está mais neste cartão.");
      }
      await trello.marcarItem(cartaoId, itemId, Boolean(dados.feito));
    } else if (acao.tipo === "trello_adicionar_item") {
      const checklistId = strCampo(alvo, "checklistId");
      if (!checklistId || !card.checklists.some((k) => k.id === checklistId)) {
        throw new ErroAlcance("O checklist não está mais neste cartão.");
      }
      await trello.adicionarItem(checklistId, typeof dados.nome === "string" ? dados.nome : "");
    } else if (acao.tipo === "trello_mover_cartao") {
      const listaId = strCampo(dados, "listaId") ?? strCampo(alvo, "listaId");
      const listas = await trello.listas();
      if (!listaId || !listas.some((l) => l.id === listaId)) {
        throw new ErroAlcance("A lista de destino não existe mais no quadro.");
      }
      await trello.atualizarCartao(cartaoId, { idList: listaId });
    } else if (acao.tipo === "trello_definir_prazo") {
      const prazo = typeof dados.prazo === "string" ? dados.prazo : "";
      await trello.atualizarCartao(cartaoId, { due: prazo ? prazoParaUtc(prazo) : null });
    }

    return { link: linkHttps(card.link) };
  }

  // Drive
  const cfg = configDrive();
  if (!cfg) throw new ErroAlcance("O Google Drive não está configurado.");
  const drive = clienteDrive(cfg, buscar);
  const cache = new Map<string, ItemDrive | null>();

  const refs = acao.viagemId ? await refsDaViagemPorId(acao.viagemId) : null;
  if (!refs?.pastaId || !(await descendeDe(drive, refs.pastaId, cfg.pastaRaizId, cache))) {
    throw new ErroAlcance("A viagem ou a pasta não está mais disponível no Drive.");
  }

  if (acao.tipo === "drive_criar_pasta") {
    const paiId = strCampo(dados, "paiId") ?? strCampo(alvo, "dentroDeId");
    if (!paiId || !(await descendeDe(drive, paiId, refs.pastaId, cache))) {
      throw new ErroAlcance("A pasta de destino não pertence mais a esta viagem.");
    }
    const pai = cache.get(paiId) ?? (await drive.obter(paiId));
    if (!pai || pai.mime !== MIME_PASTA) throw new ErroAlcance("A pasta de destino não foi encontrada.");
    const criada = await drive.criarPasta(typeof dados.nome === "string" ? dados.nome : "", paiId);
    return { link: linkHttps(criada.link) };
  }

  if (acao.tipo === "drive_renomear") {
    const arquivoId = strCampo(dados, "arquivoId") ?? strCampo(alvo, "arquivoId");
    if (!arquivoId || ehPastaDoSistema(refs, arquivoId)) {
      throw new ErroAlcance("Este item não pode ser renomeado.");
    }
    const item = await drive.obter(arquivoId);
    cache.set(arquivoId, item);
    if (!item || !(await descendeDe(drive, item.id, refs.pastaId, cache))) {
      throw new ErroAlcance("O arquivo não foi encontrado na pasta da viagem.");
    }
    await drive.renomear(item.id, typeof dados.nome === "string" ? dados.nome : "");
    return { link: linkHttps(item.link) };
  }

  if (acao.tipo === "drive_mover") {
    const arquivoId = strCampo(dados, "arquivoId") ?? strCampo(alvo, "arquivoId");
    const paraId = strCampo(dados, "paraId") ?? strCampo(alvo, "paraId");
    if (!arquivoId || !paraId || ehPastaDoSistema(refs, arquivoId)) {
      throw new ErroAlcance("Este item não pode ser movido.");
    }
    const item = await drive.obter(arquivoId);
    cache.set(arquivoId, item);
    if (!item || !(await descendeDe(drive, item.id, refs.pastaId, cache))) {
      throw new ErroAlcance("O arquivo não foi encontrado na pasta da viagem.");
    }
    if (!(await descendeDe(drive, paraId, refs.pastaId, cache))) {
      throw new ErroAlcance("A pasta de destino não pertence mais a esta viagem.");
    }
    const destino = cache.get(paraId) ?? (await drive.obter(paraId));
    if (!destino || destino.mime !== MIME_PASTA) throw new ErroAlcance("A pasta de destino não foi encontrada.");
    if (item.mime === MIME_PASTA && (await descendeDe(drive, destino.id, item.id, cache))) {
      throw new ErroAlcance("Não é possível mover uma pasta para dentro dela mesma.");
    }
    const deId = item.pais[0];
    if (!deId) throw new ErroAlcance("Não foi possível identificar a pasta atual do item.");
    await drive.mover(item.id, deId, destino.id);
    return { link: linkHttps(item.link) };
  }

  throw new ErroAlcance("Envio de anexo não disponível.");
}
