import { describe, expect, it } from "vitest";
import { formatarCambio, lerCambio } from "@/domain/cambio";
import { CAMPOS, REGRAS_INICIAIS, RegrasSchema, diferencasRegras, normalizarRegras, valorNoCaminho } from "@/domain/regras";

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

describe("câmbio nas regras", () => {
  const comCambio = (usd: object) => ({ ...REGRAS_INICIAIS, cambio: { ...REGRAS_INICIAIS.cambio, USD: { ...REGRAS_INICIAIS.cambio.USD, ...usd } } });

  it("lerCambio aceita vírgula ou ponto e devolve 4 casas", () => {
    expect(lerCambio("5,4210")).toBe("5.4210");
    expect(lerCambio("5.4210")).toBe("5.4210");
    expect(lerCambio("5,42")).toBe("5.4200");
    expect(lerCambio(" 9999,9999 ")).toBe("9999.9999");
    for (const ruim of ["", "0", "0,0000", "-1", "5,42101", "10000", "abc", "5,4,2"]) {
      expect(() => lerCambio(ruim), ruim).toThrow("Câmbio inválido");
    }
    expect(formatarCambio("5.4210")).toBe("5,4210");
  });

  it("schema recusa câmbio fora do formato canônico e data inválida", () => {
    const ok = (p: object) => RegrasSchema.safeParse(comCambio(p)).success;
    expect(ok({ comercial: "5.4210" })).toBe(true);
    expect(ok({ comercial: "5,4210" })).toBe(false);
    expect(ok({ comercial: "-5.4210" })).toBe(false);
    expect(ok({ comercial: "0.0000" })).toBe(false);
    expect(ok({ data: "2026-02-30" })).toBe(false);
    expect(ok({ data: "06/11/2026" })).toBe(false);
    expect(ok({ data: "2026-11-06" })).toBe(true);
  });

  it("versão antiga sem cambio é lida com os valores iniciais", () => {
    const antiga: Record<string, unknown> = { ...REGRAS_INICIAIS };
    delete antiga.cambio;
    expect(normalizarRegras(antiga)).toEqual(REGRAS_INICIAIS);
    expect(normalizarRegras(REGRAS_INICIAIS)).toEqual(REGRAS_INICIAIS);
  });

  it("histórico mostra 'Câmbio EUR: 5,8930 → 6,0000' e a data", () => {
    const depois = {
      ...REGRAS_INICIAIS,
      cambio: { ...REGRAS_INICIAIS.cambio, EUR: { comercial: "6.0000", data: "2026-11-20" } },
    };
    expect(diferencasRegras(REGRAS_INICIAIS, depois)).toEqual([
      { campo: "Câmbio EUR", antes: "5,8930", depois: "6,0000" },
      { campo: "Câmbio EUR (data)", antes: "06/11/2026", depois: "20/11/2026" },
    ]);
  });
});

describe("encerramentoDaily", () => {
  const inicial =
    "Qualquer dúvida, nosso customer care está à disposição no WhatsApp. Aproveitem o dia!\nEquipe ECLAK Viagens";

  it("tem o texto inicial do spec", () => {
    expect(REGRAS_INICIAIS.encerramentoDaily).toBe(inicial);
  });

  it("versão sem o campo recebe o texto inicial", () => {
    const antiga: Record<string, unknown> = { ...REGRAS_INICIAIS };
    delete antiga.encerramentoDaily;
    expect(normalizarRegras(antiga)).toEqual(REGRAS_INICIAIS);
  });

  it("recusa texto em branco ou longo demais", () => {
    expect(RegrasSchema.safeParse({ ...REGRAS_INICIAIS, encerramentoDaily: "  " }).success).toBe(false);
    expect(RegrasSchema.safeParse({ ...REGRAS_INICIAIS, encerramentoDaily: "a".repeat(1001) }).success).toBe(false);
  });

  it("aparece no histórico quando alterado", () => {
    expect(diferencasRegras(REGRAS_INICIAIS, { ...REGRAS_INICIAIS, encerramentoDaily: "Novo texto" })).toEqual([
      { campo: "Encerramento do daily", antes: inicial, depois: "Novo texto" },
    ]);
  });
});
