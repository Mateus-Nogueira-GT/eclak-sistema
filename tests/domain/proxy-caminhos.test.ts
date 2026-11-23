import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { podeAcessar } from "@/domain/perfis";
import { deveProteger, MATCHER_PROXY } from "@/server/proxy-caminhos";

const ex = ["/login", "/login/", "/auth/confirmar", "/auth/confirmar/", "/logo-eclak.png", "/favicon.ico", "/_next/static/a.js", "/_next/image"];
const guardados = ["/auth/confirmarx", "/auth", "/definir-senha", "/login-historico", "/loginx/a", "/logo-eclak.png.bak", "/fornecedores", "/", "/admin/usuarios"];

describe("exclusões do proxy", () => {
  const re = new RegExp("^" + MATCHER_PROXY + "$");
  it.each(ex)("matcher e deveProteger excluem %s", (p) => {
    expect(re.test(p)).toBe(false);
    expect(deveProteger(p)).toBe(false);
  });
  it.each(guardados)("matcher e deveProteger guardam %s", (p) => {
    expect(re.test(p)).toBe(true);
    expect(deveProteger(p)).toBe(true);
  });
  it("config.matcher de src/proxy.ts é o mesmo literal", () => {
    const src = readFileSync("src/proxy.ts", "utf8");
    expect(src).toContain(JSON.stringify(MATCHER_PROXY));
  });
});

describe("área Financeiro", () => {
  const rotas = ["/financeiro/lancamentos", "/financeiro/faturas", "/financeiro/categorias", "/financeiro/contas-bancarias"];
  it.each(rotas)("proxy guarda %s", (p) => expect(deveProteger(p)).toBe(true));
  it.each(["consultor", "operacional"] as const)("%s é bloqueado", (perfil) => {
    for (const r of rotas) expect(podeAcessar(perfil, r)).toBe(false);
  });
  it.each(["diretor", "fin_operacional", "fin_estrategico"] as const)("%s passa", (perfil) => {
    for (const r of rotas) expect(podeAcessar(perfil, r)).toBe(true);
  });
});

describe("área Operação (fatia 5)", () => {
  const rotas = ["/tarefas", "/roteiros", "/dailies", "/viagens/x/roteiro/imprimir"];
  it.each(rotas)("proxy guarda %s", (p) => expect(deveProteger(p)).toBe(true));
  it.each(["consultor", "operacional"] as const)("%s passa", (perfil) => {
    for (const r of rotas) expect(podeAcessar(perfil, r)).toBe(true);
  });
});
