CREATE TABLE "reembolsos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"conta_pagar_id" uuid,
	"servico" text NOT NULL,
	"fornecedor_id" uuid,
	"ocorrido_em" date NOT NULL,
	"ocorrido" text NOT NULL,
	"valor_cobrar" bigint NOT NULL,
	"valor_devolver" bigint NOT NULL,
	"forma_devolucao" "forma_devolucao" NOT NULL,
	"prazo_cliente" date NOT NULL,
	"previsto_fornecedor" date,
	"pedido_em" date,
	"protocolo" text,
	"reembolsado_em" date,
	"cancelado_em" timestamp with time zone,
	"cancelado_por" uuid,
	"motivo_cancelamento" text,
	"criado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reembolsos_valores" CHECK ("reembolsos"."valor_cobrar" >= 0 AND "reembolsos"."valor_devolver" >= 0 AND ("reembolsos"."valor_cobrar" > 0 OR "reembolsos"."valor_devolver" > 0)),
	CONSTRAINT "reembolsos_previsto" CHECK ("reembolsos"."valor_cobrar" = 0 OR "reembolsos"."previsto_fornecedor" IS NOT NULL),
	CONSTRAINT "reembolsos_ocorrido" CHECK (char_length("reembolsos"."ocorrido") BETWEEN 10 AND 1000),
	CONSTRAINT "reembolsos_cancelamento" CHECK (("reembolsos"."cancelado_em" IS NULL AND "reembolsos"."cancelado_por" IS NULL AND "reembolsos"."motivo_cancelamento" IS NULL)
        OR ("reembolsos"."cancelado_em" IS NOT NULL AND "reembolsos"."cancelado_por" IS NOT NULL AND "reembolsos"."motivo_cancelamento" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "reembolsos" ADD CONSTRAINT "reembolsos_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reembolsos" ADD CONSTRAINT "reembolsos_conta_pagar_id_contas_pagar_id_fk" FOREIGN KEY ("conta_pagar_id") REFERENCES "public"."contas_pagar"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reembolsos" ADD CONSTRAINT "reembolsos_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reembolsos" ADD CONSTRAINT "reembolsos_cancelado_por_usuarios_id_fk" FOREIGN KEY ("cancelado_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reembolsos" ADD CONSTRAINT "reembolsos_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lancamentos" ADD CONSTRAINT "lancamentos_reembolso_id_reembolsos_id_fk" FOREIGN KEY ("reembolso_id") REFERENCES "public"."reembolsos"("id") ON DELETE restrict ON UPDATE no action;