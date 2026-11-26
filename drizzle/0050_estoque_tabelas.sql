CREATE TABLE "caixa_itens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caixa_id" uuid NOT NULL,
	"produto_id" uuid NOT NULL,
	"quantidade" integer NOT NULL,
	"custo_unitario" bigint,
	CONSTRAINT "caixa_itens_caixa_produto_unico" UNIQUE("caixa_id","produto_id"),
	CONSTRAINT "caixa_itens_quantidade" CHECK ("caixa_itens"."quantidade" >= 1),
	CONSTRAINT "caixa_itens_custo_unitario" CHECK ("caixa_itens"."custo_unitario" IS NULL OR "caixa_itens"."custo_unitario" >= 0)
);
--> statement-breakpoint
CREATE TABLE "caixas_experiencia" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"filial" "centro_custo" NOT NULL,
	"situacao" "situacao_caixa" DEFAULT 'rascunho' NOT NULL,
	"custo_total" bigint,
	"confirmada_em" timestamp with time zone,
	"confirmada_por" uuid,
	"cancelada_em" timestamp with time zone,
	"cancelada_por" uuid,
	"motivo_cancelamento" text,
	"criado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "caixas_experiencia_custo_total" CHECK ("caixas_experiencia"."custo_total" IS NULL OR "caixas_experiencia"."custo_total" >= 0),
	CONSTRAINT "caixas_experiencia_confirmacao" CHECK (("caixas_experiencia"."situacao" = 'confirmada' AND "caixas_experiencia"."custo_total" IS NOT NULL AND "caixas_experiencia"."confirmada_em" IS NOT NULL AND "caixas_experiencia"."confirmada_por" IS NOT NULL)
        OR ("caixas_experiencia"."situacao" = 'rascunho' AND "caixas_experiencia"."custo_total" IS NULL AND "caixas_experiencia"."confirmada_em" IS NULL AND "caixas_experiencia"."confirmada_por" IS NULL)
        OR "caixas_experiencia"."situacao" = 'cancelada'),
	CONSTRAINT "caixas_experiencia_cancelamento" CHECK (("caixas_experiencia"."situacao" = 'cancelada' AND "caixas_experiencia"."cancelada_em" IS NOT NULL AND "caixas_experiencia"."cancelada_por" IS NOT NULL AND "caixas_experiencia"."motivo_cancelamento" IS NOT NULL)
        OR ("caixas_experiencia"."situacao" <> 'cancelada' AND "caixas_experiencia"."cancelada_em" IS NULL AND "caixas_experiencia"."cancelada_por" IS NULL AND "caixas_experiencia"."motivo_cancelamento" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "estoque_movimentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"produto_id" uuid NOT NULL,
	"filial" "centro_custo" NOT NULL,
	"tipo" "tipo_movimento_estoque" NOT NULL,
	"quantidade" integer NOT NULL,
	"custo_unitario" bigint NOT NULL,
	"custo_medio_antes" bigint NOT NULL,
	"fornecedor_id" uuid,
	"fornecedor_texto" text,
	"lancamento_id" uuid,
	"caixa_id" uuid,
	"motivo" text,
	"usuario_id" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "estoque_movimentos_quantidade" CHECK ("estoque_movimentos"."quantidade" <> 0),
	CONSTRAINT "estoque_movimentos_custos" CHECK ("estoque_movimentos"."custo_unitario" >= 0 AND "estoque_movimentos"."custo_medio_antes" >= 0),
	CONSTRAINT "estoque_movimentos_um_fornecedor" CHECK (num_nonnulls("estoque_movimentos"."fornecedor_id", "estoque_movimentos"."fornecedor_texto") <= 1),
	CONSTRAINT "estoque_movimentos_fornecedor_so_entrada" CHECK ("estoque_movimentos"."tipo" = 'entrada' OR num_nonnulls("estoque_movimentos"."fornecedor_id", "estoque_movimentos"."fornecedor_texto") = 0),
	CONSTRAINT "estoque_movimentos_motivo" CHECK ("estoque_movimentos"."tipo" NOT IN ('saida', 'ajuste') OR ("estoque_movimentos"."motivo" IS NOT NULL AND char_length("estoque_movimentos"."motivo") BETWEEN 5 AND 200))
);
--> statement-breakpoint
CREATE TABLE "estoque_saldos" (
	"produto_id" uuid NOT NULL,
	"filial" "centro_custo" NOT NULL,
	"quantidade" integer DEFAULT 0 NOT NULL,
	"custo_medio" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "estoque_saldos_pk" PRIMARY KEY("produto_id","filial"),
	CONSTRAINT "estoque_saldos_quantidade" CHECK ("estoque_saldos"."quantidade" >= 0),
	CONSTRAINT "estoque_saldos_custo_medio" CHECK ("estoque_saldos"."custo_medio" >= 0)
);
--> statement-breakpoint
CREATE TABLE "produtos_estoque" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"uso" "uso_estoque" NOT NULL,
	"minimo_mt" integer DEFAULT 0 NOT NULL,
	"minimo_rs" integer DEFAULT 0 NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "produtos_estoque_minimos" CHECK ("produtos_estoque"."minimo_mt" >= 0 AND "produtos_estoque"."minimo_rs" >= 0)
);
--> statement-breakpoint
ALTER TABLE "lancamentos" ADD COLUMN "estoque_movimento_id" uuid;--> statement-breakpoint
ALTER TABLE "caixa_itens" ADD CONSTRAINT "caixa_itens_caixa_id_caixas_experiencia_id_fk" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas_experiencia"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixa_itens" ADD CONSTRAINT "caixa_itens_produto_id_produtos_estoque_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos_estoque"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas_experiencia" ADD CONSTRAINT "caixas_experiencia_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas_experiencia" ADD CONSTRAINT "caixas_experiencia_confirmada_por_usuarios_id_fk" FOREIGN KEY ("confirmada_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas_experiencia" ADD CONSTRAINT "caixas_experiencia_cancelada_por_usuarios_id_fk" FOREIGN KEY ("cancelada_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caixas_experiencia" ADD CONSTRAINT "caixas_experiencia_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ADD CONSTRAINT "estoque_movimentos_produto_id_produtos_estoque_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos_estoque"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ADD CONSTRAINT "estoque_movimentos_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ADD CONSTRAINT "estoque_movimentos_lancamento_id_lancamentos_id_fk" FOREIGN KEY ("lancamento_id") REFERENCES "public"."lancamentos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ADD CONSTRAINT "estoque_movimentos_caixa_id_caixas_experiencia_id_fk" FOREIGN KEY ("caixa_id") REFERENCES "public"."caixas_experiencia"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ADD CONSTRAINT "estoque_movimentos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estoque_saldos" ADD CONSTRAINT "estoque_saldos_produto_id_produtos_estoque_id_fk" FOREIGN KEY ("produto_id") REFERENCES "public"."produtos_estoque"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "caixas_experiencia_viagem_ativa_unico" ON "caixas_experiencia" USING btree ("viagem_id") WHERE "caixas_experiencia"."situacao" <> 'cancelada';--> statement-breakpoint
CREATE INDEX "estoque_movimentos_produto_filial_idx" ON "estoque_movimentos" USING btree ("produto_id","filial","criado_em");--> statement-breakpoint
CREATE INDEX "estoque_movimentos_caixa_idx" ON "estoque_movimentos" USING btree ("caixa_id");--> statement-breakpoint
CREATE UNIQUE INDEX "produtos_estoque_nome_ativo_unico" ON "produtos_estoque" USING btree (lower("nome")) WHERE "produtos_estoque"."ativo";--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_estoque_movimento_id_estoque_movimentos_id_fk" FOREIGN KEY ("estoque_movimento_id") REFERENCES "public"."estoque_movimentos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lancamentos_estoque_movimento_idx" ON "lancamentos" USING btree ("estoque_movimento_id");