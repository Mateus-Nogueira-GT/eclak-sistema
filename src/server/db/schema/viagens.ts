import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { MOEDAS } from "@/domain/cambio";
import { TIPOS_ITEM } from "@/domain/precificacao";
import { STATUS_ORCAMENTO, STATUS_VERSAO } from "@/domain/viagens";
import { clientes, pessoas } from "./clientes";
import { fornecedores } from "./fornecedores";
import { regrasVersoes } from "./regras";
import { filialEnum, usuarios } from "./usuarios";

export const statusOrcamento = pgEnum("status_orcamento", STATUS_ORCAMENTO);
export const statusVersao = pgEnum("status_versao", STATUS_VERSAO);
export const tipoItem = pgEnum("tipo_item", TIPOS_ITEM);
export const moedaEnum = pgEnum("moeda", MOEDAS);

// RLS e os índices parciais (viagens_cliente_idx, itens_viagem_viagem_idx, cotacoes_item_idx,
// cotacoes_uma_escolhida, versoes_viagem_idx) estão na migração custom 0011_rls_viagens.sql. A FK circular
// viagens(id, versao_aprovada_id) -> versoes_precificacao(viagem_id, id), o único (viagem_id, id) e o gatilho
// que só aceita versão aprovada estão na 0012_integridade_versao_aprovada.sql (o drizzle não os conhece).
export const viagens = pgTable(
  "viagens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clienteId: uuid("cliente_id")
      .notNull()
      .references(() => clientes.id, { onDelete: "restrict" }),
    seq: integer("seq").notNull(),
    destino: text("destino").notNull(),
    inicio: date("inicio").notNull(),
    fim: date("fim").notNull(),
    filial: filialEnum("filial").notNull(),
    consultorId: uuid("consultor_id")
      .notNull()
      .references(() => usuarios.id),
    status: statusOrcamento("status").notNull().default("em_edicao"),
    versaoAprovadaId: uuid("versao_aprovada_id"),
    observacoes: text("observacoes"),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
    excluidoEm: timestamp("excluido_em", { withTimezone: true }),
  },
  (t) => [
    unique("viagens_cliente_seq_unico").on(t.clienteId, t.seq),
    check("viagens_fim_apos_inicio", sql`${t.fim} >= ${t.inicio}`),
  ],
);

export const viagemPassageiros = pgTable(
  "viagem_passageiros",
  {
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    pessoaId: uuid("pessoa_id")
      .notNull()
      .references(() => pessoas.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.viagemId, t.pessoaId] })],
);

export const itensViagem = pgTable("itens_viagem", {
  id: uuid("id").primaryKey().defaultRandom(),
  viagemId: uuid("viagem_id")
    .notNull()
    .references(() => viagens.id, { onDelete: "restrict" }),
  ordem: integer("ordem").notNull(),
  tipo: tipoItem("tipo").notNull(),
  cidade: text("cidade"),
  servico: text("servico").notNull(),
  checkin: date("checkin"),
  checkout: date("checkout"),
  diarias: integer("diarias"),
  /** Item gerado pelo sistema (taxa de roteiro). */
  automatico: boolean("automatico").notNull().default(false),
  excluidoEm: timestamp("excluido_em", { withTimezone: true }),
});

export const cotacoes = pgTable("cotacoes", {
  id: uuid("id").primaryKey().defaultRandom(),
  itemId: uuid("item_id")
    .notNull()
    .references(() => itensViagem.id, { onDelete: "restrict" }),
  fornecedorId: uuid("fornecedor_id").references(() => fornecedores.id),
  moeda: moedaEnum("moeda").notNull().default("BRL"),
  valorOriginal: bigint("valor_original", { mode: "bigint" }).notNull(), // centavos da moeda
  cambioComercial: numeric("cambio_comercial", { precision: 10, scale: 4 }),
  cambioAplicado: numeric("cambio_aplicado", { precision: 10, scale: 4 }),
  cambioData: date("cambio_data"),
  valorBrl: bigint("valor_brl", { mode: "bigint" }).notNull(), // centavos de real
  comissaoPct: numeric("comissao_pct", { precision: 6, scale: 3 }).notNull().default(sql`0`),
  descontoAVistaPct: numeric("desconto_a_vista_pct", { precision: 6, scale: 3 }),
  tarifaFixa: bigint("tarifa_fixa", { mode: "bigint" }).notNull().default(sql`0`), // aéreo, centavos
  escolhida: boolean("escolhida").notNull().default(false),
  criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  excluidoEm: timestamp("excluido_em", { withTimezone: true }),
});

export const versoesPrecificacao = pgTable(
  "versoes_precificacao",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    numero: integer("numero").notNull(),
    status: statusVersao("status").notNull().default("aguardando"),
    /** Itens e cotações usados no cálculo. */
    snapshot: jsonb("snapshot").notNull(),
    preco: bigint("preco", { mode: "bigint" }).notNull(),
    forma: jsonb("forma").notNull(),
    dias: integer("dias").notNull(),
    regrasVersaoId: uuid("regras_versao_id")
      .notNull()
      .references(() => regrasVersoes.id),
    rateio: text("rateio").notNull(),
    /** Saída de `margemDaAprovacao` serializada. */
    resultado: jsonb("resultado").notNull(),
    /** "O que mudou", escrito pelo consultor. */
    alteracao: text("alteracao"),
    enviadoPor: uuid("enviado_por")
      .notNull()
      .references(() => usuarios.id),
    enviadoEm: timestamp("enviado_em", { withTimezone: true }).notNull().defaultNow(),
    decididoPor: uuid("decidido_por").references(() => usuarios.id),
    decididoEm: timestamp("decidido_em", { withTimezone: true }),
    comentario: text("comentario"),
  },
  (t) => [unique("versoes_viagem_numero_unico").on(t.viagemId, t.numero)],
);
