import { describe, expect, it } from "vitest";
import { formatarPercentual, formatarReais, lerPercentual, lerReais } from "@/domain/dinheiro";

describe("lerReais", () => {
  it("aceita formatos válidos", () => {
    expect(lerReais("1.234,56")).toBe(123456n);
    expect(lerReais("R$ 3.500")).toBe(350000n);
    expect(lerReais("R$3.500,5")).toBe(350050n);
    expect(lerReais("20725,93")).toBe(2072593n);
    expect(lerReais("250")).toBe(25000n);
    expect(lerReais("  0,05 ")).toBe(5n);
    expect(lerReais("R$ 10")).toBe(1000n);
    expect(lerReais(" R$10 ")).toBe(1000n);
  });
  it.each(["", "  ", "abc", "1,234", "-5", "1.23,45", "1,2,3", "12.34", ",5", "R$", "5%", "10 5", "1 000", "R$ R$ 5"])(
    "recusa %j",
    (t) => {
      expect(() => lerReais(t)).toThrow("Valor inválido");
    },
  );
});

describe("formatarReais", () => {
  it("formata com ponto e vírgula", () => {
    expect(formatarReais(2072593n)).toBe("R$ 20.725,93");
    expect(formatarReais(0n)).toBe("R$ 0,00");
    expect(formatarReais(5n)).toBe("R$ 0,05");
    expect(formatarReais(123456789n)).toBe("R$ 1.234.567,89");
    expect(formatarReais(-150n)).toBe("-R$ 1,50");
  });
});

describe("percentual", () => {
  it("lê e formata", () => {
    expect(lerPercentual("2,19%")).toBe("2.190");
    expect(lerPercentual("7")).toBe("7.000");
    expect(lerPercentual("0,125")).toBe("0.125");
    expect(lerPercentual("2,19 %")).toBe("2.190");
    expect(formatarPercentual("2.190")).toBe("2,19%");
    expect(formatarPercentual("7.000")).toBe("7%");
    expect(formatarPercentual("0.125")).toBe("0,125%");
  });
  it.each(["", "x", "1,2345", "-1", "R$ 5", "1 2"])("recusa %j", (t) => {
    expect(() => lerPercentual(t)).toThrow("Valor inválido");
  });
});
