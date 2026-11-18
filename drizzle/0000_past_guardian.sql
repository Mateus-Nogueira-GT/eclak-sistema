CREATE TYPE "public"."filial" AS ENUM('Rondonópolis', 'RS');--> statement-breakpoint
CREATE TYPE "public"."perfil_usuario" AS ENUM('diretor', 'consultor', 'operacional', 'fin_operacional', 'fin_estrategico');--> statement-breakpoint
CREATE TABLE "usuarios" (
	"id" uuid PRIMARY KEY NOT NULL,
	"nome" text NOT NULL,
	"email" text NOT NULL,
	"perfil" "perfil_usuario" NOT NULL,
	"filial" "filial" NOT NULL,
	"ativo" boolean DEFAULT true NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usuarios_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "auditoria" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"usuario_id" uuid,
	"em" timestamp with time zone DEFAULT now() NOT NULL,
	"tabela" text NOT NULL,
	"registro_id" text NOT NULL,
	"acao" text NOT NULL,
	"antes" jsonb,
	"depois" jsonb
);
