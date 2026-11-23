ALTER TABLE "pessoas" ADD COLUMN "atualizado_em" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pessoas" ADD COLUMN "removido_em" timestamp with time zone;