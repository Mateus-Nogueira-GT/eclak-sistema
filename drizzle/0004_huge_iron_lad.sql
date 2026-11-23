CREATE TYPE "public"."modalidade_fornecedor" AS ENUM('net', 'comissionado');--> statement-breakpoint
CREATE TYPE "public"."tipo_servico" AS ENUM('Hotelaria', 'Transfer', 'Trem', 'Carro', 'Ingresso', 'Passeio guiado', 'Seguro', 'Restaurante', 'Operadora', 'Aéreo', 'Taxa', 'Outro');--> statement-breakpoint
CREATE TABLE "fornecedores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nome" text NOT NULL,
	"tipos" "tipo_servico"[] NOT NULL,
	"cidade" text,
	"modalidade" "modalidade_fornecedor" NOT NULL,
	"comissao_pct" numeric(6, 3) DEFAULT 0 NOT NULL,
	"tarifa_fixa" bigint DEFAULT 0 NOT NULL,
	"desconto_a_vista" text,
	"operacao_financeira_operadora" text,
	"contato_nome" text,
	"contato_telefone" text,
	"contato_email" text,
	"plantao" text,
	"observacoes" text,
	"criado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"atualizado_em" timestamp with time zone DEFAULT now() NOT NULL,
	"excluido_em" timestamp with time zone
);
