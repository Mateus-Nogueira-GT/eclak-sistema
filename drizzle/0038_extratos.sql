CREATE TABLE "extrato_transacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"extrato_id" uuid NOT NULL,
	"conta_bancaria_id" uuid NOT NULL,
	"fitid" text NOT NULL,
	"data" date NOT NULL,
	"valor" bigint NOT NULL,
	"tipo" text,
	"descricao" text NOT NULL,
	"situacao" "situacao_extrato" DEFAULT 'pendente' NOT NULL,
	"linha_origem" text,
	"linha_id" uuid,
	"conciliada_por" uuid,
	"conciliada_em" timestamp with time zone,
	"ignorada_motivo" text,
	"ignorada_por" uuid,
	"ignorada_em" timestamp with time zone,
	CONSTRAINT "extrato_transacoes_conta_fitid_unico" UNIQUE("conta_bancaria_id","fitid"),
	CONSTRAINT "extrato_transacoes_linha_origem" CHECK ("extrato_transacoes"."linha_origem" IS NULL OR "extrato_transacoes"."linha_origem" IN ('manual', 'parcela', 'pagamento', 'comissao', 'fatura_cartao')),
	CONSTRAINT "extrato_transacoes_conciliada_coerente" CHECK (("extrato_transacoes"."situacao" = 'conciliada') = ("extrato_transacoes"."linha_origem" IS NOT NULL AND "extrato_transacoes"."linha_id" IS NOT NULL AND "extrato_transacoes"."conciliada_por" IS NOT NULL AND "extrato_transacoes"."conciliada_em" IS NOT NULL)
        AND ("extrato_transacoes"."situacao" = 'conciliada' OR ("extrato_transacoes"."linha_origem" IS NULL AND "extrato_transacoes"."linha_id" IS NULL AND "extrato_transacoes"."conciliada_por" IS NULL AND "extrato_transacoes"."conciliada_em" IS NULL))),
	CONSTRAINT "extrato_transacoes_ignorada_coerente" CHECK (("extrato_transacoes"."situacao" = 'ignorada') = ("extrato_transacoes"."ignorada_motivo" IS NOT NULL AND length(btrim("extrato_transacoes"."ignorada_motivo")) > 0 AND "extrato_transacoes"."ignorada_por" IS NOT NULL AND "extrato_transacoes"."ignorada_em" IS NOT NULL)
        AND ("extrato_transacoes"."situacao" = 'ignorada' OR ("extrato_transacoes"."ignorada_motivo" IS NULL AND "extrato_transacoes"."ignorada_por" IS NULL AND "extrato_transacoes"."ignorada_em" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "extratos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conta_bancaria_id" uuid NOT NULL,
	"arquivo_nome" text NOT NULL,
	"arquivo_hash" text NOT NULL,
	"banco_ofx" text,
	"conta_ofx" text,
	"inicio" date,
	"fim" date,
	"transacoes" integer NOT NULL,
	"repetidas" integer NOT NULL,
	"importado_por" uuid NOT NULL,
	"importado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extratos_conta_hash_unico" UNIQUE("conta_bancaria_id","arquivo_hash"),
	CONSTRAINT "extratos_contagens" CHECK ("extratos"."transacoes" >= 0 AND "extratos"."repetidas" >= 0)
);
--> statement-breakpoint
ALTER TABLE "extrato_transacoes" ADD CONSTRAINT "extrato_transacoes_extrato_id_extratos_id_fk" FOREIGN KEY ("extrato_id") REFERENCES "public"."extratos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extrato_transacoes" ADD CONSTRAINT "extrato_transacoes_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extrato_transacoes" ADD CONSTRAINT "extrato_transacoes_conciliada_por_usuarios_id_fk" FOREIGN KEY ("conciliada_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extrato_transacoes" ADD CONSTRAINT "extrato_transacoes_ignorada_por_usuarios_id_fk" FOREIGN KEY ("ignorada_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extratos" ADD CONSTRAINT "extratos_conta_bancaria_id_contas_bancarias_id_fk" FOREIGN KEY ("conta_bancaria_id") REFERENCES "public"."contas_bancarias"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extratos" ADD CONSTRAINT "extratos_importado_por_usuarios_id_fk" FOREIGN KEY ("importado_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extrato_transacoes_linha_unica" ON "extrato_transacoes" USING btree ("linha_origem","linha_id") WHERE "extrato_transacoes"."situacao" = 'conciliada';--> statement-breakpoint
CREATE INDEX "extrato_transacoes_conta_data_idx" ON "extrato_transacoes" USING btree ("conta_bancaria_id","data");--> statement-breakpoint
CREATE INDEX "extrato_transacoes_extrato_idx" ON "extrato_transacoes" USING btree ("extrato_id");