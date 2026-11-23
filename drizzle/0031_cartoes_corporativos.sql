CREATE TABLE "cartoes_corporativos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"final" char(4) NOT NULL,
	"dia_fechamento" smallint NOT NULL,
	"dia_vencimento" smallint NOT NULL,
	"conta_bancaria_id" uuid NOT NULL,
	"centro" "centro_custo" NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cartoes_corporativos_final" CHECK ("cartoes_corporativos"."final" ~ '^[0-9]{4}$'),
	CONSTRAINT "cartoes_corporativos_dias" CHECK ("cartoes_corporativos"."dia_fechamento" BETWEEN 1 AND 28 AND "cartoes_corporativos"."dia_vencimento" BETWEEN 1 AND 28)
);
--> statement-breakpoint
CREATE TABLE "faturas_cartao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cartao_id" uuid NOT NULL,
	"fechamento" date NOT NULL,
	"vencimento" date NOT NULL,
	"status" "status_lancamento" DEFAULT 'em_aberto' NOT NULL,
	"pago_em" date,
	"valor_pago" bigint,
	"conta_bancaria_id" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "faturas_cartao_cartao_fechamento_unico" UNIQUE("cartao_id","fechamento"),
	CONSTRAINT "faturas_cartao_id_cartao_unico" UNIQUE("id","cartao_id"),
	CONSTRAINT "faturas_cartao_valor_pago" CHECK ("faturas_cartao"."valor_pago" IS NULL OR "faturas_cartao"."valor_pago" >= 0),
	CONSTRAINT "faturas_cartao_baixa" CHECK (("faturas_cartao"."status" = 'baixado' AND "faturas_cartao"."pago_em" IS NOT NULL AND "faturas_cartao"."valor_pago" IS NOT NULL AND "faturas_cartao"."conta_bancaria_id" IS NOT NULL)
        OR ("faturas_cartao"."status" <> 'baixado' AND "faturas_cartao"."pago_em" IS NULL AND "faturas_cartao"."valor_pago" IS NULL AND "faturas_cartao"."conta_bancaria_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "categorias_financeiras" DROP CONSTRAINT "categorias_financeiras_sistema";--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD COLUMN "cartao_id" uuid;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD COLUMN "fatura_cartao_id" uuid;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD COLUMN "cartao_id" uuid;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD COLUMN "fatura_cartao_id" uuid;--> statement-breakpoint
ALTER TABLE "cartoes_corporativos" ADD CONSTRAINT "cartoes_corporativos_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas_cartao" ADD CONSTRAINT "faturas_cartao_cartao_id_cartoes_corporativos_id_fk" FOREIGN KEY ("cartao_id") REFERENCES "public"."cartoes_corporativos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faturas_cartao" ADD CONSTRAINT "faturas_cartao_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cartoes_corporativos_nome_ativo_unico" ON "cartoes_corporativos" USING btree ("nome") WHERE "cartoes_corporativos"."ativo";--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD CONSTRAINT "pagamentos_fornecedor_cartao_id_cartoes_corporativos_id_fk" FOREIGN KEY ("cartao_id") REFERENCES "public"."cartoes_corporativos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD CONSTRAINT "pagamentos_fornecedor_fatura_cartao_fk" FOREIGN KEY ("fatura_cartao_id","cartao_id") REFERENCES "public"."faturas_cartao"("id","cartao_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_cartao_id_cartoes_corporativos_id_fk" FOREIGN KEY ("cartao_id") REFERENCES "public"."cartoes_corporativos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_fatura_cartao_fk" FOREIGN KEY ("fatura_cartao_id","cartao_id") REFERENCES "public"."faturas_cartao"("id","cartao_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pagamentos_fornecedor_fatura_cartao_idx" ON "pagamentos_fornecedor" USING btree ("fatura_cartao_id");--> statement-breakpoint
CREATE INDEX "lancamentos_fatura_cartao_idx" ON "lancamentos" USING btree ("fatura_cartao_id");--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD CONSTRAINT "pagamentos_fornecedor_fatura_com_cartao" CHECK ("pagamentos_fornecedor"."fatura_cartao_id" IS NULL OR "pagamentos_fornecedor"."cartao_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "categorias_financeiras" ADD CONSTRAINT "categorias_financeiras_sistema" CHECK ("categorias_financeiras"."sistema" IS NULL OR "categorias_financeiras"."sistema" IN ('vendas_viagem', 'fornecedores_viagem', 'comissoes_hotel', 'comissoes_operadora', 'cartao_corporativo'));--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_fatura_com_cartao" CHECK ("lancamentos"."fatura_cartao_id" IS NULL OR "lancamentos"."cartao_id" IS NOT NULL);