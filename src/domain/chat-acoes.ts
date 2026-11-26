import { z } from "zod";
import { tamanhoLegivel } from "./anexos";

// Domínio puro das ações do agente do chat (Trello e Drive): tipos, limites, validação das entradas e
// montagem dos rótulos de confirmação e resumo. Sem I/O.

export const TIPOS_ACAO_CHAT = [
  "trello_comentar",
  "trello_marcar_item",
  "trello_adicionar_item",
  "trello_mover_cartao",
  "trello_definir_prazo",
  "trello_criar_cartao",
  "drive_enviar_arquivo",
  "drive_criar_pasta",
  "drive_renomear",
  "drive_mover",
] as const;
export type TipoAcaoChat = (typeof TIPOS_ACAO_CHAT)[number];

export const SITUACOES_ACAO_CHAT = [
  "pendente",
  "executando",
  "feita",
  "falhou",
  "cancelada",
  "expirada",
] as const;
export type SituacaoAcaoChat = (typeof SITUACOES_ACAO_CHAT)[number];

export const VALIDADE_PROPOSTA_MIN = 15;
export const VALIDADE_ANEXO_MIN = 60;
export const EXECUTANDO_PRESO_MIN = 2;
export const MAX_PROPOSTAS_POR_PERGUNTA = 3;
export const MAX_ANEXOS_ESPERANDO = 3;
export const TAMANHO_MAXIMO_ANEXO_CHAT = 5 * 1024 * 1024;
export const MSG_TAMANHO_ANEXO_CHAT = "O arquivo passa de 5 MB";

export type Proposta = {
  id: string;
  titulo: string;
  linhas: [string, string][];
  expiraEm: string;
};

export function servicoDaAcao(tipo: TipoAcaoChat): "trello" | "drive" {
  return tipo.startsWith("trello_") ? "trello" : "drive";
}

/** Nome válido de arquivo ou pasta no Drive: aparado, sem `/` nem `\`, sem caractere de controle, não vazio. */
export function nomeNoDrive(s: string): string | null {
  const t = s.trim();
  if (!t || t === "." || t === "..") return null;
  if (/[/\\\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

const DATA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

export function dataIsoValida(s: string): boolean {
  const m = DATA_ISO.exec(s);
  if (!m) return false;
  const a = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return false;
  const d = new Date(Date.UTC(a, mes - 1, dia));
  return d.getUTCFullYear() === a && d.getUTCMonth() === mes - 1 && d.getUTCDate() === dia;
}

/** Data ISO ("2026-12-01") → 12h de Cuiabá (UTC-4) em UTC ("2026-12-01T16:00:00.000Z"). */
export function prazoParaUtc(dia: string): string {
  if (!dataIsoValida(dia)) throw new Error("Data inválida");
  return `${dia}T16:00:00.000Z`;
}

/** Minúsculas e sem diacríticos, para busca sem acento. */
export function semAcento(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const idCurto = z.string().trim().min(1).max(200);
const textoObrigatorio = (max: number) => z.string().trim().min(1).max(max);
const nomeDriveObrigatorio = (max: number) =>
  z
    .string()
    .transform((s) => nomeNoDrive(s))
    .refine((s): s is string => s !== null && s.length <= max, `nome inválido (1 a ${max} caracteres)`);

const prazoOpcional = z
  .string()
  .trim()
  .refine((s) => s === "" || dataIsoValida(s), "prazo deve ser AAAA-MM-DD ou vazio");

export const ENTRADAS_ACAO: Record<TipoAcaoChat, z.ZodType> = {
  trello_comentar: z.object({ cartao: idCurto, texto: textoObrigatorio(2000) }).strict(),
  trello_marcar_item: z.object({ cartao: idCurto, item: idCurto, feito: z.boolean() }).strict(),
  trello_adicionar_item: z.object({ cartao: idCurto, checklist: idCurto, nome: textoObrigatorio(200) }).strict(),
  trello_mover_cartao: z.object({ cartao: idCurto, lista: idCurto }).strict(),
  trello_definir_prazo: z.object({ cartao: idCurto, prazo: prazoOpcional }).strict(),
  trello_criar_cartao: z
    .object({
      lista: z.string().trim().max(200),
      nome: textoObrigatorio(200),
      descricao: z.string().trim().max(2000),
    })
    .strict(),
  drive_enviar_arquivo: z
    .object({
      viagem: idCurto,
      anexo: idCurto,
      destino: idCurto,
      nome: z
        .string()
        .max(200)
        .optional()
        .default("")
        .refine((s) => s.trim() === "" || nomeNoDrive(s) !== null, "nome inválido"),
    })
    .strict(),
  drive_criar_pasta: z.object({ viagem: idCurto, dentroDe: idCurto, nome: nomeDriveObrigatorio(120) }).strict(),
  drive_renomear: z.object({ arquivo: idCurto, nome: nomeDriveObrigatorio(200) }).strict(),
  drive_mover: z.object({ arquivo: idCurto, destino: idCurto }).strict(),
};

const TITULOS: Record<TipoAcaoChat, string> = {
  trello_comentar: "Comentar no cartão",
  trello_marcar_item: "Marcar item do checklist",
  trello_adicionar_item: "Adicionar item ao checklist",
  trello_mover_cartao: "Mover cartão",
  trello_definir_prazo: "Definir prazo do cartão",
  trello_criar_cartao: "Criar cartão no Trello",
  drive_enviar_arquivo: "Enviar arquivo ao Drive",
  drive_criar_pasta: "Criar pasta no Drive",
  drive_renomear: "Renomear no Drive",
  drive_mover: "Mover no Drive",
};

export function tituloDaAcao(tipo: TipoAcaoChat): string {
  return TITULOS[tipo];
}

function formatarPrazoLinha(prazo: unknown): string {
  if (typeof prazo !== "string" || !dataIsoValida(prazo)) return "Sem prazo";
  return `${prazo.slice(8, 10)}/${prazo.slice(5, 7)}/${prazo.slice(0, 4)}`;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function linhasDaAcao(
  tipo: TipoAcaoChat,
  alvo: Record<string, string>,
  dados: Record<string, unknown>,
): [string, string][] {
  switch (tipo) {
    case "trello_comentar":
      return [
        ["Cartão", alvo.cartao ?? ""],
        ["Comentário", str(dados.texto)],
      ];
    case "trello_marcar_item":
      return [
        ["Cartão", alvo.cartao ?? ""],
        ["Checklist", alvo.checklist ?? ""],
        ["Item", alvo.item ?? ""],
        ["Marcar como", dados.feito ? "Concluído" : "Não concluído"],
      ];
    case "trello_adicionar_item":
      return [
        ["Cartão", alvo.cartao ?? ""],
        ["Checklist", alvo.checklist ?? ""],
        ["Novo item", str(dados.nome)],
      ];
    case "trello_mover_cartao":
      return [
        ["Cartão", alvo.cartao ?? ""],
        ["De", alvo.de ?? ""],
        ["Para", alvo.para ?? ""],
      ];
    case "trello_definir_prazo":
      return [
        ["Cartão", alvo.cartao ?? ""],
        ["Prazo atual", alvo.prazoAtual || "Sem prazo"],
        ["Novo prazo", formatarPrazoLinha(dados.prazo)],
      ];
    case "trello_criar_cartao":
      return [
        ["Lista", alvo.lista ?? ""],
        ["Nome", str(dados.nome)],
        ["Descrição", str(dados.descricao) || "Sem descrição"],
      ];
    case "drive_enviar_arquivo":
      return [
        ["Viagem", alvo.viagem ?? ""],
        ["Pasta", alvo.pasta ?? ""],
        ["Arquivo", str(dados.nome) || alvo.arquivo || ""],
        ["Tamanho", alvo.tamanho || (typeof dados.tamanho === "number" ? tamanhoLegivel(dados.tamanho) : "")],
      ];
    case "drive_criar_pasta":
      return [
        ["Viagem", alvo.viagem ?? ""],
        ["Dentro de", alvo.dentroDe ?? ""],
        ["Nova pasta", str(dados.nome)],
      ];
    case "drive_renomear":
      return [
        ["Viagem", alvo.viagem ?? ""],
        ["Arquivo", alvo.arquivo ?? ""],
        ["Novo nome", str(dados.nome)],
      ];
    case "drive_mover":
      return [
        ["Viagem", alvo.viagem ?? ""],
        ["Arquivo", alvo.arquivo ?? ""],
        ["De", alvo.de ?? ""],
        ["Para", alvo.para ?? ""],
      ];
  }
}

export function resumoDaAcao(tipo: TipoAcaoChat, alvo: Record<string, string>): string {
  switch (tipo) {
    case "trello_comentar":
      return `Comentário publicado no cartão ${alvo.cartao ?? ""}`.trim();
    case "trello_marcar_item":
      return `Item atualizado no cartão ${alvo.cartao ?? ""}`.trim();
    case "trello_adicionar_item":
      return `Item adicionado ao checklist do cartão ${alvo.cartao ?? ""}`.trim();
    case "trello_mover_cartao":
      return `Cartão ${alvo.cartao ?? ""} movido para ${alvo.para ?? ""}`.trim();
    case "trello_definir_prazo":
      return `Prazo atualizado no cartão ${alvo.cartao ?? ""}`.trim();
    case "trello_criar_cartao":
      return `Cartão criado na lista ${alvo.lista ?? ""}`.trim();
    case "drive_enviar_arquivo":
      return `Arquivo enviado para ${alvo.pasta ?? ""} (${alvo.viagem ?? ""})`.trim();
    case "drive_criar_pasta":
      return `Pasta criada em ${alvo.dentroDe ?? ""} (${alvo.viagem ?? ""})`.trim();
    case "drive_renomear":
      return `Item renomeado no Drive (${alvo.viagem ?? ""})`.trim();
    case "drive_mover":
      return `Item movido para ${alvo.para ?? ""} (${alvo.viagem ?? ""})`.trim();
  }
}
