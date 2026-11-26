import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import {
  SITUACOES_ACAO_CHAT,
  TAMANHO_MAXIMO_ANEXO_CHAT,
  TIPOS_ACAO_CHAT,
  type TipoAcaoChat,
} from "@/domain/chat-acoes";
import type { ClasseErro } from "@/domain/integracoes";
import { usuarios } from "./usuarios";
import { viagens } from "./viagens";

export const situacaoChatAcaoEnum = pgEnum("situacao_chat_acao", SITUACOES_ACAO_CHAT);

export type ResultadoChatAcao =
  | { link: string | null }
  | { classe: ClasseErro | "desconhecido" | "alcance"; status?: number | null };

// Propostas de ação do agente do chat (Trello e Drive). O modelo propõe (linha `pendente`); só quem pediu pode
// confirmar ou cancelar em até 15 min. `tomado_em` faz o fencing da execução. RLS na migração custom 0048.
export const chatAcoes = pgTable(
  "chat_acoes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    tipo: text("tipo").$type<TipoAcaoChat>().notNull(),
    viagemId: uuid("viagem_id").references(() => viagens.id, { onDelete: "restrict" }),
    alvo: jsonb("alvo").$type<Record<string, unknown>>().notNull(),
    dados: jsonb("dados").$type<Record<string, unknown>>().notNull(),
    situacao: situacaoChatAcaoEnum("situacao").notNull().default("pendente"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    expiraEm: timestamp("expira_em", { withTimezone: true }).notNull(),
    decididoEm: timestamp("decidido_em", { withTimezone: true }),
    tomadoEm: timestamp("tomado_em", { withTimezone: true }),
    resultado: jsonb("resultado").$type<ResultadoChatAcao | null>(),
  },
  (t) => [
    index("chat_acoes_usuario_situacao_idx").on(t.usuarioId, t.situacao),
    index("chat_acoes_situacao_expira_idx").on(t.situacao, t.expiraEm),
    check("chat_acoes_tipo", sql`${t.tipo} IN (${sql.raw(TIPOS_ACAO_CHAT.map((x) => `'${x}'`).join(", "))})`),
    check("chat_acoes_viagem_coerente", sql`(${t.tipo} = 'trello_criar_cartao') = (${t.viagemId} IS NULL)`),
    check("chat_acoes_executando_coerente", sql`${t.situacao} <> 'executando' OR ${t.tomadoEm} IS NOT NULL`),
  ],
);
export type ChatAcao = typeof chatAcoes.$inferSelect;

// Arquivos anexados no chat esperando para ir ao Drive (bucket `anexos` em `chat/<usuario>/<uuid>`, validade 60 min).
// Limpos pelo agendador após vencer ou removidos do bucket após upload bem-sucedido. RLS na migração custom 0048.
export const chatAnexos = pgTable(
  "chat_anexos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    nome: text("nome").notNull(),
    mime: text("mime").notNull(),
    tamanho: integer("tamanho").notNull(),
    caminho: text("caminho").notNull().unique(),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    expiraEm: timestamp("expira_em", { withTimezone: true }).notNull(),
    usadoEm: timestamp("usado_em", { withTimezone: true }),
  },
  (t) => [
    index("chat_anexos_usuario_expira_idx").on(t.usuarioId, t.expiraEm),
    check("chat_anexos_tamanho", sql`${t.tamanho} BETWEEN 1 AND ${sql.raw(String(TAMANHO_MAXIMO_ANEXO_CHAT))}`),
  ],
);
export type ChatAnexo = typeof chatAnexos.$inferSelect;
