-- RLS ligado nas cinco tabelas do estoque e da caixa de experiência, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "produtos_estoque" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "estoque_saldos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "estoque_movimentos" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "caixas_experiencia" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "caixa_itens" ENABLE ROW LEVEL SECURITY;
