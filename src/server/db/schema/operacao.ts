import { date, integer, jsonb, pgEnum, pgTable, text, timestamp, unique, uuid, boolean } from "drizzle-orm/pg-core";
import { ESTADOS_DAILY } from "@/domain/daily";
import { IDIOMAS, STATUS_ROTEIRO, type ConteudoRoteiro } from "@/domain/roteiro";
import { CATEGORIAS_TAREFA, ORIGENS_TAREFA, TIPOS_PRAZO } from "@/domain/tarefas";
import { usuarios } from "./usuarios";
import { viagens } from "./viagens";

export const categoriaTarefa = pgEnum("categoria_tarefa", CATEGORIAS_TAREFA);
export const prazoTarefa = pgEnum("prazo_tarefa", TIPOS_PRAZO);
export const origemTarefa = pgEnum("origem_tarefa", ORIGENS_TAREFA);
export const statusRoteiro = pgEnum("status_roteiro", STATUS_ROTEIRO);
export const idiomaDestino = pgEnum("idioma_destino", IDIOMAS);
export const estadoDaily = pgEnum("estado_daily", ESTADOS_DAILY);

// RLS das três tabelas, os índices parciais (tarefas_viagem_chave_unica, tarefas_abertas_responsavel_idx,
// tarefas_viagem_idx) e os CHECKs estão na migração custom 0027_operacao_rls.sql (o drizzle não os conhece).
export const tarefas = pgTable("tarefas", {
  id: uuid("id").primaryKey().defaultRandom(),
  viagemId: uuid("viagem_id").notNull().references(() => viagens.id, { onDelete: "restrict" }),
  categoria: categoriaTarefa("categoria").notNull(),
  dia: date("dia"),
  item: text("item").notNull(),
  fazer: text("fazer").notNull().default(""),
  prazoTipo: prazoTarefa("prazo_tipo"),
  prazoData: date("prazo_data"),
  prazoDias: integer("prazo_dias"),
  responsavelId: uuid("responsavel_id").references(() => usuarios.id),
  customerCare: boolean("customer_care").notNull().default(false),
  observacao: text("observacao"),
  ordem: integer("ordem").notNull(),
  origem: origemTarefa("origem").notNull().default("manual"),
  chave: text("chave"),
  concluidaEm: timestamp("concluida_em", { withTimezone: true }),
  concluidaPor: uuid("concluida_por").references(() => usuarios.id),
  criadoPor: uuid("criado_por").references(() => usuarios.id),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  excluidoEm: timestamp("excluido_em", { withTimezone: true }),
});

export const roteiros = pgTable("roteiros", {
  id: uuid("id").primaryKey().defaultRandom(),
  viagemId: uuid("viagem_id").notNull().unique().references(() => viagens.id, { onDelete: "restrict" }),
  status: statusRoteiro("status").notNull().default("rascunho"),
  idioma: idiomaDestino("idioma").notNull(),
  fuso: text("fuso").notNull(),
  abertura: text("abertura").notNull().default(""),
  conteudo: jsonb("conteudo").$type<ConteudoRoteiro>().notNull(),
  enviadoClienteEm: timestamp("enviado_cliente_em", { withTimezone: true }),
  enviadoClientePor: uuid("enviado_cliente_por").references(() => usuarios.id),
  aprovadoEm: timestamp("aprovado_em", { withTimezone: true }),
  aprovadoPor: uuid("aprovado_por").references(() => usuarios.id),
  criadoPor: uuid("criado_por").references(() => usuarios.id),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
});

export const dailies = pgTable(
  "dailies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roteiroId: uuid("roteiro_id").notNull().references(() => roteiros.id, { onDelete: "restrict" }),
    data: date("data").notNull(),
    estado: estadoDaily("estado").notNull().default("pendente"),
    texto: text("texto"),
    geradoEm: timestamp("gerado_em", { withTimezone: true }),
    geradoPor: uuid("gerado_por").references(() => usuarios.id),
    revisadoEm: timestamp("revisado_em", { withTimezone: true }),
    revisadoPor: uuid("revisado_por").references(() => usuarios.id),
    enviadoEm: timestamp("enviado_em", { withTimezone: true }),
    enviadoPor: uuid("enviado_por").references(() => usuarios.id),
    plantaoId: uuid("plantao_id").references(() => usuarios.id),
    interno: text("interno"),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("dailies_roteiro_data_unico").on(t.roteiroId, t.data)],
);
