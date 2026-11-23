import { describe, expect, it } from "vitest";
import { MSG_DOCUMENTO_NOTA, filtroNotasDaUrl, motivoCancelamentoSchema, notaFiscalSchema } from "@/domain/notas-fiscais";

const base = {
  numero: " 0412 ",
  emitidaEm: "2026-11-03",
  competencia: "2026-11",
  valor: "1.234,56",
  destinatario: "  Marina Souza ",
  documento: "529.982.247-25",
  fornecedorId: "",
  clienteId: "",
  viagemId: "",
  observacao: "",
};

describe("notaFiscalSchema", () => {
  it("normaliza: número e nome aparados, valor em centavos, documento só em dígitos, vazios viram null", () => {
    const r = notaFiscalSchema.parse(base);
    expect(r).toEqual({
      numero: "0412",
      emitidaEm: "2026-11-03",
      competencia: "2026-11",
      valor: 123456n,
      destinatario: "Marina Souza",
      documento: "52998224725",
      fornecedorId: null,
      clienteId: null,
      viagemId: null,
      observacao: null,
    });
  });

  it("aceita CNPJ válido com máscara e sem", () => {
    expect(notaFiscalSchema.parse({ ...base, documento: "11.222.333/0001-81" }).documento).toBe("11222333000181");
    expect(notaFiscalSchema.parse({ ...base, documento: "11222333000181" }).documento).toBe("11222333000181");
  });

  it("documento é opcional", () => {
    expect(notaFiscalSchema.parse({ ...base, documento: "" }).documento).toBeNull();
    expect(notaFiscalSchema.parse({ ...base, documento: undefined }).documento).toBeNull();
  });

  it("recusa CPF e CNPJ inválidos, com máscara ou sem", () => {
    for (const documento of ["529.982.247-26", "111.111.111-11", "11.222.333/0001-82", "123", "1122233300018"]) {
      const r = notaFiscalSchema.safeParse({ ...base, documento });
      expect(r.success, documento).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe(MSG_DOCUMENTO_NOTA);
    }
  });

  it("recusa competência fora de AAAA-MM", () => {
    for (const competencia of ["2026-13", "2026-1", "11/2026", ""]) {
      expect(notaFiscalSchema.safeParse({ ...base, competencia }).success, competencia).toBe(false);
    }
  });

  it("valor: zero, negativo e lixo são recusados", () => {
    for (const valor of ["0", "0,00", "-5", "abc", ""]) {
      expect(notaFiscalSchema.safeParse({ ...base, valor }).success, valor).toBe(false);
    }
  });

  it("número e destinatário são obrigatórios; data real", () => {
    expect(notaFiscalSchema.safeParse({ ...base, numero: "  " }).success).toBe(false);
    expect(notaFiscalSchema.safeParse({ ...base, destinatario: "" }).success).toBe(false);
    expect(notaFiscalSchema.safeParse({ ...base, emitidaEm: "2026-02-30" }).success).toBe(false);
  });

  it("no máximo um entre fornecedor e cliente", () => {
    const id = "6f1c5f0e-1b1e-4f6e-9a55-3b1c1e0f2a11";
    expect(notaFiscalSchema.safeParse({ ...base, fornecedorId: id }).success).toBe(true);
    expect(notaFiscalSchema.safeParse({ ...base, clienteId: id }).success).toBe(true);
    expect(notaFiscalSchema.safeParse({ ...base, fornecedorId: id, clienteId: id }).success).toBe(false);
  });

  it("campos desconhecidos são recusados", () => {
    expect(notaFiscalSchema.safeParse({ ...base, status: "cancelada" }).success).toBe(false);
  });
});

describe("motivoCancelamentoSchema", () => {
  it("exige texto", () => {
    expect(motivoCancelamentoSchema.safeParse("  ").success).toBe(false);
    expect(motivoCancelamentoSchema.parse(" Emitida em duplicidade ")).toBe("Emitida em duplicidade");
  });
});

describe("filtroNotasDaUrl", () => {
  it("padrão: o mês de hoje, página 1", () => {
    expect(filtroNotasDaUrl({}, "2026-11-23")).toEqual({ de: "2026-11-01", ate: "2026-11-30", pagina: 1 });
  });
  it("lê período, destinatário e página; inválidos viram o padrão", () => {
    expect(filtroNotasDaUrl({ de: "2026-01-01", ate: "2026-12-31", destinatario: " marina ", pagina: "3" }, "2026-11-23")).toEqual({
      de: "2026-01-01",
      ate: "2026-12-31",
      destinatario: "marina",
      pagina: 3,
    });
    expect(filtroNotasDaUrl({ de: "lixo", pagina: "0" }, "2026-11-23")).toEqual({ de: "2026-11-01", ate: "2026-11-30", pagina: 1 });
  });
});
