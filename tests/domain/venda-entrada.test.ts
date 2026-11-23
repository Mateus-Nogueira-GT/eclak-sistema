import { describe, expect, it } from "vitest";
import {
  alteracaoNovaForma,
  baixaPagamentoSchema,
  baixaParcelaSchema,
  comissaoRecebidaSchema,
  contestacaoSchema,
  fechamentoSchema,
  formaFornecedorSchema,
  motivoPrevistoSchema,
  motivoSchema,
  novaFormaSchema,
  pedidoClienteSchema,
} from "@/domain/venda-entrada";

const HOJE = "2026-11-22";
const CB = "6f1c3a52-8d4e-4b7a-9c21-0e5f7d8a9b10";
const base = {
  aceiteEm: "2026-11-20",
  forma: { tipo: "boleto", parcelas: 4 },
  parcelas: 4,
  primeiroVencimento: "2026-12-10",
  faturaNome: "Marcos Souza",
  faturaDocumento: "529.982.247-25",
};
const erro = (x: Record<string, unknown>) => {
  const r = fechamentoSchema(HOJE).safeParse({ ...base, ...x });
  return r.success ? null : r.error.issues[0].message;
};

describe("fechamentoSchema", () => {
  it("normaliza o documento e os textos opcionais", () => {
    const r = fechamentoSchema(HOJE).parse({ ...base, comprovante: "  ", observacao: " Emitir fatura " });
    expect(r).toMatchObject({ faturaDocumento: "52998224725", comprovante: null, observacao: "Emitir fatura", forma: { tipo: "boleto", parcelas: 4 } });
    expect(fechamentoSchema(HOJE).parse({ ...base, faturaDocumento: "11.222.333/0001-81" }).faturaDocumento).toBe("11222333000181");
  });

  it("mensagens", () => {
    expect(erro({ aceiteEm: "" })).toBe("Informe a data do aceite");
    expect(erro({ aceiteEm: undefined })).toBe("Informe a data do aceite");
    expect(erro({ aceiteEm: "2026-02-30" })).toBe("Data inválida");
    expect(erro({ primeiroVencimento: "" })).toBe("Informe o primeiro vencimento");
    expect(erro({ faturaNome: "  " })).toBe("Informe o nome da fatura");
    expect(erro({ faturaDocumento: "123.456.789-00" })).toBe("CPF ou CNPJ inválido");
    expect(erro({ faturaDocumento: "11.222.333/0001-82" })).toBe("CPF ou CNPJ inválido");
    expect(erro({ parcelas: 0 })).toBe("Número de parcelas inválido");
    expect(erro({ parcelas: 1.5 })).toBe("Número de parcelas inválido");
    expect(erro({ parcelas: 11 })).toBe("Número de parcelas inválido");
    expect(erro({ forma: { tipo: "pix", parcelas: 2 } })).toBe("Parcelas inválidas");
    expect(erro({ extra: 1 })).not.toBeNull();
    expect(erro({ primeiroVencimento: "2026-11-19" })).toBe("O primeiro vencimento não pode ser antes do aceite");
    expect(erro({ primeiroVencimento: "2026-11-20" })).toBeNull();
    expect(erro({ aceiteEm: "2026-11-23", primeiroVencimento: "2026-12-10" })).toBe("Data do aceite no futuro");
    expect(erro({ aceiteEm: "2026-11-22" })).toBeNull();
    // só pontuação de CPF/CNPJ e espaços saem; outro caractere invalida
    expect(erro({ faturaDocumento: " 529 982 247 25 " })).toBeNull();
    expect(erro({ faturaDocumento: "CPF 529.982.247-25" })).toBe("CPF ou CNPJ inválido");
    expect(erro({ faturaDocumento: "529.982.247-25x" })).toBe("CPF ou CNPJ inválido");
    expect(erro({ faturaDocumento: "529,982,247-25" })).toBe("CPF ou CNPJ inválido");
  });
});

describe("nova forma e pedido do cliente", () => {
  it("forma pelos Parâmetros; nota opcional; pedido obrigatório", () => {
    expect(novaFormaSchema(6).safeParse({ forma: { tipo: "credito", parcelas: 8 } }).success).toBe(false);
    expect(novaFormaSchema(10).parse({ forma: { tipo: "credito", parcelas: 8 }, nota: " Cartão em 8x " })).toEqual({
      forma: { tipo: "credito", parcelas: 8 },
      nota: "Cartão em 8x",
    });
    expect(alteracaoNovaForma("Cartão em 8x")).toBe("Nova forma de pagamento acordada com o cliente: Cartão em 8x");
    expect(alteracaoNovaForma(null)).toBe("Nova forma de pagamento acordada com o cliente");
    const p = pedidoClienteSchema.safeParse("   ");
    expect(p.success ? null : p.error.issues[0].message).toBe("Escreva o pedido do cliente");
  });
});

describe("entradas do financeiro da viagem", () => {
  const msg = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? null : r.error!.issues[0].message);

  it("baixa de parcela: data até hoje, valor em reais, taxa opcional", () => {
    expect(baixaParcelaSchema(HOJE).parse({ contaBancariaId: CB, recebidaEm: "2026-11-21", valorRecebido: "1.234,56" })).toEqual({
      recebidaEm: "2026-11-21",
      valorRecebido: 123456n,
      taxaEfetiva: null,
      observacao: null,
      contaBancariaId: CB,
    });
    expect(baixaParcelaSchema(HOJE).parse({ contaBancariaId: CB, recebidaEm: "2026-11-21", valorRecebido: "10", taxaEfetiva: "1,50" }).taxaEfetiva).toBe(150n);
    expect(baixaParcelaSchema(HOJE).parse({ contaBancariaId: CB, recebidaEm: "2026-11-21", valorRecebido: "10", observacao: "  Tarifa  " }).observacao).toBe("Tarifa");
    expect(baixaParcelaSchema(HOJE).parse({ contaBancariaId: CB, recebidaEm: "2026-11-21", valorRecebido: "10", observacao: "  " }).observacao).toBeNull();
    expect(msg(baixaParcelaSchema(HOJE).safeParse({ contaBancariaId: CB, recebidaEm: "", valorRecebido: "10" }))).toBe("Informe a data");
    expect(msg(baixaParcelaSchema(HOJE).safeParse({ contaBancariaId: CB, recebidaEm: "2026-11-23", valorRecebido: "10" }))).toBe("Data no futuro");
    expect(msg(baixaParcelaSchema(HOJE).safeParse({ contaBancariaId: CB, recebidaEm: "2026-11-21", valorRecebido: "abc" }))).toBe("Valor inválido");
  });

  it("conta bancária obrigatória nas três baixas: 'Escolha a conta bancária'", () => {
    for (const conta of [{}, { contaBancariaId: "" }, { contaBancariaId: "x" }, { contaBancariaId: null }]) {
      expect(msg(baixaParcelaSchema(HOJE).safeParse({ recebidaEm: "2026-11-21", valorRecebido: "10", ...conta }))).toBe("Escolha a conta bancária");
      expect(msg(baixaPagamentoSchema(HOJE).safeParse({ pagoEm: "2026-11-21", valorOriginalPago: "10", ...conta }))).toBe("Escolha a conta bancária");
      expect(msg(comissaoRecebidaSchema(HOJE).safeParse({ recebidaEm: "2026-11-21", valorRecebido: "10", ...conta }))).toBe("Escolha a conta bancária");
    }
    expect(comissaoRecebidaSchema(HOJE).parse({ recebidaEm: "2026-11-21", valorRecebido: "10", contaBancariaId: CB })).toEqual({
      recebidaEm: "2026-11-21",
      valorRecebido: 1000n,
      contaBancariaId: CB,
    });
  });

  it("baixa de pagamento: câmbio efetivo opcional no schema, canônico", () => {
    expect(baixaPagamentoSchema(HOJE).parse({ contaBancariaId: CB, pagoEm: "2026-11-21", valorOriginalPago: "1.000,00", cambioEfetivo: "6,3" })).toEqual({
      pagoEm: "2026-11-21",
      valorOriginalPago: 100000n,
      cambioEfetivo: "6.3000",
      contaBancariaId: CB,
    });
    expect(baixaPagamentoSchema(HOJE).parse({ contaBancariaId: CB, pagoEm: "2026-11-21", valorOriginalPago: "1" }).cambioEfetivo).toBeNull();
    expect(msg(baixaPagamentoSchema(HOJE).safeParse({ contaBancariaId: CB, pagoEm: "2026-11-21", valorOriginalPago: "1", cambioEfetivo: "0" }))).toBe("Câmbio inválido");
  });

  it("forma ao fornecedor", () => {
    expect(formaFornecedorSchema.parse({ tipo: "a_vista" })).toEqual({ tipo: "a_vista" });
    expect(formaFornecedorSchema.parse({ tipo: "parcelado", parcelas: [{ vencimento: "2027-01-10", valor: "100,00" }] })).toEqual({
      tipo: "parcelado",
      parcelas: [{ vencimento: "2027-01-10", valorOriginal: 10000n }],
    });
    expect(msg(formaFornecedorSchema.safeParse({ tipo: "parcelado", parcelas: [] }))).toBe("Informe as parcelas");
    expect(msg(formaFornecedorSchema.safeParse({ tipo: "cartao_corporativo" }))).toBe("Informe a data");
    expect(msg(formaFornecedorSchema.safeParse({ tipo: "boleto" }))).toBe("Forma inválida");
  });

  it("textos obrigatórios", () => {
    expect(msg(motivoPrevistoSchema.safeParse(" "))).toBe("Escreva o motivo da alteração");
    expect(msg(contestacaoSchema.safeParse(""))).toBe("Escreva a contestação");
    expect(msg(motivoSchema.safeParse(""))).toBe("Escreva o motivo");
    expect(motivoSchema.parse("  Fornecedor faliu ")).toBe("Fornecedor faliu");
  });
});
