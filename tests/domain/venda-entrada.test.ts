import { describe, expect, it } from "vitest";
import { alteracaoNovaForma, fechamentoSchema, novaFormaSchema, pedidoClienteSchema } from "@/domain/venda-entrada";

const base = {
  aceiteEm: "2026-11-20",
  forma: { tipo: "boleto", parcelas: 4 },
  parcelas: 4,
  primeiroVencimento: "2026-12-10",
  faturaNome: "Marcos Souza",
  faturaDocumento: "529.982.247-25",
};
const erro = (x: Record<string, unknown>) => {
  const r = fechamentoSchema.safeParse({ ...base, ...x });
  return r.success ? null : r.error.issues[0].message;
};

describe("fechamentoSchema", () => {
  it("normaliza o documento e os textos opcionais", () => {
    const r = fechamentoSchema.parse({ ...base, comprovante: "  ", observacao: " Emitir fatura " });
    expect(r).toMatchObject({ faturaDocumento: "52998224725", comprovante: null, observacao: "Emitir fatura", forma: { tipo: "boleto", parcelas: 4 } });
    expect(fechamentoSchema.parse({ ...base, faturaDocumento: "11.222.333/0001-81" }).faturaDocumento).toBe("11222333000181");
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
