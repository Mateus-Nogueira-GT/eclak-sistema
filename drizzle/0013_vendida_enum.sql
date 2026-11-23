-- Sozinho nesta migração: um valor novo de enum não pode ser usado na mesma transação em que é criado.
ALTER TYPE "public"."status_orcamento" ADD VALUE IF NOT EXISTS 'vendida';
