import { describe, expect, it } from "vitest";
import { MOEDAS, cambioAplicado, converter } from "@/domain/cambio";

describe("câmbio", () => {
  it("lista as moedas aceitas", () => {
    expect(MOEDAS).toEqual(["BRL", "USD", "EUR", "GBP", "CHF"]);
  });

  it("câmbio aplicado = comercial × (1 + acréscimo), 4 casas, meio para cima", () => {
    expect(cambioAplicado("5.8930", "4.500")).toBe("6.1582");
    expect(cambioAplicado("5.4210", "4.500")).toBe("5.6649");
    expect(cambioAplicado("1.0000", "0.000")).toBe("1.0000");
    // 1,0000 × 1,00005 = 1,00005 → 1,0001 (meio para cima)
    expect(cambioAplicado("1.0000", "0.005")).toBe("1.0001");
  });

  it("converte centavos da moeda em centavos de real", () => {
    expect(converter(100000n, "6.1582")).toBe(615820n);
    expect(converter(1n, "6.1582")).toBe(6n); // 6,1582 → 6
    expect(converter(1n, "5.5000")).toBe(6n); // 5,5 → meio para cima
    expect(converter(12345n, "1.0000")).toBe(12345n);
  });

  it("recusa câmbio ou percentual mal formado", () => {
    expect(() => converter(100n, "6,1582")).toThrow();
    expect(() => cambioAplicado("abc", "4.500")).toThrow();
  });
});
