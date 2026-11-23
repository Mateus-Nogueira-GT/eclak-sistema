-- RLS ligado em todas as tabelas de public, sem políticas para anon/authenticated.
-- O acesso a dados é só pelo servidor (conexão direta, que ignora RLS).
-- Regra: toda migração nova que cria tabela termina com o `enable row level security` dela.
ALTER TABLE "usuarios" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auditoria" ENABLE ROW LEVEL SECURITY;
