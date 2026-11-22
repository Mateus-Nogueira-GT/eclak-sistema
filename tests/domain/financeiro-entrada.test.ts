import { describe, expect, it } from "vitest";
import {
  baixaLancamentoSchema,
  categoriaSchema,
  contaBancariaSchema,
  filtroLancamentosSchema,
  lancamentoSchema,
  loteSchema,
  repasseSchema,
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
  it("parcelado: 2 a 60", () => {
    expect(lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "parcelado", parcelas: 60 } }).success).toBe(true);
    expect(lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "parcelado", parcelas: 61 } }).success).toBe(false);
    expect(lancamentoSchema.safeParse({ ...lanc, repeticao: { tipo: "parcelado", parcelas: 1 } }).success).toBe(false);
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
