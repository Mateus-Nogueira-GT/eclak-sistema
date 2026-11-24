import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { INTEGRACOES_FILA, SITUACOES_ENVIO, type ClasseErro, type MotivoEspera } from "@/domain/integracoes";
import { viagens } from "./viagens";

export const integracaoFilaEnum = pgEnum("integracao_fila", INTEGRACOES_FILA);
export const situacaoEnvioEnum = pgEnum("situacao_envio", SITUACOES_ENVIO);

/** Último erro do envio; `aguardando` não é erro do serviço (ver `MOTIVOS_ESPERA`) e não gasta tentativa. */
export type ErroEnvio =
  | { classe: ClasseErro; status: number | null }
  | { classe: "aguardando"; status: null; motivo: MotivoEspera };

// Fila de envios às integrações (outbox): gravada na transação do evento, enviada fora dela (after() e cron).
// `chave` é a idempotência por integração; `payload` e `resultado` sem dado sensível; `ultimo_erro` só classe e
// status HTTP (nunca corpo). `tomado_em`: quando passou a `enviando` (o que ficou preso há mais de 10 min volta).
// RLS na migração custom.
export const integracaoEnvios = pgTable(
  "integracao_envios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    integracao: integracaoFilaEnum("integracao").notNull(),
    tipo: text("tipo").notNull(),
    viagemId: uuid("viagem_id").references(() => viagens.id, { onDelete: "restrict" }),
    chave: text("chave").notNull(),
    payload: jsonb("payload").notNull(),
    situacao: situacaoEnvioEnum("situacao").notNull().default("pendente"),
    tentativas: integer("tentativas").notNull().default(0),
    proximaEm: timestamp("proxima_em", { withTimezone: true }).notNull().defaultNow(),
    tomadoEm: timestamp("tomado_em", { withTimezone: true }),
    ultimoErro: jsonb("ultimo_erro").$type<ErroEnvio>(),
    resultado: jsonb("resultado"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    enviadoEm: timestamp("enviado_em", { withTimezone: true }),
  },
  (t) => [
    unique("integracao_envios_chave_unica").on(t.integracao, t.chave),
    index("integracao_envios_situacao_proxima_idx").on(t.situacao, t.proximaEm),
    check("integracao_envios_tentativas", sql`${t.tentativas} >= 0`),
    check("integracao_envios_enviado_coerente", sql`(${t.situacao} = 'enviado') = (${t.enviadoEm} IS NOT NULL)`),
    check("integracao_envios_enviando_coerente", sql`${t.situacao} <> 'enviando' OR ${t.tomadoEm} IS NOT NULL`),
  ],
);
export type IntegracaoEnvio = typeof integracaoEnvios.$inferSelect;
