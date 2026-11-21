import { describe, expect, it } from "vitest";
import { FILIAIS, PERFIS, PERFIS_VALORES, podeAcessar, ROTAS_POR_PERFIL, veCamadaEstrategica } from "@/domain/perfis";

describe("perfis", () => {
  it("nomes e listas", () => {
    expect(PERFIS.fin_operacional.nome).toBe("Financeiro operacional");
    expect(PERFIS_VALORES).toHaveLength(5);
    expect(FILIAIS).toEqual(["Rondonópolis", "RS"]);
    expect(Object.keys(ROTAS_POR_PERFIL).sort()).toEqual([...PERFIS_VALORES].sort());
  });
  it("podeAcessar", () => {
    expect(podeAcessar("consultor", "/fornecedores/novo")).toBe(true);
    expect(podeAcessar("consultor", "/fornecedores")).toBe(true);
    expect(podeAcessar("consultor", "/fornecedoresX")).toBe(false);
    expect(podeAcessar("consultor", "/admin/parametros")).toBe(false);
    expect(podeAcessar("diretor", "/admin/usuarios")).toBe(true);
    expect(podeAcessar("diretor", "/admin/parametros/x")).toBe(true);
  });
  it("clientes: todos os perfis acessam", () => {
    for (const p of PERFIS_VALORES) {
      expect(podeAcessar(p, "/clientes")).toBe(true);
      expect(podeAcessar(p, "/clientes/novo")).toBe(true);
    }
  });
  it("viagens: todos os perfis acessam", () => {
    for (const p of PERFIS_VALORES) {
      expect(podeAcessar(p, "/viagens")).toBe(true);
      expect(podeAcessar(p, "/viagens/novo")).toBe(true);
      expect(podeAcessar(p, "/viagens/abc/proposta")).toBe(true);
      expect(podeAcessar(p, "/viagensX")).toBe(false);
    }
  });
  it("aprovações: só o diretor acessa", () => {
    expect(podeAcessar("diretor", "/aprovacoes")).toBe(true);
    expect(podeAcessar("diretor", "/aprovacoes/x")).toBe(true);
    expect(podeAcessar("diretor", "/aprovacoesX")).toBe(false);
    for (const p of PERFIS_VALORES.filter((x) => x !== "diretor")) {
      expect(podeAcessar(p, "/aprovacoes")).toBe(false);
    }
  });
  it("veCamadaEstrategica", () => {
    for (const p of ["diretor", "fin_operacional", "fin_estrategico"] as const)
      expect(veCamadaEstrategica(p)).toBe(true);
    for (const p of ["consultor", "operacional"] as const) expect(veCamadaEstrategica(p)).toBe(false);
  });
});
