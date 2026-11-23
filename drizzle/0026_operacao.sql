CREATE TYPE "public"."categoria_tarefa" AS ENUM('ingressos', 'transfers_passeios', 'restaurantes', 'hoteis_carro_voos', 'conferir', 'envio');--> statement-breakpoint
CREATE TYPE "public"."estado_daily" AS ENUM('pendente', 'gerado', 'revisado', 'enviado');--> statement-breakpoint
CREATE TYPE "public"."idioma_destino" AS ENUM('italiano', 'espanhol', 'frances', 'ingles', 'alemao', 'portugues');--> statement-breakpoint
CREATE TYPE "public"."origem_tarefa" AS ENUM('manual', 'venda', 'roteiro');--> statement-breakpoint
CREATE TYPE "public"."prazo_tarefa" AS ENUM('data', 'dias_antes');--> statement-breakpoint
CREATE TYPE "public"."status_roteiro" AS ENUM('rascunho', 'aguardando_cliente', 'aprovado');--> statement-breakpoint
CREATE TABLE "dailies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"roteiro_id" uuid NOT NULL,
	"data" date NOT NULL,
	"estado" "estado_daily" DEFAULT 'pendente' NOT NULL,
	"texto" text,
	"gerado_em" timestamp with time zone,
	"gerado_por" uuid,
	"revisado_em" timestamp with time zone,
	"revisado_por" uuid,
	"enviado_em" timestamp with time zone,
	"enviado_por" uuid,
	"plantao_id" uuid,
	"interno" text,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dailies_roteiro_data_unico" UNIQUE("roteiro_id","data")
);
--> statement-breakpoint
CREATE TABLE "roteiros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"status" "status_roteiro" DEFAULT 'rascunho' NOT NULL,
	"idioma" "idioma_destino" NOT NULL,
	"fuso" text NOT NULL,
	"abertura" text DEFAULT '' NOT NULL,
	"conteudo" jsonb NOT NULL,
	"enviado_cliente_em" timestamp with time zone,
	"enviado_cliente_por" uuid,
	"aprovado_em" timestamp with time zone,
	"aprovado_por" uuid,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roteiros_viagem_id_unique" UNIQUE("viagem_id")
);
--> statement-breakpoint
CREATE TABLE "tarefas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"categoria" "categoria_tarefa" NOT NULL,
	"dia" date,
	"item" text NOT NULL,
	"fazer" text DEFAULT '' NOT NULL,
	"prazo_tipo" "prazo_tarefa",
	"prazo_data" date,
	"prazo_dias" integer,
	"responsavel_id" uuid,
	"customer_care" boolean DEFAULT false NOT NULL,
	"observacao" text,
	"ordem" integer NOT NULL,
	"origem" "origem_tarefa" DEFAULT 'manual' NOT NULL,
	"chave" text,
	"concluida_em" timestamp with time zone,
	"concluida_por" uuid,
	"criado_por" uuid,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dailies" ADD CONSTRAINT "dailies_roteiro_id_roteiros_id_fk" FOREIGN KEY ("roteiro_id") REFERENCES "public"."roteiros"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dailies" ADD CONSTRAINT "dailies_gerado_por_usuarios_id_fk" FOREIGN KEY ("gerado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dailies" ADD CONSTRAINT "dailies_revisado_por_usuarios_id_fk" FOREIGN KEY ("revisado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dailies" ADD CONSTRAINT "dailies_enviado_por_usuarios_id_fk" FOREIGN KEY ("enviado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dailies" ADD CONSTRAINT "dailies_plantao_id_usuarios_id_fk" FOREIGN KEY ("plantao_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roteiros" ADD CONSTRAINT "roteiros_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roteiros" ADD CONSTRAINT "roteiros_enviado_cliente_por_usuarios_id_fk" FOREIGN KEY ("enviado_cliente_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roteiros" ADD CONSTRAINT "roteiros_aprovado_por_usuarios_id_fk" FOREIGN KEY ("aprovado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roteiros" ADD CONSTRAINT "roteiros_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_responsavel_id_usuarios_id_fk" FOREIGN KEY ("responsavel_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_concluida_por_usuarios_id_fk" FOREIGN KEY ("concluida_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;