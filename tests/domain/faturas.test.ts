import { describe, expect, it } from "vitest";
import { numeroFaturaSchema, parcelasMudaram, type ParcelaRetrato } from "@/domain/faturas";

const p = (numero: number, vencimento: string, valor: string, total = 2): ParcelaRetrato => ({ numero, total, vencimento, valor });

describe("parcelasMudaram", () => {
  const retrato = [p(1, "2026-12-10", "500000"), p(2, "2027-01-10", "500000")];

  it("iguais (em qualquer ordem) não mudaram", () => {
    expect(parcelasMudaram(retrato, [p(2, "2027-01-10", "500000"), p(1, "2026-12-10", "500000")])).toBe(false);
  });

  it("parcela a menos, valor, vencimento ou número diferente mudaram", () => {
    expect(parcelasMudaram(retrato, [retrato[0]])).toBe(true);
    expect(parcelasMudaram(retrato, [retrato[0], p(2, "2027-01-10", "500001")])).toBe(true);
    expect(parcelasMudaram(retrato, [retrato[0], p(2, "2027-01-11", "500000")])).toBe(true);
    expect(parcelasMudaram(retrato, [retrato[0], p(3, "2027-01-10", "500000")])).toBe(true);
  });

  it("o total de parcelas (n/N) não entra na comparação", () => {
    expect(parcelasMudaram(retrato, [p(1, "2026-12-10", "500000", 3), p(2, "2027-01-10", "500000", 3)])).toBe(false);
  });
});

describe("numeroFaturaSchema", () => {
  it("aceita de 1 a 999999, inteiro", () => {
    expect(numeroFaturaSchema.safeParse(1).success).toBe(true);
    expect(numeroFaturaSchema.safeParse(999999).success).toBe(true);
    for (const x of [0, 1000000, 1.5, -3, "2000", NaN]) expect(numeroFaturaSchema.safeParse(x).success).toBe(false);
  });
});
