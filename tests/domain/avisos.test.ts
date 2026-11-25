import { describe, expect, it } from "vitest";
import { PASSO_AVISO, recebe, SETORES, SETORES_DO_PERFIL } from "@/domain/avisos";

describe("setores dos avisos (spec §8.2)", () => {
  it("cinco setores, na ordem do spec", () => {
    expect(SETORES).toEqual(["Gestão", "Financeiro", "Comercial", "Operacional", "Geral"]);
  });

  it("cada perfil recebe os setores da tabela", () => {
    expect(SETORES_DO_PERFIL).toEqual({
      diretor: ["Gestão", "Financeiro", "Comercial", "Operacional", "Geral"],
      fin_estrategico: ["Gestão", "Financeiro", "Geral"],
      fin_operacional: ["Financeiro", "Geral"],
      consultor: ["Comercial", "Operacional", "Geral"],
      operacional: ["Operacional", "Geral"],
    });
  });

  it("recebe", () => {
    expect(recebe("diretor", "Comercial")).toBe(true);
    expect(recebe("fin_estrategico", "Gestão")).toBe(true);
    expect(recebe("fin_operacional", "Gestão")).toBe(false);
    expect(recebe("fin_operacional", "Financeiro")).toBe(true);
    expect(recebe("consultor", "Financeiro")).toBe(false);
    expect(recebe("consultor", "Gestão")).toBe(false);
    expect(recebe("operacional", "Comercial")).toBe(false);
    for (const p of ["diretor", "fin_estrategico", "fin_operacional", "consultor", "operacional"] as const) expect(recebe(p, "Geral")).toBe(true);
  });

  it("próximo passo dos sete avisos da Visão geral (decisão do coordenador)", () => {
    expect(PASSO_AVISO).toEqual({
      caixa: "Rever o fluxo de caixa",
      margem: "Rever os custos lançados na viagem",
      parcela: "Cobrar o cliente",
      comissao: "Cobrar a comissão do fornecedor",
      pagar: "Pagar ou reprogramar as contas",
      conciliacao: "Conciliar o extrato",
      aprovacao: "Aprovar ou devolver os pedidos",
    });
  });
});
