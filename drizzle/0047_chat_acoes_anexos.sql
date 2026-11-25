CREATE TABLE "chat_acoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"tipo" text NOT NULL,
	"viagem_id" uuid,
	"alvo" jsonb NOT NULL,
	"dados" jsonb NOT NULL,
	"situacao" "situacao_chat_acao" DEFAULT 'pendente' NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"decidido_em" timestamp with time zone,
	"tomado_em" timestamp with time zone,
	"resultado" jsonb,
	CONSTRAINT "chat_acoes_tipo" CHECK ("chat_acoes"."tipo" IN ('trello_comentar', 'trello_marcar_item', 'trello_adicionar_item', 'trello_mover_cartao', 'trello_definir_prazo', 'trello_criar_cartao', 'drive_enviar_arquivo', 'drive_criar_pasta', 'drive_renomear', 'drive_mover')),
	CONSTRAINT "chat_acoes_viagem_coerente" CHECK (("chat_acoes"."tipo" = 'trello_criar_cartao') = ("chat_acoes"."viagem_id" IS NULL)),
	CONSTRAINT "chat_acoes_executando_coerente" CHECK ("chat_acoes"."situacao" <> 'executando' OR "chat_acoes"."tomado_em" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "chat_anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"usuario_id" uuid NOT NULL,
	"nome" text NOT NULL,
	"mime" text NOT NULL,
	"tamanho" integer NOT NULL,
	"caminho" text NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"expira_em" timestamp with time zone NOT NULL,
	"usado_em" timestamp with time zone,
	CONSTRAINT "chat_anexos_caminho_unique" UNIQUE("caminho"),
	CONSTRAINT "chat_anexos_tamanho" CHECK ("chat_anexos"."tamanho" BETWEEN 1 AND 5242880)
);
--> statement-breakpoint
ALTER TABLE "chat_acoes" ADD CONSTRAINT "chat_acoes_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_acoes" ADD CONSTRAINT "chat_acoes_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_anexos" ADD CONSTRAINT "chat_anexos_usuario_id_usuarios_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_acoes_usuario_situacao_idx" ON "chat_acoes" USING btree ("usuario_id","situacao");--> statement-breakpoint
CREATE INDEX "chat_acoes_situacao_expira_idx" ON "chat_acoes" USING btree ("situacao","expira_em");--> statement-breakpoint
CREATE INDEX "chat_anexos_usuario_expira_idx" ON "chat_anexos" USING btree ("usuario_id","expira_em");