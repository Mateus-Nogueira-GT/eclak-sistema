import "server-only";
import { z } from "zod";
import { semAcento } from "@/domain/chat-acoes";
import { protegerTexto } from "@/domain/ia-privacidade";
import { TIMEOUT_MS } from "@/domain/integracoes";
import { configTrello } from "@/server/integracoes/config";
import { ErroIntegracao } from "@/server/integracoes/http";
import type { FerramentaIA } from "@/server/integracoes/ia";
import { clienteTrello } from "@/server/integracoes/trello";
import { codigosPorCartao, refsDaViagem, viagemDoCartao } from "./alcance";
import { ERRO_DO_SERVICO } from "./erros-servico";
import type { ContextoFerramenta, ResultadoExecucaoFerramenta } from "./ferramentas";

// Ferramentas de leitura do Trello (spec §5). Todo texto livre passa por `protegerTexto` campo a campo com os
// conhecidos do sistema (R-A3, R-A4); `id` e `link` nunca passam pela máscara.

const MAX_CARTOES = 30;
const MAX_DESCRICAO = 4000;
const MAX_COMENTARIO = 1000;
const CODIGO_VIAGEM_RE = /^ECL-\d+-\d+$/i;
const LINK_VIAGEM_UUID_RE =
  /(?:Viagem no sistema:\s*)?(?:https?:\/\/[^\s]+)?\/viagens\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export const FERRAMENTAS_LEITURA_TRELLO: FerramentaIA[] = [
  {
    name: "trello_listas",
    description: "Listas abertas do quadro configurado no Trello, com a quantidade de cartões abertos em cada uma.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "trello_buscar_cartoes",
    description:
      `Busca cartões abertos do quadro configurado no Trello por parte do nome (sem acento) e/ou por lista (id ou nome). ` +
      `Passe "" nos filtros que não quiser usar. Devolve até ${MAX_CARTOES} cartões e o total.`,
    input_schema: {
      type: "object",
      properties: {
        busca: { type: "string", description: 'Trecho do nome do cartão ou "" para sem filtro.' },
        lista: { type: "string", description: 'Id ou nome da lista ou "" para todas as listas.' },
      },
      required: ["busca", "lista"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "trello_cartao",
    description:
      "Detalhes de um cartão do quadro do Trello (descrição, checklists com itens e os 20 comentários mais recentes). " +
      "Aceita o código da viagem (ECL-0001-01) ou o id do cartão.",
    input_schema: {
      type: "object",
      properties: {
        cartao: { type: "string", description: "Código da viagem (ECL-0001-01) ou id do cartão no Trello." },
      },
      required: ["cartao"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export const FERRAMENTAS_ACAO_TRELLO: FerramentaIA[] = [
  {
    name: "trello_comentar",
    description:
      "Propõe publicar um comentário num cartão de viagem do sistema no Trello (a pessoa confirma na tela antes de publicar). Nunca inclua custo, margem ou comissão.",
    input_schema: {
      type: "object",
      properties: {
        cartao: { type: "string", description: "Código da viagem (ECL-0001-01) ou id do cartão de viagem." },
        texto: { type: "string", description: "Texto do comentário (1 a 2.000 caracteres)." },
      },
      required: ["cartao", "texto"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "trello_marcar_item",
    description: "Propõe marcar ou desmarcar um item de checklist de um cartão de viagem no Trello.",
    input_schema: {
      type: "object",
      properties: {
        cartao: { type: "string", description: "Código da viagem ou id do cartão de viagem." },
        item: { type: "string", description: "Id do item do checklist." },
        feito: { type: "boolean", description: "true para marcar concluído, false para desmarcar." },
      },
      required: ["cartao", "item", "feito"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "trello_adicionar_item",
    description: "Propõe adicionar um novo item a um checklist de um cartão de viagem no Trello.",
    input_schema: {
      type: "object",
      properties: {
        cartao: { type: "string", description: "Código da viagem ou id do cartão de viagem." },
        checklist: { type: "string", description: "Id do checklist no cartão." },
        nome: { type: "string", description: "Nome do novo item (1 a 200 caracteres)." },
      },
      required: ["cartao", "checklist", "nome"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "trello_mover_cartao",
    description: "Propõe mover um cartão de viagem para outra lista aberta do mesmo quadro no Trello.",
    input_schema: {
      type: "object",
      properties: {
        cartao: { type: "string", description: "Código da viagem ou id do cartão de viagem." },
        lista: { type: "string", description: "Id da lista de destino no quadro." },
      },
      required: ["cartao", "lista"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "trello_definir_prazo",
    description: 'Propõe definir ou remover o prazo de um cartão de viagem no Trello. Passe "AAAA-MM-DD" ou "" para remover.',
    input_schema: {
      type: "object",
      properties: {
        cartao: { type: "string", description: "Código da viagem ou id do cartão de viagem." },
        prazo: { type: "string", description: 'Data no formato AAAA-MM-DD ou "" para remover o prazo.' },
      },
      required: ["cartao", "prazo"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "trello_criar_cartao",
    description:
      'Propõe criar um cartão avulso em qualquer lista aberta do quadro configurado no Trello. Passe lista "" para usar a lista padrão.',
    input_schema: {
      type: "object",
      properties: {
        lista: { type: "string", description: 'Id da lista ou "" para a lista configurada.' },
        nome: { type: "string", description: "Título do cartão (1 a 200 caracteres)." },
        descricao: { type: "string", description: 'Descrição do cartão (até 2.000 caracteres) ou "".' },
      },
      required: ["lista", "nome", "descricao"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const ENTRADAS = {
  trello_listas: z.object({}).strict(),
  trello_buscar_cartoes: z
    .object({
      busca: z.string().trim().max(200),
      lista: z.string().trim().max(200),
    })
    .strict(),
  trello_cartao: z.object({ cartao: z.string().trim().min(1).max(200) }).strict(),
};

export function ehLeituraTrello(nome: string): nome is keyof typeof ENTRADAS {
  return nome in ENTRADAS;
}

function timeoutDe(prazoAte: number): number | null {
  const restante = prazoAte - Date.now();
  return restante < 1000 ? null : Math.min(TIMEOUT_MS, restante);
}

export async function executarLeituraTrello(
  nome: keyof typeof ENTRADAS,
  entrada: unknown,
  ctx: ContextoFerramenta,
): Promise<ResultadoExecucaoFerramenta> {
  const cfg = configTrello();
  if (!cfg) return { conteudo: `Ferramenta ${nome} não está disponível.`, erro: true };
  const v = ENTRADAS[nome].safeParse(entrada);
  if (!v.success) return { conteudo: `Entrada inválida para ${nome}.`, erro: true };
  const timeoutMs = timeoutDe(ctx.prazoAte);
  if (timeoutMs === null) return { conteudo: "O tempo da resposta está no fim. Tente uma pergunta mais específica.", erro: true };

  const prot = (s: string) => protegerTexto(s, ctx.conhecidos);
  const cli = clienteTrello(cfg, ctx.buscar, { timeoutMs });

  try {
    if (nome === "trello_listas") {
      const [listas, cartoes] = await Promise.all([cli.listas(), cli.cartoes()]);
      const contagem = new Map<string, number>();
      for (const c of cartoes) contagem.set(c.listaId, (contagem.get(c.listaId) ?? 0) + 1);
      return {
        conteudo: JSON.stringify({
          listas: listas.map((l) => ({
            id: l.id,
            nome: prot(l.nome),
            cartoes: contagem.get(l.id) ?? 0,
          })),
        }),
        erro: false,
      };
    }

    if (nome === "trello_buscar_cartoes") {
      const { busca, lista } = v.data as { busca: string; lista: string };
      const [listas, cartoes, mapaViagens] = await Promise.all([cli.listas(), cli.cartoes(), codigosPorCartao()]);
      const nomeDaLista = new Map(listas.map((l) => [l.id, l.nome]));
      const buscaNorm = semAcento(busca);
      const listaNorm = semAcento(lista);
      const filtrados = cartoes.filter((c) => {
        if (listaNorm) {
          const nomeL = nomeDaLista.get(c.listaId) ?? "";
          if (c.listaId !== lista && semAcento(nomeL) !== listaNorm) return false;
        }
        if (buscaNorm && !semAcento(c.nome).includes(buscaNorm)) return false;
        return true;
      });
      return {
        conteudo: JSON.stringify({
          total: filtrados.length,
          cartoes: filtrados.slice(0, MAX_CARTOES).map((c) => ({
            id: c.id,
            nome: prot(c.nome),
            lista: prot(nomeDaLista.get(c.listaId) ?? ""),
            prazo: c.prazo,
            concluido: c.concluido,
            link: c.link,
            viagem: mapaViagens.get(c.id) ?? null,
          })),
        }),
        erro: false,
      };
    }

    // trello_cartao
    const { cartao } = v.data as { cartao: string };
    let cartaoId = cartao;
    let viagem: string | null = null;
    if (CODIGO_VIAGEM_RE.test(cartao)) {
      const refs = await refsDaViagem(cartao);
      if (!refs?.cartaoId) return { conteudo: "Cartão não encontrado.", erro: true };
      cartaoId = refs.cartaoId;
      viagem = refs.codigo;
    } else {
      const refs = await viagemDoCartao(cartao);
      viagem = refs?.codigo ?? null;
    }

    const [detalhe, listas] = await Promise.all([cli.cartao(cartaoId), cli.listas()]);
    if (!detalhe) return { conteudo: "Cartão não encontrado.", erro: true };
    const nomeLista = listas.find((l) => l.id === detalhe.listaId)?.nome ?? "";
    const descLimpa = detalhe.descricao.replace(LINK_VIAGEM_UUID_RE, "").trim();

    return {
      conteudo: JSON.stringify({
        id: detalhe.id,
        nome: prot(detalhe.nome),
        lista: prot(nomeLista),
        prazo: detalhe.prazo,
        concluido: detalhe.concluido,
        link: detalhe.link,
        viagem,
        descricao: prot(descLimpa).slice(0, MAX_DESCRICAO),
        checklists: detalhe.checklists.map((k) => ({
          id: k.id,
          nome: prot(k.nome),
          itens: k.itens.map((it) => ({ id: it.id, nome: prot(it.nome), feito: it.feito })),
        })),
        comentarios: detalhe.comentarios.slice(0, 20).map((cm) => ({
          autor: prot(cm.autor),
          data: cm.data,
          texto: prot(cm.texto).slice(0, MAX_COMENTARIO),
        })),
      }),
      erro: false,
    };
  } catch (e) {
    if (e instanceof ErroIntegracao) return { conteudo: ERRO_DO_SERVICO.trello[e.classe], erro: true };
    console.error("Erro na ferramenta do Trello", { ferramenta: nome, code: (e as { code?: string } | null)?.code });
    return { conteudo: ERRO_DO_SERVICO.trello.servidor, erro: true };
  }
}
