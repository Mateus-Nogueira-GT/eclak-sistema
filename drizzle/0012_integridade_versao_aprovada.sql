-- Integridade de viagens.versao_aprovada_id: a versão aprovada é da própria viagem e está aprovada.
-- 1) (viagem_id, id) único em versoes_precificacao, alvo da FK composta.
ALTER TABLE "versoes_precificacao" ADD CONSTRAINT "versoes_viagem_id_unico" UNIQUE ("viagem_id", "id");--> statement-breakpoint
-- 2) A FK simples (0011) vira composta: viagens(id, versao_aprovada_id) -> versoes_precificacao(viagem_id, id).
--    MATCH SIMPLE: com versao_aprovada_id nulo a FK não se aplica.
ALTER TABLE "viagens" DROP CONSTRAINT "viagens_versao_aprovada_id_fk";--> statement-breakpoint
ALTER TABLE "viagens" ADD CONSTRAINT "viagens_versao_aprovada_fk" FOREIGN KEY ("id", "versao_aprovada_id") REFERENCES "public"."versoes_precificacao"("viagem_id", "id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- 3) Só versão aprovada (ou aprovada com ajuste) pode ser a versão aprovada da viagem.
CREATE FUNCTION "public"."viagens_conferir_versao_aprovada"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = ''
AS $$
DECLARE
  st text;
BEGIN
  IF NEW.versao_aprovada_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT v.status::text INTO st FROM public.versoes_precificacao v WHERE v.id = NEW.versao_aprovada_id;
  IF st IS NULL OR st NOT IN ('aprovada', 'aprovada_com_ajuste') THEN
    RAISE EXCEPTION 'versao_aprovada_id deve apontar para uma versão aprovada (status: %)', coalesce(st, 'inexistente')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."viagens_conferir_versao_aprovada"() FROM PUBLIC, anon, authenticated;--> statement-breakpoint
CREATE TRIGGER "viagens_versao_aprovada_status"
  BEFORE INSERT OR UPDATE OF "versao_aprovada_id" ON "viagens"
  FOR EACH ROW EXECUTE FUNCTION "public"."viagens_conferir_versao_aprovada"();
