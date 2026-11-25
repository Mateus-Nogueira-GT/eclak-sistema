import { describe, expect, it } from "vitest";
import { DOMINIOS_LINK_CHAT, historicoParaEnviar, MAX_CARACTERES_CHAT, MAX_MENSAGENS_CHAT, partesComLink } from "@/domain/chat";

describe("historicoParaEnviar", () => {
  it("só de/texto, sem os balões de erro", () => {
    expect(
      historicoParaEnviar([
        { de: "eu", texto: "Oi" },
        { de: "ia", texto: "Sem conexão", erro: true },
        { de: "eu", texto: "De novo" },
        { de: "ia", texto: "Resposta" },
        { de: "eu", texto: "Mais" },
      ]),
    ).toEqual([
      { de: "eu", texto: "Oi" },
      { de: "eu", texto: "De novo" },
      { de: "ia", texto: "Resposta" },
      { de: "eu", texto: "Mais" },
    ]);
  });

  it("resposta longa da IA é cortada no limite do servidor (senão a conversa trava)", () => {
    const r = historicoParaEnviar([
      { de: "eu", texto: "Liste" },
      { de: "ia", texto: "x".repeat(9000) },
      { de: "eu", texto: "E agora?" },
    ]);
    expect(r[1].texto).toHaveLength(MAX_CARACTERES_CHAT);
    expect(r.every((m) => m.texto.length <= MAX_CARACTERES_CHAT)).toBe(true);
  });

  it("mais de 30: as últimas, começando numa pergunta", () => {
    const msgs = Array.from({ length: 41 }, (_, i) => ({ de: i % 2 === 0 ? ("eu" as const) : ("ia" as const), texto: String(i) }));
    const r = historicoParaEnviar(msgs);
    expect(r.length).toBeLessThanOrEqual(MAX_MENSAGENS_CHAT);
    expect(r[0].de).toBe("eu");
    expect(r[r.length - 1]).toEqual({ de: "eu", texto: "40" });
  });
});

describe("partesComLink", () => {
  it("só libera os três domínios do spec", () => {
    expect(DOMINIOS_LINK_CHAT).toEqual(["trello.com", "drive.google.com", "docs.google.com"]);
  });

  it("transforma links permitidos (https) e mantém outros endereços como texto", () => {
    expect(
      partesComLink("Veja o cartão em https://trello.com/c/abc e o doc https://docs.google.com/x."),
    ).toEqual([
      { tipo: "texto", valor: "Veja o cartão em " },
      { tipo: "link", url: "https://trello.com/c/abc" },
      { tipo: "texto", valor: " e o doc " },
      { tipo: "link", url: "https://docs.google.com/x" },
      { tipo: "texto", valor: "." },
    ]);

    expect(partesComLink("Subdomínio https://sub.drive.google.com/file/d/1/view ok")).toEqual([
      { tipo: "texto", valor: "Subdomínio " },
      { tipo: "link", url: "https://sub.drive.google.com/file/d/1/view" },
      { tipo: "texto", valor: " ok" },
    ]);

    for (const recusado of [
      "https://trello.com.evil.io/x",
      "http://trello.com/c/abc",
      "https://exemplo.com",
      "https://faketrello.com/c/abc",
    ]) {
      expect(partesComLink(`Link: ${recusado}`)).toEqual([{ tipo: "texto", valor: `Link: ${recusado}` }]);
    }
  });
});
