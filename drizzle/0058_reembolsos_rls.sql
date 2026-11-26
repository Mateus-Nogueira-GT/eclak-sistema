-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "reembolsos" ENABLE ROW LEVEL SECURITY;
