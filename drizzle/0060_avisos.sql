CREATE TABLE "avisos_comunicados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"setor" text NOT NULL,
	"texto" text NOT NULL,
	"passo" text,
	"criado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"resolvido_por" uuid,
	"resolvido_em" timestamp with time zone,
	CONSTRAINT "avisos_comunicados_setor" CHECK ("avisos_comunicados"."setor" IN ('Gestão', 'Financeiro', 'Comercial', 'Operacional', 'Geral')),
	CONSTRAINT "avisos_comunicados_texto" CHECK (char_length("avisos_comunicados"."texto") BETWEEN 5 AND 500),
	CONSTRAINT "avisos_comunicados_passo" CHECK ("avisos_comunicados"."passo" IS NULL OR char_length("avisos_comunicados"."passo") <= 200),
	CONSTRAINT "avisos_comunicados_resolucao" CHECK (("avisos_comunicados"."resolvido_em" IS NULL) = ("avisos_comunicados"."resolvido_por" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "avisos_dispensados" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chave" text NOT NULL,
	"tipo" text NOT NULL,
	"titulo" text NOT NULL,
	"detalhe" text NOT NULL,
	"usuario_id" uuid NOT NULL,
	"justificativa" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "avisos_dispensados_justificativa" CHECK (char_length("avisos_dispensados"."justificativa") BETWEEN 10 AND 500)
);
--> statement-breakpoint
ALTER TABLE "avisos_comunicados" ADD CONSTRAINT "avisos_comunicados_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avisos_comunicados" ADD CONSTRAINT "avisos_comunicados_resolvido_por_usuarios_id_fk" FOREIGN KEY ("resolvido_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "avisos_dispensados" ADD CONSTRAINT "avisos_dispensados_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "avisos_comunicados_abertos_idx" ON "avisos_comunicados" USING btree ("setor") WHERE "avisos_comunicados"."resolvido_em" IS NULL;--> statement-breakpoint
CREATE INDEX "avisos_dispensados_criado_idx" ON "avisos_dispensados" USING btree ("criado_em");