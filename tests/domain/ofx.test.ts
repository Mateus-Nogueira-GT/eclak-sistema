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
  it.each(["CHARSET:8859-1", "CHARSET:ISO-8859-1", "CHARSET:LATIN1", "ENCODING:USASCII\nCHARSET:1252"])(
    "SGML com %s decodifica como windows-1252",
    (cab) => {
      const bytes = Uint8Array.from(Buffer.from(`OFXHEADER:100\n${cab}\n\n<OFX><MEMO>TARIFA BANCÁRIA</OFX>`, "latin1"));
      expect(decodificarOfx(bytes)).toContain("TARIFA BANCÁRIA");
    },
  );
  it.each(["ISO-8859-1", "windows-1252"])("XML com encoding %s decodifica como windows-1252", (enc) => {
    const bytes = Uint8Array.from(Buffer.from(`<?xml version="1.0" encoding="${enc}"?><OFX><MEMO>PAGTO ÁGUA</OFX>`, "latin1"));
    expect(decodificarOfx(bytes)).toContain("PAGTO ÁGUA");
  });
  it("sem indicação de charset assume UTF-8", () => {
    expect(decodificarOfx(new TextEncoder().encode("<OFX>ação</OFX>"))).toBe("<OFX>ação</OFX>");
  });
  it("bytes UTF-8 com cabeçalho CHARSET:1252 (cabeçalho errado) saem em UTF-8", () => {
    const bytes = new TextEncoder().encode("OFXHEADER:100\nENCODING:USASCII\nCHARSET:1252\n\n<OFX><MEMO>TARIFA BANCÁRIA</OFX>");
    const texto = decodificarOfx(bytes);
    expect(texto).toContain("TARIFA BANCÁRIA");
    expect(texto).not.toContain("Ã");
  });
  it("bytes 1252 com cabeçalho CHARSET:NONE saem em windows-1252", () => {
    const bytes = Uint8Array.from(Buffer.from("OFXHEADER:100\nENCODING:UTF-8\nCHARSET:NONE\n\n<OFX><MEMO>TARIFA BANCÁRIA</OFX>", "latin1"));
    const texto = decodificarOfx(bytes);
    expect(texto).toContain("TARIFA BANCÁRIA");
    expect(texto).not.toContain("\uFFFD");
  });
  it("XML declarado UTF-8 com bytes 1252 sai em windows-1252", () => {
    const bytes = Uint8Array.from(Buffer.from('<?xml version="1.0" encoding="UTF-8"?><OFX><MEMO>PAGTO ÁGUA</OFX>', "latin1"));
    expect(decodificarOfx(bytes)).toContain("PAGTO ÁGUA");
  });
  it("BOM do UTF-8 é retirado", () => {
    expect(decodificarOfx(Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("<OFX>ação</OFX>")]))).toBe("<OFX>ação</OFX>");
  });
});

describe("ofx: entidades", () => {
  const comMemo = (memo: string) =>
    lerOfx(
      `<OFX><STMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261103<TRNAMT>-1.00<FITID>1<MEMO>${memo}</STMTTRN></BANKTRANLIST></STMTRS></OFX>`,
    );
  const descricao = (memo: string) => {
    const r = comMemo(memo);
    if (!r.ok) throw new Error(r.erro);
    return r.extrato.transacoes[0].descricao;
  };
  it("decimais e hexadecimais", () => {
    expect(descricao("TARIFA BANC&#193;RIA")).toBe("TARIFA BANCÁRIA");
    expect(descricao("PAGTO &#xC1;GUA &#Xc1;")).toBe("PAGTO ÁGUA Á");
  });
  it("nomeadas continuam e &amp;#193; fica literal (uma passada só)", () => {
    expect(descricao("A &amp; B &quot;C&quot;")).toBe('A & B "C"');
    expect(descricao("X &amp;#193;")).toBe("X &#193;");
  });
  it("código inválido fica como está", () => {
    expect(descricao("A &#1114112; B &#xD800;")).toBe("A &#1114112; B &#xD800;");
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

  it("ignora os saldos: o fixture SGML (com LEDGERBAL) rende só as 3 transações", () => {
    const r = lerFixture("sgml-1252.ofx");
    expect(r.ok && r.extrato.transacoes.map((t) => t.fitid)).toEqual(["202611030001", "202611050002", "202611100003"]);
  });

  it("valores em linha própria (XML indentado)", () => {
    const r = lerOfx(
      "<OFX>\n<STMTRS>\n<BANKACCTFROM>\n<ACCTID>\n  12345-6\n</ACCTID>\n</BANKACCTFROM>\n<BANKTRANLIST>\n<STMTTRN>\n" +
        "<DTPOSTED>\n  20261103\n</DTPOSTED>\n<TRNAMT>\n  -10,50\n</TRNAMT>\n<FITID>\n  123\n</FITID>\n<MEMO>\n  Pix\n</MEMO>\n" +
        "</STMTTRN>\n</BANKTRANLIST>\n</STMTRS>\n</OFX>",
    );
    expect(r.ok && r.extrato.conta).toBe("3456");
    expect(r.ok && r.extrato.transacoes).toEqual([
      { fitid: "123", data: "2026-11-03", valor: -1050n, tipo: "OTHER", descricao: "Pix" },
    ]);
  });

  it("tag vazia em SGML não engole a tag da linha seguinte", () => {
    const r = lerOfx(
      "<OFX><STMTRS><BANKTRANLIST><STMTTRN>\n<DTPOSTED>20261103\n<TRNAMT>-1.00\n<FITID>9\n<NAME>\n<MEMO>Só memo\n</STMTTRN></BANKTRANLIST></STMTRS></OFX>",
    );
    expect(r.ok && r.extrato.transacoes[0].descricao).toBe("Só memo");
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
