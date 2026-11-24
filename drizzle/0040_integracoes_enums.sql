CREATE TYPE "public"."integracao_fila" AS ENUM('trello', 'drive');--> statement-breakpoint
CREATE TYPE "public"."situacao_envio" AS ENUM('pendente', 'enviando', 'enviado', 'falhou');