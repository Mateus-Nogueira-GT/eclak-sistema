import { describe, expect, it } from "vitest";
import {
  cicloDoCartao,
  inicioDaSemana,
  metaReserva,
  projetarMeses,
  projetarSemanas,
  situacaoReserva,
  type MovimentoCaixa,
} from "@/domain/caixa";

const movs: MovimentoCaixa[] = [
  { data: "2026-11-10", valor: 5000n, lado: "pagar", vencida: true, tipo: "empresa" },
  { data: "2026-11-25", valor: 20000n, lado: "receber", vencida: false, tipo: "clientes" },
  { data: "2026-12-02", valor: 3000n, lado: "pagar", vencida: false, tipo: "fornecedores" },
];

describe("inicioDaSemana", () => {
  it("devolve a segunda-feira", () => {
    expect(inicioDaSemana("2026-11-23")).toBe("2026-11-23");
    expect(inicioDaSemana("2026-11-29")).toBe("2026-11-23");
    expect(inicioDaSemana("2026-12-01")).toBe("2026-11-30");
  });
  it("recusa data inválida", () => {
    expect(() => inicioDaSemana("2026-13-01")).toThrow(Error);
  });
});

describe("projetarSemanas", () => {
  const p = projetarSemanas(100000n, movs, "2026-11-23");
  it("projeta 8 semanas com a vencida na primeira", () => {
    expect(p).toHaveLength(8);
    expect(p[0]).toMatchObject({
      inicio: "2026-11-23",
      fim: "2026-11-29",
      rotulo: "23/11 a 29/11",
      entradas: 20000n,
      saidas: 5000n,
      vencidas: 5000n,
      saldoFinal: 115000n,
    });
    expect(p[1]!.saldoFinal).toBe(112000n);
    expect(p[7]!.saldoFinal).toBe(112000n);
  });
  it("deixa fora o que passa da última semana", () => {
    const r = projetarSemanas(0n, [{ ...movs[1]!, data: "2027-02-01" }], "2026-11-23");
    expect(r[7]!.saldoFinal).toBe(0n);
  });
});

describe("projetarMeses", () => {
  const p = projetarMeses(100000n, movs, "2026-11-23");
  it("projeta 12 meses", () => {
    expect(p).toHaveLength(12);
    expect(p[0]).toMatchObject({
      inicio: "2026-11-01",
      fim: "2026-11-30",
      rotulo: "nov/2026",
      entradas: 20000n,
      saidas: 5000n,
      vencidas: 5000n,
      saldoFinal: 115000n,
    });
    expect(p[1]).toMatchObject({ rotulo: "dez/2026", saidas: 3000n, saldoFinal: 112000n });
    expect(p[11]!.rotulo).toBe("out/2027");
  });
});

describe("reserva", () => {
  it("meta = 6 x custo fixo", () => {
    expect(metaReserva(2072593n)).toBe(12435558n);
  });
  it("atingida em / falta", () => {
    const meses = projetarMeses(10000000n, [{ data: "2026-12-10", valor: 3000000n, lado: "receber", vencida: false, tipo: "clientes" }], "2026-11-23");
    const s = situacaoReserva(10000000n, 2072593n, meses);
    expect(s).toEqual({ meta: 12435558n, temos: 10000000n, falta: 2435558n, atingidaEm: "dez/2026" });
  });
  it("nunca atingida", () => {
    const meses = projetarMeses(0n, [], "2026-11-23");
    expect(situacaoReserva(0n, 2072593n, meses).atingidaEm).toBeNull();
  });
  it("falta zero quando temos mais que a meta", () => {
    const meses = projetarMeses(20000000n, [], "2026-11-23");
    const s = situacaoReserva(20000000n, 2072593n, meses);
    expect(s.falta).toBe(0n);
    expect(s.atingidaEm).toBe("nov/2026");
  });
});

describe("cicloDoCartao", () => {
  it("calcula fechamento e vencimento", () => {
    expect(cicloDoCartao("2026-11-10", 15, 25)).toEqual({ fechamento: "2026-11-15", vencimento: "2026-11-25" });
    expect(cicloDoCartao("2026-11-16", 15, 25)).toEqual({ fechamento: "2026-12-15", vencimento: "2026-12-25" });
    expect(cicloDoCartao("2026-11-10", 25, 5)).toEqual({ fechamento: "2026-11-25", vencimento: "2026-12-05" });
    expect(cicloDoCartao("2026-12-28", 25, 5)).toEqual({ fechamento: "2027-01-25", vencimento: "2027-02-05" });
  });
  it("recusa entradas inválidas", () => {
    expect(() => cicloDoCartao("2026-11-10", 0, 5)).toThrow(Error);
    expect(() => cicloDoCartao("2026-11-10", 15, 29)).toThrow(Error);
    expect(() => cicloDoCartao("2026-02-30", 15, 25)).toThrow(Error);
  });
});
