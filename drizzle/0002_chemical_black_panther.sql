CREATE TABLE "regras_versoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"vigente_desde" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"criado_por" uuid,
	"valores" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "regras_versoes" ADD CONSTRAINT "regras_versoes_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;