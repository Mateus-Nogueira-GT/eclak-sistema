import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TAMANHO_MAXIMO_OFX, dataOfx, decodificarOfx, lerOfx, valorOfxEmCentavos } from "@/domain/ofx";

const fixture = (nome: string) => readFileSync(join(__dirname, "..", "fixtures", "ofx", nome));
const lerFixture = (nome: string) => lerOfx(decodificarOfx(fixture(nome)));

describe("ofx: valor em centavos", () => {
  it.each([
    ["-2862.49", -286249n],
    ["-2862,49", -286249n],
    ["+10", 1000n],
    ["100", 10000n],
    ["0.5", 50n],
  ])("%s", (s, esperado) => expect(valorOfxEmCentavos(s)).toBe(esperado));

  it.each(["1.234,56", "abc", "1.234", "", "1,2,3", "--5", "1.234.567"])("recusa %j", (s) =>
    expect(valorOfxEmCentavos(s)).toBeNull(),
  );
});

describe("ofx: data", () => {
  it.each(["20261103", "20261103120000", "20261103120000.000[-3:BRT]", "20261103120000[-3:BRT]"])("%s", (s) =>
    expect(dataOfx(s)).toBe("2026-11-03"),
  );
  it.each(["20261340", "20261132", "2026", "abc", ""])("recusa %j", (s) => expect(dataOfx(s)).toBeNull());
  it("recusa 29/02 de ano não bissexto", () => expect(dataOfx("20270229")).toBeNull());
});

describe("ofx: decodificação", () => {
  it("SGML com CHARSET 1252 decodifica os acentos", () => {
    const texto = decodificarOfx(fixture("sgml-1252.ofx"));
    expect(texto).toContain("TARIFA BANCÁRIA");
    expect(texto).toContain("PAGTO ÁGUA");
  });
  it("sem a decodificação certa os bytes 1252 não são UTF-8 válido", () => {
    expect(new TextDecoder("utf-8").decode(fixture("sgml-1252.ofx"))).not.toContain("TARIFA BANCÁRIA");
  });
  it("XML com UTF-8 decodifica os acentos", () => {
    expect(decodificarOfx(fixture("xml-utf8.ofx"))).toContain("São João");
  });
  it("sem indicação de charset assume UTF-8", () => {
    expect(decodificarOfx(new TextEncoder().encode("<OFX>ação</OFX>"))).toBe("<OFX>ação</OFX>");
  });
});

describe("ofx: leitura", () => {
  it("SGML 1252: 3 transações", () => {
    const r = lerFixture("sgml-1252.ofx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const e = r.extrato;
    expect(e.banco).toBe("0001");
    expect(e.conta).toBe("3456");
    expect(e.inicio).toBe("2026-11-01");
    expect(e.fim).toBe("2026-11-30");
    expect(e.transacoes).toHaveLength(3);
    const [a, b, c] = e.transacoes;
    expect(a).toEqual({
      fitid: "202611030001",
      data: "2026-11-03",
      valor: -286249n,
      tipo: "DEBIT",
      descricao: "PAGTO ÁGUA · CONTA DE ÁGUA NOVEMBRO",
    });
    expect(b.descricao).toBe("TARIFA BANCÁRIA");
    expect(b.valor).toBe(-4590n);
    expect(c.valor).toBe(150000n);
    expect(c.data).toBe("2026-11-10");
    expect(c.descricao).toHaveLength(255);
  });

  it("NAME e MEMO iguais não duplicam", () => {
    const r = lerOfx(
      "<OFX><STMTRS><BANKACCTFROM><ACCTID>1234</ACCTID></BANKACCTFROM><BANKTRANLIST>" +
        "<STMTTRN><DTPOSTED>20261101<TRNAMT>-1.00<FITID>X<NAME> PIX <MEMO>PIX</STMTTRN></BANKTRANLIST></STMTRS></OFX>",
    );
    expect(r.ok && r.extrato.transacoes[0].descricao).toBe("PIX");
  });

  it("XML UTF-8: 2 transações, tags fechadas", () => {
    const r = lerFixture("xml-utf8.ofx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.extrato.banco).toBe("0002");
    expect(r.extrato.conta).toBe("7650");
    expect(r.extrato.transacoes.map((t) => [t.fitid, t.data, t.valor, t.descricao])).toEqual([
      ["A1", "2026-12-02", -10050n, "Pagamento São João"],
      ["A2", "2026-12-15", 200000n, "Recebimento Açaí"],
    ]);
  });

  it("banco cai para FI/ORG quando não há BANKID, e para null sem nenhum", () => {
    const base = (m: string) =>
      `<OFX>${m}<STMTRS><BANKACCTFROM><ACCTID>99</ACCTID></BANKACCTFROM><BANKTRANLIST></BANKTRANLIST></STMTRS></OFX>`;
    const a = lerOfx(base("<SONRS><FI><ORG>Banco Teste<FID>1</FI></SONRS>"));
    expect(a.ok && a.extrato.banco).toBe("Banco Teste");
    const b = lerOfx(base(""));
    expect(b.ok && b.extrato.banco).toBeNull();
    expect(b.ok && b.extrato.transacoes).toEqual([]);
  });

  it("ignora os saldos", () => {
    const r = lerFixture("sgml-1252.ofx");
    expect(r.ok && r.extrato.transacoes.every((t) => t.fitid !== "")).toBe(true);
  });

  it("mais de uma conta é recusado", () => {
    expect(lerFixture("duas-contas.ofx")).toEqual({
      ok: false,
      erro: "O arquivo tem mais de uma conta. Baixe o extrato de uma conta por vez",
    });
  });

  it("cartão de crédito é recusado", () => {
    expect(lerFixture("cartao.ofx")).toEqual({ ok: false, erro: "Extrato de cartão de crédito não é aceito aqui" });
  });

  it("texto qualquer não é OFX", () => {
    expect(lerOfx("olá, mundo")).toEqual({ ok: false, erro: "O arquivo não parece um extrato OFX" });
    expect(lerOfx("")).toEqual({ ok: false, erro: "O arquivo não parece um extrato OFX" });
  });

  it("transação sem FITID", () => {
    const r = lerOfx(
      "<OFX><STMTRS><BANKTRANLIST><STMTTRN><DTPOSTED>20261101<TRNAMT>-1.00<NAME>X</STMTTRN></BANKTRANLIST></STMTRS></OFX>",
    );
    expect(r).toEqual({ ok: false, erro: "Transação sem identificador (FITID) no extrato" });
  });

  it("transação com valor ou data inválidos é recusada com mensagem", () => {
    const t = (d: string, a: string) =>
      `<OFX><STMTRS><BANKTRANLIST><STMTTRN><DTPOSTED>${d}<TRNAMT>${a}<FITID>Z</STMTTRN></BANKTRANLIST></STMTRS></OFX>`;
    const v = lerOfx(t("20261101", "1.234,56"));
    expect(!v.ok && v.erro).toMatch(/valor/i);
    const d = lerOfx(t("20261399", "1.00"));
    expect(!d.ok && d.erro).toMatch(/data/i);
  });

  it("conta mascarada: 4 últimos alfanuméricos", () => {
    const f = (id: string) => {
      const r = lerOfx(`<OFX><STMTRS><BANKACCTFROM><ACCTID>${id}</ACCTID></BANKACCTFROM><BANKTRANLIST></BANKTRANLIST></STMTRS></OFX>`);
      return r.ok ? r.extrato.conta : "erro";
    };
    expect(f("12345-6")).toBe("3456");
    expect(f("12")).toBe("12");
  });

  it("tamanho máximo é 5 MB", () => expect(TAMANHO_MAXIMO_OFX).toBe(5 * 1024 * 1024));
});
