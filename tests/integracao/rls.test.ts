import { beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { db } from "@/server/db/client";
import { auditoria } from "@/server/db/schema";
import { criarUsuarioTeste, limparBanco } from "../helpers/db";

const anon = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

describe("RLS: anon não lê nada", () => {
  beforeEach(async () => {
    await limparBanco();
    const u = await criarUsuarioTeste("diretor");
    await db.insert(auditoria).values({
      usuarioId: u.id,
      tabela: "usuarios",
      registroId: u.id,
      acao: "criar",
      depois: { ok: true },
    });
  });

  for (const tabela of ["usuarios", "auditoria"]) {
    it(`anon não enxerga linhas de ${tabela}`, async () => {
      const { data, error } = await anon().from(tabela).select("*");
      expect(error ? [] : data).toEqual([]);
    });
  }
});
