import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { chaveRoteiro, chaveVenda, descricaoDoCartao, nomeDoCartao } from "@/domain/trello";
import { formatarCodigoViagem } from "@/domain/viagens";
import type { Transacao } from "@/server/db/client";
import { clientes, pessoas, viagens } from "@/server/db/schema";
import { urlDoSite } from "@/server/site";
import { estadoIntegracao } from "./config";
import { inserirEnvio, processarDepois, type EventoFila } from "./fila";
import type { PayloadCartao, PayloadRoteiro } from "./trello";

// Eventos do sistema que viram envio às integrações. Rodam na transação do evento (fechar venda, aprovar roteiro);
// a chamada externa fica para depois do commit (`agendarEnvios`). Desligada: nenhuma consulta a mais.

/** Código, titular, destino e datas da viagem, lidos na transação (nada de valor nem documento). */
async function dadosDoCartao(tx: Transacao, viagemId: string) {
  const [v] = await tx
    .select({
      seq: viagens.seq,
      destino: viagens.destino,
      inicio: viagens.inicio,
      fim: viagens.fim,
      clienteId: viagens.clienteId,
      clienteCodigo: clientes.codigo,
      grupo: clientes.grupo,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
  if (!v) return null;
  const [titular] = await tx
    .select({ nome: pessoas.nome })
    .from(pessoas)
    .where(and(eq(pessoas.clienteId, v.clienteId), eq(pessoas.titular, true), isNull(pessoas.removidoEm)))
    .limit(1);
  return {
    codigo: formatarCodigoViagem(v.clienteCodigo, v.seq),
    titular: titular?.nome ?? v.grupo,
    destino: v.destino,
    inicio: v.inicio,
    fim: v.fim,
  };
}

/** Endereço do sistema para o link do cartão; sem ele (produção mal configurada), o caminho sozinho. */
function site(): string {
  try {
    return urlDoSite();
  } catch {
    return "";
  }
}

/** Envio `venda:<viagem>` (cartão + "Tarefas da venda"), sem conferir a configuração; null se a viagem não existe. */
export async function eventoCartaoDaViagem(tx: Transacao, viagemId: string, itens: string[]): Promise<EventoFila | null> {
  const dados = await dadosDoCartao(tx, viagemId);
  if (!dados) return null;
  const payload: PayloadCartao = {
    viagemId,
    nome: nomeDoCartao(dados),
    descricao: descricaoDoCartao(site(), viagemId),
    itens,
  };
  return { integracao: "trello", tipo: "cartao_viagem", viagemId, chave: chaveVenda(viagemId), payload };
}

/** Envio `roteiro:<viagem>` ("Tarefas do roteiro" no cartão da venda), sem conferir a configuração. */
export function eventoChecklistDoRoteiro(viagemId: string, itens: string[]): EventoFila {
  const payload: PayloadRoteiro = { viagemId, itens };
  return { integracao: "trello", tipo: "checklist_roteiro", viagemId, chave: chaveRoteiro(viagemId), payload };
}

/**
 * Venda fechada: envio `venda:<viagem>` com o cartão e os itens do checklist "Tarefas da venda". Devolve o id do
 * envio criado; null se o Trello está desligado ou a viagem já tinha envio.
 */
export async function enfileirarCartaoDaViagem(tx: Transacao, viagemId: string, itens: string[]): Promise<string | null> {
  if (!estadoIntegracao("trello").configurada) return null;
  const evento = await eventoCartaoDaViagem(tx, viagemId, itens);
  return evento ? inserirEnvio(tx, evento) : null;
}

/**
 * Roteiro aprovado: envio `roteiro:<viagem>` com o checklist "Tarefas do roteiro" no cartão da venda. Enquanto o
 * cartão está na fila, o processador espera sem gastar tentativa; sem cartão (ou com falha), gasta as tentativas e
 * o envio fica em Reenviar.
 */
export async function enfileirarChecklistDoRoteiro(tx: Transacao, viagemId: string, itens: string[]): Promise<string | null> {
  if (!estadoIntegracao("trello").configurada) return null;
  return inserirEnvio(tx, eventoChecklistDoRoteiro(viagemId, itens));
}

/** Depois do commit do evento: manda o que entrou na fila. Nunca lança (o evento já está gravado; o cron repete). */
export function agendarEnvios(): void {
  try {
    processarDepois();
  } catch (e) {
    const codigo = (e as { code?: unknown } | null)?.code;
    console.error(`[integracoes] não agendou os envios: ${typeof codigo === "string" ? codigo : e instanceof Error ? e.name : "desconhecido"}`);
  }
}
