import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { supabaseAdmin } from "@/server/supabase";
import { db } from "@/server/db/client";
import { auditoria, usuarios } from "@/server/db/schema";
import { alterarUsuario, criarUsuario, reenviarConvite } from "@/server/actions/usuarios";
import { listarUsuarios } from "@/server/queries/usuarios";
import { anonClient, comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const novo = (email: string) => ({
  nome: "Fernanda",
  email,
  perfil: "consultor" as const,
  filial: "Rondonópolis" as const,
});

describe("administração de usuários", () => {
  beforeEach(limparBanco);

  it("Diretor cria consultor: linha em usuarios e auditoria 'criar'", async () => {
    const d = await criarUsuarioTeste("diretor");
    const email = `Novo-${Date.now()}@Eclak.test`;
    const r = await comSessao(d.id, () => criarUsuario(novo(` ${email} `)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [u] = await db.select().from(usuarios).where(eq(usuarios.id, r.id));
    expect(u.perfil).toBe("consultor");
    expect(u.email).toBe(email.toLowerCase());
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, r.id));
    expect(aud.map((a) => a.acao)).toEqual(["criar"]);
    const lista = await comSessao(d.id, () => listarUsuarios());
    expect(lista.map((x) => x.id)).toContain(r.id);
  });

  it("consultor não cria nem altera; nada é gravado", async () => {
    const c = await criarUsuarioTeste("consultor");
    const r1 = await comSessao(c.id, () => criarUsuario(novo("x@eclak.test")));
    expect(r1).toEqual({ ok: false, erro: "Sem permissão" });
    const r2 = await comSessao(c.id, () => alterarUsuario(c.id, { perfil: "diretor" }));
    expect(r2).toEqual({ ok: false, erro: "Sem permissão" });
    const [u] = await db.select().from(usuarios).where(eq(usuarios.id, c.id));
    expect(u.perfil).toBe("consultor");
    expect(await db.select().from(usuarios)).toHaveLength(1);
    expect(await db.select().from(auditoria)).toHaveLength(0);
    await expect(comSessao(c.id, () => listarUsuarios())).rejects.toThrow("Sem permissão");
  });

  it("e-mail repetido (sem diferenciar maiúsculas) é recusado", async () => {
    const d = await criarUsuarioTeste("diretor");
    const r = await comSessao(d.id, () => criarUsuario(novo(d.email.toUpperCase())));
    expect(r).toEqual({ ok: false, erro: "Já existe um usuário com este e-mail" });
  });

  it("valida nome e e-mail em português", async () => {
    const d = await criarUsuarioTeste("diretor");
    const a = await comSessao(d.id, () => criarUsuario({ ...novo("a@eclak.test"), nome: "  " }));
    expect(a).toEqual({ ok: false, erro: "Informe o nome" });
    const b = await comSessao(d.id, () => criarUsuario(novo("não-é-email")));
    expect(b).toEqual({ ok: false, erro: "E-mail inválido" });
  });

  it("único Diretor ativo não pode se rebaixar nem se desativar", async () => {
    const d = await criarUsuarioTeste("diretor");
    const msg = { ok: false, erro: "É preciso manter pelo menos um Diretor ativo" };
    expect(await comSessao(d.id, () => alterarUsuario(d.id, { perfil: "consultor" }))).toEqual(msg);
    expect(await comSessao(d.id, () => alterarUsuario(d.id, { ativo: false }))).toEqual(msg);
    const [u] = await db.select().from(usuarios).where(eq(usuarios.id, d.id));
    expect(u.perfil).toBe("diretor");
    expect(u.ativo).toBe(true);
  });

  it("com dois Diretores, um pode se rebaixar e a auditoria registra antes/depois", async () => {
    const d1 = await criarUsuarioTeste("diretor");
    await criarUsuarioTeste("diretor");
    const r = await comSessao(d1.id, () => alterarUsuario(d1.id, { perfil: "consultor" }));
    expect(r).toEqual({ ok: true });
    const [aud] = await db.select().from(auditoria).where(eq(auditoria.registroId, d1.id));
    expect(aud.acao).toBe("alterar");
    expect((aud.antes as { perfil: string }).perfil).toBe("diretor");
    expect((aud.depois as { perfil: string }).perfil).toBe("consultor");
  });

  it("desativar grava auditoria 'desativar'", async () => {
    const d = await criarUsuarioTeste("diretor");
    const c = await criarUsuarioTeste("consultor");
    expect(await comSessao(d.id, () => alterarUsuario(c.id, { ativo: false }))).toEqual({ ok: true });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, c.id));
    expect(aud.map((a) => a.acao)).toEqual(["desativar"]);
  });

  it("duas desativações simultâneas dos dois únicos Diretores: só uma passa", async () => {
    const d1 = await criarUsuarioTeste("diretor");
    const d2 = await criarUsuarioTeste("diretor");
    const [r1, r2] = await Promise.all([
      comSessao(d1.id, () => alterarUsuario(d2.id, { ativo: false })),
      comSessao(d2.id, () => alterarUsuario(d1.id, { ativo: false })),
    ]);
    expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    const ativos = await db.select().from(usuarios).where(eq(usuarios.ativo, true));
    expect(ativos).toHaveLength(1);
  });

  it("convites simultâneos ao mesmo e-mail não apagam o usuário de auth já gravado", async () => {
    const d = await criarUsuarioTeste("diretor");
    const email = `race-${Date.now()}@eclak.test`;
    const rs = await comSessao(d.id, () =>
      Promise.all([criarUsuario(novo(email)), criarUsuario(novo(email))]),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    const linhas = await db.select().from(usuarios).where(eq(usuarios.email, email));
    expect(linhas).toHaveLength(1);
    const { data, error } = await supabaseAdmin().auth.admin.getUserById(linhas[0].id);
    expect(error).toBeNull();
    expect(data.user?.id).toBe(linhas[0].id);
  });
});

describe("reenviar convite", () => {
  beforeEach(limparBanco);

  it("consultor não reenvia: Sem permissão", async () => {
    const c = await criarUsuarioTeste("consultor");
    expect(await comSessao(c.id, () => reenviarConvite(c.id))).toEqual({ ok: false, erro: "Sem permissão" });
  });

  it("Diretor reenvia para quem nunca entrou; auditoria 'alterar' com conviteReenviadoEm", async () => {
    const d = await criarUsuarioTeste("diretor");
    await anonClient().auth.signInWithPassword({ email: d.email, password: d.senha });
    const r = await comSessao(d.id, () => criarUsuario(novo(`reenvio-${Date.now()}@eclak.test`)));
    if (!r.ok) throw new Error(r.erro);
    const lista = await comSessao(d.id, () => listarUsuarios());
    expect(lista.find((u) => u.id === r.id)?.convitePendente).toBe(true);
    expect(lista.find((u) => u.id === d.id)?.convitePendente).toBe(false);

    expect(await comSessao(d.id, () => reenviarConvite(r.id))).toEqual({ ok: true });
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, r.id));
    expect(aud.map((a) => a.acao)).toEqual(["criar", "alterar"]);
    const depois = aud.find((a) => a.acao === "alterar")!.depois as { conviteReenviadoEm: string };
    expect(Number.isNaN(Date.parse(depois.conviteReenviadoEm))).toBe(false);
  });

  it("quem já entrou no sistema não recebe convite de novo", async () => {
    const d = await criarUsuarioTeste("diretor");
    const c = await criarUsuarioTeste("consultor");
    const login = await anonClient().auth.signInWithPassword({ email: c.email, password: c.senha });
    expect(login.error).toBeNull();
    expect(await comSessao(d.id, () => reenviarConvite(c.id))).toEqual({
      ok: false,
      erro: "Este usuário já entrou no sistema",
    });
    expect(await db.select().from(auditoria).where(eq(auditoria.registroId, c.id))).toHaveLength(0);
  });

  it("id desconhecido ou inválido: Usuário não encontrado", async () => {
    const d = await criarUsuarioTeste("diretor");
    const msg = { ok: false, erro: "Usuário não encontrado" };
    expect(await comSessao(d.id, () => reenviarConvite("nao-e-uuid"))).toEqual(msg);
    expect(await comSessao(d.id, () => reenviarConvite("00000000-0000-4000-8000-000000000000"))).toEqual(msg);
  });
});
