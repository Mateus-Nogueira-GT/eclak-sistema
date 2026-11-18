import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { REGRAS_INICIAIS } from "@/domain/regras";
import { db } from "@/server/db/client";
import { auditoria, regrasVersoes } from "@/server/db/schema";
import { salvarRegras } from "@/server/actions/regras";
import { historicoRegras, regrasVigentes } from "@/server/queries/regras";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";

const com = (p: Partial<typeof REGRAS_INICIAIS>) => ({ ...REGRAS_INICIAIS, ...p });
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("parâmetros versionados", () => {
  beforeEach(limparBanco);

  it("banco vazio: regrasVigentes devolve REGRAS_INICIAIS e grava a primeira versão", async () => {
    const d = await criarUsuarioTeste("diretor");
    const v = await comSessao(d.id, () => regrasVigentes());
    expect(v.valores).toEqual(REGRAS_INICIAIS);
    expect(await db.select().from(regrasVersoes)).toHaveLength(1);
  });

  it("exige login", async () => {
    await expect(regrasVigentes()).rejects.toThrow("Sem permissão");
  });

  it("qualquer perfil logado lê as regras vigentes", async () => {
    const c = await criarUsuarioTeste("consultor");
    const v = await comSessao(c.id, () => regrasVigentes());
    expect(v.valores.margemReferenciaPct).toBe("19.000");
  });

  it("duas leituras simultâneas com banco vazio criam uma única versão inicial", async () => {
    const d = await criarUsuarioTeste("diretor");
    await comSessao(d.id, () => Promise.all([regrasVigentes(), regrasVigentes(), regrasVigentes()]));
    expect(await db.select().from(regrasVersoes)).toHaveLength(1);
  });

  it("Diretor salva margem 20: vigente passa a 20, data anterior ainda devolve 19, auditoria 'criar'", async () => {
    const d = await criarUsuarioTeste("diretor");
    await comSessao(d.id, () => regrasVigentes());
    await pausa(20);
    const antes = new Date();
    await pausa(20);
    const r = await comSessao(d.id, () => salvarRegras(com({ margemReferenciaPct: "20.000" })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const agora = await comSessao(d.id, () => regrasVigentes());
    expect(agora.versaoId).toBe(r.versaoId);
    expect(agora.valores.margemReferenciaPct).toBe("20.000");
    const passado = await comSessao(d.id, () => regrasVigentes(antes));
    expect(passado.valores.margemReferenciaPct).toBe("19.000");
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, r.versaoId));
    expect(aud.map((a) => [a.acao, a.tabela, a.usuarioId])).toEqual([["criar", "regras_versoes", d.id]]);
  });

  it("histórico mostra campo, antes e depois, mais recentes primeiro", async () => {
    const d = await criarUsuarioTeste("diretor");
    await comSessao(d.id, async () => {
      await salvarRegras(com({ margemReferenciaPct: "20.000" }));
      await salvarRegras(com({ margemReferenciaPct: "20.000", taxas: { ...REGRAS_INICIAIS.taxas, credito1x: "2.500" } }));
    });
    const h = await comSessao(d.id, () => historicoRegras());
    expect(h.map((l) => [l.campo, l.antes, l.depois])).toEqual([
      ["Taxa de cartão: crédito 1x", "2,19%", "2,5%"],
      ["Margem de referência", "19%", "20%"],
    ]);
    expect(h[0].usuario).toBe("Teste diretor");
    expect(h[0].em).toBeInstanceOf(Date);
  });

  it("fin_operacional e consultor não salvam nem leem o histórico; nada é gravado", async () => {
    const f = await criarUsuarioTeste("fin_operacional");
    const r = await comSessao(f.id, () => salvarRegras(com({ margemReferenciaPct: "25.000" })));
    expect(r).toEqual({ ok: false, erro: "Sem permissão" });
    expect(await db.select().from(regrasVersoes)).toHaveLength(0);
    expect(await db.select().from(auditoria)).toHaveLength(0);
    await expect(comSessao(f.id, () => historicoRegras())).rejects.toThrow("Sem permissão");
  });

  it("recusa valores inválidos com mensagem e campo", async () => {
    const d = await criarUsuarioTeste("diretor");
    const r = await comSessao(d.id, () => salvarRegras(com({ parcelamentoMaximo: 11 })));
    expect(r).toMatchObject({ ok: false, erro: "Informe de 1 a 10", campos: { parcelamentoMaximo: "Informe de 1 a 10" } });
    const r2 = await comSessao(d.id, () => salvarRegras({ ...REGRAS_INICIAIS, margemAlvoPct: "-3.000" }));
    expect(r2.ok).toBe(false);
    expect(await db.select().from(regrasVersoes)).toHaveLength(0);
  });

  it("dois salvamentos em paralelo gravam duas versões novas; a última por seq vale", async () => {
    const d = await criarUsuarioTeste("diretor");
    await comSessao(d.id, () => regrasVigentes());
    const rs = await comSessao(d.id, () =>
      Promise.all([
        salvarRegras(com({ margemReferenciaPct: "21.000" })),
        salvarRegras(com({ margemReferenciaPct: "22.000" })),
      ]),
    );
    expect(rs.every((r) => r.ok)).toBe(true);
    const linhas = await db.select().from(regrasVersoes);
    expect(linhas).toHaveLength(3);
    const margens = linhas.map((l) => l.valores.margemReferenciaPct).sort();
    expect(margens).toEqual(["19.000", "21.000", "22.000"]);
    const vig = await comSessao(d.id, () => regrasVigentes());
    const ultima = [...linhas].sort((a, b) => a.seq - b.seq).at(-1)!;
    expect(vig.versaoId).toBe(ultima.id);
  });

  it("salvar com banco vazio cria a versão inicial antes, para o histórico ter o 'antes'", async () => {
    const d = await criarUsuarioTeste("diretor");
    await comSessao(d.id, () => salvarRegras(com({ margemReferenciaPct: "20.000" })));
    expect(await db.select().from(regrasVersoes)).toHaveLength(2);
    const h = await comSessao(d.id, () => historicoRegras());
    expect(h).toHaveLength(1);
  });

  it("a versão inicial vale desde sempre; data anterior a um save devolve os valores iniciais", async () => {
    const d = await criarUsuarioTeste("diretor");
    const v = await comSessao(d.id, () => regrasVigentes());
    expect(v.vigenteDesde.getTime()).toBe(0);
    const antigo = await comSessao(d.id, () => regrasVigentes(new Date("2000-01-01")));
    expect(antigo.valores).toEqual(REGRAS_INICIAIS);
    await comSessao(d.id, () => salvarRegras(com({ margemReferenciaPct: "20.000" })));
    const antes = await comSessao(d.id, () => regrasVigentes(new Date("2000-01-01")));
    expect(antes.valores.margemReferenciaPct).toBe("19.000");
    const agora = await comSessao(d.id, () => regrasVigentes());
    expect(agora.valores.margemReferenciaPct).toBe("20.000");
  });

  it("campos de um mesmo save mantêm a ordem da tela no histórico", async () => {
    const d = await criarUsuarioTeste("diretor");
    await comSessao(d.id, () =>
      salvarRegras(com({ margemAlvoPct: "18.000", margemReferenciaPct: "20.000", markupTremPct: "41.000" })),
    );
    const h = await comSessao(d.id, () => historicoRegras());
    expect(h.map((l) => l.campo)).toEqual(["Margem líquida alvo da viagem", "Margem de referência", "Markup de trem"]);
  });
});
