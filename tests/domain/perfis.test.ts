import { describe, expect, it } from "vitest";
import { FILIAIS, PERFIS, PERFIS_FINANCEIRO, PERFIS_VALORES, podeAcessar, ROTAS_POR_PERFIL, veCamadaEstrategica } from "@/domain/perfis";

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
  it("vendas: consultor, operacional e diretor acessam; financeiros não", () => {
    for (const p of ["consultor", "operacional", "diretor"] as const) {
      expect(podeAcessar(p, "/vendas")).toBe(true);
      expect(podeAcessar(p, "/vendas/x")).toBe(true);
      expect(podeAcessar(p, "/vendasX")).toBe(false);
    }
    for (const p of ["fin_operacional", "fin_estrategico"] as const) expect(podeAcessar(p, "/vendas")).toBe(false);
  });
  it("veCamadaEstrategica", () => {
    for (const p of ["diretor", "fin_operacional", "fin_estrategico"] as const)
      expect(veCamadaEstrategica(p)).toBe(true);
    for (const p of ["consultor", "operacional"] as const) expect(veCamadaEstrategica(p)).toBe(false);
  });
  it("financeiro: só Diretor e financeiros", () => {
    expect(podeAcessar("fin_operacional", "/financeiro/lancamentos")).toBe(true);
    expect(podeAcessar("fin_estrategico", "/financeiro")).toBe(true);
    expect(podeAcessar("diretor", "/financeiro/faturas")).toBe(true);
    expect(podeAcessar("consultor", "/financeiro/faturas")).toBe(false);
    expect(podeAcessar("operacional", "/financeiro")).toBe(false);
    expect(PERFIS_FINANCEIRO).toEqual(["diretor", "fin_operacional", "fin_estrategico"]);
  });
  it("tarefas, roteiros e dailies: todos os perfis acessam", () => {
    for (const p of PERFIS_VALORES) {
      expect(podeAcessar(p, "/tarefas")).toBe(true);
      expect(podeAcessar(p, "/roteiros")).toBe(true);
      expect(podeAcessar(p, "/dailies/x")).toBe(true);
    }
  });
  it("visão geral: primeira tela do Diretor e do Financeiro estratégico; relatórios nos três do financeiro", () => {
    expect(ROTAS_POR_PERFIL.diretor[0]).toBe("/visao-geral");
    expect(ROTAS_POR_PERFIL.fin_estrategico[0]).toBe("/visao-geral");
    for (const p of ["diretor", "fin_estrategico"] as const) expect(podeAcessar(p, "/visao-geral")).toBe(true);
    for (const p of ["fin_operacional", "consultor", "operacional"] as const) expect(podeAcessar(p, "/visao-geral")).toBe(false);
    expect(podeAcessar("fin_operacional", "/financeiro/relatorios")).toBe(true);
    expect(podeAcessar("consultor", "/financeiro/relatorios")).toBe(false);
  });
});
