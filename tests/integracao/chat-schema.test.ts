import { beforeEach, describe, expect, it } from "vitest";
import { db, sql } from "@/server/db/client";
import { chatAcoes, chatAnexos, clientes, viagens } from "@/server/db/schema";
import { criarUsuarioTeste, limparBanco } from "../helpers/db";

describe("schema chat_acoes e chat_anexos", () => {
  let usuarioId: string;
  let viagemId: string;

  beforeEach(async () => {
    await limparBanco();
    const u = await criarUsuarioTeste("diretor");
    usuarioId = u.id;
    const [c] = await db
      .insert(clientes)
      .values({ grupo: "Família Teste", tipo: "familia", filial: "Rondonópolis", telefone: "66999999999" })
      .returning();
    const [v] = await db
      .insert(viagens)
      .values({
        clienteId: c.id,
        seq: 1,
        destino: "Itália",
        inicio: "2027-08-14",
        fim: "2027-09-01",
        filial: "Rondonópolis",
        consultorId: u.id,
      })
      .returning();
    viagemId = v.id;
  });

  it("recusa tipo fora da lista de 10 ferramentas", async () => {
    await expect(
      sql`insert into chat_acoes (usuario_id, tipo, viagem_id, alvo, dados, expira_em)
          values (${usuarioId}, 'trello_apagar', ${viagemId}, '{}', '{}', now() + interval '15 minutes')`,
    ).rejects.toThrow();
  });

  it("aceita viagem_id nulo só com trello_criar_cartao e exige viagem_id nas demais", async () => {
    const [criada] = await db
      .insert(chatAcoes)
      .values({
        usuarioId,
        tipo: "trello_criar_cartao",
        viagemId: null,
        alvo: { listaId: "l1", lista: "Emissão" },
        dados: { nome: "Cartão avulso", descricao: "" },
        expiraEm: new Date(Date.now() + 15 * 60_000),
      })
      .returning();
    expect(criada.situacao).toBe("pendente");
    expect(criada.viagemId).toBeNull();

    await expect(
      db.insert(chatAcoes).values({
        usuarioId,
        tipo: "trello_comentar",
        viagemId: null,
        alvo: { cartaoId: "c1", cartao: "ECL-0001-01" },
        dados: { texto: "Oi" },
        expiraEm: new Date(Date.now() + 15 * 60_000),
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(chatAcoes).values({
        usuarioId,
        tipo: "trello_criar_cartao",
        viagemId,
        alvo: { listaId: "l1", lista: "Emissão" },
        dados: { nome: "Cartão avulso", descricao: "" },
        expiraEm: new Date(Date.now() + 15 * 60_000),
      }),
    ).rejects.toThrow();
  });

  it("exige expira_em obrigatório em chat_acoes", async () => {
    await expect(
      sql`insert into chat_acoes (usuario_id, tipo, viagem_id, alvo, dados)
          values (${usuarioId}, 'trello_criar_cartao', null, '{}', '{}')`,
    ).rejects.toThrow();
  });

  it("chat_anexos exige tamanho entre 1 e 5.242.880 bytes", async () => {
    const expiraEm = new Date(Date.now() + 60 * 60_000);
    const [ok] = await db
      .insert(chatAnexos)
      .values({
        usuarioId,
        nome: "voucher.pdf",
        mime: "application/pdf",
        tamanho: 5_242_880,
        caminho: `chat/${usuarioId}/a1`,
        expiraEm,
      })
      .returning();
    expect(ok.tamanho).toBe(5_242_880);

    await expect(
      db.insert(chatAnexos).values({
        usuarioId,
        nome: "grande.pdf",
        mime: "application/pdf",
        tamanho: 5_242_881,
        caminho: `chat/${usuarioId}/a2`,
        expiraEm,
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(chatAnexos).values({
        usuarioId,
        nome: "vazio.pdf",
        mime: "application/pdf",
        tamanho: 0,
        caminho: `chat/${usuarioId}/a3`,
        expiraEm,
      }),
    ).rejects.toThrow();
  });
});
