import { describe, expect, it } from "vitest";
import {
  CHECKLIST_ROTEIRO,
  CHECKLIST_VENDA,
  chaveRoteiro,
  chaveVenda,
  descricaoDoCartao,
  nomeDoCartao,
  periodoDoCartao,
} from "@/domain/trello";

describe("nomeDoCartao", () => {
  it("código · SOBRENOME · destino · período (o exemplo da spec)", () => {
    expect(
      nomeDoCartao({ codigo: "ECL-0147-01", titular: "Marcos Souza", destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01" }),
    ).toBe("ECL-0147-01 · SOUZA · Itália · 14/08 a 01/09/2027");
  });

  it("sobrenome é o último nome, em maiúsculas com acento; espaços sobrando não contam", () => {
    expect(
      nomeDoCartao({ codigo: "ECL-0002-03", titular: "  Ana Maria da Conceição  ", destino: " Costa Amalfitana ", inicio: "2027-01-05", fim: "2027-01-05" }),
    ).toBe("ECL-0002-03 · CONCEIÇÃO · Costa Amalfitana · 05/01 a 05/01/2027");
  });

  it("viagem que vira o ano mostra os dois anos", () => {
    expect(periodoDoCartao("2026-12-28", "2027-01-04")).toBe("28/12/2026 a 04/01/2027");
    expect(periodoDoCartao("2027-08-14", "2027-09-01")).toBe("14/08 a 01/09/2027");
  });
});

describe("descricaoDoCartao", () => {
  it("link da viagem no sistema", () => {
    expect(descricaoDoCartao("https://sistema.eclak.com.br", "abc")).toBe("Viagem no sistema: https://sistema.eclak.com.br/viagens/abc");
  });
});

describe("chaves e checklists", () => {
  it("valores exatos", () => {
    expect(chaveVenda("v1")).toBe("venda:v1");
    expect(chaveRoteiro("v1")).toBe("roteiro:v1");
    expect(CHECKLIST_VENDA).toBe("Tarefas da venda");
    expect(CHECKLIST_ROTEIRO).toBe("Tarefas do roteiro");
  });
});
