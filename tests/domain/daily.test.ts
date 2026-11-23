import { describe, expect, it } from "vitest";
import {
  conferirDaily,
  converterHorario,
  dataDeEnvio,
  dataDeGeracao,
  diaDaSemana,
  estadoDoDaily,
  formatarHora,
  linkMapaHotel,
  nomesDaSaudacao,
  textoDoDaily,
  trocaDeHotel,
} from "@/domain/daily";
import { ENCERRAMENTO_INICIAL } from "@/domain/regras";
import type { DiaRoteiro, HotelRoteiro } from "@/domain/roteiro";

const hoteis: HotelRoteiro[] = [
  { cidade: "Veneza", nome: "Palazzo Barocci", entrada: "2027-08-14", saida: "2027-08-16", horaCheckin: null, horaCheckout: "11:00", mapa: null },
  { cidade: "Florença", nome: "Orto de' Medici", entrada: "2027-08-16", saida: "2027-08-19", horaCheckin: "16:00", horaCheckout: null, mapa: "https://maps.google.com/?q=Orto+de+Medici+Firenze" },
];
const dia = (itens: DiaRoteiro["itens"]): DiaRoteiro => ({ data: "2027-08-16", titulo: "", itens, dica: null, porque: null, gastro: [] });
const diaModelo = dia([
  { hora: "13:26", titulo: "Partida do trem de alta velocidade para Florença, da estação Venezia Santa Lucia", texto: "Recomendamos chegar com 30 minutos de antecedência.", mapa: null },
  { hora: "16:00", titulo: "Check-in no Orto de' Medici", texto: "", mapa: null },
]);
const gerar = (d: DiaRoteiro, h = hoteis, idioma: "italiano" | "portugues" = "italiano") =>
  textoDoDaily({ data: "2027-08-16", idioma, nomes: "Marina e Rafael", dia: d, hoteis: h, encerramento: ENCERRAMENTO_INICIAL });
const MODELO =
  "Buongiorno, Marina e Rafael!\n\nProgramação de amanhã, segunda-feira, 16/08.\n\nCheck-out: Palazzo Barocci, até as 11h\nCheck-in: Orto de' Medici, a partir das 16h\nhttps://maps.google.com/?q=Orto+de+Medici+Firenze\n\n*13h26*: Partida do trem de alta velocidade para Florença, da estação Venezia Santa Lucia. Recomendamos chegar com 30 minutos de antecedência.\n\n*16h*: Check-in no Orto de' Medici.\n\nQualquer dúvida, nosso customer care está à disposição no WhatsApp. Aproveitem o dia!\nEquipe ECLAK Viagens";
const conferir = (t: string, troca = false, idioma: "italiano" | "portugues" = "italiano") =>
  conferirDaily(t, { troca, idioma, encerramento: ENCERRAMENTO_INICIAL });

describe("texto", () => {
  it("formata horas e nomes", () => {
    expect(formatarHora("13:26")).toBe("13h26");
    expect(formatarHora("16:00")).toBe("16h");
    expect(formatarHora("06:20")).toBe("06h20");
    expect(nomesDaSaudacao(["Marina Souza", "Rafael Souza"], "Família Souza")).toBe("Marina e Rafael");
    expect(nomesDaSaudacao(["Ana X", "Bia Y", "Caio Z"], "G")).toBe("Ana, Bia e Caio");
    expect(nomesDaSaudacao(["A", "B", "C", "D"], "Família Souza")).toBe("Família Souza");
    expect(nomesDaSaudacao(["Marina Souza"], "G")).toBe("Marina");
    expect(diaDaSemana("2027-08-16")).toBe("segunda-feira");
  });

  it("gera o modelo exato e passa nos 6 indicadores", () => {
    const t = gerar(diaModelo);
    expect(t).toBe(MODELO);
    const r = conferir(t, true);
    expect(r).toHaveLength(6);
    expect(r.every((i) => i.ok)).toBe(true);
    expect(r.map((i) => i.nome)).toEqual([
      "Saudação no idioma do destino",
      "Sem gerundismo",
      "Troca de hotel: check-out e check-in no topo, com o mapa",
      "Cada item da programação começa pelo horário",
      "Sem contatos de fornecedores",
      "Encerramento padrão da ECLAK",
    ]);
  });

  it("monta mapa do hotel e frases de item", () => {
    const h = { cidade: "Sorrento", nome: "Hotel Belair", entrada: null, saida: null, horaCheckin: null, horaCheckout: null, mapa: null };
    expect(linkMapaHotel(h)).toBe("https://maps.google.com/?q=Hotel%20Belair%20Sorrento");
    const novo = { ...h, nome: "Hotel 1898", cidade: "Barcelona", entrada: "2027-08-16" };
    const t = gerar(diaModelo, [hoteis[0], novo]);
    expect(t).toContain("https://maps.google.com/?q=Hotel%201898%20Barcelona");
    expect(conferir(t, true)[4].ok).toBe(true);
    const t2 = gerar(dia([{ hora: "11:20", titulo: "Chegada a Veneza", texto: "Barco privativo do aeroporto ao hotel | Cerca de 35 minutos", mapa: null }]), []);
    expect(t2).toContain("*11h20*: Chegada a Veneza. Barco privativo do aeroporto ao hotel. Cerca de 35 minutos.");
  });
});

describe("indicadores que falham", () => {
  it("1 saudação", () => {
    const r = conferir("Bom dia, Marina!");
    expect(r[0].ok).toBe(false);
    expect(r[0].dica).toBe('Comece com a saudação do país, como "Buongiorno" na Itália.');
    expect(conferir("Bom dia, Marina!", false, "portugues")[0].ok).toBe(true);
  });
  it("2 gerundismo", () => {
    const r = conferir("Buongiorno!\n\nVamos estar enviando o voucher");
    expect(r[1].ok).toBe(false);
    expect(r[1].dica).toBe('Troque "Vamos estar enviando" pelo verbo direto, como "enviaremos" ou "aguardamos".');
  });
  it("3 troca", () => {
    const invertido = "Buongiorno!\n\nCheck-in: A\nhttps://maps.google.com/?q=A\nCheck-out: B\n\n*10h*: x.";
    expect(conferir(invertido, true)[2].ok).toBe(false);
    expect(conferir(invertido, true)[2].dica).toBe('Abra com "Check-out: [hotel]" e "Check-in: [hotel]", com o link do Google Maps do hotel novo logo abaixo.');
    expect(conferir(invertido, true)[2].nome).toBe("Troca de hotel: check-out e check-in no topo, com o mapa");
    const curto = "Buongiorno!\n\nCheck-out: B\nCheck-in: A\nhttps://maps.app.goo.gl/abc\n\n*10h*: x.";
    expect(conferir(curto, true)[2].ok).toBe(true);
    expect(conferir(curto.replace("https://maps.app.goo.gl/abc", "sem link"), true)[2].ok).toBe(false);
    const sem = conferir(MODELO, false)[2];
    expect(sem.nome).toBe("Sem troca de hotel neste dia");
    expect(sem.ok).toBe(true);
  });
  it("4 horário", () => {
    expect(conferir("Buongiorno!\n\n13h26 partida")[3].ok).toBe(false);
    expect(conferir("Buongiorno!\n\nSem programação")[3].ok).toBe(false);
    expect(conferir("Buongiorno!\n\n*10: x")[3].ok).toBe(false);
    expect(conferir("Buongiorno!\n\n13h26 partida")[3].dica).toBe("Use o formato *06h20*: partida do trem...");
    expect(conferir("Buongiorno!\n\n*13h26*: partida.\n\n14h30 outra")[3].ok).toBe(false);
  });
  it("5 contatos", () => {
    expect(conferir("Buongiorno!\n\nMotorista: João")[4].ok).toBe(false);
    expect(conferir("Buongiorno!\n\nMotorista: João")[4].dica).toBe("Contatos de guia, apoio local e operadora ficam só na versão interna.");
    expect(conferir("Buongiorno!\n\n(39) 3333-0000")[4].ok).toBe(false);
  });
  it("6 encerramento", () => {
    const r = conferir("Buongiorno!\n\n*10h*: x.\n\nEquipe ECLAK");
    expect(r[5].ok).toBe(false);
    expect(r[5].dica).toBe("Termine com o texto padrão, definido em Parâmetros.");
  });
});

describe("troca, datas e estado", () => {
  it("troca de hotel", () => {
    expect(trocaDeHotel(hoteis, "2027-08-16").troca).toBe(true);
    expect(trocaDeHotel(hoteis, "2027-08-15").troca).toBe(false);
  });
  it("D-2 e D-1", () => {
    expect(dataDeGeracao("2027-08-16")).toBe("2027-08-14");
    expect(dataDeEnvio("2027-08-16")).toBe("2027-08-15");
  });
  it("estado", () => {
    expect(estadoDoDaily("2027-08-16", null, "2027-08-13")).toEqual({ rotulo: "Gera em 14/08", tom: "cinza", noPrazoDeGerar: false });
    expect(estadoDoDaily("2027-08-16", null, "2027-08-14")).toEqual({ rotulo: "A gerar", tom: "ouro", noPrazoDeGerar: true });
    expect(estadoDoDaily("2027-08-16", "pendente", "2027-08-14").rotulo).toBe("A gerar");
    expect(estadoDoDaily("2027-08-16", "gerado", "2027-08-14")).toMatchObject({ rotulo: "Gerado, a revisar", tom: "ouro" });
    expect(estadoDoDaily("2027-08-16", "revisado", "2027-08-14")).toMatchObject({ rotulo: "Pronto para enviar", tom: "agua" });
    expect(estadoDoDaily("2027-08-16", "enviado", "2027-08-14")).toMatchObject({ rotulo: "Enviado", tom: "verde" });
  });
  it("dia que já passou sem ser gerado fica neutro", () => {
    expect(estadoDoDaily("2027-08-16", null, "2027-08-16")).toMatchObject({ rotulo: "A gerar", tom: "ouro" });
    expect(estadoDoDaily("2027-08-16", null, "2027-08-17")).toEqual({ rotulo: "Não gerado", tom: "cinza", noPrazoDeGerar: true });
    expect(estadoDoDaily("2027-08-16", "pendente", "2027-08-20")).toMatchObject({ rotulo: "Não gerado", tom: "cinza" });
    expect(estadoDoDaily("2027-08-16", "gerado", "2027-08-20")).toMatchObject({ rotulo: "Gerado, a revisar", tom: "ouro" });
  });
});

describe("converterHorario", () => {
  it("verão e inverno", () => {
    expect(converterHorario("2027-08-16", "13:26", "Europe/Rome", "America/Cuiaba")).toBe("07:26");
    expect(converterHorario("2027-08-16", "13:26", "Europe/Rome", "America/Sao_Paulo")).toBe("08:26");
    expect(converterHorario("2027-01-20", "13:26", "Europe/Rome", "America/Cuiaba")).toBe("08:26");
    expect(converterHorario("2027-01-20", "13:26", "Europe/Rome", "America/Sao_Paulo")).toBe("09:26");
  });
  it("virada de dia", () => {
    expect(converterHorario("2027-08-16", "02:00", "Europe/Rome", "America/Cuiaba")).toBe("20:00");
  });
});
