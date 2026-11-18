import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
