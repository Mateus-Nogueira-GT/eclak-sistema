import "server-only";
import { z } from "zod";
import { protegerTexto } from "@/domain/ia-privacidade";
import { TIMEOUT_MS } from "@/domain/integracoes";
import { configDrive } from "@/server/integracoes/config";
import { clienteDrive, LIMITE_UPLOAD_BYTES, MIME_PASTA, type ItemDrive } from "@/server/integracoes/drive";
import { ErroIntegracao } from "@/server/integracoes/http";
import type { FerramentaIA } from "@/server/integracoes/ia";
import { textoDoPdf } from "@/server/integracoes/pdf";
import { caminhoAteARaiz, descendeDe, refsDaViagem } from "./alcance";
import { ERRO_DO_SERVICO } from "./erros-servico";
import type { ContextoFerramenta, ResultadoExecucaoFerramenta } from "./ferramentas";

// Ferramentas de leitura do Google Drive (spec §5). Todo item é conferido contra `pastaRaizId` (R-A2); texto livre
// passa por `protegerTexto` campo a campo com os conhecidos do sistema (R-A3, R-A4); `id` e `link` nunca passam.

const MAX_LISTAGEM = 100;
const MAX_BUSCA = 20;
const MAX_TEXTO_ARQUIVO = 20_000;
const CODIGO_VIAGEM_RE = /^ECL-\d+-\d+$/i;

const MIME_EXPORT: Record<string, "text/plain" | "text/csv"> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const MIME_TEXTO = new Set(["text/plain", "text/csv", "text/markdown"]);

export const FERRAMENTAS_LEITURA_DRIVE: FerramentaIA[] = [
  {
    name: "drive_listar",
    description:
      `Lista pastas e arquivos de uma pasta do Google Drive dentro da pasta raiz (até ${MAX_LISTAGEM} itens e o total). ` +
      'Passe o código da viagem (ECL-0001-01), o id de uma pasta ou "" para a pasta raiz.',
    input_schema: {
      type: "object",
      properties: {
        pasta: { type: "string", description: 'Código da viagem, id da pasta ou "" para a pasta raiz.' },
      },
      required: ["pasta"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "drive_buscar",
    description:
      `Busca arquivos dentro da pasta raiz do Google Drive cujo nome ou conteúdo contenha o texto informado (até ${MAX_BUSCA}).`,
    input_schema: {
      type: "object",
      properties: {
        texto: { type: "string", description: "Termo a buscar no nome ou no conteúdo dos arquivos." },
      },
      required: ["texto"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "drive_ler_arquivo",
    description:
      "Lê o texto de um arquivo do Google Drive (Google Docs, Planilhas, Apresentações, PDF com texto, TXT, CSV ou Markdown, até 5 MB e 20.000 caracteres).",
    input_schema: {
      type: "object",
      properties: {
        arquivo: { type: "string", description: "Id do arquivo no Google Drive." },
      },
      required: ["arquivo"],
      additionalProperties: false,
    },
    strict: true,
  },
];

export const FERRAMENTAS_ACAO_DRIVE: FerramentaIA[] = [
  {
    name: "drive_enviar_arquivo",
    description:
      'Propõe guardar um arquivo anexado no chat dentro da pasta de uma viagem no Google Drive. Passe nome "" para manter o nome original.',
    input_schema: {
      type: "object",
      properties: {
        viagem: { type: "string", description: "Código da viagem (ECL-0001-01)." },
        anexo: { type: "string", description: "Referência (id) do arquivo anexado no chat." },
        destino: { type: "string", description: '"publico", "interno" ou id de uma subpasta da viagem.' },
        nome: { type: "string", description: 'Nome opcional para salvar no Drive ou "" para manter o nome original.' },
      },
      required: ["viagem", "anexo", "destino", "nome"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "drive_criar_pasta",
    description: "Propõe criar uma subpasta dentro da pasta de uma viagem no Google Drive.",
    input_schema: {
      type: "object",
      properties: {
        viagem: { type: "string", description: "Código da viagem (ECL-0001-01)." },
        dentroDe: { type: "string", description: '"publico", "interno", "raiz_da_viagem" ou id de subpasta da viagem.' },
        nome: { type: "string", description: "Nome da nova pasta (1 a 120 caracteres, sem barras)." },
      },
      required: ["viagem", "dentroDe", "nome"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "drive_renomear",
    description: "Propõe renomear um arquivo ou subpasta dentro da pasta de uma viagem no Google Drive.",
    input_schema: {
      type: "object",
      properties: {
        arquivo: { type: "string", description: "Id do arquivo ou subpasta no Google Drive." },
        nome: { type: "string", description: "Novo nome (1 a 200 caracteres, sem barras)." },
      },
      required: ["arquivo", "nome"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "drive_mover",
    description: "Propõe mover um arquivo ou subpasta para outra pasta da mesma viagem no Google Drive.",
    input_schema: {
      type: "object",
      properties: {
        arquivo: { type: "string", description: "Id do arquivo ou subpasta no Google Drive." },
        destino: { type: "string", description: '"publico", "interno" ou id de uma subpasta da mesma viagem.' },
      },
      required: ["arquivo", "destino"],
      additionalProperties: false,
    },
    strict: true,
  },
];

const ENTRADAS = {
  drive_listar: z.object({ pasta: z.string().trim().max(200) }).strict(),
  drive_buscar: z.object({ texto: z.string().trim().min(1).max(100) }).strict(),
  drive_ler_arquivo: z.object({ arquivo: z.string().trim().min(1).max(200) }).strict(),
};

export function ehLeituraDrive(nome: string): nome is keyof typeof ENTRADAS {
  return nome in ENTRADAS;
}

function timeoutDe(prazoAte: number): number | null {
  const restante = prazoAte - Date.now();
  return restante < 1000 ? null : Math.min(TIMEOUT_MS, restante);
}

function msgIlegivel(link: string | null): string {
  return link ? `Este arquivo não tem texto que eu consiga ler; o link é ${link}` : "Este arquivo não tem texto que eu consiga ler.";
}

export async function executarLeituraDrive(
  nome: keyof typeof ENTRADAS,
  entrada: unknown,
  ctx: ContextoFerramenta,
): Promise<ResultadoExecucaoFerramenta> {
  const cfg = configDrive();
  if (!cfg) return { conteudo: `Ferramenta ${nome} não está disponível.`, erro: true };
  const v = ENTRADAS[nome].safeParse(entrada);
  if (!v.success) return { conteudo: `Entrada inválida para ${nome}.`, erro: true };
  const timeoutMs = timeoutDe(ctx.prazoAte);
  if (timeoutMs === null) return { conteudo: "O tempo da resposta está no fim. Tente uma pergunta mais específica.", erro: true };

  const prot = (s: string) => protegerTexto(s, ctx.conhecidos);
  const drive = clienteDrive(cfg, ctx.buscar, { timeoutMs });

  try {
    if (nome === "drive_listar") {
      const { pasta } = v.data as { pasta: string };
      let pastaId = cfg.pastaRaizId;
      if (pasta !== "") {
        if (CODIGO_VIAGEM_RE.test(pasta)) {
          const refs = await refsDaViagem(pasta);
          if (!refs?.pastaId) return { conteudo: "Pasta não encontrada.", erro: true };
          pastaId = refs.pastaId;
        } else {
          pastaId = pasta;
        }
        const cache = new Map<string, ItemDrive | null>();
        const dentro = await descendeDe(drive, pastaId, cfg.pastaRaizId, cache);
        if (!dentro) return { conteudo: "Pasta não encontrada.", erro: true };
        if (pastaId !== cfg.pastaRaizId) {
          const alvo = cache.get(pastaId) ?? (await drive.obter(pastaId));
          if (!alvo || alvo.mime !== MIME_PASTA) return { conteudo: "Pasta não encontrada.", erro: true };
        }
      }

      const itens = await drive.listarItens(pastaId);
      const ordenados = [...itens].sort((a, b) => {
        const pa = a.mime === MIME_PASTA ? 0 : 1;
        const pb = b.mime === MIME_PASTA ? 0 : 1;
        if (pa !== pb) return pa - pb;
        return a.nome.localeCompare(b.nome, "pt-BR");
      });
      return {
        conteudo: JSON.stringify({
          total: ordenados.length,
          itens: ordenados.slice(0, MAX_LISTAGEM).map((i) => ({
            id: i.id,
            nome: prot(i.nome),
            tipo: i.mime === MIME_PASTA ? "pasta" : "arquivo",
            mime: i.mime,
            modificado: i.modificado,
            tamanho: i.tamanho,
            link: i.link,
          })),
        }),
        erro: false,
      };
    }

    if (nome === "drive_buscar") {
      const { texto } = v.data as { texto: string };
      const brutos = await drive.buscar(texto);
      const cache = new Map<string, ItemDrive | null>(brutos.map((i) => [i.id, i]));
      const dentro: { id: string; nome: string; mime: string; modificado: string | null; link: string | null; caminho: string[] }[] = [];
      for (const item of brutos) {
        if (item.mime === MIME_PASTA) continue;
        const caminho = await caminhoAteARaiz(drive, item.id, cfg.pastaRaizId, cache);
        if (caminho === null) continue;
        dentro.push({
          id: item.id,
          nome: prot(item.nome),
          mime: item.mime,
          modificado: item.modificado,
          link: item.link,
          caminho: caminho.map(prot),
        });
        if (dentro.length >= MAX_BUSCA) break;
      }
      return {
        conteudo: JSON.stringify({ total: dentro.length, arquivos: dentro }),
        erro: false,
      };
    }

    // drive_ler_arquivo
    const { arquivo } = v.data as { arquivo: string };
    const cache = new Map<string, ItemDrive | null>();
    const item = await drive.obter(arquivo);
    cache.set(arquivo, item);
    if (!item || !(await descendeDe(drive, item.id, cfg.pastaRaizId, cache))) {
      return { conteudo: "Arquivo não encontrado.", erro: true };
    }

    let bruto = "";
    const exportMime = MIME_EXPORT[item.mime];
    if (exportMime) {
      try {
        bruto = await drive.exportar(item.id, exportMime);
      } catch (e) {
        if (e instanceof ErroIntegracao && e.classe === "recusado" && e.status === 200) {
          return { conteudo: msgIlegivel(item.link), erro: true };
        }
        throw e;
      }
    } else if (item.mime === "application/pdf" || MIME_TEXTO.has(item.mime)) {
      if (item.tamanho !== null && item.tamanho > LIMITE_UPLOAD_BYTES) {
        return { conteudo: msgIlegivel(item.link), erro: true };
      }
      let baixado: { bytes: Uint8Array; mime: string };
      try {
        baixado = await drive.baixarBytes(item.id);
      } catch (e) {
        if (e instanceof ErroIntegracao && e.classe === "recusado" && e.status === 200) {
          return { conteudo: msgIlegivel(item.link), erro: true };
        }
        throw e;
      }
      if (item.mime === "application/pdf") {
        bruto = await textoDoPdf(baixado.bytes);
        if (bruto.trim() === "") return { conteudo: msgIlegivel(item.link), erro: true };
      } else {
        bruto = new TextDecoder("utf-8").decode(baixado.bytes);
      }
    } else {
      return { conteudo: msgIlegivel(item.link), erro: true };
    }

    // R-A3: o texto inteiro passa por protegerTexto antes de cortar em 20.000 caracteres.
    const protegido = prot(bruto);
    const cortado = protegido.length > MAX_TEXTO_ARQUIVO;
    return {
      conteudo: JSON.stringify({
        nome: prot(item.nome),
        mime: item.mime,
        texto: protegido.slice(0, MAX_TEXTO_ARQUIVO),
        cortado,
      }),
      erro: false,
    };
  } catch (e) {
    if (e instanceof ErroIntegracao) return { conteudo: ERRO_DO_SERVICO.drive[e.classe], erro: true };
    console.error("Erro na ferramenta do Drive", { ferramenta: nome, code: (e as { code?: string } | null)?.code });
    return { conteudo: ERRO_DO_SERVICO.drive.servidor, erro: true };
  }
}
