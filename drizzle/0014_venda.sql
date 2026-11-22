CREATE TYPE "public"."comissao_tipo" AS ENUM('descontada', 'a_receber');--> statement-breakpoint
CREATE TYPE "public"."forma_pagamento_fornecedor" AS ENUM('a_vista', 'parcelado', 'cartao_corporativo');--> statement-breakpoint
CREATE TYPE "public"."meio_recebimento" AS ENUM('pix', 'boleto', 'cartao_credito', 'cartao_fornecedor');--> statement-breakpoint
CREATE TYPE "public"."status_comissao" AS ENUM('prevista', 'recebida', 'nao_recebida');--> statement-breakpoint
CREATE TYPE "public"."status_conta" AS ENUM('a_pagar', 'paga', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."status_pagamento" AS ENUM('a_pagar', 'pago');--> statement-breakpoint
CREATE TYPE "public"."status_parcela" AS ENUM('a_receber', 'recebida', 'cancelada');--> statement-breakpoint
CREATE TABLE "comissoes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"conta_id" uuid NOT NULL,
	"fornecedor_id" uuid,
	"base_brl" bigint NOT NULL,
	"pct" numeric(6, 3) NOT NULL,
	"valor_previsto" bigint NOT NULL,
	"prevista_para" date NOT NULL,
	"status" "status_comissao" DEFAULT 'prevista' NOT NULL,
	"recebida_em" date,
	"valor_recebido" bigint,
	"motivo" text,
	CONSTRAINT "comissoes_valores" CHECK ("comissoes"."base_brl" >= 0 AND "comissoes"."valor_previsto" >= 0 AND ("comissoes"."valor_recebido" IS NULL OR "comissoes"."valor_recebido" >= 0))
);
--> statement-breakpoint
CREATE TABLE "contas_pagar" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"cotacao_id" uuid NOT NULL,
	"fornecedor_id" uuid,
	"descricao" text NOT NULL,
	"aereo" boolean DEFAULT false NOT NULL,
	"moeda" "moeda" NOT NULL,
	"valor_original" bigint NOT NULL,
	"cambio_aplicado" numeric(10, 4),
	"previsto_venda_brl" bigint NOT NULL,
	"previsto_brl" bigint NOT NULL,
	"comissao_pct" numeric(6, 3) DEFAULT 0 NOT NULL,
	"comissao_tipo" "comissao_tipo" NOT NULL,
	"desconto_a_vista_pct" numeric(6, 3),
	"forma" "forma_pagamento_fornecedor",
	"status" "status_conta" DEFAULT 'a_pagar' NOT NULL,
	"contestacao" text,
	"contestada_em" timestamp with time zone,
	"motivo_previsto" text,
	"excluido_em" timestamp with time zone,
	CONSTRAINT "contas_pagar_valores" CHECK ("contas_pagar"."valor_original" >= 0 AND "contas_pagar"."previsto_venda_brl" >= 0 AND "contas_pagar"."previsto_brl" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pagamentos_fornecedor" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conta_id" uuid NOT NULL,
	"numero" integer NOT NULL,
	"vencimento" date NOT NULL,
	"valor_original" bigint NOT NULL,
	"valor_brl_previsto" bigint NOT NULL,
	"status" "status_pagamento" DEFAULT 'a_pagar' NOT NULL,
	"pago_em" date,
	"valor_original_pago" bigint,
	"cambio_efetivo" numeric(10, 4),
	"valor_brl_pago" bigint,
	CONSTRAINT "pagamentos_fornecedor_valores" CHECK ("pagamentos_fornecedor"."valor_original" >= 0 AND "pagamentos_fornecedor"."valor_brl_previsto" >= 0 AND ("pagamentos_fornecedor"."valor_original_pago" IS NULL OR "pagamentos_fornecedor"."valor_original_pago" >= 0) AND ("pagamentos_fornecedor"."valor_brl_pago" IS NULL OR "pagamentos_fornecedor"."valor_brl_pago" >= 0))
);
--> statement-breakpoint
CREATE TABLE "parcelas_receber" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"venda_id" uuid NOT NULL,
	"numero" integer NOT NULL,
	"total_parcelas" integer NOT NULL,
	"vencimento" date NOT NULL,
	"valor" bigint NOT NULL,
	"meio" "meio_recebimento" NOT NULL,
	"taxa_prevista" bigint DEFAULT 0 NOT NULL,
	"status" "status_parcela" DEFAULT 'a_receber' NOT NULL,
	"recebida_em" date,
	"valor_recebido" bigint,
	"taxa_efetiva" bigint,
	"observacao" text,
	CONSTRAINT "parcelas_receber_valores" CHECK ("parcelas_receber"."valor" >= 0 AND "parcelas_receber"."taxa_prevista" >= 0 AND ("parcelas_receber"."valor_recebido" IS NULL OR "parcelas_receber"."valor_recebido" >= 0) AND ("parcelas_receber"."taxa_efetiva" IS NULL OR "parcelas_receber"."taxa_efetiva" >= 0))
);
--> statement-breakpoint
CREATE TABLE "vendas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"viagem_id" uuid NOT NULL,
	"versao_id" uuid NOT NULL,
	"aceite_em" date NOT NULL,
	"forma" jsonb NOT NULL,
	"parcelas" integer NOT NULL,
	"primeiro_vencimento" date NOT NULL,
	"total" bigint NOT NULL,
	"fatura_nome" text NOT NULL,
	"fatura_documento" text NOT NULL,
	"comprovante" text,
	"observacao" text,
	"criado_por" uuid NOT NULL,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendas_viagem_unico" UNIQUE("viagem_id"),
	CONSTRAINT "vendas_total_nao_negativo" CHECK ("vendas"."total" >= 0),
	CONSTRAINT "vendas_parcelas_positivas" CHECK ("vendas"."parcelas" >= 1),
	CONSTRAINT "vendas_fatura_documento" CHECK ("vendas"."fatura_documento" ~ '^(\d{11}|\d{14})$')
);
--> statement-breakpoint
ALTER TABLE "viagens" ADD COLUMN "internacional" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "viagens" ADD COLUMN "nota_cliente" text;--> statement-breakpoint
ALTER TABLE "viagens" ADD COLUMN "vendida_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "viagens" ADD COLUMN "conciliada_em" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_conta_id_contas_pagar_id_fk" FOREIGN KEY ("conta_id") REFERENCES "public"."contas_pagar"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comissoes" ADD CONSTRAINT "comissoes_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas_pagar" ADD CONSTRAINT "contas_pagar_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas_pagar" ADD CONSTRAINT "contas_pagar_item_id_itens_viagem_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."itens_viagem"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas_pagar" ADD CONSTRAINT "contas_pagar_cotacao_id_cotacoes_id_fk" FOREIGN KEY ("cotacao_id") REFERENCES "public"."cotacoes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contas_pagar" ADD CONSTRAINT "contas_pagar_fornecedor_id_fornecedores_id_fk" FOREIGN KEY ("fornecedor_id") REFERENCES "public"."fornecedores"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pagamentos_fornecedor" ADD CONSTRAINT "pagamentos_fornecedor_conta_id_contas_pagar_id_fk" FOREIGN KEY ("conta_id") REFERENCES "public"."contas_pagar"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcelas_receber" ADD CONSTRAINT "parcelas_receber_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parcelas_receber" ADD CONSTRAINT "parcelas_receber_venda_id_vendas_id_fk" FOREIGN KEY ("venda_id") REFERENCES "public"."vendas"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_viagem_id_viagens_id_fk" FOREIGN KEY ("viagem_id") REFERENCES "public"."viagens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_versao_id_versoes_precificacao_id_fk" FOREIGN KEY ("versao_id") REFERENCES "public"."versoes_precificacao"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendas" ADD CONSTRAINT "vendas_criado_por_usuarios_id_fk" FOREIGN KEY ("criado_por") REFERENCES "public"."usuarios"("id") ON DELETE no action ON UPDATE no action;