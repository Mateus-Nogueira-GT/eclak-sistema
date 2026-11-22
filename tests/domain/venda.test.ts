import { describe, expect, it } from "vitest";
import { itensDoSnapshot, resultadoDaVersao, type CotacaoLida, type ItemLido, type ItemSnapshot, type Snapshot } from "@/domain/aprovacoes";
import { precoDoPacote, type FormaPagamento } from "@/domain/precificacao";
import { REGRAS_INICIAIS as R } from "@/domain/regras";
import {
  aplicarFormaFornecedor,
  COMISSAO_TIPOS,
  contasDoSnapshot,
  cronogramaRecebimento,
  documentoValido,
  formatarDocumento,
  FORMAS_PAGAMENTO_FORNECEDOR,
  margemReal,
  meioDaForma,
  MEIOS_RECEBIMENTO,
  planejadaDaVersao,
  ponteDaMargem,
  ROTULO_STATUS_VIAGEM,
  statusDaViagem,
  alocarTaxasPrevistas,
  reprevisarLinhas,
  vencimentoPadraoFornecedor,
  taxaRoteiroDoSnapshot,
  type ContaGerada,
} from "@/domain/venda";

// ---------------------------------------------------------------------------
// Montagem de snapshot como o servidor faz (itensDoSnapshot)
// ---------------------------------------------------------------------------

let seq = 0;
const novoId = () => `id-${++seq}`;

type Cot = Partial<CotacaoLida> & { valorBrl: bigint };
function cot(o: Cot): CotacaoLida {
  return {
    id: novoId(),
    fornecedorId: null,
    fornecedor: null,
    moeda: "BRL",
    valorOriginal: o.valorBrl,
    cambioComercial: null,
    cambioAplicado: null,
    cambioData: null,
    comissaoPct: "0.000",
    descontoAVistaPct: null,
    tarifaFixa: 0n,
    escolhida: true,
    ...o,
  };
}

function item(tipo: ItemLido["tipo"], servico: string, cotacoes: CotacaoLida[], o: Partial<ItemLido> = {}): ItemLido {
  return {
    id: novoId(),
    ordem: ++seq,
    tipo,
    cidade: null,
    servico,
    checkin: null,
    checkout: null,
    diarias: null,
    automatico: tipo === "Taxa",
    cotacoes,
    ...o,
  };
}

function snapshot(itens: ItemLido[], inicio: string, fim: string): Snapshot {
  const r = itensDoSnapshot(itens);
  if ("erro" in r) throw new Error(r.erro);
  return { destino: "Europa", inicio, fim, passageiros: [{ id: "p1", nome: "Ana" }, { id: "p2", nome: "Bia" }], itens: r as ItemSnapshot[] };
}

const fornecedor = (nome: string, o: Omit<Cot, "fornecedor" | "fornecedorId">) =>
  cot({ fornecedorId: `f-${nome}`, fornecedor: nome, ...o });

// ---------------------------------------------------------------------------

describe("constantes", () => {
  it("meios, tipos de comissão e formas ao fornecedor", () => {
    expect(MEIOS_RECEBIMENTO).toEqual(["pix", "boleto", "cartao_credito", "cartao_fornecedor"]);
    expect(COMISSAO_TIPOS).toEqual(["descontada", "a_receber"]);
    expect(FORMAS_PAGAMENTO_FORNECEDOR).toEqual(["a_vista", "parcelado", "cartao_corporativo"]);
  });
  it("meio de recebimento pela forma", () => {
    expect(meioDaForma({ tipo: "pix", parcelas: 1 })).toBe("pix");
    expect(meioDaForma({ tipo: "boleto", parcelas: 4 })).toBe("boleto");
    expect(meioDaForma({ tipo: "credito", parcelas: 6, antecipado: true })).toBe("cartao_credito");
    expect(meioDaForma({ tipo: "cartao_fornecedor", parcelas: 1 })).toBe("cartao_fornecedor");
  });
});

describe("cronogramaRecebimento (Review Focus 3)", () => {
  it("100000 em 3: truncado ao centavo, a última absorve; mensal no mesmo dia", () => {
    expect(cronogramaRecebimento(100000n, 3, "2026-11-20")).toEqual([
      { numero: 1, vencimento: "2026-11-20", valor: 33333n },
      { numero: 2, vencimento: "2026-12-20", valor: 33333n },
      { numero: 3, vencimento: "2027-01-20", valor: 33334n },
    ]);
  });
  it("soma exata para qualquer n de 1 a 10 e centavos ímpares", () => {
    for (const total of [1001n, 1n, 9n, 99999n, 1234567n, 9_000_001n]) {
      for (let n = 1; n <= 10; n++) {
        const c = cronogramaRecebimento(total, n, "2026-11-20");
        expect(c).toHaveLength(n);
        expect(c.reduce((a, p) => a + p.valor, 0n)).toBe(total);
        expect(c.map((p) => p.numero)).toEqual(Array.from({ length: n }, (_, i) => i + 1));
      }
    }
    const dez = cronogramaRecebimento(1001n, 10, "2026-11-20");
    expect(dez.slice(0, 9).every((p) => p.valor === 100n)).toBe(true);
    expect(dez[9].valor).toBe(101n);
  });
  it("dia inexistente vira o último do mês, sem perder o dia original", () => {
    expect(cronogramaRecebimento(300n, 3, "2027-01-31").map((p) => p.vencimento)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
    expect(cronogramaRecebimento(300n, 2, "2028-01-31").map((p) => p.vencimento)).toEqual(["2028-01-31", "2028-02-29"]);
    expect(cronogramaRecebimento(300n, 3, "2026-12-30").map((p) => p.vencimento)).toEqual(["2026-12-30", "2027-01-30", "2027-02-28"]);
  });
  it("entradas inválidas", () => {
    expect(() => cronogramaRecebimento(100n, 0, "2026-11-20")).toThrow("Parcelas inválidas");
    expect(() => cronogramaRecebimento(100n, 1.5, "2026-11-20")).toThrow("Parcelas inválidas");
    expect(() => cronogramaRecebimento(-1n, 1, "2026-11-20")).toThrow("Valor inválido");
    expect(() => cronogramaRecebimento(100n, 1, "2026-02-30")).toThrow("Data inválida");
  });
});

describe("alocarTaxasPrevistas", () => {
  it("reparte a taxa da aprovação pelo valor das parcelas; a última absorve e a soma é exata", () => {
    expect(alocarTaxasPrevistas(1000n, [33333n, 33333n, 33334n])).toEqual([333n, 333n, 334n]);
    // 1001 × 1/3 = 333,67 → truncado 333; a última fica com 335
    expect(alocarTaxasPrevistas(1001n, [100n, 100n, 100n])).toEqual([333n, 333n, 335n]);
    expect(alocarTaxasPrevistas(0n, [500n, 500n])).toEqual([0n, 0n]);
    expect(alocarTaxasPrevistas(7n, [0n, 0n])).toEqual([0n, 7n]);
    expect(alocarTaxasPrevistas(5n, [])).toEqual([]);
    expect(() => alocarTaxasPrevistas(-1n, [1n])).toThrow("Valor inválido");
  });
  it("nunca devolve parte negativa (7 centavos em 10 parcelas de 1)", () => {
    const a = alocarTaxasPrevistas(7n, Array.from({ length: 10 }, () => 1n));
    expect(a.every((x) => x >= 0n)).toBe(true);
    expect(a.reduce((x, y) => x + y, 0n)).toBe(7n);
    expect(a).toEqual([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 7n]);
    const b = alocarTaxasPrevistas(5n, [1n, 0n, 1n, 1n, 0n, 1n]);
    expect(b.every((x) => x >= 0n)).toBe(true);
    expect(b.reduce((x, y) => x + y, 0n)).toBe(5n);
    for (const taxa of [1n, 999n, 31337n, 123457n]) {
      for (let n = 1; n <= 10; n++) {
        const valores = cronogramaRecebimento(9_000_001n, n, "2026-11-20").map((p) => p.valor);
        expect(alocarTaxasPrevistas(taxa, valores).reduce((x, y) => x + y, 0n)).toBe(taxa);
      }
    }
  });
});

describe("documentoValido / formatarDocumento", () => {
  it("CPF e CNPJ com dígitos verificadores", () => {
    expect(documentoValido("52998224725")).toBe(true);
    expect(documentoValido("52998224724")).toBe(false);
    expect(documentoValido("11222333000181")).toBe(true);
    expect(documentoValido("11222333000182")).toBe(false);
    expect(documentoValido("11111111111111")).toBe(false);
    expect(documentoValido("529.982.247-25")).toBe(false);
    expect(documentoValido("123")).toBe(false);
  });
  it("formata CPF e CNPJ", () => {
    expect(formatarDocumento("52998224725")).toBe("529.982.247-25");
    expect(formatarDocumento("11222333000181")).toBe("11.222.333/0001-81");
    expect(formatarDocumento("123")).toBe("123");
  });
});

// ---------------------------------------------------------------------------
// Caso Ribeiro do protótipo (mock-data.ts `ribeiro`), valores em reais × 100
// ---------------------------------------------------------------------------

const saidasRibeiro: [string, string, number][] = [
  ["Hotelaria", "Hotel Miradouro Sete", 3900],
  ["Hotelaria", "Quinta Ribeira Alta", 1800],
  ["Hotelaria", "Residencia Alcalá Norte", 3600],
  ["Hotelaria", "Casa del Azahar", 1700],
  ["Hotelaria", "Hotel Passeig Modernista", 4200],
  ["Hotelaria", "Hôtel Promenade Azur", 2600],
  ["Hotelaria", "Palazzo Lungarno Nove", 4100],
  ["Hotelaria", "Hotel Travertino Roma", 5200],
  ["Hotelaria", "Ca' Laguna Antica", 3400],
  ["Hotelaria", "Maison Rivoli Seize", 13020],
  ["Hotelaria", "The Mayfair Row", 5400],
  ["Transfer", "TransEuropa Transfers", 4800],
  ["Passeio", "Sintra Privé Tours", 2980],
  ["Passeio", "Guias Privados Roma", 3900],
  ["Seguro", "Proteção Viagem Corretora", 4000],
];

function ribeiro() {
  seq = 0;
  const itens: ItemLido[] = [
    ...saidasRibeiro.map(([tipo, nome, reais]) =>
      item(tipo as ItemLido["tipo"], `Serviço ${nome}`, [fornecedor(nome, { valorBrl: BigInt(reais) * 100n })]),
    ),
    item("Passeio", "Circuito Toscana e Cinque Terre", [
      fornecedor("Operadora Mediterrânea", { valorBrl: 950000n, comissaoPct: "10.000" }),
    ]),
    item("Aéreo", "Aéreo GRU-LIS", [fornecedor("Cia Aérea", { valorBrl: 2000000n })]),
    item("Taxa", "Taxa de roteiro", [cot({ valorBrl: 25000n })]),
  ];
  const s = snapshot(itens, "2027-01-15", "2027-02-01");
  const modalidade: Record<string, "net" | "comissionado"> = { "f-Operadora Mediterrânea": "comissionado" };
  for (const [, nome] of saidasRibeiro) modalidade[`f-${nome}`] = "net";
  return { s, modalidade };
}

describe("contasDoSnapshot", () => {
  it("uma conta por item não-Taxa (Aéreo marcado), net descontada e comissionada a receber", () => {
    const { s, modalidade } = ribeiro();
    const contas = contasDoSnapshot(s, modalidade, s.fim);
    expect(contas).toHaveLength(17);
    expect(contas.some((c) => c.descricao === "Taxa de roteiro")).toBe(false);
    expect(contas.filter((c) => c.aereo).map((c) => c.fornecedor)).toEqual(["Cia Aérea"]);

    const florenca = contas.find((c) => c.fornecedor === "Palazzo Lungarno Nove")!;
    expect(florenca).toMatchObject({ comissaoTipo: "descontada", previstoBrl: 410000n, previstoOriginal: 410000n, comissao: null, aereo: false });

    const op = contas.find((c) => c.fornecedor === "Operadora Mediterrânea")!;
    expect(op.comissaoTipo).toBe("a_receber");
    expect(op.previstoBrl).toBe(950000n);
    expect(op.comissao).toEqual({ baseBrl: 950000n, pct: "10.000", valor: 95000n, previstaPara: "2027-03-15" });
  });

  it("descontada paga o líquido; a cotação usada é a escolhida", () => {
    seq = 0;
    const s = snapshot(
      [
        item("Passeio", "Passeio", [
          fornecedor("Caro", { valorBrl: 200000n, escolhida: false }),
          fornecedor("Barato", { valorBrl: 150000n, comissaoPct: "10.000", escolhida: true }),
        ]),
      ],
      "2026-12-01",
      "2026-12-31",
    );
    const [c] = contasDoSnapshot(s, {}, s.fim);
    expect(c).toMatchObject({ fornecedor: "Barato", comissaoTipo: "descontada", previstoBrl: 135000n, valorBrl: 150000n, comissao: null });
  });

  it("comissão em dezembro vence em 15 de janeiro; moeda estrangeira leva o original líquido", () => {
    seq = 0;
    const s = snapshot(
      [item("Hotelaria", "Hotel", [fornecedor("Paris", { moeda: "EUR", valorOriginal: 100000n, cambioAplicado: "6.1582", valorBrl: 615820n, comissaoPct: "8.000" })])],
      "2026-12-20",
      "2026-12-31",
    );
    const [a] = contasDoSnapshot(s, { "f-Paris": "comissionado" }, s.fim);
    expect(a.comissao).toEqual({ baseBrl: 615820n, pct: "8.000", valor: 49266n, previstaPara: "2027-01-15" });
    expect(a.previstoOriginal).toBe(100000n);
    const [d] = contasDoSnapshot(s, {}, s.fim);
    expect(d).toMatchObject({ previstoBrl: 566554n, previstoOriginal: 92000n, moeda: "EUR", cambioAplicado: "6.1582" });
  });

  it("comissionado com comissão zero não gera comissão", () => {
    const { s } = ribeiro();
    const contas = contasDoSnapshot(s, { "f-Hotel Miradouro Sete": "comissionado" }, s.fim);
    expect(contas[0]).toMatchObject({ comissaoTipo: "a_receber", previstoBrl: 390000n, comissao: null });
  });
});

describe("aplicarFormaFornecedor", () => {
  const conta = (o: Partial<Pick<ContaGerada, "moeda" | "previstoOriginal" | "previstoBrl">> = {}) => ({
    moeda: "BRL" as const,
    previstoOriginal: 1302000n,
    previstoBrl: 1302000n,
    ...o,
  });
  it("à vista aplica o desconto da cotação", () => {
    expect(aplicarFormaFornecedor(conta(), { tipo: "a_vista", vencimento: "2026-12-01" }, "7.000")).toEqual([
      { numero: 1, vencimento: "2026-12-01", valorOriginal: 1210860n, valorBrlPrevisto: 1210860n },
    ]);
    expect(aplicarFormaFornecedor(conta(), { tipo: "a_vista" }, null)).toEqual([
      { numero: 1, vencimento: null, valorOriginal: 1302000n, valorBrlPrevisto: 1302000n },
    ]);
  });
  it("parcelado: soma igual ao previsto; reais proporcionais e a última absorve", () => {
    const eur = conta({ moeda: "EUR", previstoOriginal: 100000n, previstoBrl: 615821n });
    const linhas = aplicarFormaFornecedor(
      eur,
      {
        tipo: "parcelado",
        parcelas: [
          { vencimento: "2026-12-01", valorOriginal: 33333n },
          { vencimento: "2027-01-01", valorOriginal: 33333n },
          { vencimento: "2027-02-01", valorOriginal: 33334n },
        ],
      },
      "5.000",
    );
    expect(linhas.map((l) => l.valorOriginal)).toEqual([33333n, 33333n, 33334n]);
    expect(linhas.reduce((a, l) => a + l.valorBrlPrevisto, 0n)).toBe(615821n);
    expect(linhas[0].valorBrlPrevisto).toBe(205271n);
    expect(() =>
      aplicarFormaFornecedor(eur, { tipo: "parcelado", parcelas: [{ vencimento: "2026-12-01", valorOriginal: 99999n }] }, null),
    ).toThrow("A soma das parcelas deve ser igual ao valor previsto");
    expect(() => aplicarFormaFornecedor(eur, { tipo: "parcelado", parcelas: [] }, null)).toThrow("Informe as parcelas");
  });
  it("parcelado com linhas mínimas ou zeradas: reais nunca negativos e soma exata", () => {
    const pequena = conta({ moeda: "EUR", previstoOriginal: 10n, previstoBrl: 7n });
    const parcelas = Array.from({ length: 10 }, (_, i) => ({ vencimento: `2027-0${(i % 9) + 1}-01`, valorOriginal: 1n }));
    const l1 = aplicarFormaFornecedor(pequena, { tipo: "parcelado", parcelas }, null);
    expect(l1.every((l) => l.valorBrlPrevisto >= 0n)).toBe(true);
    expect(l1.reduce((a, l) => a + l.valorBrlPrevisto, 0n)).toBe(7n);
    const comZero = conta({ moeda: "EUR", previstoOriginal: 3n, previstoBrl: 20n });
    const l2 = aplicarFormaFornecedor(
      comZero,
      {
        tipo: "parcelado",
        parcelas: [
          { vencimento: "2027-01-01", valorOriginal: 1n },
          { vencimento: "2027-02-01", valorOriginal: 0n },
          { vencimento: "2027-03-01", valorOriginal: 1n },
          { vencimento: "2027-04-01", valorOriginal: 1n },
          { vencimento: "2027-05-01", valorOriginal: 0n },
        ],
      },
      null,
    );
    expect(l2.map((l) => l.valorBrlPrevisto)).toEqual([6n, 0n, 6n, 6n, 2n]);
    expect(l2.every((l) => l.valorBrlPrevisto >= 0n)).toBe(true);
    expect(l2.reduce((a, l) => a + l.valorBrlPrevisto, 0n)).toBe(20n);
    const zerada = aplicarFormaFornecedor(
      conta({ previstoOriginal: 0n, previstoBrl: 0n }),
      { tipo: "parcelado", parcelas: [{ vencimento: "2027-01-01", valorOriginal: 0n }, { vencimento: "2027-02-01", valorOriginal: 0n }] },
      null,
    );
    expect(zerada.map((l) => l.valorBrlPrevisto)).toEqual([0n, 0n]);
  });
  it("cartão corporativo: uma linha na data da fatura, valor cheio", () => {
    expect(aplicarFormaFornecedor(conta(), { tipo: "cartao_corporativo", vencimento: "2026-12-10" }, "7.000")).toEqual([
      { numero: 1, vencimento: "2026-12-10", valorOriginal: 1302000n, valorBrlPrevisto: 1302000n },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Margem real e ponte
// ---------------------------------------------------------------------------

function vender(s: Snapshot, modalidade: Record<string, "net" | "comissionado">, forma: FormaPagamento, dias: number) {
  const r0 = resultadoDaVersao(s, 0n, forma, dias, "por_dia", R);
  const preco = precoDoPacote(BigInt(r0.custo), forma, R);
  const resultado = resultadoDaVersao(s, preco, forma, dias, "por_dia", R);
  const total = BigInt(resultado.precoCliente!);
  const contas = contasDoSnapshot(s, modalidade, s.fim);
  const crono = cronogramaRecebimento(total, forma.parcelas, "2026-11-20");
  const previstas = alocarTaxasPrevistas(BigInt(resultado.taxa), crono.map((p) => p.valor));
  const parcelas = crono.map((p, i) => ({
    valor: p.valor,
    recebida: false,
    taxaEfetiva: null as bigint | null,
    taxaPrevista: previstas[i],
  }));
  return { preco, resultado, total, contas, parcelas };
}

describe("margemReal", () => {
  it.each<[string, FormaPagamento]>([
    ["pix", { tipo: "pix", parcelas: 1 }],
    ["boleto 4x", { tipo: "boleto", parcelas: 4 }],
    ["cartão 6x", { tipo: "credito", parcelas: 6 }],
  ])("sem divergência e comissão recebida (%s): igual à margem da aprovação (mesma fórmula)", (_, forma) => {
    seq = 0;
    const s = snapshot(
      [
        item("Hotelaria", "Hotel", [fornecedor("Hotel Net", { valorBrl: 1234567n, comissaoPct: "0.000" })], { diarias: 3 }),
        item("Passeio", "Circuito", [fornecedor("Operadora", { valorBrl: 950001n, comissaoPct: "10.000" })]),
        item("Transfer", "Transfer", [fornecedor("Transfer Desc", { valorBrl: 480003n, comissaoPct: "12.500" })]),
        item("Aéreo", "Voo", [fornecedor("Cia", { valorBrl: 3000000n })]),
        item("Taxa", "Taxa de roteiro", [cot({ valorBrl: 25000n })]),
      ],
      "2027-01-15",
      "2027-02-01",
    );
    const { preco, resultado, contas, parcelas } = vender(s, { "f-Operadora": "comissionado" }, forma, 18);
    if (forma.tipo !== "pix") expect(BigInt(resultado.taxa) > 0n).toBe(true);
    const comissao = contas.find((c) => c.comissao)!.comissao!;
    const m = margemReal({
      preco,
      contas: contas.map((c) => ({ aereo: c.aereo, previstoBrl: c.previstoBrl, pagoBrl: null })),
      comissoesRecebidas: comissao.valor,
      parcelas,
      fixo: BigInt(resultado.fixo),
      impostoPct: R.impostoSobreMargemPct,
      taxaRoteiro: taxaRoteiroDoSnapshot(s),
    });
    expect(m.custo).toBe(BigInt(resultado.custo));
    expect(m.imposto).toBe(BigInt(resultado.imposto));
    expect(m.taxas).toBe(BigInt(resultado.taxa));
    expect(m.fixo).toBe(BigInt(resultado.fixo));
    expect(m.final).toBe(BigInt(resultado.final));
    expect(m.finalPct).toBe(resultado.finalPct);

    const ponte = ponteDaMargem({
      planejada: planejadaDaVersao(resultado),
      preco,
      impostoPct: R.impostoSobreMargemPct,
      taxaRoteiro: taxaRoteiroDoSnapshot(s),
      contas: contas.map((c) => ({ rotulo: c.fornecedor ?? c.descricao, aereo: c.aereo, moeda: c.moeda, previstoVendaBrl: c.previstoBrl, previstoBrl: c.previstoBrl, pagoBrl: null })),
      comissoes: [{ fornecedor: "Operadora", aereo: false, valorPrevisto: comissao.valor, valorRecebido: comissao.valor }],
      parcelas,
    });
    expect(ponte.real).toEqual(m);
    expect(ponte.linhas).toEqual([
      { rotulo: "Margem planejada", valor: BigInt(resultado.final) },
      { rotulo: "Margem real", valor: BigInt(resultado.final) },
    ]);
  });

  it("taxas: efetiva quando recebida e informada, senão a prevista (sem escala)", () => {
    const m = margemReal({
      preco: 900000n,
      contas: [{ aereo: false, previstoBrl: 500000n, pagoBrl: 510000n }, { aereo: true, previstoBrl: 999999n, pagoBrl: null }],
      comissoesRecebidas: 10000n,
      parcelas: [
        { valor: 500000n, recebida: true, taxaEfetiva: 1000n, taxaPrevista: 17350n },
        { valor: 500000n, recebida: true, taxaEfetiva: null, taxaPrevista: 17350n },
        { valor: 0n, recebida: false, taxaEfetiva: 5n, taxaPrevista: 3n },
      ],
      fixo: 100000n,
      impostoPct: "7.000",
      taxaRoteiro: 25000n,
    });
    // custo = 510000 − 10000 + 25000 (Aéreo fora)
    expect(m.custo).toBe(525000n);
    // 7% de 375000
    expect(m.imposto).toBe(26250n);
    // 1000 (efetiva) + 17350 (recebida sem efetiva) + 3 (não recebida)
    expect(m.taxas).toBe(18353n);
    expect(m.final).toBe(900000n - 525000n - 26250n - 18353n - 100000n);
    expect(m.finalPct).toBe("25.6");
  });

  it("custo acima do preço: imposto zero e margem negativa", () => {
    const m = margemReal({
      preco: 100000n,
      contas: [{ aereo: false, previstoBrl: 120000n, pagoBrl: null }],
      comissoesRecebidas: 0n,
      parcelas: [],
      fixo: 0n,
      impostoPct: "7.000",
      taxaRoteiro: 0n,
    });
    expect(m).toEqual({ custo: 120000n, imposto: 0n, taxas: 0n, fixo: 0n, final: -20000n, finalPct: "-20.0" });
  });
});

describe("ponteDaMargem", () => {
  const somaMeio = (l: { valor: bigint }[]) => l.slice(1, -1).reduce((a, x) => a + x.valor, 0n);

  it("Ribeiro: Florença 4100 → 5940 e comissão não recebida; a ponte explica a diferença exata", () => {
    const { s, modalidade } = ribeiro();
    const forma: FormaPagamento = { tipo: "boleto", parcelas: 5 };
    const { preco, resultado, contas, parcelas: previstas } = vender(s, modalidade, forma, 18);
    const planejada = planejadaDaVersao(resultado);
    // 1º boleto recebido com taxa efetiva R$ 1,00 acima da prevista; os demais ainda em aberto
    const parcelas = previstas.map((p, i) => (i === 0 ? { ...p, recebida: true, taxaEfetiva: p.taxaPrevista + 100n } : p));
    const entradaContas = contas.map((c) => ({
      rotulo: c.fornecedor ?? c.descricao,
      aereo: c.aereo,
      moeda: c.moeda,
      previstoVendaBrl: c.previstoBrl,
      previstoBrl: c.fornecedor === "Palazzo Lungarno Nove" ? 594000n : c.previstoBrl,
      pagoBrl: null as bigint | null,
    }));
    const p = ponteDaMargem({
      planejada,
      preco,
      impostoPct: R.impostoSobreMargemPct,
      taxaRoteiro: taxaRoteiroDoSnapshot(s),
      contas: entradaContas,
      comissoes: [{ fornecedor: "Operadora Mediterrânea", aereo: false, valorPrevisto: 95000n, valorRecebido: null }],
      parcelas,
    });
    const real = margemReal({
      preco,
      contas: entradaContas,
      comissoesRecebidas: 0n,
      parcelas,
      fixo: planejada.fixo,
      impostoPct: R.impostoSobreMargemPct,
      taxaRoteiro: taxaRoteiroDoSnapshot(s),
    });
    expect(p.real).toEqual(real);
    expect(real.final < planejada.final).toBe(true);
    expect(p.linhas[0]).toEqual({ rotulo: "Margem planejada", valor: planejada.final });
    expect(p.linhas.at(-1)).toEqual({ rotulo: "Margem real", valor: real.final });
    expect(somaMeio(p.linhas)).toBe(real.final - planejada.final);
    expect(p.linhas.map((l) => l.rotulo)).toEqual([
      "Margem planejada",
      "Palazzo Lungarno Nove: valor atualizado",
      "Comissão pendente: Operadora Mediterrânea",
      "Taxas financeiras",
      "Imposto",
      "Margem real",
    ]);
    expect(p.linhas[1].valor).toBe(-184000n);
    expect(p.linhas[2].valor).toBe(-95000n);
    // custo sobe 279000 → imposto cai 7% disso
    expect(p.linhas[4].valor).toBe(19530n);
    // boletos: 5 × R$ 2,50 na aprovação; só a diferença da taxa efetiva do 1º boleto aparece
    expect(real.taxas).toBe(1350n);
    expect(p.linhas[3].valor).toBe(-100n);
  });

  it("escolhida mais barata que a precificada: 'Fornecedores escolhidos' = margem extra; câmbio nas contas pagas em moeda estrangeira", () => {
    seq = 0;
    const s = snapshot(
      [
        item("Hotelaria", "Hotel Paris", [
          fornecedor("Caro", { moeda: "EUR", valorOriginal: 100000n, cambioAplicado: "6.1582", valorBrl: 615820n, escolhida: false }),
          fornecedor("Barato", { moeda: "EUR", valorOriginal: 90000n, cambioAplicado: "6.1582", valorBrl: 554238n, escolhida: true }),
        ]),
        item("Passeio", "Passeio", [fornecedor("Guia", { valorBrl: 300000n })]),
      ],
      "2027-01-10",
      "2027-01-20",
    );
    const forma: FormaPagamento = { tipo: "credito", parcelas: 6 };
    const { preco, resultado, contas, parcelas } = vender(s, {}, forma, 10);
    expect(BigInt(resultado.margemExtra)).toBe(61582n);
    const p = ponteDaMargem({
      planejada: planejadaDaVersao(resultado),
      preco,
      impostoPct: R.impostoSobreMargemPct,
      taxaRoteiro: taxaRoteiroDoSnapshot(s),
      contas: [
        { rotulo: "Barato", aereo: false, moeda: "EUR", previstoVendaBrl: contas[0].previstoBrl, previstoBrl: contas[0].previstoBrl, pagoBrl: 560000n },
        { rotulo: "Guia", aereo: false, moeda: "BRL", previstoVendaBrl: 300000n, previstoBrl: 300000n, pagoBrl: 300500n },
      ],
      comissoes: [],
      parcelas,
    });
    const linhas = Object.fromEntries(p.linhas.map((l) => [l.rotulo, l.valor]));
    expect(linhas["Fornecedores escolhidos"]).toBe(61582n);
    expect(linhas["Diferença de câmbio"]).toBe(554238n - 560000n);
    expect(linhas["Guia: valor atualizado"]).toBe(-500n);
    expect(linhas["Imposto"]).toBeDefined();
    expect(somaMeio(p.linhas)).toBe(p.real.final - BigInt(resultado.final));
  });

  it("Aéreo fica fora da ponte e da margem; comissão recebida com valor diferente aparece", () => {
    const planejada = { custo: 500000n, imposto: 35000n, taxa: 0n, fixo: 0n, final: 1000000n - 500000n - 35000n };
    const p = ponteDaMargem({
      planejada,
      preco: 1000000n,
      impostoPct: "7.000",
      taxaRoteiro: 0n,
      contas: [
        { rotulo: "Op", aereo: false, moeda: "BRL", previstoVendaBrl: 550000n, previstoBrl: 550000n, pagoBrl: 550000n },
        { rotulo: "Cia", aereo: true, moeda: "BRL", previstoVendaBrl: 100000n, previstoBrl: 150000n, pagoBrl: 160000n },
      ],
      comissoes: [
        { fornecedor: "Op", aereo: false, valorPrevisto: 50000n, valorRecebido: 45000n },
        { fornecedor: "Cia", aereo: true, valorPrevisto: 1000n, valorRecebido: null },
      ],
      parcelas: [],
    });
    expect(p.linhas.map((l) => [l.rotulo, l.valor])).toEqual([
      ["Margem planejada", 465000n],
      ["Comissão recebida: Op", -5000n],
      ["Imposto", 350n],
      ["Margem real", 460350n],
    ]);
  });

  it("comissão marcada não recebida tem rótulo próprio", () => {
    const p = ponteDaMargem({
      planejada: { custo: 500000n, imposto: 35000n, taxa: 0n, fixo: 0n, final: 465000n },
      preco: 1000000n,
      impostoPct: "7.000",
      taxaRoteiro: 0n,
      contas: [{ rotulo: "Op", aereo: false, moeda: "BRL", previstoVendaBrl: 550000n, previstoBrl: 550000n, pagoBrl: null }],
      comissoes: [{ fornecedor: "Op", aereo: false, valorPrevisto: 50000n, valorRecebido: null, naoRecebida: true }],
      parcelas: [],
    });
    expect(p.linhas.map((l) => [l.rotulo, l.valor])).toEqual([
      ["Margem planejada", 465000n],
      ["Comissão não recebida: Op", -50000n],
      ["Imposto", 3500n],
      ["Margem real", 418500n],
    ]);
  });
});

describe("statusDaViagem", () => {
  const base = { status: "vendida", inicio: "2027-01-15", fim: "2027-02-01", conciliadaEm: null };
  it("deriva pela data e pela conciliação", () => {
    expect(statusDaViagem({ ...base, status: "aprovado", hoje: "2027-01-20" })).toBe("orcamento");
    expect(statusDaViagem({ ...base, hoje: "2027-01-14" })).toBe("vendida");
    expect(statusDaViagem({ ...base, hoje: "2027-01-15" })).toBe("em_viagem");
    expect(statusDaViagem({ ...base, hoje: "2027-02-01" })).toBe("em_viagem");
    expect(statusDaViagem({ ...base, hoje: "2027-02-02" })).toBe("recebendo");
    expect(statusDaViagem({ ...base, hoje: "2027-06-30" })).toBe("recebendo");
    expect(statusDaViagem({ ...base, hoje: "2027-01-10", conciliadaEm: "2027-03-01" })).toBe("conciliada");
  });
  it("rótulos", () => {
    expect(ROTULO_STATUS_VIAGEM).toEqual({
      orcamento: "Orçamento",
      vendida: "Vendida",
      em_viagem: "Em viagem",
      recebendo: "Recebendo",
      conciliada: "Conciliada",
    });
  });
});

describe("vencimentoPadraoFornecedor", () => {
  it("30 dias antes do início, nunca antes do aceite", () => {
    expect(vencimentoPadraoFornecedor("2027-08-14", "2026-11-20")).toBe("2027-07-15");
    expect(vencimentoPadraoFornecedor("2027-03-01", "2026-11-20")).toBe("2027-01-30");
    expect(vencimentoPadraoFornecedor("2026-12-10", "2026-11-20")).toBe("2026-11-20");
    expect(() => vencimentoPadraoFornecedor("2027-02-30", "2026-11-20")).toThrow("Data inválida");
  });
});

describe("reprevisarLinhas", () => {
  const l = (o: bigint, b: bigint, pago = false) => ({ valorOriginal: o, valorBrlPrevisto: b, pago });

  it("uma linha sem desconto: vira o novo previsto", () => {
    expect(reprevisarLinhas([l(500000n, 500000n)], { original: 500000n, brl: 500000n }, { original: 684000n, brl: 684000n })).toEqual([
      { valorOriginal: 684000n, valorBrlPrevisto: 684000n },
    ]);
  });

  it("à vista com desconto: a diferença entra na mesma razão (desconto mantido)", () => {
    // 310600 com 4% à vista = 298176; previsto vai a 320000 → 307200 (= 320000 × 0,96)
    expect(reprevisarLinhas([l(298176n, 298176n)], { original: 310600n, brl: 310600n }, { original: 320000n, brl: 320000n })).toEqual([
      { valorOriginal: 307200n, valorBrlPrevisto: 307200n },
    ]);
  });

  it("parcelado com uma paga: só as em aberto absorvem, na proporção, soma exata", () => {
    const r = reprevisarLinhas(
      [l(50000n, 50000n, true), l(30000n, 30000n), l(20000n, 20000n)],
      { original: 100000n, brl: 100000n },
      { original: 110001n, brl: 110001n },
    );
    expect(r[0]).toEqual({ valorOriginal: 50000n, valorBrlPrevisto: 50000n });
    expect(r[1].valorBrlPrevisto + r[2].valorBrlPrevisto).toBe(60001n);
    expect(r[1].valorBrlPrevisto).toBe(36000n);
    expect(r[2].valorBrlPrevisto).toBe(24001n);
  });

  it("redução maior que o em aberto: nunca negativo", () => {
    const r = reprevisarLinhas([l(50000n, 50000n, true), l(50000n, 50000n)], { original: 100000n, brl: 100000n }, { original: 10000n, brl: 10000n });
    expect(r).toEqual([
      { valorOriginal: 50000n, valorBrlPrevisto: 50000n },
      { valorOriginal: 0n, valorBrlPrevisto: 0n },
    ]);
  });

  it("moeda estrangeira: original e reais separados; linhas zeradas recebem na última", () => {
    const r = reprevisarLinhas([l(0n, 0n), l(0n, 0n)], { original: 0n, brl: 0n }, { original: 1000n, brl: 6158n });
    expect(r).toEqual([
      { valorOriginal: 0n, valorBrlPrevisto: 0n },
      { valorOriginal: 1000n, valorBrlPrevisto: 6158n },
    ]);
  });
});
