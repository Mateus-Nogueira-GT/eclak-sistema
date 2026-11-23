CREATE TABLE "anexos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dono_tipo" text NOT NULL,
	"dono_id" uuid NOT NULL,
	"caminho" text NOT NULL,
	"nome" text NOT NULL,
	"mime" text NOT NULL,
	"tamanho" integer NOT NULL,
	"enviado_por" uuid NOT NULL,
	"enviado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone,
	CONSTRAINT "anexos_caminho_unique" UNIQUE("caminho"),
	CONSTRAINT "anexos_dono_tipo" CHECK ("anexos"."dono_tipo" IN ('manual', 'parcela', 'pagamento', 'comissao', 'fatura_cartao', 'nota_fiscal')),
	CONSTRAINT "anexos_tamanho" CHECK ("anexos"."tamanho" BETWEEN 1 AND 10485760)
);
--> statement-breakpoint
ALTER TABLE "anexos" ADD CONSTRAINT "anexos_enviado_por_usuarios_id_fk" FOREIGN KEY ("enviado_por") REFERENCES "public"."usuarios"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "anexos_dono_idx" ON "anexos" USING btree ("dono_tipo","dono_id") WHERE "anexos"."excluido_em" IS NULL;