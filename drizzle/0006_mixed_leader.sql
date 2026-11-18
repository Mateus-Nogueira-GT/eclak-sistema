CREATE TYPE "public"."tipo_cliente" AS ENUM('familia', 'casal', 'individual', 'grupo');--> statement-breakpoint
CREATE SEQUENCE "public"."cliente_codigo_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"codigo" integer DEFAULT nextval('cliente_codigo_seq') NOT NULL,
	"grupo" text NOT NULL,
	"tipo" "tipo_cliente" NOT NULL,
	"filial" "filial" NOT NULL,
	"telefone" text NOT NULL,
	"email" text,
	"pref_quarto" text,
	"pref_alimentacao" text,
	"pref_assento" text,
	"observacoes" text,
	"cliente_desde" date DEFAULT current_date NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	CONSTRAINT "clientes_codigo_unique" UNIQUE("codigo")
);
--> statement-breakpoint
CREATE TABLE "pessoas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"titular" boolean DEFAULT false NOT NULL,
	"ordem" integer NOT NULL,
	"nome" text NOT NULL,
	"parentesco" text,
	"nascimento" date,
	"cpf" text,
	"passaporte" text,
	"validade_passaporte" date
);
--> statement-breakpoint
ALTER TABLE "pessoas" ADD CONSTRAINT "pessoas_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;