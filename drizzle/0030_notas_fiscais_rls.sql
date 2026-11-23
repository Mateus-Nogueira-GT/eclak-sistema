-- Fatia 4b: RLS ligado em notas_fiscais, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "notas_fiscais" ENABLE ROW LEVEL SECURITY;
