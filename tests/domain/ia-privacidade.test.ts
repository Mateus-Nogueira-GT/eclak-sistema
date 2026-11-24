import { describe, expect, it } from "vitest";
import { protegerTexto } from "@/domain/ia-privacidade";

describe("protegerTexto", () => {
  it("CPF com máscara e com 11 dígitos", () => {
    expect(protegerTexto("CPF do titular: 123.456.789-09.")).toBe("CPF do titular: [CPF].");
    expect(protegerTexto("cpf 12345678909 ok")).toBe("cpf [CPF] ok");
  });

  it("11 dígitos dentro de um número maior não viram CPF (mas 14 viram CNPJ)", () => {
    expect(protegerTexto("pedido 123456789012")).toBe("pedido 123456789012");
    expect(protegerTexto("CNPJ 12345678000195")).toBe("CNPJ [CNPJ]");
  });

  it("CNPJ com máscara", () => {
    expect(protegerTexto("Fornecedor 12.345.678/0001-95 pago")).toBe("Fornecedor [CNPJ] pago");
  });

  it("passaporte: 2 letras e 6 ou 7 dígitos", () => {
    expect(protegerTexto("Passaporte FZ123456, validade 2030")).toBe("Passaporte [PASSAPORTE], validade 2030");
    expect(protegerTexto("passaporte AB1234567.")).toBe("passaporte [PASSAPORTE].");
    // Voo e código de viagem não são passaporte.
    expect(protegerTexto("Voo AZ675 e ECL-0147-01")).toBe("Voo AZ675 e ECL-0147-01");
  });

  it("RG com máscara", () => {
    expect(protegerTexto("RG 12.345.678-9 e 1.234.567-X")).toBe("RG [RG] e [RG]");
  });

  it("nascimentos conhecidos em dd/mm/aaaa e ISO", () => {
    const conhecidos = { nascimentos: ["1980-03-07"] };
    expect(protegerTexto("Nasceu em 07/03/1980, ou 1980-03-07.", conhecidos)).toBe("Nasceu em [NASCIMENTO], ou [NASCIMENTO].");
    // Sem a data na lista, a data fica.
    expect(protegerTexto("Nasceu em 07/03/1980.")).toBe("Nasceu em 07/03/1980.");
  });

  it("datas de viagem e valores ficam", () => {
    const t = "Embarque em 14/08/2027 (2027-08-14), total R$ 1.234,56 e R$ 12.345.678,00; hotel às 14h30.";
    expect(protegerTexto(t, { nascimentos: ["1980-03-07"] })).toBe(t);
  });

  it("documentos conhecidos (ex.: passaporte estrangeiro) viram [DOCUMENTO]; os curtos demais ficam", () => {
    expect(protegerTexto("Doc 563829104 e x9", { documentos: ["563829104", "x9"] })).toBe("Doc [DOCUMENTO] e x9");
    // Valor conhecido com caracteres especiais de regex não quebra.
    expect(protegerTexto("Doc A.B*123", { documentos: ["A.B*123"] })).toBe("Doc [DOCUMENTO]");
    // CPF conhecido sem máscara aparece com máscara no texto: o padrão pega.
    expect(protegerTexto("CPF 123.456.789-09", { documentos: ["12345678909"] })).toBe("CPF [CPF]");
  });

  it("vários padrões no mesmo texto", () => {
    expect(
      protegerTexto("Ana (CPF 123.456.789-09, passaporte FZ123456, nascida em 1990-12-31) viaja em 14/08/2027.", {
        nascimentos: ["1990-12-31"],
      }),
    ).toBe("Ana (CPF [CPF], passaporte [PASSAPORTE], nascida em [NASCIMENTO]) viaja em 14/08/2027.");
  });
});
