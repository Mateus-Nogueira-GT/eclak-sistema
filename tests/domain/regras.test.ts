import { describe, expect, it } from "vitest";
import { CAMPOS, REGRAS_INICIAIS, RegrasSchema, diferencasRegras, valorNoCaminho } from "@/domain/regras";

describe("RegrasSchema", () => {
  it("aceita as regras iniciais, com dinheiro em centavos", () => {
    expect(RegrasSchema.parse(REGRAS_INICIAIS)).toEqual(REGRAS_INICIAIS);
    expect(REGRAS_INICIAIS.custoFixoMensal).toBe("2072593");
    expect(REGRAS_INICIAIS.taxas.boletoPorBoleto).toBe("250");
  });

  it("recusa parcelamento acima de 10 ou abaixo de 1", () => {
    expect(RegrasSchema.safeParse({ ...REGRAS_INICIAIS, parcelamentoMaximo: 11 }).success).toBe(false);
    expect(RegrasSchema.safeParse({ ...REGRAS_INICIAIS, parcelamentoMaximo: 0 }).success).toBe(false);
  });

  it("recusa percentual negativo ou acima do limite e dinheiro fora da faixa", () => {
    const ruim = (p: object) => RegrasSchema.safeParse({ ...REGRAS_INICIAIS, ...p }).success;
    expect(ruim({ margemAlvoPct: "-1.000" })).toBe(false);
    expect(ruim({ margemAlvoPct: "1000.000" })).toBe(false);
    expect(ruim({ margemAlvoPct: "999.999" })).toBe(true);
    expect(ruim({ custoFixoMensal: "1000000000000" })).toBe(false);
    expect(ruim({ custoFixoMensal: "999999999999" })).toBe(true);
    expect(ruim({ custoFixoMensal: "-5" })).toBe(false);
    expect(ruim({ reservaCaixaMeses: 0 })).toBe(false);
  });

  it("todo campo da tela existe nas regras iniciais", () => {
    for (const campo of CAMPOS) {
      expect(valorNoCaminho(REGRAS_INICIAIS, campo.caminho), campo.caminho).not.toBeUndefined();
    }
  });
});

describe("diferencasRegras", () => {
  it("formata rótulos e valores em português", () => {
    const depois = {
      ...REGRAS_INICIAIS,
      margemReferenciaPct: "20.000",
      taxas: { ...REGRAS_INICIAIS.taxas, credito2a6x: "3.500", boletoPorBoleto: "300" },
    };
    expect(diferencasRegras(REGRAS_INICIAIS, depois)).toEqual([
      { campo: "Margem de referência", antes: "19%", depois: "20%" },
      { campo: "Taxa de boleto (por boleto)", antes: "R$ 2,50", depois: "R$ 3,00" },
      { campo: "Taxa de cartão: crédito 2x a 6x", antes: "3,47%", depois: "3,5%" },
    ]);
  });
});
