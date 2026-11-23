-- Fatia 4b: RLS ligado em anexos, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "anexos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- Bucket privado dos anexos no Supabase Storage. Sem políticas em storage.objects: só a service role do servidor
-- lê e grava; o navegador baixa por URL assinada de 60 s. Limites do bucket iguais aos conferidos na action.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('anexos', 'anexos', false, 10485760, ARRAY['application/pdf', 'image/png', 'image/jpeg'])
ON CONFLICT (id) DO NOTHING;
