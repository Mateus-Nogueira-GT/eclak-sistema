CREATE TABLE "ia_usos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"em" timestamp with time zone DEFAULT now() NOT NULL,
	"recurso" text NOT NULL,
	"modelo" text NOT NULL,
	"tokens_entrada" integer NOT NULL,
	"tokens_saida" integer NOT NULL,
	CONSTRAINT "ia_usos_tokens" CHECK ("ia_usos"."tokens_entrada" >= 0 AND "ia_usos"."tokens_saida" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ia_usos" ADD CONSTRAINT "ia_usos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ia_usos_em_idx" ON "ia_usos" USING btree ("em");