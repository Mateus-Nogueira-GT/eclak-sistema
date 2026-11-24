import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { SITUACOES_EXTRATO } from "@/domain/conciliacao";
import { ORIGENS, type Origem } from "@/domain/financeiro";
import { contasBancarias } from "./financeiro";
import { usuarios } from "./usuarios";

const centavos = (nome: string) => bigint(nome, { mode: "bigint" });

export const situacaoExtratoEnum = pgEnum("situacao_extrato", SITUACOES_EXTRATO);

// Extrato bancário importado de um arquivo OFX (o arquivo em si não é guardado: só o hash, para recusar o mesmo
// arquivo de novo). RLS e CHECKs de coerência na migração custom.
export const extratos = pgTable(
  "extratos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    contaBancariaId: uuid("conta_bancaria_id")
      .notNull()
      .references(() => contasBancarias.id, { onDelete: "restrict" }),
    arquivoNome: text("arquivo_nome").notNull(),
    arquivoHash: text("arquivo_hash").notNull(),
    bancoOfx: text("banco_ofx"),
    contaOfx: text("conta_ofx"),
    inicio: date("inicio", { mode: "string" }),
    fim: date("fim", { mode: "string" }),
    transacoes: integer("transacoes").notNull(),
    repetidas: integer("repetidas").notNull(),
    importadoPor: uuid("importado_por")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    importadoEm: timestamp("importado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("extratos_conta_hash_unico").on(t.contaBancariaId, t.arquivoHash),
    check("extratos_contagens", sql`${t.transacoes} >= 0 AND ${t.repetidas} >= 0`),
  ],
);

// Linha do extrato. `linha_origem` + `linha_id` apontam para a linha da view `lancamentos_financeiros` (sem FK, como
// em `anexos`); a existência é conferida na action e a validade na leitura.
export const extratoTransacoes = pgTable(
  "extrato_transacoes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    extratoId: uuid("extrato_id")
      .notNull()
      .references(() => extratos.id, { onDelete: "restrict" }),
    contaBancariaId: uuid("conta_bancaria_id")
      .notNull()
      .references(() => contasBancarias.id, { onDelete: "restrict" }),
    fitid: text("fitid").notNull(),
    data: date("data", { mode: "string" }).notNull(),
    valor: centavos("valor").notNull(),
    tipo: text("tipo"),
    descricao: text("descricao").notNull(),
    situacao: situacaoExtratoEnum("situacao").notNull().default("pendente"),
    linhaOrigem: text("linha_origem").$type<Origem>(),
    linhaId: uuid("linha_id"),
    conciliadaPor: uuid("conciliada_por").references(() => usuarios.id, { onDelete: "restrict" }),
    conciliadaEm: timestamp("conciliada_em", { withTimezone: true }),
    ignoradaMotivo: text("ignorada_motivo"),
    ignoradaPor: uuid("ignorada_por").references(() => usuarios.id, { onDelete: "restrict" }),
    ignoradaEm: timestamp("ignorada_em", { withTimezone: true }),
  },
  (t) => [
    unique("extrato_transacoes_conta_fitid_unico").on(t.contaBancariaId, t.fitid),
    uniqueIndex("extrato_transacoes_linha_unica")
      .on(t.linhaOrigem, t.linhaId)
      .where(sql`${t.situacao} = 'conciliada'`),
    index("extrato_transacoes_conta_data_idx").on(t.contaBancariaId, t.data),
    index("extrato_transacoes_extrato_idx").on(t.extratoId),
    check(
      "extrato_transacoes_linha_origem",
      sql`${t.linhaOrigem} IS NULL OR ${t.linhaOrigem} IN (${sql.raw(ORIGENS.map((o) => `'${o}'`).join(", "))})`,
    ),
    check(
      "extrato_transacoes_conciliada_coerente",
      sql`(${t.situacao} = 'conciliada') = (${t.linhaOrigem} IS NOT NULL AND ${t.linhaId} IS NOT NULL AND ${t.conciliadaPor} IS NOT NULL AND ${t.conciliadaEm} IS NOT NULL)
        AND (${t.situacao} = 'conciliada' OR (${t.linhaOrigem} IS NULL AND ${t.linhaId} IS NULL AND ${t.conciliadaPor} IS NULL AND ${t.conciliadaEm} IS NULL))`,
    ),
    check(
      "extrato_transacoes_ignorada_coerente",
      sql`(${t.situacao} = 'ignorada') = (${t.ignoradaMotivo} IS NOT NULL AND length(btrim(${t.ignoradaMotivo})) > 0 AND ${t.ignoradaPor} IS NOT NULL AND ${t.ignoradaEm} IS NOT NULL)
        AND (${t.situacao} = 'ignorada' OR (${t.ignoradaMotivo} IS NULL AND ${t.ignoradaPor} IS NULL AND ${t.ignoradaEm} IS NULL))`,
    ),
  ],
);
