-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "integracao_envios" ENABLE ROW LEVEL SECURITY;
