import { describe, expect, it } from "vitest";
import { FORMAS_DEVOLUCAO, geraContaAPagar, ROTULO_FORMA_DEVOLUCAO, situacaoDoReembolso, type LadoCliente, type LadoFornecedor } from "@/domain/reembolsos";
import { reembolsoSchema } from "@/domain/reembolsos-entrada";

const forn = (o: Partial<LadoFornecedor> = {}): LadoFornecedor => ({ valor: 10000n, pedidoEm: null, recebidoEm: null, ...o });
const cli = (o: Partial<LadoCliente> = {}): LadoCliente => ({ valor: 8000n, reembolsadoEm: null, ...o });
const sit = (f: Partial<LadoFornecedor> = {}, c: Partial<LadoCliente> = {}, canceladoEm: string | null = null) =>
  situacaoDoReembolso({ canceladoEm, fornecedor: forn(f), cliente: cli(c) });

describe("formas de devolução", () => {
  it("rótulos e quais geram conta a pagar", () => {
    expect(FORMAS_DEVOLUCAO.map((f) => ROTULO_FORMA_DEVOLUCAO[f])).toEqual(["PIX", "Transferência", "Abatimento na próxima parcela", "Crédito para a próxima viagem"]);
    expect(FORMAS_DEVOLUCAO.map(geraContaAPagar)).toEqual([true, true, false, false]);
  });
});

describe("situacaoDoReembolso", () => {
  it("cobrar sem pedido: Pedir ao fornecedor", () => {
    expect(sit()).toBe("Pedir ao fornecedor");
  });
  it("pedido feito, nada recebido nem devolvido: Aguardando fornecedor e cliente", () => {
    expect(sit({ pedidoEm: "2027-01-10" })).toBe("Aguardando fornecedor e cliente");
  });
  it("fornecedor pagou, cliente não: Reembolsar o cliente", () => {
    expect(sit({ pedidoEm: "2027-01-10", recebidoEm: "2027-01-20" })).toBe("Reembolsar o cliente");
  });
  it("cliente reembolsado, fornecedor não: Aguardando o fornecedor", () => {
    expect(sit({ pedidoEm: "2027-01-10" }, { reembolsadoEm: "2027-01-15" })).toBe("Aguardando o fornecedor");
  });
  it("os dois lados fechados: Concluído", () => {
    expect(sit({ recebidoEm: "2027-01-20" }, { reembolsadoEm: "2027-01-21" })).toBe("Concluído");
  });
  it("cancelado vale sobre o resto", () => {
    expect(sit({ recebidoEm: "2027-01-20" }, { reembolsadoEm: "2027-01-21" }, "2027-02-01")).toBe("Cancelado");
    expect(sit({}, {}, "2027-02-01")).toBe("Cancelado");
  });
  it("lado com valor 0 conta como fechado", () => {
    // Nada a cobrar: o fornecedor não bloqueia nem pede pedido.
    expect(sit({ valor: 0n })).toBe("Reembolsar o cliente");
    expect(sit({ valor: 0n }, { reembolsadoEm: "2027-01-21" })).toBe("Concluído");
    // Nada a devolver: só falta o fornecedor.
    expect(sit({}, { valor: 0n })).toBe("Pedir ao fornecedor");
    expect(sit({ pedidoEm: "2027-01-10" }, { valor: 0n })).toBe("Aguardando o fornecedor");
    expect(sit({ pedidoEm: "2027-01-10", recebidoEm: "2027-01-20" }, { valor: 0n })).toBe("Concluído");
  });
});

describe("reembolsoSchema", () => {
  const base = {
    viagemId: "11111111-1111-4111-8111-111111111111",
    servico: "Hotel Palazzo",
    ocorridoEm: "2027-01-05",
    ocorrido: "O hotel cancelou a reserva na véspera.",
    valorCobrar: "1.000,00",
    valorDevolver: "800,00",
    formaDevolucao: "pix",
    prazoCliente: "2027-01-20",
    previstoFornecedor: "2027-01-30",
  };
  const erro = (o: Record<string, unknown>) => {
    const r = reembolsoSchema.safeParse({ ...base, ...o });
    return r.success ? null : r.error.issues.map((i) => i.message);
  };

  it("aceita o caso completo e converte reais em centavos", () => {
    const r = reembolsoSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ valorCobrar: 100000n, valorDevolver: 80000n, contaPagarId: null, formaDevolucao: "pix" });
  });
  it("recusa os dois valores em 0 (ou vazios)", () => {
    expect(erro({ valorCobrar: "0,00", valorDevolver: "0", previstoFornecedor: "" })).toContain("Informe um valor a cobrar ou a devolver");
    expect(erro({ valorCobrar: "", valorDevolver: "" })).toContain("Informe um valor a cobrar ou a devolver");
  });
  it("só devolver: sem data prevista do fornecedor", () => {
    expect(erro({ valorCobrar: "0", previstoFornecedor: "" })).toBeNull();
    expect(erro({ valorCobrar: "0", previstoFornecedor: null })).toBeNull();
  });
  it("cobrança sem data prevista é recusada", () => {
    expect(erro({ previstoFornecedor: "" })).toContain("Informe quando o fornecedor deve pagar");
  });
  it("ocorrido: 10 a 1.000 caracteres", () => {
    expect(erro({ ocorrido: "curto" })).not.toBeNull();
    expect(erro({ ocorrido: "x".repeat(10) })).toBeNull();
    expect(erro({ ocorrido: "x".repeat(1000) })).toBeNull();
    expect(erro({ ocorrido: "x".repeat(1001) })).not.toBeNull();
  });
  it("serviço obrigatório (até 200), forma e datas válidas, conta opcional", () => {
    expect(erro({ servico: "  " })).not.toBeNull();
    expect(erro({ servico: "x".repeat(201) })).not.toBeNull();
    expect(erro({ formaDevolucao: "dinheiro" })).not.toBeNull();
    expect(erro({ ocorridoEm: "2027-02-30" })).not.toBeNull();
    expect(erro({ prazoCliente: "" })).not.toBeNull();
    expect(erro({ contaPagarId: "nao-uuid" })).not.toBeNull();
    expect(erro({ contaPagarId: "22222222-2222-4222-8222-222222222222" })).toBeNull();
    expect(erro({ contaPagarId: "" })).toBeNull();
  });
});
