-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "chat_acoes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_anexos" ENABLE ROW LEVEL SECURITY;
