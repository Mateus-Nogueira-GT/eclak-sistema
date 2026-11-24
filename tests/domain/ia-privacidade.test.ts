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
  it("CPF com separadores variados (ponto, hífen, barra ou espaço entre os grupos 3-3-3-2)", () => {
    expect(protegerTexto("cpf 123456789-09.")).toBe("cpf [CPF].");
    expect(protegerTexto("cpf 123 456 789 09 ok")).toBe("cpf [CPF] ok");
    expect(protegerTexto("cpf 123.456.789/09")).toBe("cpf [CPF]");
    expect(protegerTexto("cpf 123-456-789-09")).toBe("cpf [CPF]");
  });

  it("CNPJ com separadores variados", () => {
    expect(protegerTexto("cnpj 12.345.678/0001 95")).toBe("cnpj [CNPJ]");
    expect(protegerTexto("cnpj 12 345 678 0001 95")).toBe("cnpj [CNPJ]");
    expect(protegerTexto("cnpj 12345678/0001-95")).toBe("cnpj [CNPJ]");
  });

  it("passaporte com espaço ou hífen depois das letras", () => {
    expect(protegerTexto("Passaporte FZ 123456.")).toBe("Passaporte [PASSAPORTE].");
    expect(protegerTexto("Passaporte FZ-1234567")).toBe("Passaporte [PASSAPORTE]");
  });

  it("documentos conhecidos com separadores entre os caracteres", () => {
    const conhecidos = { documentos: ["YA1234567", "563829104"] };
    expect(protegerTexto("Doc YA 123 4567 e ya-1234567", conhecidos)).toBe("Doc [DOCUMENTO] e [DOCUMENTO]");
    expect(protegerTexto("Doc 563.829.104 e 563 829 104 e 563/829-104", conhecidos)).toBe(
      "Doc [DOCUMENTO] e [DOCUMENTO] e [DOCUMENTO]",
    );
    // O valor conhecido com máscara também casa com a sequência sem ela.
    expect(protegerTexto("Doc 563829104", { documentos: ["563.829.104"] })).toBe("Doc [DOCUMENTO]");
  });

  it("documento conhecido só com dígitos não come valor nem data", () => {
    const conhecidos = { documentos: ["1234567", "14082027"] };
    expect(protegerTexto("Total R$ 1.234.567,00 em 14/08/2027", conhecidos)).toBe("Total R$ 1.234.567,00 em 14/08/2027");
  });

  it("nascimentos conhecidos em d/m/aaaa, dd-mm-aaaa e dd.mm.aaaa", () => {
    const conhecidos = { nascimentos: ["1980-03-07"] };
    expect(protegerTexto("Nasceu 7/3/1980, 07-03-1980, 07.03.1980, 7.3.1980 e 1980-03-07.", conhecidos)).toBe(
      "Nasceu [NASCIMENTO], [NASCIMENTO], [NASCIMENTO], [NASCIMENTO] e [NASCIMENTO].",
    );
    // Conhecido em dd/mm/aaaa também vale nas outras formas.
    expect(protegerTexto("Nasceu 31.12.1990", { nascimentos: ["31/12/1990"] })).toBe("Nasceu [NASCIMENTO]");
    // Outra data com os mesmos números em outra ordem fica.
    expect(protegerTexto("Embarque 3/7/1980", conhecidos)).toBe("Embarque 3/7/1980");
  });

  it("telefones com DDD viram [TELEFONE]", () => {
    expect(protegerTexto("Tel (66) 99999-1234.")).toBe("Tel [TELEFONE].");
    expect(protegerTexto("Tel 66 99999-1234")).toBe("Tel [TELEFONE]");
    expect(protegerTexto("Tel +55 66 99999-1234")).toBe("Tel [TELEFONE]");
    expect(protegerTexto("Tel +55 (66) 3421-1234")).toBe("Tel [TELEFONE]");
    expect(protegerTexto("Tel 6634211234 fixo")).toBe("Tel [TELEFONE] fixo");
    expect(protegerTexto("Tel (66)99999-1234")).toBe("Tel [TELEFONE]");
    // 11 dígitos sem separador: continua [CPF] (o lado seguro).
    expect(protegerTexto("Tel 66999991234")).toBe("Tel [CPF]");
  });

  it("não protege datas de viagem, valores, códigos ECL, voos e horários", () => {
    const t =
      "Viagem ECL-0147-01 de 14/08/2027 a 20/08/2027 (2027-08-14 a 2027-08-20), voo AZ675 às 10:30, " +
      "total R$ 1.234,56, R$ 12.345.678,00 e R$ 123.456.789,00; 1234,56; USD 120000; pedido 123456789012; 14/08/2027 10:30.";
    expect(protegerTexto(t, { nascimentos: ["1980-03-07"], documentos: ["YA1234567"] })).toBe(t);
  });
});
