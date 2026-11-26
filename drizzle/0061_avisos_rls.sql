-- RLS ligado, sem políticas para anon/authenticated (acesso só pelo servidor).
ALTER TABLE "avisos_dispensados" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "avisos_comunicados" ENABLE ROW LEVEL SECURITY;
