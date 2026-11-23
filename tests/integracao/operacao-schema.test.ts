import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/server/db/client";
import { dailies, roteiros, tarefas } from "@/server/db/schema";
import { cabecalhoDaViagem } from "@/server/queries/operacao";
import { limparBanco, comSessao } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());

let f: Fixture;
beforeEach(async () => {
  await limparBanco();
  f = await vendida();
});

const tarefa = (o: Record<string, unknown> = {}) => ({
  viagemId: f.viagemId,
  categoria: "conferir" as const,
  item: "Teste",
  ordem: 99,
  ...o,
});

const conteudo = { dias: [], hoteis: [], voos: [] };
const roteiro = () => ({ viagemId: f.viagemId, idioma: "italiano" as const, fuso: "Europe/Rome", conteudo });

describe("restrições do esquema da operação", () => {
  it("(viagem, chave) é único; chave nula repete", async () => {
    await db.insert(tarefas).values(tarefa({ chave: "manual.x" }));
    await expect(db.insert(tarefas).values(tarefa({ chave: "manual.x", ordem: 100 }))).rejects.toThrow();
    await db.insert(tarefas).values(tarefa({ ordem: 101 }));
    await db.insert(tarefas).values(tarefa({ ordem: 102 }));
  });

  it("prazo 'data' sem prazo_data falha", async () => {
    await expect(db.insert(tarefas).values(tarefa({ prazoTipo: "data" }))).rejects.toThrow();
    await expect(db.insert(tarefas).values(tarefa({ prazoTipo: "dias_antes", prazoDias: 366 }))).rejects.toThrow();
    await db.insert(tarefas).values(tarefa({ prazoTipo: "dias_antes", prazoDias: 7 }));
  });

  it("responsável e customer care juntos falham", async () => {
    await expect(db.insert(tarefas).values(tarefa({ responsavelId: f.u.id, customerCare: true }))).rejects.toThrow();
  });

  it("concluida_em e concluida_por vão juntos", async () => {
    await expect(db.insert(tarefas).values(tarefa({ concluidaEm: new Date() }))).rejects.toThrow();
  });

  it("um roteiro por viagem", async () => {
    await db.insert(roteiros).values(roteiro());
    await expect(db.insert(roteiros).values(roteiro())).rejects.toThrow();
  });

  it("daily gerado sem texto falha; pendente sem texto passa", async () => {
    const [r] = await db.insert(roteiros).values(roteiro()).returning();
    await expect(db.insert(dailies).values({ roteiroId: r.id, data: "2027-08-14", estado: "gerado" })).rejects.toThrow();
    await db.insert(dailies).values({ roteiroId: r.id, data: "2027-08-14", estado: "pendente" });
    await expect(db.insert(dailies).values({ roteiroId: r.id, data: "2027-08-14", estado: "pendente" })).rejects.toThrow();
  });
});

describe("cabecalhoDaViagem", () => {
  it("devolve o cabeçalho sem nada estratégico", async () => {
    const c = await comSessao(f.u.id, () => cabecalhoDaViagem(f.viagemId));
    expect(c).not.toBeNull();
    expect(c!.codigo).toMatch(/^ECL-\d{4}-01$/);
    expect(c!.passageiros).toHaveLength(2);
    expect(c!.noites).toBe(18);
    expect(c!.vendida).toBe(true);
    expect(c!.consultor.id).toBe(f.u.id);
    const json = JSON.stringify(c);
    for (const proibido of ["valor", "margem", "custo", "comissao"]) expect(json).not.toContain(`"${proibido}"`);
  });

  it("id inválido ou inexistente devolve null", async () => {
    expect(await comSessao(f.u.id, () => cabecalhoDaViagem("x"))).toBeNull();
  });
});
