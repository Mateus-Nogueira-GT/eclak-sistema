import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { supabaseAdmin } from "@/server/supabase";
import { GET as confirmar } from "@/app/auth/confirmar/route";
import { definirSenha, pedirNovaSenha } from "@/server/actions/senha";
import { anonClient, comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const MAILPIT = "http://127.0.0.1:54324";

function form(campos: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

async function tokenDe(type: "invite" | "recovery", email: string) {
  const { data, error } = await supabaseAdmin().auth.admin.generateLink({ type, email });
  expect(error).toBeNull();
  return data.properties!.hashed_token;
}

describe("link do e-mail -> definir senha -> entrar", () => {
  beforeEach(limparBanco);

  it("convite: verifyOtp, troca de senha e login com a senha nova", async () => {
    const email = `convite-${randomUUID()}@eclak.test`;
    const token_hash = await tokenDe("invite", email);
    const c = anonClient();
    const v = await c.auth.verifyOtp({ type: "invite", token_hash });
    expect(v.error).toBeNull();
    expect(v.data.session).not.toBeNull();
    const u = await c.auth.updateUser({ password: "senha-nova-123" });
    expect(u.error).toBeNull();
    const login = await anonClient().auth.signInWithPassword({ email, password: "senha-nova-123" });
    expect(login.error).toBeNull();
  });

  it("recuperação: verifyOtp, troca de senha e login com a senha nova", async () => {
    const t = await criarUsuarioTeste("consultor");
    const token_hash = await tokenDe("recovery", t.email);
    const c = anonClient();
    expect((await c.auth.verifyOtp({ type: "recovery", token_hash })).error).toBeNull();
    expect((await c.auth.updateUser({ password: "outra-senha-456" })).error).toBeNull();
    const login = await anonClient().auth.signInWithPassword({
      email: t.email,
      password: "outra-senha-456",
    });
    expect(login.error).toBeNull();
    const antiga = await anonClient().auth.signInWithPassword({ email: t.email, password: t.senha });
    expect(antiga.error).not.toBeNull();
  });
});

describe("rota /auth/confirmar", () => {
  beforeEach(limparBanco);
  const req = (q: string) => new NextRequest(`http://localhost:3000/auth/confirmar${q}`);

  it("token válido de convite redireciona para /definir-senha", async () => {
    const token = await tokenDe("invite", `rota-${randomUUID()}@eclak.test`);
    const r = await confirmar(req(`?token_hash=${token}&type=invite`));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/definir-senha");
  });

  it("token válido de recuperação redireciona para /definir-senha", async () => {
    const t = await criarUsuarioTeste("consultor");
    const token = await tokenDe("recovery", t.email);
    const r = await confirmar(req(`?token_hash=${token}&type=recovery`));
    expect(r.headers.get("location")).toBe("/definir-senha");
  });

  it.each([
    "?token_hash=invalido&type=invite",
    "?type=invite",
    "?token_hash=abc&type=signup",
    "",
  ])("link inválido (%s) volta para /login?erro=link", async (q) => {
    const r = await confirmar(req(q));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/login?erro=link");
  });

  it("servidor ligado em 0.0.0.0: Location relativo, sem host", async () => {
    const token = await tokenDe("invite", `bind-${randomUUID()}@eclak.test`);
    const ok = await confirmar(
      new NextRequest(`http://0.0.0.0:3995/auth/confirmar?token_hash=${token}&type=invite`),
    );
    const erro = await confirmar(
      new NextRequest("http://0.0.0.0:3995/auth/confirmar?token_hash=x&type=invite"),
    );
    for (const r of [ok, erro]) {
      const loc = r.headers.get("location")!;
      expect(loc.startsWith("/")).toBe(true);
      expect(loc).not.toContain("0.0.0.0");
    }
  });

  it("o mesmo link não serve duas vezes", async () => {
    const token = await tokenDe("invite", `duas-${randomUUID()}@eclak.test`);
    await confirmar(req(`?token_hash=${token}&type=invite`));
    const r = await confirmar(req(`?token_hash=${token}&type=invite`));
    expect(r.headers.get("location")).toBe("/login?erro=link");
  });
});

describe("definirSenha", () => {
  beforeEach(limparBanco);
  const inicial = { erro: null };

  it("sem sessão: Sem permissão", async () => {
    const r = await definirSenha(inicial, form({ senha: "12345678", confirmacao: "12345678" }));
    expect(r).toEqual({ erro: "Sem permissão" });
  });

  it("valida tamanho e confirmação", async () => {
    const c = await criarUsuarioTeste("consultor");
    expect(
      await comSessao(c.id, () => definirSenha(inicial, form({ senha: "1234567", confirmacao: "1234567" }))),
    ).toEqual({ erro: "A senha precisa ter pelo menos 8 caracteres" });
    expect(
      await comSessao(c.id, () => definirSenha(inicial, form({ senha: "12345678", confirmacao: "12345679" }))),
    ).toEqual({ erro: "As senhas não conferem" });
  });

  it("senha válida: grava e redireciona para /", async () => {
    const c = await criarUsuarioTeste("consultor");
    const erro = await comSessao(c.id, () =>
      definirSenha(inicial, form({ senha: "senha-valida-1", confirmacao: "senha-valida-1" })),
    ).catch((e) => e);
    expect(String(erro.digest)).toContain("NEXT_REDIRECT");
    expect(String(erro.digest)).toContain(";/;");
    const login = await anonClient().auth.signInWithPassword({ email: c.email, password: "senha-valida-1" });
    expect(login.error).toBeNull();
  });
});

describe("pedirNovaSenha", () => {
  beforeEach(limparBanco);
  const MSG = "Se o e-mail estiver cadastrado, você receberá um link para criar uma nova senha.";

  async function emailsPara(email: string) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
    return ((await r.json()) as { messages: { ID: string }[] }).messages;
  }

  it("mesma resposta para e-mail cadastrado e não cadastrado (sem enumeração)", async () => {
    const t = await criarUsuarioTeste("consultor");
    const a = await pedirNovaSenha({ mensagem: null }, form({ email: t.email }));
    const b = await pedirNovaSenha({ mensagem: null }, form({ email: `ninguem-${randomUUID()}@eclak.test` }));
    expect(a).toEqual({ mensagem: MSG });
    expect(b).toEqual({ mensagem: MSG });
  });

  it("e-mail de recuperação aponta para /auth/confirmar com token_hash e type=recovery", async () => {
    const t = await criarUsuarioTeste("consultor");
    await pedirNovaSenha({ mensagem: null }, form({ email: t.email }));
    let msgs: { ID: string }[] = [];
    for (let i = 0; i < 20 && msgs.length === 0; i++) {
      msgs = await emailsPara(t.email);
      if (msgs.length === 0) await new Promise((r) => setTimeout(r, 250));
    }
    expect(msgs.length).toBeGreaterThan(0);
    const corpo = (await (await fetch(`${MAILPIT}/api/v1/message/${msgs[0].ID}`)).json()) as {
      HTML: string;
    };
    const link = corpo.HTML.match(/href="([^"]+)"/)![1].replaceAll("&amp;", "&");
    const url = new URL(link);
    expect(url.pathname).toBe("/auth/confirmar");
    expect(url.searchParams.get("type")).toBe("recovery");
    const r = await confirmar(new NextRequest(`http://localhost:3000${url.pathname}${url.search}`));
    expect(r.headers.get("location")).toBe("/definir-senha");
  });
});
