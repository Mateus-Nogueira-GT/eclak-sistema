import { describe, expect, it } from "vitest";
import { envioSchema, formaSchema, rotuloForma } from "@/domain/aprovacoes";

describe("forma de pagamento da versão", () => {
  const s = formaSchema(10);

  it("normaliza: antecipação só no crédito; pix e cartão direto só em 1x", () => {
    expect(s.parse({ tipo: "credito", parcelas: 6, antecipado: true })).toEqual({ tipo: "credito", parcelas: 6, antecipado: true });
    expect(s.parse({ tipo: "credito", parcelas: 6, antecipado: false })).toEqual({ tipo: "credito", parcelas: 6 });
    expect(s.parse({ tipo: "boleto", parcelas: 4, antecipado: true })).toEqual({ tipo: "boleto", parcelas: 4 });
    expect(s.parse({ tipo: "pix", parcelas: 1 })).toEqual({ tipo: "pix", parcelas: 1 });
    expect(s.safeParse({ tipo: "pix", parcelas: 2 }).success).toBe(false);
    expect(s.safeParse({ tipo: "cartao_fornecedor", parcelas: 3 }).success).toBe(false);
  });

  it("parcelas de 1 ao parcelamento máximo dos Parâmetros", () => {
    expect(s.safeParse({ tipo: "credito", parcelas: 0 }).success).toBe(false);
    expect(s.safeParse({ tipo: "credito", parcelas: 11 }).success).toBe(false);
    expect(s.safeParse({ tipo: "credito", parcelas: 2.5 }).success).toBe(false);
    expect(formaSchema(6).safeParse({ tipo: "boleto", parcelas: 7 }).success).toBe(false);
    expect(formaSchema(6).safeParse({ tipo: "boleto", parcelas: 6 }).success).toBe(true);
    const r = s.safeParse({ tipo: "cheque", parcelas: 1 });
    expect(r.success ? null : r.error.issues[0].message).toBe("Forma de pagamento inválida");
    const p = s.safeParse({ tipo: "credito", parcelas: 11 });
    expect(p.success ? null : p.error.issues[0].message).toBe("Parcelas inválidas");
  });

  it("rótulos em pt-BR", () => {
    expect(rotuloForma({ tipo: "pix", parcelas: 1 })).toBe("Pix");
    expect(rotuloForma({ tipo: "cartao_fornecedor", parcelas: 1 })).toBe("Cartão direto no fornecedor");
    expect(rotuloForma({ tipo: "boleto", parcelas: 4 })).toBe("Boleto em 4x");
    expect(rotuloForma({ tipo: "credito", parcelas: 2 })).toBe("Cartão em 2x");
    expect(rotuloForma({ tipo: "credito", parcelas: 6, antecipado: true })).toBe("Cartão em 6x com antecipação");
  });

  it("envio: preço opcional em reais; alteração vazia vira nulo", () => {
    const e = envioSchema(10);
    expect(e.parse({ forma: { tipo: "pix", parcelas: 1 }, alteracao: "  " })).toEqual({
      preco: null,
      forma: { tipo: "pix", parcelas: 1 },
      alteracao: null,
    });
    expect(e.parse({ preco: "50.000,10", forma: { tipo: "pix", parcelas: 1 }, alteracao: "Primeira" }).preco).toBe(5000010n);
    const r = e.safeParse({ preco: "abc", forma: { tipo: "pix", parcelas: 1 }, alteracao: "" });
    expect(r.success ? null : r.error.issues[0].message).toBe("Valor inválido");
    expect(e.safeParse({ preco: "0,00", forma: { tipo: "pix", parcelas: 1 }, alteracao: "" }).success).toBe(false);
  });
});
