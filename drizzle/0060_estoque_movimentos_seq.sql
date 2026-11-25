-- Fatia 5b: o "último movimento" do par produto/filial passa a ser decidido por `seq` (identidade, lida sob a trava
-- do saldo), não por `criado_em` (`clock_timestamp()`), que um passo do relógio do Postgres pode inverter.
-- `criado_em` fica para exibição. As linhas existentes recebem `seq` na ordem de `criado_em` (e `id`).
DROP INDEX "estoque_movimentos_produto_filial_idx";--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ADD COLUMN "seq" bigint;--> statement-breakpoint
UPDATE "estoque_movimentos" m SET "seq" = o.n
FROM (SELECT "id", row_number() OVER (ORDER BY "criado_em", "id") AS n FROM "estoque_movimentos") o
WHERE o."id" = m."id";--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ALTER COLUMN "seq" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ALTER COLUMN "seq" ADD GENERATED ALWAYS AS IDENTITY (sequence name "estoque_movimentos_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1);--> statement-breakpoint
SELECT setval('"estoque_movimentos_seq_seq"', coalesce(max("seq"), 0) + 1, false) FROM "estoque_movimentos";--> statement-breakpoint
CREATE INDEX "estoque_movimentos_produto_filial_idx" ON "estoque_movimentos" USING btree ("produto_id","filial","seq");
