import { describe, expect, it } from "vitest";
import {
  diferencaPp,
  intervaloAnterior,
  intervaloDeMeses,
  intervaloDoPeriodo,
  linhasCsv,
  nomeArquivoRelatorio,
  periodoDosRelatorios,
  margemPonderada,
  montarDre,
  ordenarAvisos,
  paraCsv,
  pctAbaixoDe,
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
  it("mes e ano: o mesmo trecho do mês/ano anterior", () => {
    expect(intervaloAnterior("mes", { de: "2026-11-01", ate: "2026-11-23" })).toEqual({ de: "2026-10-01", ate: "2026-10-23" });
    expect(intervaloAnterior("ano", { de: "2026-01-01", ate: "2026-11-23" })).toEqual({ de: "2025-01-01", ate: "2025-11-23" });
  });
  it("mes e ano: dia limitado ao fim do mês anterior; janeiro volta a dezembro", () => {
    expect(intervaloAnterior("mes", { de: "2026-03-01", ate: "2026-03-31" })).toEqual({ de: "2026-02-01", ate: "2026-02-28" });
    expect(intervaloAnterior("mes", { de: "2026-01-01", ate: "2026-01-15" })).toEqual({ de: "2025-12-01", ate: "2025-12-15" });
    expect(intervaloAnterior("ano", { de: "2028-01-01", ate: "2028-02-29" })).toEqual({ de: "2027-01-01", ate: "2027-02-28" });
  });
  it("mes_anterior: o mês inteiro antes dele", () => {
    expect(intervaloAnterior("mes_anterior", { de: "2026-10-01", ate: "2026-10-31" })).toEqual({ de: "2026-09-01", ate: "2026-09-30" });
    expect(intervaloAnterior("mes_anterior", { de: "2026-01-01", ate: "2026-01-31" })).toEqual({ de: "2025-12-01", ate: "2025-12-31" });
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

describe("diferencaPp e pctAbaixoDe", () => {
  it("diferença com sinal e uma casa, aceitando 1 ou 3 casas", () => {
    expect(diferencaPp("12.5", "19.0")).toBe("-6.5");
    expect(diferencaPp("19.0", "12.5")).toBe("6.5");
    expect(diferencaPp("-3.2", "4.0")).toBe("-7.2");
    expect(diferencaPp("10.0", "10.000")).toBe("0.0");
    expect(diferencaPp("10.0", "9.975")).toBe("0.0");
    expect(diferencaPp("10.0", "9.949")).toBe("0.1");
  });
  it("compara percentuais com sinal", () => {
    expect(pctAbaixoDe("18.9", "19.000")).toBe(true);
    expect(pctAbaixoDe("19.0", "19.000")).toBe(false);
    expect(pctAbaixoDe("-1.0", "0.0")).toBe(true);
    expect(() => pctAbaixoDe("abc", "1")).toThrow();
  });
});

describe("relatórios: período, arquivo e linhas do CSV", () => {
  const hoje = "2026-11-23";
  it("período da URL: padrão é o mês de hoje; inválido volta ao mês com aviso", () => {
    expect(periodoDosRelatorios(undefined, undefined, hoje)).toEqual({ de: "2026-11", ate: "2026-11", intervalo: { de: "2026-11-01", ate: "2026-11-30" }, invalido: false });
    expect(periodoDosRelatorios("2026-09", "2026-10", hoje)).toMatchObject({ intervalo: { de: "2026-09-01", ate: "2026-10-31" }, invalido: false });
    expect(periodoDosRelatorios("2026-09", undefined, hoje)).toMatchObject({ de: "2026-09", ate: "2026-09", invalido: false });
    expect(periodoDosRelatorios("2026-10", "2026-09", hoje)).toMatchObject({ de: "2026-11", ate: "2026-11", invalido: true });
    expect(periodoDosRelatorios("lixo", "2026-09", hoje).invalido).toBe(true);
    expect(periodoDosRelatorios("2020-01", "2026-11", hoje).invalido).toBe(true);
  });
  it("nome do arquivo", () => {
    expect(nomeArquivoRelatorio("dre", "2026-11", "2026-11")).toBe("relatorio-dre-2026-11.csv");
    expect(nomeArquivoRelatorio("bancos", "2026-09", "2026-11")).toBe("relatorio-bancos-2026-09_2026-11.csv");
  });
  it("DRE", () => {
    const r = linhasCsv("dre", { linhas: [{ rotulo: "Receita de viagens", valor: 123456n, nivel: "total" }, { rotulo: "(-) Custo", valor: -5000n, nivel: "total" }] });
    expect(r.cabecalho).toEqual(["Linha", "Valor"]);
    expect(r.linhas).toEqual([["Receita de viagens", 123456n], ["(-) Custo", -5000n]]);
  });
  it("contas a pagar e a receber, com total por situação", () => {
    const dados = {
      linhas: [{ vencimento: "2026-11-05", pessoa: "Hotel", descricao: "Diária", categoria: "Hospedagem", viagemCodigo: "ECL-1", situacao: "Vencida", valor: 1000n }],
      totais: { Vencida: 1000n },
    };
    const p = linhasCsv("pagar", dados);
    expect(p.cabecalho).toEqual(["Vencimento", "Fornecedor", "Descrição", "Categoria", "Viagem", "Situação", "Valor"]);
    expect(p.linhas).toEqual([["05/11/2026", "Hotel", "Diária", "Hospedagem", "ECL-1", "Vencida", 1000n], ["Total", "", "", "", "", "Vencida", 1000n]]);
    expect(linhasCsv("receber", dados).cabecalho[1]).toBe("Cliente");
  });
  it("volume por banco", () => {
    const r = linhasCsv("bancos", {
      contas: [{ nome: "Itaú", entradas: 300n, saidas: 100n, saldoPeriodo: 200n, saldoAtual: 900n }],
      total: { entradas: 300n, saidas: 100n, saldoPeriodo: 200n },
    });
    expect(r.cabecalho).toEqual(["Conta", "Entradas", "Saídas", "Saldo do período", "Saldo atual"]);
    expect(r.linhas).toEqual([["Itaú", 300n, 100n, 200n, 900n], ["Total", 300n, 100n, 200n, null]]);
  });
  it("margem por viagem: coluna Valor vendido; sem cálculo", () => {
    const r = linhasCsv("margens", [
      { codigo: "ECL-1", cliente: "Souza", destino: "Itália", vendido: 5000n, planejadaPct: "19.000", realPct: "16.5", diferencaPp: "-2.5" },
      { codigo: "ECL-2", cliente: "Lima", destino: "Chile", vendido: 100n, planejadaPct: "20.0", realPct: null, diferencaPp: null },
    ]);
    expect(r.cabecalho).toEqual(["Viagem", "Cliente", "Destino", "Valor vendido", "Planejada", "Real", "Diferença"]);
    expect(r.linhas).toEqual([["ECL-1", "Souza", "Itália", 5000n, "19%", "16,5%", "-2,5 pontos"], ["ECL-2", "Lima", "Chile", 100n, "20%", "Sem cálculo", null]]);
  });
  it("vendas por consultor", () => {
    const r = linhasCsv("consultores", {
      linhas: [{ nome: "Ana", viagens: 2, vendido: 9000n, margemPct: "18.2" }],
      total: { viagens: 2, vendido: 9000n, margemPct: null },
    });
    expect(r.cabecalho).toEqual(["Consultor", "Viagens", "Valor vendido", "Margem real"]);
    expect(r.linhas).toEqual([["Ana", "2", 9000n, "18,2%"], ["Total", "2", 9000n, "Sem margem"]]);
  });
});
