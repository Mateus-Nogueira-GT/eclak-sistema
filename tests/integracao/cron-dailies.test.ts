import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { db } from "@/server/db/client";
import { auditoria, dailies, viagens } from "@/server/db/schema";
import { aprovarRoteiro, criarRoteiro } from "@/server/actions/roteiros";
import { gerarDaily, marcarEnviado, marcarRevisado, salvarInterno } from "@/server/actions/dailies";
import { gerarDailiesDoDia } from "@/server/operacao/dailies";
import { GET, POST } from "@/app/api/cron/dailies/route";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

// O agendador roda sem sessão (cron): todas as chamadas a gerarDailiesDoDia e à rota ficam fora de comSessao.

const DIA = "2027-08-16";

let f: Fixture;
let op: { id: string };
let roteiroId: string;

beforeEach(async () => {
  await limparBanco();
  f = await vendida();
  op = await criarUsuarioTeste("operacional");
  const c = await comSessao(op.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
  if (!c.ok || !("id" in c)) throw new Error(c.ok ? "sem id" : c.erro);
  roteiroId = c.id;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function aprovar() {
  const r = await comSessao(op.id, () => aprovarRoteiro(roteiroId));
  if (!r.ok) throw new Error(r.erro);
}
const linha = async (data = DIA) =>
  (await db.select().from(dailies).where(and(eq(dailies.roteiroId, roteiroId), eq(dailies.data, data))))[0];
const auditoriasDe = (id: string) => db.select().from(auditoria).where(and(eq(auditoria.tabela, "dailies"), eq(auditoria.registroId, id)));

describe("gerarDailiesDoDia", () => {
  it("roteiro aprovado sem daily no dia: gera com gerado_por nulo e audita com usuário nulo", async () => {
    await aprovar();
    expect(await gerarDailiesDoDia(DIA)).toEqual({ gerados: 1, pulados: 0 });
    const d = await linha();
    expect(d.estado).toBe("gerado");
    expect(d.geradoPor).toBeNull();
    expect(d.geradoEm).not.toBeNull();
    expect(d.texto).toBeTruthy();
    const aud = await auditoriasDe(d.id);
    expect(aud).toHaveLength(1);
    expect(aud[0]).toMatchObject({ acao: "criar", usuarioId: null });
    // Os outros dias do roteiro não são tocados.
    expect(await linha("2027-08-17")).toBeUndefined();
  });

  it("mesmo texto que o gerarDaily de uma pessoa", async () => {
    await aprovar();
    await gerarDailiesDoDia(DIA);
    const doSistema = (await linha()).texto;
    await db.delete(dailies);
    const g = await comSessao(op.id, () => gerarDaily(roteiroId, DIA));
    if (!g.ok) throw new Error(g.erro);
    expect((await linha()).texto).toBe(doSistema);
  });

  it("dia pendente (só a versão interna): gera e mantém plantão e interno", async () => {
    await aprovar();
    const s = await comSessao(op.id, () => salvarInterno(roteiroId, DIA, { plantaoId: f.u.id, interno: "Localizador ABC123" }));
    if (!s.ok) throw new Error(s.erro);
    expect(await gerarDailiesDoDia(DIA)).toEqual({ gerados: 1, pulados: 0 });
    const d = await linha();
    expect(d).toMatchObject({ id: s.id, estado: "gerado", geradoPor: null, plantaoId: f.u.id, interno: "Localizador ABC123" });
    const aud = await auditoriasDe(d.id);
    expect(aud.find((a) => a.acao === "alterar")).toMatchObject({ usuarioId: null });
  });

  for (const estado of ["gerado", "revisado", "enviado"] as const) {
    it(`daily ${estado}: não mexe no texto nem audita`, async () => {
      await aprovar();
      const g = await comSessao(op.id, () => gerarDaily(roteiroId, DIA));
      if (!g.ok) throw new Error(g.erro);
      await db.update(dailies).set({ texto: "Texto revisado à mão" }).where(eq(dailies.id, g.id));
      if (estado !== "gerado") expect((await comSessao(op.id, () => marcarRevisado(g.id))).ok).toBe(true);
      if (estado === "enviado") expect((await comSessao(op.id, () => marcarEnviado(g.id))).ok).toBe(true);
      const antes = await linha();
      const nAntes = (await db.select({ id: auditoria.id }).from(auditoria)).length;
      expect(await gerarDailiesDoDia(DIA)).toEqual({ gerados: 0, pulados: 1 });
      expect(await linha()).toEqual(antes);
      expect((await db.select({ id: auditoria.id }).from(auditoria)).length).toBe(nAntes);
    });
  }

  it("roteiro em rascunho: não gera", async () => {
    expect(await gerarDailiesDoDia(DIA)).toEqual({ gerados: 0, pulados: 0 });
    expect(await linha()).toBeUndefined();
  });

  it("viagem excluída: não gera", async () => {
    await aprovar();
    await db.update(viagens).set({ excluidoEm: new Date() }).where(eq(viagens.id, f.viagemId));
    expect(await gerarDailiesDoDia(DIA)).toEqual({ gerados: 0, pulados: 0 });
    expect(await linha()).toBeUndefined();
  });

  it("data fora do roteiro: não gera", async () => {
    await aprovar();
    expect(await gerarDailiesDoDia("2027-09-10")).toEqual({ gerados: 0, pulados: 0 });
    expect(await db.select().from(dailies)).toHaveLength(0);
  });

  it("segunda execução no mesmo dia: não gera de novo", async () => {
    await aprovar();
    expect(await gerarDailiesDoDia(DIA)).toEqual({ gerados: 1, pulados: 0 });
    const antes = await linha();
    expect(await gerarDailiesDoDia(DIA)).toEqual({ gerados: 0, pulados: 1 });
    expect(await linha()).toEqual(antes);
  });
});

describe("POST /api/cron/dailies", () => {
  const pedido = (auth?: string) =>
    new Request("http://localhost/api/cron/dailies", { method: "POST", headers: auth ? { authorization: auth } : {} });

  it("sem CRON_SECRET no ambiente: 503 e nada roda", async () => {
    await aprovar();
    vi.stubEnv("CRON_SECRET", "");
    expect((await POST(pedido("Bearer qualquer"))).status).toBe(503);
    expect(await db.select().from(dailies)).toHaveLength(0);
  });

  it("sem segredo ou com segredo errado: 401 e nada roda", async () => {
    await aprovar();
    vi.stubEnv("CRON_SECRET", "segredo-de-teste");
    expect((await POST(pedido())).status).toBe(401);
    expect((await POST(pedido("Bearer outro"))).status).toBe(401);
    expect(await db.select().from(dailies)).toHaveLength(0);
  });

  it("com o segredo: gera o dia de hoje + 2 em Cuiabá", async () => {
    await aprovar();
    vi.stubEnv("CRON_SECRET", "segredo-de-teste");
    // 14/08 03:30 UTC ainda é 13/08 23:30 em Cuiabá: hoje + 2 = 15/08.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-08-14T03:30:00.000Z"));
    const r = await POST(pedido("Bearer segredo-de-teste"));
    vi.useRealTimers();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ gerados: 1, pulados: 0 });
    expect((await linha("2027-08-15")).estado).toBe("gerado");
    expect(await linha("2027-08-16")).toBeUndefined();
  });

  it("GET: 405", () => {
    expect(GET().status).toBe(405);
  });
});
