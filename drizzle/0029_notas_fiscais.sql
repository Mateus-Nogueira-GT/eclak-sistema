CREATE TABLE "notas_fiscais" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"numero" text NOT NULL,
	"emitida_em" date NOT NULL,
	"competencia" text NOT NULL,
	"valor" bigint NOT NULL,
	"destinatario" text NOT NULL,
	"documento" text,
	"fornecedor_id" uuid,
	"cliente_id" uuid,
	"viagem_id" uuid,
	"observacao" text,
	"status" text DEFAULT 'emitida' NOT NULL,
	"motivo_cancelamento" text,
	"criado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notas_fiscais_valor" CHECK ("notas_fiscais"."valor" > 0),
	CONSTRAINT "notas_fiscais_documento" CHECK ("notas_fiscais"."documento" IS NULL OR "notas_fiscais"."documento" ~ '^([0-9]{11}|[0-9]{14})$'),
	CONSTRAINT "notas_fiscais_competencia" CHECK ("notas_fiscais"."competencia" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
	CONSTRAINT "notas_fiscais_status" CHECK ("notas_fiscais"."status" IN ('emitida', 'cancelada')),
	CONSTRAINT "notas_fiscais_pessoa" CHECK ("notas_fiscais"."fornecedor_id" IS NULL OR "notas_fiscais"."cliente_id" IS NULL),
	CONSTRAINT "notas_fiscais_motivo" CHECK (("notas_fiscais"."status" = 'cancelada') = ("notas_fiscais"."motivo_cancelamento" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "notas_fiscais" ADD CONSTRAINT "notas_fiscais_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_fiscais" ADD CONSTRAINT "notas_fiscais_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_fiscais" ADD CONSTRAINT "notas_fiscais_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notas_fiscais" ADD CONSTRAINT "notas_fiscais_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notas_fiscais_numero_unico" ON "notas_fiscais" USING btree ("numero") WHERE "notas_fiscais"."status" <> 'cancelada';--> statement-breakpoint
CREATE INDEX "notas_fiscais_emitida_idx" ON "notas_fiscais" USING btree ("emitida_em");