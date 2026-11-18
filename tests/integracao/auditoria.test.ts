import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/server/db/client";
import { auditoria, usuarios } from "@/server/db/schema";
import { registrarAuditoria } from "@/server/auditoria";
import { limparBanco } from "../helpers/db";

async function inserirUsuario(tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) {
  const id = randomUUID();
  await tx.insert(usuarios).values({
    id,
    nome: "Fulano",
    email: `${id}@eclak.test`,
    perfil: "consultor",
    filial: "Rondonópolis",
  });
  return id;
}

describe("registrarAuditoria", () => {
  beforeEach(limparBanco);

  it("faz rollback do usuário e da auditoria quando a transação falha", async () => {
    await expect(
      db.transaction(async (tx) => {
        const id = await inserirUsuario(tx);
        await registrarAuditoria(tx, {
          usuarioId: id,
          tabela: "usuarios",
          registroId: id,
          acao: "criar",
          depois: { id },
        });
        throw new Error("falha forçada");
      }),
    ).rejects.toThrow("falha forçada");

    expect(await db.select().from(usuarios)).toHaveLength(0);
    expect(await db.select().from(auditoria)).toHaveLength(0);
  });

  it("grava antes/depois com bigint (inclusive aninhado) como string e Date como ISO", async () => {
    const quando = new Date("2026-11-18T12:00:00.000Z");
    const antes = { valorCentavos: 12345678901234567n, itens: [{ v: 1n }], aninhado: { v: 2n } };
    const id = await db.transaction(async (tx) => {
      const uid = await inserirUsuario(tx);
      await registrarAuditoria(tx, {
        usuarioId: uid,
        tabela: "usuarios",
        registroId: uid,
        acao: "alterar",
        antes,
        depois: { valorCentavos: 5n, quando },
      });
      return uid;
    });

    const [linha] = await db.select().from(auditoria);
    expect(linha.usuarioId).toBe(id);
    expect(linha.tabela).toBe("usuarios");
    expect(linha.registroId).toBe(id);
    expect(linha.acao).toBe("alterar");
    expect(linha.antes).toEqual({
      valorCentavos: "12345678901234567",
      itens: [{ v: "1" }],
      aninhado: { v: "2" },
    });
    expect(linha.depois).toEqual({ valorCentavos: "5", quando: "2026-11-18T12:00:00.000Z" });
    // não muta o objeto do chamador
    expect(antes.valorCentavos).toBe(12345678901234567n);
  });

  it("aceita antes/depois ausentes (null)", async () => {
    const uid = randomUUID();
    await db.transaction((tx) =>
      registrarAuditoria(tx, { usuarioId: uid, tabela: "t", registroId: "1", acao: "excluir" }),
    );
    const [linha] = await db.select().from(auditoria);
    expect(linha.antes).toBeNull();
    expect(linha.depois).toBeNull();
  });
});
