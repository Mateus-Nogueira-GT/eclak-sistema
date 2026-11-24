import { describe, expect, it } from "vitest";
import {
  aniversariosNaViagem,
  conteudoRoteiroSchema,
  datasDaViagem,
  fusoValido,
  hoteisEVoosDosItens,
  noitesDoHotel,
  nomeArquivo,
  roteiroInicial,
  rotuloDiaRoteiro,
  sugerirIdiomaEFuso,
  textoAniversario,
} from "@/domain/roteiro";

describe("datas", () => {
  it("datasDaViagem", () => {
    const d = datasDaViagem("2027-08-14", "2027-09-01");
    expect(d).toHaveLength(19);
    expect(d[0]).toBe("2027-08-14");
    expect(d[18]).toBe("2027-09-01");
    expect(datasDaViagem("2027-12-30", "2028-01-02")).toEqual(["2027-12-30", "2027-12-31", "2028-01-01", "2028-01-02"]);
  });
  it("rotuloDiaRoteiro", () => {
    expect(rotuloDiaRoteiro("2027-08-14")).toBe("14/08 (sábado)");
    expect(rotuloDiaRoteiro("2027-08-16")).toBe("16/08 (segunda-feira)");
  });
});

describe("idioma e fuso", () => {
  it("sugere pelo destino", () => {
    expect(sugerirIdiomaEFuso("Itália")).toEqual({ idioma: "italiano", fuso: "Europe/Rome" });
    expect(sugerirIdiomaEFuso("Costa Amalfitana, ITALIA")).toEqual({ idioma: "italiano", fuso: "Europe/Rome" });
    expect(sugerirIdiomaEFuso("Japão")).toBeNull();
  });
  it("fusoValido", () => {
    expect(fusoValido("Europe/Rome")).toBe(true);
    expect(fusoValido("Marte/Base")).toBe(false);
  });
});

const itens = [
  { tipo: "Hotelaria" as const, cidade: "Veneza", servico: "Palazzo Barocci", checkin: "2027-08-14", checkout: "2027-08-16" },
  { tipo: "Aéreo" as const, cidade: null, servico: "GRU-VCE", checkin: "2027-08-13", checkout: null },
  { tipo: "Passeio" as const, cidade: "Roma", servico: "Coliseu", checkin: null, checkout: null },
];

describe("roteiroInicial", () => {
  const r = roteiroInicial({ inicio: "2027-08-14", fim: "2027-09-01", itens });
  it("monta um dia por data, vazio", () => {
    expect(r.dias).toHaveLength(19);
    expect(r.dias[0]).toEqual({ data: "2027-08-14", titulo: "", itens: [], dica: null, porque: null, gastro: [] });
  });
  it("traz hotéis e voos, sem o passeio", () => {
    expect(r.hoteis).toEqual([
      { cidade: "Veneza", nome: "Palazzo Barocci", entrada: "2027-08-14", saida: "2027-08-16", horaCheckin: null, horaCheckout: null, mapa: null },
    ]);
    expect(r.voos).toEqual([{ data: "2027-08-13", voo: "", trecho: "GRU-VCE", saida: null, chegada: null }]);
    expect(hoteisEVoosDosItens(itens)).toEqual({ hoteis: r.hoteis, voos: r.voos });
  });
  it("o conteúdo inicial é válido", () => {
    expect(conteudoRoteiroSchema("2027-08-14", "2027-09-01").safeParse(r).success).toBe(true);
  });
});

describe("conteudoRoteiroSchema", () => {
  const base = roteiroInicial({ inicio: "2027-08-14", fim: "2027-09-01", itens });
  const schema = conteudoRoteiroSchema("2027-08-14", "2027-09-01");
  const msgs = (v: unknown) => {
    const r = schema.safeParse(v);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  const comItem = (item: object) => ({
    ...base,
    dias: base.dias.map((d, i) => (i === 0 ? { ...d, itens: [{ hora: null, titulo: "x", texto: "", mapa: null, ...item }] } : d)),
  });

  it("aceita trecho de voo com até 200 caracteres (o serviço do item vai até 200)", () => {
    const voo = { data: null, voo: "AZ 123", trecho: "x".repeat(200), saida: null, chegada: null };
    expect(msgs({ ...base, voos: [voo] })).toEqual([]);
    expect(msgs({ ...base, voos: [{ ...voo, trecho: "x".repeat(201) }] })).toContain("Texto muito longo");
  });
  it("voo trazido de um item aéreo com serviço de 200 caracteres passa na validação", () => {
    const longo = [{ tipo: "Aéreo" as const, cidade: null, servico: "y".repeat(200), checkin: "2027-08-14", checkout: null }];
    const r = roteiroInicial({ inicio: "2027-08-14", fim: "2027-09-01", itens: longo });
    expect(schema.safeParse(r).success).toBe(true);
  });
  it("recusa dias que não batem", () => {
    expect(msgs({ ...base, dias: base.dias.slice(0, 18) })).toContain("Os dias do roteiro não batem com as datas da viagem");
  });
  it("recusa hora inválida", () => {
    expect(msgs(comItem({ hora: "25:00" }))).toContain("Hora inválida");
    expect(msgs(comItem({ hora: "09:30" }))).toEqual([]);
  });
  it("recusa link que não é https", () => {
    expect(msgs(comItem({ mapa: "javascript:alert(1)" }))).toContain("Link inválido");
    expect(msgs(comItem({ mapa: "https://maps.app/x" }))).toEqual([]);
  });
  it("recusa saída antes da entrada", () => {
    const h = { ...base.hoteis[0], entrada: "2027-08-16", saida: "2027-08-14" };
    expect(msgs({ ...base, hoteis: [h] })).toContain("A saída não pode ser antes da entrada");
  });
});

describe("noitesDoHotel", () => {
  const h = { cidade: "", nome: "", entrada: "2027-08-14", saida: "2027-08-16", horaCheckin: null, horaCheckout: null, mapa: null };
  it("conta noites", () => {
    expect(noitesDoHotel(h)).toBe("2 noites · 14/08 a 16/08");
    expect(noitesDoHotel({ ...h, saida: "2027-08-15" })).toBe("1 noite · 14/08 a 15/08");
    expect(noitesDoHotel({ ...h, saida: null })).toBeNull();
  });
});

describe("nomeArquivo", () => {
  it("monta o nome", () => {
    expect(nomeArquivo("RT", "Marcos Souza", "Itália", "2027-08-14", "2027-09-01")).toBe("RT_SOUZA_ITALIA_20270814-20270901");
    expect(nomeArquivo("TAREFAS", "Ana Conceição", "Costa Amalfitana", "2027-05-02", "2027-05-10")).toBe(
      "TAREFAS_CONCEICAO_COSTA-AMALFITANA_20270502-20270510",
    );
  });
  it("pontuação vira hífen, sem hífen nas pontas", () => {
    expect(nomeArquivo("RT", "Marcos Souza", "Costa Amalfitana, Itália", "2027-08-14", "2027-09-01")).toBe(
      "RT_SOUZA_COSTA-AMALFITANA-ITALIA_20270814-20270901",
    );
    expect(nomeArquivo("RT", "Marcos Souza", "Roma/Florença", "2027-08-14", "2027-09-01")).toBe("RT_SOUZA_ROMA-FLORENCA_20270814-20270901");
    expect(nomeArquivo("RT", "Marcos Souza", "  ¿Roma?  ", "2027-08-14", "2027-09-01")).toBe("RT_SOUZA_ROMA_20270814-20270901");
  });
});

describe("aniversariosNaViagem", () => {
  const hotel = { cidade: "Sorrento", nome: "Hotel Belair", entrada: "2027-08-22", saida: "2027-08-25", horaCheckin: null, horaCheckout: null, mapa: null };
  it("acha o aniversário e o hotel", () => {
    const r = aniversariosNaViagem([{ id: "r", nome: "Rafael Souza", nascimento: "1987-08-23" }], "2027-08-14", "2027-09-01", [hotel]);
    expect(r).toEqual([{ pessoaId: "r", nome: "Rafael Souza", data: "2027-08-23", idade: 40, diaDaViagem: 10, onde: "Sorrento (Hotel Belair)" }]);
    expect(textoAniversario(r[0])).toBe("Rafael Souza faz 40 anos em 23/08/2027, dia 10 da viagem, em Sorrento (Hotel Belair).");
  });
  it("sem hotel não cita o lugar", () => {
    const [a] = aniversariosNaViagem([{ id: "r", nome: "Rafael Souza", nascimento: "1987-08-23" }], "2027-08-14", "2027-09-01", []);
    expect(a.onde).toBeNull();
    expect(textoAniversario(a)).toBe("Rafael Souza faz 40 anos em 23/08/2027, dia 10 da viagem.");
  });
  it("ano virando", () => {
    const [a] = aniversariosNaViagem([{ id: "a", nome: "A", nascimento: "1990-01-02" }], "2027-12-28", "2028-01-05", []);
    expect(a.data).toBe("2028-01-02");
    expect(a.idade).toBe(38);
  });
  it("29/02 em ano não bissexto", () => {
    const [a] = aniversariosNaViagem([{ id: "a", nome: "A", nascimento: "2000-02-29" }], "2027-02-25", "2027-03-02", []);
    expect(a.data).toBe("2027-02-28");
    expect(a.idade).toBe(27);
  });
  it("sem nascimento ou fora do período", () => {
    expect(aniversariosNaViagem([{ id: "a", nome: "A", nascimento: null }], "2027-08-14", "2027-09-01", [])).toEqual([]);
    expect(aniversariosNaViagem([{ id: "a", nome: "A", nascimento: "1990-03-01" }], "2027-08-14", "2027-09-01", [])).toEqual([]);
  });
});
