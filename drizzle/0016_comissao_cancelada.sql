-- Sozinho nesta migração: um valor novo de enum não pode ser usado na mesma transação em que é criado.
-- Comissão cancelada (conta passou a `descontada`): registro financeiro nunca é apagado.
ALTER TYPE "public"."status_comissao" ADD VALUE IF NOT EXISTS 'cancelada';
