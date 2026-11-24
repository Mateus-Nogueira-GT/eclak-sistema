import { describe, expect, it } from "vitest";
import { historicoParaEnviar, MAX_CARACTERES_CHAT, MAX_MENSAGENS_CHAT } from "@/domain/chat";

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
