import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/client";
import { usuarios } from "@/server/db/schema";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());

const { ErroAcesso, exigirPerfil, usuarioAtual } = await import("@/server/auth");

describe("autorização no servidor", () => {
  beforeEach(limparBanco);

  it("exigirPerfil('diretor') rejeita consultor com ErroAcesso", async () => {
    const c = await criarUsuarioTeste("consultor");
    await expect(comSessao(c.id, () => exigirPerfil("diretor"))).rejects.toBeInstanceOf(ErroAcesso);
    await expect(comSessao(c.id, () => exigirPerfil("diretor"))).rejects.toThrow("Sem permissão");
  });

  it("exigirPerfil('diretor') resolve para diretor", async () => {
    const d = await criarUsuarioTeste("diretor");
    const u = await comSessao(d.id, () => exigirPerfil("diretor"));
    expect(u.perfil).toBe("diretor");
    expect(u.id).toBe(d.id);
  });

  it("sem sessão, exigirPerfil rejeita", async () => {
    await expect(exigirPerfil()).rejects.toBeInstanceOf(ErroAcesso);
  });

  it("sem argumentos só exige login", async () => {
    const c = await criarUsuarioTeste("consultor");
    expect((await comSessao(c.id, () => exigirPerfil())).perfil).toBe("consultor");
  });

  it("usuário desativado com sessão aberta perde acesso na hora", async () => {
    const d = await criarUsuarioTeste("diretor");
    await comSessao(d.id, async () => {
      expect(await usuarioAtual()).not.toBeNull();
      await db.update(usuarios).set({ ativo: false }).where(eq(usuarios.id, d.id));
      expect(await usuarioAtual()).toBeNull();
      await expect(exigirPerfil()).rejects.toBeInstanceOf(ErroAcesso);
      await expect(exigirPerfil("diretor")).rejects.toBeInstanceOf(ErroAcesso);
    });
  });
});
