CREATE TABLE "integracao_envios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integracao" "integracao_fila" NOT NULL,
	"tipo" text NOT NULL,
	"viagem_id" uuid,
	"chave" text NOT NULL,
	"payload" jsonb NOT NULL,
	"situacao" "situacao_envio" DEFAULT 'pendente' NOT NULL,
	"tentativas" integer DEFAULT 0 NOT NULL,
	"proxima_em" timestamp with time zone DEFAULT now() NOT NULL,
	"tomado_em" timestamp with time zone,
	"ultimo_erro" jsonb,
	"resultado" jsonb,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"enviado_em" timestamp with time zone,
	CONSTRAINT "integracao_envios_chave_unica" UNIQUE("integracao","chave"),
	CONSTRAINT "integracao_envios_tentativas" CHECK ("integracao_envios"."tentativas" >= 0),
	CONSTRAINT "integracao_envios_enviado_coerente" CHECK (("integracao_envios"."situacao" = 'enviado') = ("integracao_envios"."enviado_em" IS NOT NULL)),
	CONSTRAINT "integracao_envios_enviando_coerente" CHECK ("integracao_envios"."situacao" <> 'enviando' OR "integracao_envios"."tomado_em" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "integracao_envios" ADD CONSTRAINT "integracao_envios_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integracao_envios_situacao_proxima_idx" ON "integracao_envios" USING btree ("situacao","proxima_em");