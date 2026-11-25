import { describe, expect, it } from "vitest";
import {
  baixaFaturaCartaoSchema,
  baixaLancamentoSchema,
  cartaoSchema,
  categoriaSchema,
  contaBancariaSchema,
  filtroLancamentosSchema,
  lancamentoSchema,
  loteSchema,
  repasseSchema,
  filtroDaUrl,
} from "@/domain/financeiro-entrada";

const HOJE = "2026-11-22";
const U1 = "6f1b1d1e-1b1a-4c1d-8e1f-1a1b1c1d1e1f";
const U2 = "7f1b1d1e-1b1a-4c1d-8e1f-1a1b1c1d1e1f";

const lanc = {
  lado: "pagar",
  descricao: "Aluguel",
  categoriaId: U1,
  centro: "MT",
  competencia: "2026-11",
  emissao: "2026-11-01",
  vencimento: "2026-11-10",
  valor: "1.500,00",
  forma: "PIX",
  repeticao: { tipo: "unica" },
};

function erro(r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return r.error?.issues.map((i) => `${i.path.join(".")}: ${i.message}`) ?? [];
}

describe("lancamentoSchema", () => {
  it("cartão corporativo: obrigatório a pagar no cartão de crédito; nulo fora disso", () => {
    const credito = { ...lanc, forma: "Cartão de crédito" };
    expect(erro(lancamentoSchema.safeParse(credito))).toEqual(["cartaoId: Escolha o cartão corporativo"]);
    expect(erro(lancamentoSchema.safeParse({ ...credito, cartaoId: "" }))).toEqual(["cartaoId: Escolha o cartão corporativo"]);
    expect(lancamentoSchema.parse({ ...credito, cartaoId: U2 }).cartaoId).toBe(U2);
    expect(lancamentoSchema.parse({ ...lanc, cartaoId: U2 }).cartaoId).toBeNull();
    expect(lancamentoSchema.parse({ ...credito, lado: "receber", cartaoId: U2 }).cartaoId).toBeNull();
    expect(lancamentoSchema.parse(lanc).cartaoId).toBeNull();
  });
  it("aceita um lançamento válido e lê o valor em centavos", () => {
    const r = lancamentoSchema.safeParse(lanc);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.valor).toBe(150000n);
      expect(r.data.fornecedorId).toBeNull();
      expect(r.data.observacao).toBeNull();
    }
  });
  it("fornecedor e cliente juntos: erro no campo pessoa", () => {
    const r = lancamentoSchema.safeParse({ ...lanc, fornecedorId: U1, clienteId: U2 });
    expect(erro(r)).toContain("pessoa: Escolha só um: fornecedor, cliente ou nome");
  });
  it("valor zero", () => {
    expect(erro(lancamentoSchema.safeParse({ ...lanc, valor: "0,00" }))).toContain("valor: Informe um valor maior que zero");
  });
  it("parcelado: 2 a 60 e valor mínimo de R$ 0,01 por parcela", () => {
    expect(lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "parcelado", parcelas: 60 } }).success).toBe(true);
    expect(lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "parcelado", parcelas: 61 } }).success).toBe(false);
    expect(lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "parcelado", parcelas: 1 } }).success).toBe(false);
    expect(erro(lancamentoSchema.safeParse({ ...lanc, valor: "0,05", repeticao: { tipo: "parcelado", parcelas: 6 } }))).toContain(
      "valor: O valor total precisa ser de pelo menos R$ 0,01 por parcela",
    );
    expect(lancamentoSchema.safeParse({ ...lanc, valor: "0,06", repeticao: { tipo: "parcelado", parcelas: 6 } }).success).toBe(true);
  });
  it("recorrente", () => {
    expect(
      lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "recorrente", frequencia: "mensal", quantidade: 12 } }).success,
    ).toBe(true);
    expect(
      lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "recorrente", frequencia: "diaria", quantidade: 12 } }).success,
    ).toBe(false);
  });
  it("competência 2026-13", () => {
    expect(lancamentoSchema.safeParse({ ...lanc, competencia: "2026-13" }).success).toBe(false);
  });
  it("forma inválida", () => {
    expect(erro(lancamentoSchema.safeParse({ ...lanc, forma: "Cheque" }))).toContain("forma: Forma de pagamento inválida");
  });
  it("descrição vazia e data inexistente", () => {
    expect(lancamentoSchema.safeParse({ ...lanc, descricao: "  " }).success).toBe(false);
    expect(lancamentoSchema.safeParse({ ...lanc, vencimento: "2026-02-30" }).success).toBe(false);
  });
});

describe("baixaLancamentoSchema", () => {
  const baixa = { data: HOJE, valorPago: "100,00", contaBancariaId: U1 };
  it("aceita; juros e desconto viram 0", () => {
    const r = baixaLancamentoSchema(HOJE).safeParse(baixa);
    expect(r.success).toBe(true);
    if (r.success) expect([r.data.valorPago, r.data.juros, r.data.desconto]).toEqual([10000n, 0n, 0n]);
  });
  it("data futura", () => {
    expect(erro(baixaLancamentoSchema(HOJE).safeParse({ ...baixa, data: "2026-11-23" }))).toContain(
      "data: A data não pode ser futura",
    );
  });
  it("valor pago zero e juros negativo", () => {
    expect(baixaLancamentoSchema(HOJE).safeParse({ ...baixa, valorPago: "0,00" }).success).toBe(false);
    expect(baixaLancamentoSchema(HOJE).safeParse({ ...baixa, juros: "-1,00" }).success).toBe(false);
  });
});

describe("loteSchema", () => {
  const lote = { itens: [{ origem: "manual", id: U1 }], data: HOJE, contaBancariaId: U2 };
  it("aceita", () => {
    expect(loteSchema(HOJE).safeParse(lote).success).toBe(true);
  });
  it("item repetido", () => {
    const r = loteSchema(HOJE).safeParse({ ...lote, itens: [...lote.itens, { origem: "manual", id: U1 }] });
    expect(erro(r)).toContain("itens: Linha repetida no lote");
  });
  it("mesmo id em origens diferentes não é repetido; vazio e acima de 200 recusados", () => {
    expect(
      loteSchema(HOJE).safeParse({ ...lote, itens: [{ origem: "manual", id: U1 }, { origem: "parcela", id: U1 }] }).success,
    ).toBe(true);
    expect(loteSchema(HOJE).safeParse({ ...lote, itens: [] }).success).toBe(false);
    const muitos = Array.from({ length: 201 }, (_, i) => ({
      origem: "manual",
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    expect(loteSchema(HOJE).safeParse({ ...lote, itens: muitos }).success).toBe(false);
  });
  it("data futura", () => {
    expect(loteSchema(HOJE).safeParse({ ...lote, data: "2026-11-23" }).success).toBe(false);
  });
});

describe("repasseSchema", () => {
  it("aceita repasse zero, recusa data futura", () => {
    const base = { data: HOJE, valorRepassado: "0,00", contaBancariaId: U1 };
    expect(repasseSchema(HOJE).safeParse(base).success).toBe(true);
    expect(repasseSchema(HOJE).safeParse({ ...base, data: "2026-11-23" }).success).toBe(false);
  });
});

describe("categoria, conta bancária e filtro", () => {
  it("categoria", () => {
    expect(categoriaSchema.safeParse({ lado: "pagar", grupo: "Pessoal", nome: "Salários" }).success).toBe(true);
    expect(categoriaSchema.safeParse({ lado: "pagar", grupo: "Pessoal", nome: "" }).success).toBe(false);
  });
  it("conta bancária aceita saldo negativo", () => {
    const r = contaBancariaSchema.safeParse({ nome: "Itaú", saldoInicial: "-1.234,56", saldoInicialEm: "2026-11-01" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.saldoInicial).toBe(-123456n);
      expect(r.data.banco).toBeNull();
    }
    expect(contaBancariaSchema.safeParse({ nome: "X", saldoInicial: "abc", saldoInicialEm: "2026-11-01" }).success).toBe(false);
    expect(contaBancariaSchema.safeParse({ nome: "X", saldoInicial: "--1,00", saldoInicialEm: "2026-11-01" }).success).toBe(false);
  });
  it("filtro", () => {
    const f = { lado: "todos", de: "2026-11-01", ate: "2026-11-30", base: "vencimento", pagina: 1 };
    expect(filtroLancamentosSchema.safeParse(f).success).toBe(true);
    expect(filtroLancamentosSchema.safeParse({ ...f, pagina: 0 }).success).toBe(false);
    expect(filtroLancamentosSchema.safeParse({ ...f, busca: "x".repeat(101) }).success).toBe(false);
    expect(filtroLancamentosSchema.safeParse({ ...f, origem: "viagem", situacao: "vencida" }).success).toBe(true);
  });
});

describe("filtroDaUrl", () => {
  const HOJE = "2026-11-22";
  it("sem parâmetros: A pagar, vencimento no mês corrente, página 1", () => {
    expect(filtroDaUrl({}, HOJE)).toEqual({ lado: "pagar", base: "vencimento", de: "2026-11-01", ate: "2026-11-30", pagina: 1 });
  });
  it("lê os filtros, descarta vazios, desconhecidos e inválidos", () => {
    const id = "6f1c1a52-0f43-4b8e-9a43-9b3f1d6e2a11";
    expect(
      filtroDaUrl(
        { lado: "todos", de: "2026-01-01", ate: "2026-12-31", base: "competencia", situacao: "vencida", categoriaId: id, contaBancariaId: "", centro: "XX", origem: "viagem", busca: " Souza ", pagina: "3", outro: "x" },
        HOJE,
      ),
    ).toEqual({ lado: "todos", de: "2026-01-01", ate: "2026-12-31", base: "competencia", situacao: "vencida", categoriaId: id, origem: "viagem", busca: "Souza", pagina: 3 });
    expect(filtroDaUrl({ pagina: "0", lado: ["receber", "pagar"], de: "31/12/2026", grupo: "" }, HOJE)).toEqual({ lado: "receber", base: "vencimento", de: "2026-11-01", ate: "2026-11-30", pagina: 1 });
  });
  it("compras=incluir é lido; outro valor é descartado", () => {
    expect(filtroDaUrl({ compras: "incluir" }, HOJE).compras).toBe("incluir");
    expect(filtroDaUrl({ compras: "sim" }, HOJE)).not.toHaveProperty("compras");
  });
  it("fevereiro e dezembro", () => {
    expect(filtroDaUrl({}, "2028-02-10")).toMatchObject({ de: "2028-02-01", ate: "2028-02-29" });
    expect(filtroDaUrl({}, "2026-12-31")).toMatchObject({ de: "2026-12-01", ate: "2026-12-31" });
  });
});

describe("cartaoSchema", () => {
  const cartao = { nome: "Visa", final: "1234", diaFechamento: "15", diaVencimento: 25, contaBancariaId: U1, centro: "MT" };
  it("aceita e lê os dias como número", () => {
    expect(cartaoSchema.parse(cartao)).toEqual({ ...cartao, diaFechamento: 15, diaVencimento: 25 });
  });
  it("final de 4 dígitos, dias de 1 a 28, conta e centro obrigatórios", () => {
    expect(erro(cartaoSchema.safeParse({ ...cartao, final: "123" }))).toEqual(["final: Informe os 4 últimos dígitos do cartão"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, final: "12a4" }))).toEqual(["final: Informe os 4 últimos dígitos do cartão"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, diaFechamento: "29" }))).toEqual(["diaFechamento: Escolha um dia de 1 a 28"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, diaVencimento: "0" }))).toEqual(["diaVencimento: Escolha um dia de 1 a 28"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, diaVencimento: "" }))).toEqual(["diaVencimento: Escolha um dia de 1 a 28"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, diaVencimento: "1.5" }))).toEqual(["diaVencimento: Escolha um dia de 1 a 28"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, nome: " " }))).toEqual(["nome: Informe o nome do cartão"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, contaBancariaId: "" }))).toEqual(["contaBancariaId: Escolha a conta bancária"]);
    expect(erro(cartaoSchema.safeParse({ ...cartao, centro: "SP" }))).toEqual(["centro: Centro de custo inválido"]);
  });
});

describe("baixaFaturaCartaoSchema", () => {
  const s = baixaFaturaCartaoSchema(HOJE);
  it("data até hoje, conta bancária e os valores em reais das compras estrangeiras", () => {
    expect(s.parse({ data: HOJE, contaBancariaId: U1 })).toEqual({ data: HOJE, contaBancariaId: U1, estrangeiras: [] });
    expect(s.parse({ data: HOJE, contaBancariaId: U1, estrangeiras: [{ pagamentoId: U2, valorBrl: "6.543,21" }] })).toEqual({
      data: HOJE,
      contaBancariaId: U1,
      estrangeiras: [{ pagamentoId: U2, valorBrl: 654321n }],
    });
  });
  it("recusa data futura, conta vazia e campos estranhos", () => {
    expect(s.safeParse({ data: "2026-11-23", contaBancariaId: U1 }).success).toBe(false);
    expect(s.safeParse({ data: HOJE, contaBancariaId: "" }).success).toBe(false);
    expect(s.safeParse({ data: HOJE, contaBancariaId: U1, valorPago: "1,00" }).success).toBe(false);
  });
  it("valor em reais vazio, zero ou inválido: erro no campo da compra; compra repetida recusada", () => {
    const r = s.safeParse({ data: HOJE, contaBancariaId: U1, estrangeiras: [{ pagamentoId: U2, valorBrl: "" }] });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(["estrangeiras", U2]);
    expect(s.safeParse({ data: HOJE, contaBancariaId: U1, estrangeiras: [{ pagamentoId: U2, valorBrl: "0,00" }] }).success).toBe(false);
    const rep = s.safeParse({ data: HOJE, contaBancariaId: U1, estrangeiras: [{ pagamentoId: U2, valorBrl: "1,00" }, { pagamentoId: U2, valorBrl: "2,00" }] });
    expect(rep.success).toBe(false);
  });
});
