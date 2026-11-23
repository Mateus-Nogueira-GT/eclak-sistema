CREATE TYPE "public"."centro_custo" AS ENUM('MT', 'RS');--> statement-breakpoint
CREATE TYPE "public"."forma_financeiro" AS ENUM('a_prazo', 'boleto', 'cartao_credito', 'cartao_debito', 'debito_conta', 'deposito', 'dinheiro', 'pix', 'transferencia');--> statement-breakpoint
CREATE TYPE "public"."lado_financeiro" AS ENUM('pagar', 'receber');--> statement-breakpoint
CREATE TYPE "public"."status_lancamento" AS ENUM('em_aberto', 'baixado', 'cancelado');--> statement-breakpoint
CREATE TABLE "categorias_financeiras" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lado" "lado_financeiro" NOT NULL,
	"grupo" text NOT NULL,
	"nome" text NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"sistema" text,
	CONSTRAINT "categorias_financeiras_nome_unico" UNIQUE("lado","grupo","nome"),
	CONSTRAINT "categorias_financeiras_sistema_unico" UNIQUE("sistema"),
	CONSTRAINT "categorias_financeiras_sistema" CHECK ("categorias_financeiras"."sistema" IS NULL OR "categorias_financeiras"."sistema" IN ('vendas_viagem', 'fornecedores_viagem', 'comissoes_hotel', 'comissoes_operadora'))
);
--> statement-breakpoint
CREATE TABLE "contas_bancarias" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"banco" text,
	"saldo_inicial" bigint DEFAULT 0 NOT NULL,
	"saldo_inicial_em" date NOT NULL,
	"ativa" boolean DEFAULT true NOT NULL,
	"excluido_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "faturas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venda_id" uuid NOT NULL,
	"numero" integer NOT NULL,
	"emitida_em" timestamp with time zone DEFAULT now() NOT NULL,
	"emitida_por" uuid NOT NULL,
	CONSTRAINT "faturas_venda_unico" UNIQUE("venda_id"),
	CONSTRAINT "faturas_numero_unico" UNIQUE("numero")
);
--> statement-breakpoint
CREATE TABLE "faturas_contador" (
	"id" smallint PRIMARY KEY NOT NULL,
	"proximo" integer NOT NULL,
	CONSTRAINT "faturas_contador_uma_linha" CHECK ("faturas_contador"."id" = 1),
	CONSTRAINT "faturas_contador_proximo" CHECK ("faturas_contador"."proximo" >= 1)
);
--> statement-breakpoint
CREATE TABLE "faturas_versoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fatura_id" uuid NOT NULL,
	"versao" integer NOT NULL,
	"emitida_em" timestamp with time zone DEFAULT now() NOT NULL,
	"emitida_por" uuid NOT NULL,
	"dados" jsonb NOT NULL,
	CONSTRAINT "faturas_versoes_fatura_versao_unico" UNIQUE("fatura_id","versao")
);
--> statement-breakpoint
CREATE TABLE "lancamentos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lado" "lado_financeiro" NOT NULL,
	"descricao" text NOT NULL,
	"fornecedor_id" uuid,
	"cliente_id" uuid,
	"pessoa_texto" text,
	"categoria_id" uuid NOT NULL,
	"centro" "centro_custo" NOT NULL,
	"competencia" text NOT NULL,
	"emissao" date NOT NULL,
	"vencimento" date NOT NULL,
	"valor" bigint NOT NULL,
	"forma" "forma_financeiro" NOT NULL,
	"conta_bancaria_id" uuid,
	"observacao" text,
	"grupo_id" uuid,
	"parcela_numero" integer,
	"parcela_total" integer,
	"status" "status_lancamento" DEFAULT 'em_aberto' NOT NULL,
	"baixado_em" date,
	"valor_pago" bigint,
	"juros" bigint,
	"desconto" bigint,
	"baixa_conta_bancaria_id" uuid,
	"motivo_cancelamento" text,
	"criado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lancamentos_uma_pessoa" CHECK (num_nonnulls("lancamentos"."fornecedor_id", "lancamentos"."cliente_id", "lancamentos"."pessoa_texto") <= 1),
	CONSTRAINT "lancamentos_competencia" CHECK ("lancamentos"."competencia" ~ '^\d{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "lancamentos_valor" CHECK ("lancamentos"."valor" > 0),
	CONSTRAINT "lancamentos_valores_baixa" CHECK (("lancamentos"."valor_pago" IS NULL OR "lancamentos"."valor_pago" >= 0) AND ("lancamentos"."juros" IS NULL OR "lancamentos"."juros" >= 0) AND ("lancamentos"."desconto" IS NULL OR "lancamentos"."desconto" >= 0)),
	CONSTRAINT "lancamentos_baixa" CHECK (("lancamentos"."status" = 'baixado' AND "lancamentos"."baixado_em" IS NOT NULL AND "lancamentos"."valor_pago" IS NOT NULL AND "lancamentos"."baixa_conta_bancaria_id" IS NOT NULL)
        OR ("lancamentos"."status" <> 'baixado' AND "lancamentos"."baixado_em" IS NULL AND "lancamentos"."valor_pago" IS NULL AND "lancamentos"."baixa_conta_bancaria_id" IS NULL)),
	CONSTRAINT "lancamentos_parcela" CHECK (("lancamentos"."parcela_numero" IS NULL AND "lancamentos"."parcela_total" IS NULL) OR ("lancamentos"."parcela_numero" >= 1 AND "lancamentos"."parcela_total" >= "lancamentos"."parcela_numero"))
);
--> statement-breakpoint
ALTER TABLE "comissoes" ADD COLUMN "conta_bancaria_id" uuid;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD COLUMN "conta_bancaria_id" uuid;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD COLUMN "repasse_parcela_id" uuid;--> statement-breakpoint
ALTER TABLE "parcelas_receber" ADD COLUMN "conta_bancaria_id" uuid;--> statement-breakpoint
ALTER TABLE "vendas" ADD COLUMN "fornecedor_cartao_id" uuid;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_venda_id_vendas_id_fk" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas" ADD CONSTRAINT "faturas_emitida_por_usuarios_id_fk" FOREIGN KEY ("emitida_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas_versoes" ADD CONSTRAINT "faturas_versoes_fatura_id_faturas_id_fk" FOREIGN KEY ("fatura_id") REFERENCES "public"."faturas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas_versoes" ADD CONSTRAINT "faturas_versoes_emitida_por_usuarios_id_fk" FOREIGN KEY ("emitida_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_categoria_id_categorias_financeiras_id_fk" FOREIGN KEY ("categoria_id") REFERENCES "public"."categorias_financeiras"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_baixa_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("baixa_conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contas_bancarias_nome_ativa_unico" ON "contas_bancarias" USING btree ("nome") WHERE "contas_bancarias"."ativa" AND "contas_bancarias"."excluido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "lancamentos_em_aberto_vencimento_idx" ON "lancamentos" USING btree ("vencimento") WHERE "lancamentos"."status" = 'em_aberto';--> statement-breakpoint
CREATE INDEX "lancamentos_grupo_idx" ON "lancamentos" USING btree ("grupo_id");--> statement-breakpoint
CREATE INDEX "lancamentos_categoria_idx" ON "lancamentos" USING btree ("categoria_id");--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD CONSTRAINT "pagamentos_fornecedor_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD CONSTRAINT "pagamentos_fornecedor_repasse_parcela_id_parcelas_receber_id_fk" FOREIGN KEY ("repasse_parcela_id") REFERENCES "public"."parcelas_receber"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcelas_receber" ADD CONSTRAINT "parcelas_receber_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_fornecedor_cartao_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_cartao_id") REFERENCES "public"."fornecedores"("id") ON DELETE restrict ON UPDATE no action;