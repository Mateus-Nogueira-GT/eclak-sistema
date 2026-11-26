import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { SITUACOES_CAIXA, TIPOS_MOVIMENTO, USOS_ESTOQUE } from "@/domain/estoque";
import { lancamentos } from "./financeiro";
import { centroCustoEnum } from "./financeiro-enums";
import { fornecedores } from "./fornecedores";
import { usuarios } from "./usuarios";
import { viagens } from "./viagens";

export const usoEstoqueEnum = pgEnum("uso_estoque", USOS_ESTOQUE);
export const tipoMovimentoEstoqueEnum = pgEnum("tipo_movimento_estoque", TIPOS_MOVIMENTO);
export const situacaoCaixaEnum = pgEnum("situacao_caixa", SITUACOES_CAIXA);

const centavos = (nome: string) => bigint(nome, { mode: "bigint" });

// Estoque e caixa de experiência (fatia 5b). Dinheiro em centavos. A filial usa o enum de centro (MT, RS).
// `lancamentos.estoque_movimento_id` aponta para cá (FK em função, por causa do import circular com financeiro.ts).
// RLS (só service role) na migração custom 0051.

export const produtosEstoque = pgTable(
  "produtos_estoque",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nome: text("nome").notNull(),
    uso: usoEstoqueEnum("uso").notNull(),
    /** 0 = sem aviso de reposição. */
    minimoMt: integer("minimo_mt").notNull().default(0),
    minimoRs: integer("minimo_rs").notNull().default(0),
    ativo: boolean("ativo").notNull().default(true),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Nome único entre os ativos, sem diferenciar caixa.
    uniqueIndex("produtos_estoque_nome_ativo_unico").on(sql`lower(${t.nome})`).where(sql`${t.ativo}`),
    check("produtos_estoque_minimos", sql`${t.minimoMt} >= 0 AND ${t.minimoRs} >= 0`),
  ],
);

/** Um saldo por (produto, filial); linha travada (`for update`) em toda movimentação. */
export const estoqueSaldos = pgTable(
  "estoque_saldos",
  {
    produtoId: uuid("produto_id")
      .notNull()
      .references(() => produtosEstoque.id, { onDelete: "restrict" }),
    filial: centroCustoEnum("filial").notNull(),
    quantidade: integer("quantidade").notNull().default(0),
    custoMedio: centavos("custo_medio").notNull().default(sql`0`),
  },
  (t) => [
    primaryKey({ name: "estoque_saldos_pk", columns: [t.produtoId, t.filial] }),
    check("estoque_saldos_quantidade", sql`${t.quantidade} >= 0`),
    check("estoque_saldos_custo_medio", sql`${t.custoMedio} >= 0`),
  ],
);

/** Livro de movimentos: nunca é alterado nem apagado. `custo_medio_antes`: o custo médio da filial antes do movimento. */
export const estoqueMovimentos = pgTable(
  "estoque_movimentos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    produtoId: uuid("produto_id")
      .notNull()
      .references(() => produtosEstoque.id, { onDelete: "restrict" }),
    filial: centroCustoEnum("filial").notNull(),
    tipo: tipoMovimentoEstoqueEnum("tipo").notNull(),
    /** Com sinal: negativo é saída. */
    quantidade: integer("quantidade").notNull(),
    custoUnitario: centavos("custo_unitario").notNull(),
    custoMedioAntes: centavos("custo_medio_antes").notNull(),
    fornecedorId: uuid("fornecedor_id").references(() => fornecedores.id, { onDelete: "restrict" }),
    fornecedorTexto: text("fornecedor_texto"),
    /** A conta a pagar da entrada. */
    lancamentoId: uuid("lancamento_id").references(() => lancamentos.id, { onDelete: "restrict" }),
    caixaId: uuid("caixa_id").references(() => caixasExperiencia.id, { onDelete: "restrict" }),
    motivo: text("motivo"),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    /** Ordem de gravação (identidade, lida sob a trava do saldo): decide o último movimento do par produto/filial. */
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    /** Só para exibição: a ordem é `seq`. */
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("estoque_movimentos_quantidade", sql`${t.quantidade} <> 0`),
    // Sinal pelo tipo: entrada e devolução da caixa somam; saída e caixa tiram; ajuste vai para qualquer lado.
    check(
      "estoque_movimentos_sinal",
      sql`(${t.tipo} IN ('entrada', 'devolucao_caixa') AND ${t.quantidade} > 0) OR (${t.tipo} IN ('saida', 'caixa') AND ${t.quantidade} < 0) OR ${t.tipo} = 'ajuste'`,
    ),
    check("estoque_movimentos_custos", sql`${t.custoUnitario} >= 0 AND ${t.custoMedioAntes} >= 0`),
    check("estoque_movimentos_um_fornecedor", sql`num_nonnulls(${t.fornecedorId}, ${t.fornecedorTexto}) <= 1`),
    check("estoque_movimentos_fornecedor_so_entrada", sql`${t.tipo} = 'entrada' OR num_nonnulls(${t.fornecedorId}, ${t.fornecedorTexto}) = 0`),
    check(
      "estoque_movimentos_motivo",
      sql`${t.tipo} NOT IN ('saida', 'ajuste') OR (${t.motivo} IS NOT NULL AND char_length(${t.motivo}) BETWEEN 5 AND 200)`,
    ),
    index("estoque_movimentos_produto_filial_idx").on(t.produtoId, t.filial, t.seq),
    index("estoque_movimentos_caixa_idx").on(t.caixaId),
  ],
);

export const caixasExperiencia = pgTable(
  "caixas_experiencia",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    viagemId: uuid("viagem_id")
      .notNull()
      .references(() => viagens.id, { onDelete: "restrict" }),
    filial: centroCustoEnum("filial").notNull(),
    situacao: situacaoCaixaEnum("situacao").notNull().default("rascunho"),
    /** Gravado na confirmação. */
    custoTotal: centavos("custo_total"),
    confirmadaEm: timestamp("confirmada_em", { withTimezone: true }),
    confirmadaPor: uuid("confirmada_por").references(() => usuarios.id, { onDelete: "restrict" }),
    canceladaEm: timestamp("cancelada_em", { withTimezone: true }),
    canceladaPor: uuid("cancelada_por").references(() => usuarios.id, { onDelete: "restrict" }),
    motivoCancelamento: text("motivo_cancelamento"),
    criadoPor: uuid("criado_por")
      .notNull()
      .references(() => usuarios.id, { onDelete: "restrict" }),
    criadoEm: timestamp("criado_em", { withTimezone: true }).notNull().defaultNow(),
    atualizadoEm: timestamp("atualizado_em", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Uma caixa não cancelada por viagem.
    uniqueIndex("caixas_experiencia_viagem_ativa_unico").on(t.viagemId).where(sql`${t.situacao} <> 'cancelada'`),
    check("caixas_experiencia_custo_total", sql`${t.custoTotal} IS NULL OR ${t.custoTotal} >= 0`),
    // Confirmada: custo, data e quem gravados; rascunho: nenhum deles.
    check(
      "caixas_experiencia_confirmacao",
      sql`(${t.situacao} = 'confirmada' AND ${t.custoTotal} IS NOT NULL AND ${t.confirmadaEm} IS NOT NULL AND ${t.confirmadaPor} IS NOT NULL)
        OR (${t.situacao} = 'rascunho' AND ${t.custoTotal} IS NULL AND ${t.confirmadaEm} IS NULL AND ${t.confirmadaPor} IS NULL)
        OR ${t.situacao} = 'cancelada'`,
    ),
    // Cancelada: data, quem e motivo; as outras não os têm.
    check(
      "caixas_experiencia_cancelamento",
      sql`(${t.situacao} = 'cancelada' AND ${t.canceladaEm} IS NOT NULL AND ${t.canceladaPor} IS NOT NULL AND ${t.motivoCancelamento} IS NOT NULL)
        OR (${t.situacao} <> 'cancelada' AND ${t.canceladaEm} IS NULL AND ${t.canceladaPor} IS NULL AND ${t.motivoCancelamento} IS NULL)`,
    ),
  ],
);

export const caixaItens = pgTable(
  "caixa_itens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caixaId: uuid("caixa_id")
      .notNull()
      .references(() => caixasExperiencia.id, { onDelete: "restrict" }),
    produtoId: uuid("produto_id")
      .notNull()
      .references(() => produtosEstoque.id, { onDelete: "restrict" }),
    quantidade: integer("quantidade").notNull(),
    /** Nulo no rascunho; o custo médio da filial no instante da confirmação. */
    custoUnitario: centavos("custo_unitario"),
  },
  (t) => [
    unique("caixa_itens_caixa_produto_unico").on(t.caixaId, t.produtoId),
    check("caixa_itens_quantidade", sql`${t.quantidade} >= 1`),
    check("caixa_itens_custo_unitario", sql`${t.custoUnitario} IS NULL OR ${t.custoUnitario} >= 0`),
  ],
);
