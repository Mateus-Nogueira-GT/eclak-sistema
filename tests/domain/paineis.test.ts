import { describe, expect, it } from "vitest";
import {
  intervaloAnterior,
  intervaloDeMeses,
  intervaloDoPeriodo,
  margemPonderada,
  montarDre,
  ordenarAvisos,
  paraCsv,
  RESPONSAVEL_AVISO,
  variacaoPct,
  type Aviso,
  type LinhaEmpresaDre,
} from "@/domain/paineis";

describe("intervaloDoPeriodo", () => {
  const hoje = "2026-11-23";
  it("30d e 90d contam o dia de hoje", () => {
    expect(intervaloDoPeriodo("30d", hoje)).toEqual({ de: "2026-10-25", ate: "2026-11-23" });
    expect(intervaloDoPeriodo("90d", hoje).de).toBe("2026-08-26");
  });
  it("mes, mes_anterior e ano", () => {
    expect(intervaloDoPeriodo("mes", hoje)).toEqual({ de: "2026-11-01", ate: "2026-11-23" });
    expect(intervaloDoPeriodo("mes_anterior", hoje)).toEqual({ de: "2026-10-01", ate: "2026-10-31" });
    expect(intervaloDoPeriodo("ano", hoje)).toEqual({ de: "2026-01-01", ate: "2026-11-23" });
  });
  it("mes_anterior em janeiro cai em dezembro", () => {
    expect(intervaloDoPeriodo("mes_anterior", "2026-01-10")).toEqual({ de: "2025-12-01", ate: "2025-12-31" });
  });
});

describe("intervaloAnterior", () => {
  it("30d: mesma duração logo antes", () => {
    expect(intervaloAnterior("30d", { de: "2026-10-25", ate: "2026-11-23" })).toEqual({
      de: "2026-09-25",
      ate: "2026-10-24",
    });
  });
  it("mes, mes_anterior e ano: mês/ano anterior inteiro", () => {
    expect(intervaloAnterior("mes", { de: "2026-11-01", ate: "2026-11-23" })).toEqual({ de: "2026-10-01", ate: "2026-10-31" });
    expect(intervaloAnterior("mes_anterior", { de: "2026-10-01", ate: "2026-10-31" })).toEqual({ de: "2026-09-01", ate: "2026-09-30" });
    expect(intervaloAnterior("ano", { de: "2026-01-01", ate: "2026-11-23" })).toEqual({ de: "2025-01-01", ate: "2025-12-31" });
  });
});

describe("intervaloDeMeses", () => {
  it("cobre o mês inteiro", () => {
    expect(intervaloDeMeses("2026-02", "2026-02")).toEqual({ de: "2026-02-01", ate: "2026-02-28" });
    expect(intervaloDeMeses("2026-01", "2026-12")).toEqual({ de: "2026-01-01", ate: "2026-12-31" });
  });
  it("aceita 24 meses e recusa 25", () => {
    expect(intervaloDeMeses("2025-01", "2026-12")).toEqual({ de: "2025-01-01", ate: "2026-12-31" });
    expect(() => intervaloDeMeses("2024-01", "2026-01")).toThrow("Período inválido");
  });
  it("recusa ordem invertida e formato ruim", () => {
    expect(() => intervaloDeMeses("2026-03", "2026-01")).toThrow("Período inválido");
    expect(() => intervaloDeMeses("2026-13", "2026-13")).toThrow("Período inválido");
    expect(() => intervaloDeMeses("abc", "2026-01")).toThrow("Período inválido");
  });
});

describe("variacaoPct", () => {
  it("calcula com uma casa", () => {
    expect(variacaoPct(1100n, 1000n)).toBe("10.0");
    expect(variacaoPct(500n, 1000n)).toBe("-50.0");
  });
  it("sem base de comparação vira null", () => {
    expect(variacaoPct(0n, 0n)).toBeNull();
    expect(variacaoPct(10n, 0n)).toBeNull();
  });
});

describe("margemPonderada", () => {
  it("pondera pela receita", () => {
    expect(margemPonderada([{ final: 190n, receita: 1000n }, { final: 10n, receita: 1000n }])).toBe("10.0");
  });
  it("sem receita vira null", () => {
    expect(margemPonderada([])).toBeNull();
    expect(margemPonderada([{ final: 0n, receita: 0n }])).toBeNull();
  });
});

describe("montarDre", () => {
  const viagens = { receita: 100000n, custo: 70000n, imposto: 2100n, taxas: 3000n, semMargem: 0 };
  const empresa: LinhaEmpresaDre[] = [
    { lado: "pagar", grupo: "Despesas administrativas", categoria: "Aluguel", categoriaId: "a", valor: 5000n },
    { lado: "pagar", grupo: "Despesas administrativas", categoria: "Internet", categoriaId: "b", valor: 200n },
    { lado: "receber", grupo: "Outras receitas", categoria: "Rendimentos", categoriaId: "c", valor: 300n },
  ];
  it("monta as linhas na ordem e fecha o resultado", () => {
    const { linhas, resultado } = montarDre(viagens, empresa);
    expect(linhas.map((l) => [l.rotulo, l.valor, l.nivel])).toEqual([
      ["Receita de viagens", 100000n, "total"],
      ["(-) Custo dos fornecedores", -70000n, "total"],
      ["(=) Margem bruta", 30000n, "total"],
      ["(-) Imposto sobre a margem", -2100n, "total"],
      ["(-) Taxas financeiras", -3000n, "total"],
      ["(=) Margem das viagens", 24900n, "total"],
      ["Outras receitas", 300n, "grupo"],
      ["Rendimentos", 300n, "categoria"],
      ["Despesas administrativas", -5200n, "grupo"],
      ["Aluguel", -5000n, "categoria"],
      ["Internet", -200n, "categoria"],
      ["(=) Resultado do período", 20000n, "total"],
    ]);
    expect(resultado).toBe(20000n);
    expect(linhas.find((l) => l.rotulo === "Aluguel")?.categoriaId).toBe("a");
  });
  it("sem empresa: resultado é a margem das viagens", () => {
    const { linhas, resultado } = montarDre(viagens, []);
    expect(resultado).toBe(24900n);
    expect(linhas).toHaveLength(7);
  });
  it("ordena grupos de receita antes dos de despesa, alfabético dentro", () => {
    const { linhas } = montarDre({ ...viagens, receita: 0n, custo: 0n, imposto: 0n, taxas: 0n }, [
      { lado: "pagar", grupo: "B", categoria: "x", categoriaId: "1", valor: 1n },
      { lado: "pagar", grupo: "A", categoria: "y", categoriaId: "2", valor: 1n },
      { lado: "receber", grupo: "Z", categoria: "z", categoriaId: "3", valor: 1n },
      { lado: "receber", grupo: "M", categoria: "w", categoriaId: "4", valor: 1n },
    ]);
    expect(linhas.filter((l) => l.nivel === "grupo").map((l) => l.rotulo)).toEqual(["M", "Z", "A", "B"]);
  });
});

describe("ordenarAvisos", () => {
  const av = (tipo: Aviso["tipo"], titulo: string): Aviso => ({
    tipo,
    titulo,
    detalhe: "",
    href: "/",
    responsavel: RESPONSAVEL_AVISO[tipo],
  });
  it("ordena por tipo, estável dentro do tipo", () => {
    const r = ordenarAvisos([av("aprovacao", "1"), av("pagar", "2"), av("caixa", "3"), av("margem", "4"), av("caixa", "5"), av("comissao", "6"), av("parcela", "7")]);
    expect(r.map((a) => a.titulo)).toEqual(["3", "5", "4", "7", "6", "2", "1"]);
  });
  it("responsável por tipo", () => {
    expect(RESPONSAVEL_AVISO.caixa).toBe("Gestão");
    expect(RESPONSAVEL_AVISO.margem).toBe("Gestão");
    expect(RESPONSAVEL_AVISO.aprovacao).toBe("Gestão");
    expect(RESPONSAVEL_AVISO.parcela).toBe("Financeiro");
    expect(RESPONSAVEL_AVISO.comissao).toBe("Financeiro");
    expect(RESPONSAVEL_AVISO.pagar).toBe("Financeiro");
  });
});

describe("paraCsv", () => {
  const csv = paraCsv(["Nome", "Valor"], [["A; B", 123456n], ['Diz "oi"', -1000n], ["x", null]]);
  it("BOM, CRLF, escape e decimal com vírgula", () => {
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("\r\n");
    expect(csv).toContain('"A; B";1234,56');
    expect(csv).toContain('"Diz ""oi""";-10,00');
    expect(csv).toContain("x;");
    expect(csv.split("\r\n")[0]).toBe("﻿Nome;Valor");
  });
  it("centavos negativos pequenos", () => {
    expect(paraCsv(["v"], [[-5n]])).toContain("-0,05");
  });
});
