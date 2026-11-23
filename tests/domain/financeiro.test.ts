import { describe, expect, it } from "vitest";
import {
  CENTROS,
  FORMAS_FINANCEIRO,
  FORMAS_FINANCEIRO_SLUG,
  ROTULO_FORMA_FINANCEIRO,
  STATUS_LANCAMENTO,
  LADOS,
  ORIGENS,
  SITUACOES,
  centroDaFilial,
  competenciaDe,
  datasRecorrentes,
  dividirEmParcelas,
  rotuloSituacao,
} from "@/domain/financeiro";

describe("listas do financeiro", () => {
  it("formas na ordem e com o texto exato", () => {
    expect(FORMAS_FINANCEIRO).toEqual([
      "A prazo",
      "Boleto bancário",
      "Cartão de crédito",
      "Cartão de débito",
      "Débito em conta",
      "Depósito bancário",
      "Dinheiro",
      "PIX",
      "Transferência",
    ]);
    expect(LADOS).toEqual(["pagar", "receber"]);
    expect(CENTROS).toEqual(["MT", "RS"]);
    expect(ORIGENS).toEqual(["manual", "parcela", "pagamento", "comissao"]);
    expect(SITUACOES).toEqual(["vencida", "vence_hoje", "a_vencer", "baixada", "cancelada"]);
  });
});

describe("dividirEmParcelas", () => {
  it("trunca e a última absorve; mês curto vira o último dia sem deslizar", () => {
    const ps = dividirEmParcelas(10000n, 3, "2027-01-31");
    expect(ps.map((p) => p.valor)).toEqual([3333n, 3333n, 3334n]);
    expect(ps.map((p) => p.vencimento)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31"]);
    expect(ps.map((p) => [p.numero, p.total])).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });
  it("60 parcelas de 100 centavos: soma exata, sem negativos", () => {
    const ps = dividirEmParcelas(100n, 60, "2028-02-29");
    expect(ps.reduce((a, p) => a + p.valor, 0n)).toBe(100n);
    expect(ps.every((p) => p.valor >= 0n)).toBe(true);
    expect(ps[12].vencimento).toBe("2029-02-28");
  });
});

describe("datasRecorrentes", () => {
  it("mensal mantém o dia original", () => {
    expect(datasRecorrentes("2027-01-31", "mensal", 4)).toEqual(["2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  });
  it("anual", () => {
    expect(datasRecorrentes("2028-02-29", "anual", 2)).toEqual(["2028-02-29", "2029-02-28"]);
  });
  it("semanal", () => {
    expect(datasRecorrentes("2026-12-28", "semanal", 2)).toEqual(["2026-12-28", "2027-01-04"]);
  });
  it("recusa quantidade inválida", () => {
    expect(() => datasRecorrentes("2027-01-31", "mensal", 0)).toThrow();
  });
});

describe("centro, competência e situação", () => {
  it("centroDaFilial", () => {
    expect(centroDaFilial("Rondonópolis")).toBe("MT");
    expect(centroDaFilial("RS")).toBe("RS");
  });
  it("competenciaDe", () => {
    expect(competenciaDe("2026-11-22")).toBe("2026-11");
  });
  it("rotuloSituacao", () => {
    expect(rotuloSituacao("baixada", "pagar")).toBe("Paga");
    expect(rotuloSituacao("baixada", "receber")).toBe("Recebida");
    expect(rotuloSituacao("vencida", "pagar")).toBe("Vencida");
    expect(rotuloSituacao("vence_hoje", "receber")).toBe("Vence hoje");
    expect(rotuloSituacao("a_vencer", "pagar")).toBe("A vencer");
    expect(rotuloSituacao("cancelada", "pagar")).toBe("Cancelada");
  });
});

describe("formas no banco (slug) e na tela (texto)", () => {
  it("um slug por texto, na mesma ordem", () => {
    expect(FORMAS_FINANCEIRO_SLUG).toEqual([
      "a_prazo",
      "boleto",
      "cartao_credito",
      "cartao_debito",
      "debito_conta",
      "deposito",
      "dinheiro",
      "pix",
      "transferencia",
    ]);
    expect(FORMAS_FINANCEIRO_SLUG.map((f) => ROTULO_FORMA_FINANCEIRO[f])).toEqual([...FORMAS_FINANCEIRO]);
  });
  it("status do lançamento", () => {
    expect(STATUS_LANCAMENTO).toEqual(["em_aberto", "baixado", "cancelado"]);
  });
});
