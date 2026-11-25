CREATE TYPE "public"."situacao_caixa" AS ENUM('rascunho', 'confirmada', 'cancelada');--> statement-breakpoint
CREATE TYPE "public"."tipo_movimento_estoque" AS ENUM('entrada', 'saida', 'ajuste', 'caixa', 'devolucao_caixa');--> statement-breakpoint
CREATE TYPE "public"."uso_estoque" AS ENUM('caixa_experiencia', 'papelaria');