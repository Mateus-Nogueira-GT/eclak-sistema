-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "extratos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "extrato_transacoes" ENABLE ROW LEVEL SECURITY;
