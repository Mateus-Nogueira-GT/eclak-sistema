import { describe, expect, it } from "vitest";
import { REGRAS_INICIAIS as R } from "@/domain/regras";
import { arredondar } from "@/domain/decimal";
import {
  FORMAS_SIMULADOR,
  INDICES_FORMAS_PROPOSTA,
  custoAVista,
  custoLiquido,
  margemDaAprovacao,
  precificar,
  precoDoPacote,
  resultadoDoPreco,
  taxaDaForma,
  vendaDoItem,
  type FormaPagamento,
  type ItemCalc,
  type TipoItem,
} from "@/domain/precificacao";

// Caso Itália do protótipo (precificador/page.tsx, array `itens`).
// Colunas esperadas: custo líquido, custo à vista e venda (centavos).
type Linha = [TipoItem, string, number | null, bigint, string, string | null, bigint, bigint, bigint];
const ITALIA: Linha[] = [
  ["Hotelaria", "Palazzo Barocci", 2, 310600n, "4.000", "4.000", 298176n, 286249n, 338836n],
  ["Hotelaria", "Orto de' Medici", 3, 392800n, "10.500", "4.000", 351556n, 337494n, 399495n],
  ["Hotelaria", "Il Borro", 2, 1058500n, "8.000", "4.000", 973820n, 934867n, 1058500n],
  ["Hotelaria", "Hotel Belair", 4, 926600n, "8.000", "4.000", 852472n, 818373n, 968718n],
  ["Hotelaria", "Hotel Syrene", 3, 1045700n, "8.000", null, 962044n, 962044n, 1093232n],
  ["Hotelaria", "Leonardo Boutique", 4, 1084400n, "10.500", null, 970538n, 970538n, 1102884n],
  ["Trem", "Veneza-Florença", null, 71300n, "0.000", null, 71300n, 71300n, 99820n],
  ["Trem", "Nápoles-Roma", null, 57960n, "0.000", null, 57960n, 57960n, 81144n],
  ["Transfer", "Trans boat", null, 171400n, "0.000", null, 171400n, 171400n, 222820n],
  ["Transfer", "Hotel-aeroporto", null, 60500n, "0.000", null, 60500n, 60500n, 78650n],
  ["Carro", "Florença-Nápoles", null, 195430n, "10.000", null, 175887n, 175887n, 254059n],
  ["Outro", "Ferry boat (Nápoles)", null, 56000n, "0.000", null, 56000n, 56000n, 72800n],
  ["Outro", "Ferry boat (Capri)", null, 51900n, "0.000", null, 51900n, 51900n, 67470n],
  // Decisão do controlador: venda da Taxa = valor (o protótipo mostra 259,69).
  ["Taxa", "Taxa de roteiro", null, 25000n, "0.000", null, 25000n, 25000n, 25000n],
];

const item = (l: Linha, i: number): ItemCalc => ({
  id: `i${i}`,
  tipo: l[0],
  nome: l[1],
  diarias: l[2],
  valorFornecedor: l[3],
  comissaoPct: l[4],
  descontoAVistaPct: l[5],
});
const ITENS = ITALIA.map(item);
const AEREO: ItemCalc = {
  id: "aereo",
  tipo: "Aéreo",
  nome: "GRU-VCE",
  diarias: null,
  valorFornecedor: 2500000n,
  comissaoPct: "5.000",
  descontoAVistaPct: "3.000",
};

describe("arredondar", () => {
  it("arredonda meio para cima, respeitando o sinal", () => {
    expect(arredondar(5n, 2n)).toBe(3n);
    expect(arredondar(-5n, 2n)).toBe(-3n);
    expect(arredondar(4n, 3n)).toBe(1n);
    expect(arredondar(-4n, 3n)).toBe(-1n);
    expect(arredondar(5n, -2n)).toBe(-3n);
    expect(arredondar(0n, 7n)).toBe(0n);
  });
});

describe("itens do caso Itália", () => {
  it.each(ITALIA.map((l, i) => [l[1], i] as const))("%s: custo líquido, à vista e venda", (_n, i) => {
    const l = ITALIA[i];
    const it = ITENS[i];
    expect(custoLiquido(it)).toBe(l[6]);
    expect(custoAVista(it)).toBe(l[7]);
    expect(vendaDoItem(it, R)).toBe(l[8]);
  });
});

describe("taxaDaForma", () => {
  it("dá a taxa de cada forma do simulador (4 casas)", () => {
    expect(FORMAS_SIMULADOR.map((f) => f.rotulo)).toEqual([
      "Pix / cartão direto no fornecedor",
      "Crédito 1x",
      "Crédito 2x a 6x (referência)",
      "Crédito 7x a 10x",
      "6x com antecipação",
    ]);
    expect(FORMAS_SIMULADOR.map((f) => taxaDaForma(f.forma, R).pct)).toEqual([
      "0.0000",
      "2.1900",
      "3.4700",
      "2.8900",
      "7.7367",
    ]);
    expect(FORMAS_SIMULADOR.every((f) => taxaDaForma(f.forma, R).fixo === 0n)).toBe(true);
  });

  it("6x com antecipação fica só como referência: não é forma de proposta (Augusto, 23/11/2026)", () => {
    expect(FORMAS_SIMULADOR.filter((f) => f.soReferencia).map((f) => f.rotulo)).toEqual(["6x com antecipação"]);
    expect(INDICES_FORMAS_PROPOSTA.map((i) => FORMAS_SIMULADOR[i].rotulo)).toEqual([
      "Pix / cartão direto no fornecedor",
      "Crédito 1x",
      "Crédito 2x a 6x (referência)",
      "Crédito 7x a 10x",
    ]);
  });

  it("boleto 4x: sem percentual, R$ 2,50 por boleto", () => {
    expect(taxaDaForma({ tipo: "boleto", parcelas: 4 }, R)).toEqual({ pct: "0.0000", fixo: 1000n });
  });

  it("antecipação nas pontas usa os valores dos Parâmetros", () => {
    expect(taxaDaForma({ tipo: "credito", parcelas: 1, antecipado: true }, R).pct).toBe("4.6400");
    expect(taxaDaForma({ tipo: "credito", parcelas: 10, antecipado: true }, R).pct).toBe("8.6100");
  });
});

describe("precoDoPacote e resultadoDoPreco", () => {
  it("6x antecipado: preço pela fórmula com 7,7367%", () => {
    const f = FORMAS_SIMULADOR[4].forma;
    expect(precoDoPacote(5078553n, f, R)).toBe(7127708n);
    // conferência independente: 0,93 × C / (0,93 − 0,077367 − 0,19)
    expect(arredondar(930000n * 5078553n, 930000n - 77367n - 190000n)).toBe(7127708n);
  });

  it("aceita margem diferente da alvo e taxa fixa", () => {
    // P = (0,93 × 100000 + 1000) / (0,93 − 0,20) = 128767,12…
    expect(precoDoPacote(100000n, { tipo: "boleto", parcelas: 4 }, R, "20.000")).toBe(128767n);
  });

  it("resultado de um preço", () => {
    expect(resultadoDoPreco(6696518n, 5078553n, FORMAS_SIMULADOR[2].forma, R)).toEqual({
      imposto: 113258n,
      taxas: 232369n,
      margemLiquida: 1272338n,
      margemLiquidaPct: "19.0",
    });
  });
});

describe("precificar: caso Itália, 19 dias", () => {
  const p = precificar(ITENS, 19, R);

  it("totais", () => {
    expect(p.custo).toBe(5078553n);
    expect(p.custoAVista).toBe(4979512n);
    // Soma das vendas por item já arredondadas (colunas "venda" do protótipo somam 58.384,28);
    // o protótipo mostra 58.384,29 porque somou os valores sem arredondar.
    expect(p.somaVendas).toBe(5863428n); // 58.384,28 + taxa de roteiro 250,00
    const naoTaxa = p.itens.filter((x) => x.id !== "i13").reduce((a, x) => a + x.venda, 0n);
    expect(naoTaxa).toBe(5838428n);
  });

  it("simulador por forma", () => {
    const f = p.porForma;
    expect(f.map((x) => x.rotulo)).toEqual(FORMAS_SIMULADOR.map((x) => x.rotulo));
    expect(f.map((x) => x.taxaPct)).toEqual(["0.0000", "2.1900", "3.4700", "2.8900", "7.7367"]);
    expect(f.map((x) => x.preco)).toEqual([6382506n, 6577154n, 6696518n, 6641899n, 7127708n]);
    expect(f.slice(0, 4).map((x) => x.imposto)).toEqual([91277n, 104902n, 113258n, 109434n]);
    expect(f.slice(0, 4).map((x) => x.taxas)).toEqual([0n, 144040n, 232369n, 191951n]);
    expect(f.slice(0, 4).map((x) => x.margemLiquida)).toEqual([1212676n, 1249659n, 1272338n, 1261961n]);
    expect(f.map((x) => x.margemLiquidaPct)).toEqual(["19.0", "19.0", "19.0", "19.0", "19.0"]);
    expect(f.every((x) => x.taxaServico === 285000n)).toBe(true);
    expect(f.slice(0, 4).map((x) => x.precoCliente)).toEqual([6667506n, 6862154n, 6981518n, 6926899n]);
    expect(f.map((x) => x.margemSemTaxaServicoPct)).toEqual(["22.2", "22.0", "21.9", "21.9", "21.5"]);
    expect(f.map((x) => x.compensacao)).toEqual(f.map((x) => x.preco - p.somaVendas));
    expect(f.map((x) => x.compensacao)).toEqual([519078n, 713726n, 833090n, 778471n, 1264280n]);
  });

  it("à vista", () => {
    expect(p.avista.custoNoPrazo).toBe(5078553n);
    expect(p.avista.desconto).toBe(99041n);
    expect(p.avista.custoAVista).toBe(4979512n);
    expect(p.avista.opcaoAMargemPct).toEqual(["20.4", "20.4", "20.4", "20.4", "20.3"]);
    expect(p.avista.opcaoBPreco.slice(0, 4)).toEqual([6258035n, 6448888n, 6565924n, 6512370n]);
    expect(p.avista.opcaoBReducao).toEqual(p.porForma.map((x, i) => x.preco - p.avista.opcaoBPreco[i]));
    expect(p.avista.opcaoBReducao).toEqual([124471n, 128266n, 130594n, 129529n, 139004n]);
  });

  it("compensação distribuída pelos itens sem Taxa, fechando no centavo", () => {
    const ref = p.porForma[2];
    const taxa = p.itens.find((x) => x.id === "i13")!;
    expect(taxa.compensacao).toBe(0n);
    expect(taxa.valorFinal).toBe(25000n);
    expect(p.itens.reduce((a, x) => a + x.compensacao, 0n)).toBe(ref.compensacao);
    expect(p.itens.reduce((a, x) => a + x.valorFinal, 0n)).toBe(ref.preco);
    for (const x of p.itens) expect(x.valorFinal).toBe(x.venda + x.compensacao);
    p.porForma.forEach((f, k) => {
      expect(p.itens.reduce((a, x) => a + x.precoPorForma[k], 0n)).toBe(f.preco);
      expect(taxa.precoPorForma[k]).toBe(25000n);
    });
    // Palazzo: compensação 8.330,90 × 3.388,36 / 58.384,28 = 483,49
    expect(p.itens[0].compensacao).toBe(48349n);
  });

  it("item Aéreo não altera nenhum total", () => {
    const comAereo = precificar([...ITENS.slice(0, 5), AEREO, ...ITENS.slice(5)], 19, R);
    expect(comAereo).toEqual(p);
  });
});

describe("margemDaAprovacao: pedidos do protótipo (aprovacoes/page.tsx)", () => {
  const custoDe = (lista: [TipoItem, bigint, string][]) =>
    precificar(
      [
        ...lista.map(([tipo, valor, com], i) => ({
          id: `x${i}`,
          tipo,
          nome: "",
          diarias: null,
          valorFornecedor: valor,
          comissaoPct: com,
          descontoAVistaPct: null,
        })),
        { id: "taxa", tipo: "Taxa" as const, nome: "Taxa de roteiro", diarias: null, valorFornecedor: 25000n, comissaoPct: "0.000", descontoAVistaPct: null },
      ],
      1,
      R,
    ).custo;

  const c2a6: FormaPagamento = { tipo: "credito", parcelas: 6 };
  const c7a10: FormaPagamento = { tipo: "credito", parcelas: 10 };
  const boleto4: FormaPagamento = { tipo: "boleto", parcelas: 4 };

  const p1 = custoDe(ITALIA.slice(0, 13).map((l) => [l[0], l[3], l[4]]));
  const p2 = custoDe([
    ["Hotelaria", 2840000n, "10.000"],
    ["Hotelaria", 2460000n, "14.000"],
    ["Hotelaria", 1580000n, "8.000"],
    ["Trem", 980000n, "0.000"],
    ["Transfer", 420000n, "0.000"],
    ["Outro", 360000n, "0.000"],
  ]);
  const p3 = custoDe([
    ["Hotelaria", 1240000n, "8.000"],
    ["Hotelaria", 1180000n, "14.000"],
    ["Hotelaria", 960000n, "8.000"],
    ["Transfer", 290000n, "0.000"],
    ["Outro", 345000n, "0.000"],
  ]);

  it("custos", () => {
    expect([p1, p2, p3]).toEqual([5078553n, 7910200n, 3698800n]);
  });

  it.each([
    // pedido, preço, forma, dias, custo, imposto, taxa, antes, antes%, dias cobertos, [fixo, final, final%] por_dia/por_faturamento/por_viagem
    ["p1", 6696518n, c2a6, 19, p1, 113258n, 232369n, 1272338n, "19.0", "18.4", [[437551n, 834787n, "12.5"], [495542n, 776796n, "11.6"], [172716n, 1099622n, "16.4"]]],
    ["p2", 10820000n, c7a10, 16, p2, 203686n, 312698n, 2393416n, "22.1", "34.6", [[368464n, 2024952n, "18.7"], [800680n, 1592736n, "14.7"], [172716n, 2220700n, "20.5"]]],
    ["p3", 4710000n, boleto4, 12, p3, 70784n, 1000n, 939416n, "19.9", "13.6", [[276348n, 663068n, "14.1"], [348540n, 590876n, "12.5"], [172716n, 766700n, "16.3"]]],
  ] as const)("%s", (_id, preco, forma, dias, custo, imposto, taxa, antes, antesPct, diasCobertos, porRateio) => {
    (["por_dia", "por_faturamento", "por_viagem"] as const).forEach((rateio, k) => {
      const [fixo, final, finalPct] = porRateio[k];
      expect(margemDaAprovacao(preco, custo, forma, dias, rateio, R)).toEqual({
        custo,
        imposto,
        taxa,
        antes,
        antesPct,
        fixo,
        final,
        finalPct,
        diasCobertos,
      });
    });
  });

  it("imposto zero quando o preço não cobre o custo", () => {
    const m = margemDaAprovacao(100000n, 120000n, { tipo: "pix", parcelas: 1 }, 1, "por_viagem", R);
    expect(m.imposto).toBe(0n);
    expect(m.antes).toBe(-20000n);
    expect(m.antesPct).toBe("-20.0");
  });
});

const novo = (over: Partial<ItemCalc>): ItemCalc => ({
  id: "n",
  tipo: "Outro",
  nome: "",
  diarias: null,
  valorFornecedor: 100000n,
  comissaoPct: "0.000",
  descontoAVistaPct: null,
  ...over,
});

/** Soma dos preços por item = preço de cada forma; soma dos valores finais = preço da forma de referência. */
function fechaNoCentavo(p: ReturnType<typeof precificar>) {
  p.porForma.forEach((f, k) => {
    expect(p.itens.reduce((a, x) => a + x.precoPorForma[k], 0n)).toBe(f.preco);
  });
  expect(p.itens.reduce((a, x) => a + x.valorFinal, 0n)).toBe(p.porForma[2].preco);
  expect(p.itens.reduce((a, x) => a + x.compensacao, 0n)).toBe(p.porForma[2].compensacao);
}

describe("casos-limite", () => {
  it("precoDoPacote recusa taxas e margem que somam 100% ou mais", () => {
    const pix: FormaPagamento = { tipo: "pix", parcelas: 1 };
    // imposto 7% + margem 93% = 100%
    expect(() => precoDoPacote(100000n, pix, R, "93.000")).toThrow("Taxas e margem somam 100% ou mais");
    expect(() => precoDoPacote(100000n, pix, R, "95.000")).toThrow("Taxas e margem somam 100% ou mais");
    // 0,93 × 100000 / 0,00001 = 9.300.000.000
    expect(precoDoPacote(100000n, pix, R, "92.999")).toBe(9300000000n);
  });

  it("vendaDoItem recusa ganhoMinimoHotelPct de 100% ou mais", () => {
    const hotel = novo({ tipo: "Hotelaria", diarias: 2, valorFornecedor: 100000n });
    expect(() => vendaDoItem(hotel, { ...R, ganhoMinimoHotelPct: "100.000" })).toThrow("Ganho mínimo de hotelaria não pode ser 100% ou mais");
    expect(() => vendaDoItem(hotel, { ...R, ganhoMinimoHotelPct: "120.000" })).toThrow("Ganho mínimo de hotelaria não pode ser 100% ou mais");
  });

  it("compensação negativa ainda fecha no centavo", () => {
    // Hotéis acima do limite vendem pelo valor; com 50% de comissão o preço fica abaixo da soma das vendas.
    const p = precificar(
      [
        novo({ id: "a", tipo: "Hotelaria", diarias: 1, valorFornecedor: 1000000n, comissaoPct: "50.000" }),
        novo({ id: "b", tipo: "Hotelaria", diarias: 1, valorFornecedor: 700001n, comissaoPct: "50.000" }),
        novo({ id: "t", tipo: "Taxa", valorFornecedor: 25000n }),
      ],
      3,
      R,
    );
    expect(p.porForma.every((f) => f.compensacao < 0n)).toBe(true);
    expect(p.itens[2].precoPorForma.every((v) => v === 25000n)).toBe(true);
    fechaNoCentavo(p);
  });

  it("um único item recebe toda a compensação", () => {
    const p = precificar([novo({ valorFornecedor: 123457n })], 1, R);
    expect(p.itens[0].precoPorForma).toEqual(p.porForma.map((f) => f.preco));
    expect(p.itens[0].compensacao).toBe(p.porForma[2].compensacao);
    fechaNoCentavo(p);
  });

  it("pesos empatados dividem a compensação com no máximo 1 centavo de diferença", () => {
    const p = precificar(
      [novo({ id: "a", valorFornecedor: 33333n }), novo({ id: "b", valorFornecedor: 33333n }), novo({ id: "c", valorFornecedor: 33333n })],
      1,
      R,
    );
    p.porForma.forEach((_, k) => {
      const v = p.itens.map((x) => x.precoPorForma[k]);
      const max = v.reduce((a, b) => (b > a ? b : a));
      const min = v.reduce((a, b) => (b < a ? b : a));
      expect(max - min <= 1n).toBe(true);
    });
    fechaNoCentavo(p);
  });

  it("Hotelaria: diárias 0 ou nulas e diária exatamente no limite usam o ganho mínimo", () => {
    // 700000 / 0,88 = 795454,54… → 795455
    const h = (diarias: number | null) => vendaDoItem(novo({ tipo: "Hotelaria", diarias, valorFornecedor: 700000n }), R);
    expect(h(2)).toBe(795455n); // 700000 == 350000 × 2
    expect(h(0)).toBe(795455n);
    expect(h(null)).toBe(795455n);
    expect(vendaDoItem(novo({ tipo: "Hotelaria", diarias: 2, valorFornecedor: 700001n }), R)).toBe(700001n);
  });
});

describe("validação do domínio", () => {
  it("diárias: inteiro não negativo ou nulo", () => {
    for (const d of [-1, 1.5, Number.NaN]) {
      const i = novo({ tipo: "Hotelaria", diarias: d });
      expect(() => vendaDoItem(i, R)).toThrow("Diárias inválidas");
      expect(() => custoLiquido(i)).toThrow("Diárias inválidas");
      expect(() => precificar([i], 1, R)).toThrow("Diárias inválidas");
    }
  });

  it("comissão e desconto à vista: de 0 a 100", () => {
    for (const v of ["100.001", "-1.000", "abc", ""]) {
      expect(() => custoLiquido(novo({ comissaoPct: v }))).toThrow("Percentual inválido");
      expect(() => custoAVista(novo({ descontoAVistaPct: v }))).toThrow("Percentual inválido");
      expect(() => vendaDoItem(novo({ descontoAVistaPct: v }), R)).toThrow("Percentual inválido");
    }
    expect(custoLiquido(novo({ comissaoPct: "100.000" }))).toBe(0n);
    expect(custoAVista(novo({ descontoAVistaPct: "100.000" }))).toBe(0n);
  });

  it("dias: inteiro positivo", () => {
    for (const d of [0, -1, 1.5]) {
      expect(() => precificar([novo({})], d, R)).toThrow("Dias inválidos");
      expect(() => margemDaAprovacao(100000n, 50000n, { tipo: "pix", parcelas: 1 }, d, "por_dia", R)).toThrow("Dias inválidos");
    }
  });
});
