CREATE TYPE "public"."moeda" AS ENUM('BRL', 'USD', 'EUR', 'GBP', 'CHF');--> statement-breakpoint
CREATE TYPE "public"."status_orcamento" AS ENUM('em_edicao', 'aguardando_aprovacao', 'aprovado', 'devolvido');--> statement-breakpoint
CREATE TYPE "public"."status_versao" AS ENUM('aguardando', 'aprovada', 'aprovada_com_ajuste', 'devolvida');--> statement-breakpoint
CREATE TYPE "public"."tipo_item" AS ENUM('Hotelaria', 'Trem', 'Transfer', 'Carro', 'Passeio', 'Ingresso', 'Seguro', 'Outro', 'Taxa', 'Aéreo');--> statement-breakpoint
CREATE TABLE "cotacoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"fornecedor_id" uuid,
	"moeda" "moeda" DEFAULT 'BRL' NOT NULL,
	"valor_original" bigint NOT NULL,
	"cambio_comercial" numeric(10, 4),
	"cambio_aplicado" numeric(10, 4),
	"cambio_data" date,
	"valor_brl" bigint NOT NULL,
	"comissao_pct" numeric(6, 3) DEFAULT 0 NOT NULL,
	"desconto_a_vista_pct" numeric(6, 3),
	"tarifa_fixa" bigint DEFAULT 0 NOT NULL,
	"escolhida" boolean DEFAULT false NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "itens_viagem" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"ordem" integer NOT NULL,
	"tipo" "tipo_item" NOT NULL,
	"cidade" text,
	"servico" text NOT NULL,
	"checkin" date,
	"checkout" date,
	"diarias" integer,
	"automatico" boolean DEFAULT false NOT NULL,
	"excluido_em" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "versoes_precificacao" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"numero" integer NOT NULL,
	"status" "status_versao" DEFAULT 'aguardando' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"preco" bigint NOT NULL,
	"forma" jsonb NOT NULL,
	"dias" integer NOT NULL,
	"regras_versao_id" uuid NOT NULL,
	"rateio" text NOT NULL,
	"resultado" jsonb NOT NULL,
	"alteracao" text,
	"enviado_por" uuid NOT NULL,
	"enviado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"decidido_por" uuid,
	"decidido_em" timestamp with time zone,
	"comentario" text,
	CONSTRAINT "versoes_viagem_numero_unico" UNIQUE("viagem_id","numero")
);
--> statement-breakpoint
CREATE TABLE "viagem_passageiros" (
	"viagem_id" uuid NOT NULL,
	"pessoa_id" uuid NOT NULL,
	CONSTRAINT "viagem_passageiros_viagem_id_pessoa_id_pk" PRIMARY KEY("viagem_id","pessoa_id")
);
--> statement-breakpoint
CREATE TABLE "viagens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cliente_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"destino" text NOT NULL,
	"inicio" date NOT NULL,
	"fim" date NOT NULL,
	"filial" "filial" NOT NULL,
	"consultor_id" uuid NOT NULL,
	"status" "status_orcamento" DEFAULT 'em_edicao' NOT NULL,
	"versao_aprovada_id" uuid,
	"observacoes" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	CONSTRAINT "viagens_cliente_seq_unico" UNIQUE("cliente_id","seq"),
	CONSTRAINT "viagens_fim_apos_inicio" CHECK ("viagens"."fim" >= "viagens"."inicio")
);
--> statement-breakpoint
ALTER TABLE "clientes" ADD COLUMN "proxima_viagem" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "cotacoes" ADD CONSTRAINT "cotacoes_item_id_itens_viagem_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."itens_viagem"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cotacoes" ADD CONSTRAINT "cotacoes_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "itens_viagem" ADD CONSTRAINT "itens_viagem_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versoes_precificacao" ADD CONSTRAINT "versoes_precificacao_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versoes_precificacao" ADD CONSTRAINT "versoes_precificacao_regras_versao_id_regras_versoes_id_fk" FOREIGN KEY ("regras_versao_id") REFERENCES "public"."regras_versoes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versoes_precificacao" ADD CONSTRAINT "versoes_precificacao_enviado_por_usuarios_id_fk" FOREIGN KEY ("enviado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "versoes_precificacao" ADD CONSTRAINT "versoes_precificacao_decidido_por_usuarios_id_fk" FOREIGN KEY ("decidido_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viagem_passageiros" ADD CONSTRAINT "viagem_passageiros_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viagem_passageiros" ADD CONSTRAINT "viagem_passageiros_pessoa_id_pessoas_id_fk" FOREIGN KEY ("pessoa_id") REFERENCES "public"."pessoas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viagens" ADD CONSTRAINT "viagens_cliente_id_clientes_id_fk" FOREIGN KEY ("cliente_id") REFERENCES "public"."clientes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "viagens" ADD CONSTRAINT "viagens_consultor_id_usuarios_id_fk" FOREIGN KEY ("consultor_id") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;