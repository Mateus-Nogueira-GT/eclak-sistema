import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { formatarCodigoViagem } from "@/domain/viagens";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, integracaoEnvios, pessoas, viagens } from "@/server/db/schema";
import {
  caminhoAteARaiz,
  conhecidosDoSistema,
  codigosPorCartao,
  descendeDe,
  refsDaViagem,
  viagemDoCartao,
  viagemDoItem,
} from "@/server/ia/alcance";
import type { ClienteDrive, ItemDrive } from "@/server/integracoes/drive";
import { viagemPorCodigo } from "@/server/queries/operacao";
import { comSessao, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

function driveEmMemoria(arvore: Record<string, { nome: string; pais: string[]; mime?: string }>): ClienteDrive {
  return {
    async obter(id: string): Promise<ItemDrive | null> {
      const n = arvore[id];
      if (!n) return null;
      return {
        id,
        nome: n.nome,
        mime: n.mime ?? "application/vnd.google-apps.folder",
        pais: n.pais,
        modificado: null,
        tamanho: null,
        link: null,
      };
    },
  } as unknown as ClienteDrive;
}

let f: Fixture;
let codigo: string;

beforeEach(async () => {
  await limparBanco();
  f = await vendida();
  const [v] = await db
    .select({ seq: viagens.seq, codigo: clientes.codigo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(eq(viagens.id, f.viagemId));
  codigo = formatarCodigoViagem(v.codigo, v.seq);
});

describe("viagemPorCodigo e refsDaViagem", () => {
  it("sem sessão lança ErroAcesso", async () => {
    await expect(viagemPorCodigo(codigo)).rejects.toBeInstanceOf(ErroAcesso);
  });

  it("devolve os ids de Trello e Drive de envios enviados; falhou ou viagem excluída não entram", async () => {
    await db.insert(integracaoEnvios).values([
      {
        integracao: "trello",
        tipo: "cartao_viagem",
        viagemId: f.viagemId,
        chave: `venda:${f.viagemId}`,
        payload: {},
        situacao: "enviado",
        enviadoEm: new Date(),
        resultado: { cartaoId: "card-1", url: "https://trello.com/c/card-1" },
      },
      {
        integracao: "drive",
        tipo: "pasta_viagem",
        viagemId: f.viagemId,
        chave: `pasta:${f.viagemId}`,
        payload: {},
        situacao: "enviado",
        enviadoEm: new Date(),
        resultado: { pastaId: "pasta-v1", publicaId: "pub-1", internaId: "int-1" },
      },
    ]);

    const refs = await comSessao(f.u.id, () => refsDaViagem(codigo));
    expect(refs).toEqual({
      viagemId: f.viagemId,
      codigo,
      cliente: expect.any(String),
      cartaoId: "card-1",
      pastaId: "pasta-v1",
      publicaId: "pub-1",
      internaId: "int-1",
    });

    const porCartao = await comSessao(f.u.id, () => viagemDoCartao("card-1"));
    expect(porCartao?.viagemId).toBe(f.viagemId);
    expect(await comSessao(f.u.id, () => viagemDoCartao("outro-cartao"))).toBeNull();

    const mapa = await comSessao(f.u.id, () => codigosPorCartao());
    expect(mapa.get("card-1")).toBe(codigo);

    // Envio falhou -> cartaoId vira nulo.
    await db
      .update(integracaoEnvios)
      .set({ situacao: "falhou", enviadoEm: null })
      .where(eq(integracaoEnvios.chave, `venda:${f.viagemId}`));
    const semTrello = await comSessao(f.u.id, () => refsDaViagem(codigo));
    expect(semTrello?.cartaoId).toBeNull();
    expect(semTrello?.pastaId).toBe("pasta-v1");
    expect(await comSessao(f.u.id, () => viagemDoCartao("card-1"))).toBeNull();

    // Viagem excluída -> null.
    await db.update(viagens).set({ excluidoEm: new Date() }).where(eq(viagens.id, f.viagemId));
    expect(await comSessao(f.u.id, () => refsDaViagem(codigo))).toBeNull();
    expect(await comSessao(f.u.id, () => viagemPorCodigo(codigo))).toBeNull();
  });
});

describe("descendeDe, viagemDoItem e caminhoAteARaiz", () => {
  it("descendeDe: verdadeiro para o próprio ancestral, neto e 12 níveis; falso para irmão e 13 níveis", async () => {
    const arvore: Record<string, { nome: string; pais: string[] }> = {
      raiz: { nome: "Raiz", pais: [] },
      outraRaiz: { nome: "Outra", pais: [] },
      irmao: { nome: "Irmão", pais: ["outraRaiz"] },
      filho: { nome: "Filho", pais: ["raiz"] },
      neto: { nome: "Neto", pais: ["filho"] },
    };
    let pai = "raiz";
    for (let i = 1; i <= 13; i++) {
      const id = `n${i}`;
      arvore[id] = { nome: `Nivel ${i}`, pais: [pai] };
      pai = id;
    }
    const drive = driveEmMemoria(arvore);

    expect(await descendeDe(drive, "raiz", "raiz")).toBe(true);
    expect(await descendeDe(drive, "neto", "raiz")).toBe(true);
    expect(await descendeDe(drive, "irmao", "raiz")).toBe(false);
    expect(await descendeDe(drive, "n12", "raiz")).toBe(true);
    expect(await descendeDe(drive, "n13", "raiz")).toBe(false);
  });

  it("viagemDoItem acha a viagem A e devolve null para arquivo solto na raiz", async () => {
    await db.insert(integracaoEnvios).values({
      integracao: "drive",
      tipo: "pasta_viagem",
      viagemId: f.viagemId,
      chave: `pasta:${f.viagemId}`,
      payload: {},
      situacao: "enviado",
      enviadoEm: new Date(),
      resultado: { pastaId: "pasta-a", publicaId: "pub-a", internaId: "int-a" },
    });
    const drive = driveEmMemoria({
      raiz: { nome: "Raiz", pais: [] },
      "pasta-a": { nome: "ECL-0001_SOUZA", pais: ["raiz"] },
      "pub-a": { nome: "Público", pais: ["pasta-a"] },
      "arq-a": { nome: "voucher.pdf", pais: ["pub-a"], mime: "application/pdf" },
      "solto-raiz": { nome: "manual.pdf", pais: ["raiz"], mime: "application/pdf" },
    });

    const v = await comSessao(f.u.id, () => viagemDoItem(drive, "arq-a"));
    expect(v).toMatchObject({ viagemId: f.viagemId, codigo, pastaId: "pasta-a" });
    expect(await comSessao(f.u.id, () => viagemDoItem(drive, "solto-raiz"))).toBeNull();
  });

  it("caminhoAteARaiz devolve as pastas da raiz até o arquivo e null se fora da raiz", async () => {
    const drive = driveEmMemoria({
      raiz: { nome: "Raiz", pais: [] },
      "pasta-a": { nome: "ECL-0001_SOUZA", pais: ["raiz"] },
      "pub-a": { nome: "Público", pais: ["pasta-a"] },
      "arq-a": { nome: "voucher.pdf", pais: ["pub-a"], mime: "application/pdf" },
      fora: { nome: "secreto.pdf", pais: ["outra"], mime: "application/pdf" },
    });

    expect(await caminhoAteARaiz(drive, "arq-a", "raiz")).toEqual(["ECL-0001_SOUZA", "Público"]);
    expect(await caminhoAteARaiz(drive, "fora", "raiz")).toBeNull();
  });
});

describe("conhecidosDoSistema", () => {
  it("traz nascimento, cpf e passaporte de pessoas ativas e ignora removidas", async () => {
    const todas = await db.select().from(pessoas);
    await db
      .update(pessoas)
      .set({ nascimento: "1985-04-12", cpf: "11122233344", passaporte: "AB123456" })
      .where(eq(pessoas.id, todas[0].id));
    await db.insert(pessoas).values({
      clienteId: todas[0].clienteId,
      titular: false,
      ordem: 99,
      nome: "Removida",
      nascimento: "1990-09-09",
      cpf: "99988877766",
      passaporte: "ZZ999999",
      removidoEm: new Date(),
    });

    const c = await comSessao(f.u.id, () => conhecidosDoSistema());
    expect(c.nascimentos).toContain("1985-04-12");
    expect(c.documentos).toContain("11122233344");
    expect(c.documentos).toContain("AB123456");
    expect(c.nascimentos).not.toContain("1990-09-09");
    expect(c.documentos).not.toContain("99988877766");
    expect(c.documentos).not.toContain("ZZ999999");
  });
});
