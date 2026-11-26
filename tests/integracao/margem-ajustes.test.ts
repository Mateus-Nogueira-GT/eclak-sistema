import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { intervaloDeMeses, margemPonderada } from "@/domain/paineis";
import { pct1 } from "@/domain/precificacao";
import type { MargemReal } from "@/domain/venda";
import { db } from "@/server/db/client";
import { caixasExperiencia, vendas } from "@/server/db/schema";
import { obterVisaoGeral, relatorioDre, type VisaoGeral } from "@/server/queries/paineis";
import { ajustesDaViagem, margensVendidas, obterViagemVendida } from "@/server/queries/vendas";
import { comSessao, limparBanco } from "../helpers/db";
import { vendida } from "../helpers/venda";

function dias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

async function aceite(viagemId: string, data: string) {
  await db.update(vendas).set({ aceiteEm: data }).where(eq(vendas.viagemId, viagemId));
}

/** Caixa confirmada inserida à mão (ainda não há action): respeita os CHECKs da confirmação. */
async function caixaConfirmada(viagemId: string, usuarioId: string, custoTotal: bigint) {
  await db.insert(caixasExperiencia).values({
    viagemId,
    filial: "MT",
    situacao: "confirmada",
    custoTotal,
    confirmadaEm: new Date(),
    confirmadaPor: usuarioId,
    criadoPor: usuarioId,
  });
}

function realDe(m: MargemReal | { erro: string }): MargemReal {
  if ("erro" in m) throw new Error("margem sem cálculo no fixture");
  return m;
}

/** Os campos da Visão geral que não dependem do `final` das viagens. */
function semFinal(v: VisaoGeral) {
  const resto: Partial<VisaoGeral> = { ...v };
  delete resto.margemRealPct;
  delete resto.perdas;
  delete resto.viagensAbaixoReferencia;
  delete resto.avisos;
  delete resto.avisosOcultos;
  return { ...resto, avisos: [...v.avisos, ...v.avisosOcultos].filter((a) => a.tipo !== "margem") };
}

const CAIXA = 16240n; // R$ 162,40

describe("margem real com ajustes (caixa de experiência)", () => {
  beforeEach(limparBanco);

  it("Review Focus 2: DRE e Visão geral iguais antes e depois da caixa confirmada, menos a margem real", async () => {
    const hoje = hojeEmCuiaba();
    const a = await vendida();
    const b = await vendida();
    await aceite(a.viagemId, dias(hoje, -5));
    await aceite(b.viagemId, dias(hoje, -10));
    const intervalo = intervaloDeMeses(dias(hoje, -10).slice(0, 7), hoje.slice(0, 7));

    const dreAntes = await comSessao(a.fin.id, () => relatorioDre(intervalo));
    const visaoAntes = await comSessao(a.d.id, () => obterVisaoGeral("30d"));
    const margensAntes = await margensVendidas([a.viagemId, b.viagemId]);
    const fichaBAntes = await comSessao(a.d.id, () => obterViagemVendida(b.viagemId));
    expect(dreAntes.semMargem).toEqual([]);
    expect(visaoAntes.margemRealPct).not.toBeNull();
    // As duas viagens estão no DRE (a comparação de antes e depois não é vazia).
    const receitas = [a.viagemId, b.viagemId].map((id) => realDe(margensAntes.get(id)!.real).receita);
    expect(dreAntes.linhas.find((l) => l.rotulo === "Receita de viagens")!.valor).toBe(receitas[0] + receitas[1]);

    await caixaConfirmada(a.viagemId, a.d.id, CAIXA);

    const dreDepois = await comSessao(a.fin.id, () => relatorioDre(intervalo));
    const visaoDepois = await comSessao(a.d.id, () => obterVisaoGeral("30d"));
    const margensDepois = await margensVendidas([a.viagemId, b.viagemId]);

    // DRE: receita, custo, imposto e taxas não mudam; a caixa não entra (a compra já está nas categorias).
    expect(dreDepois).toEqual(dreAntes);
    // Visão geral: tudo igual, menos o que deriva do `final`.
    expect(semFinal(visaoDepois)).toEqual(semFinal(visaoAntes));

    // Viagem A: só o final (e o %) cai R$ 162,40.
    const ra = realDe(margensAntes.get(a.viagemId)!.real);
    const rd = realDe(margensDepois.get(a.viagemId)!.real);
    expect(rd).toEqual({
      ...ra,
      final: ra.final - CAIXA,
      finalPct: pct1(ra.final - CAIXA, ra.receita),
      ajustes: CAIXA,
      ajustesDetalhe: { caixa: CAIXA, reembolsos: 0n },
    });
    // Viagem B (sem caixa, na mesma leitura em lote): idêntica.
    expect(margensDepois.get(b.viagemId)).toEqual(margensAntes.get(b.viagemId));

    // A margem real média passa a refletir a caixa.
    const finais = [rd, realDe(margensDepois.get(b.viagemId)!.real)].map((r) => ({ final: r.final, receita: r.receita }));
    expect(visaoDepois.margemRealPct).toBe(margemPonderada(finais));
    expect(visaoDepois.margemRealPct).not.toBe(visaoAntes.margemRealPct);

    // Viagem sem caixa: a ficha inteira idêntica.
    expect(await comSessao(a.d.id, () => obterViagemVendida(b.viagemId))).toEqual(fichaBAntes);
  });

  it("ficha da viagem: margem real igual à do lote e a ponte ganha 'Caixa de experiência' e fecha", async () => {
    const x = await vendida();
    const antes = (await comSessao(x.d.id, () => obterViagemVendida(x.viagemId)))!.estrategico!;
    expect(Array.isArray(antes.ponte) && antes.ponte.some((l) => l.rotulo === "Caixa de experiência")).toBe(false);

    await caixaConfirmada(x.viagemId, x.d.id, CAIXA);
    const ficha = (await comSessao(x.d.id, () => obterViagemVendida(x.viagemId)))!.estrategico!;
    const lote = (await margensVendidas([x.viagemId])).get(x.viagemId)!;
    expect(ficha).toEqual(lote);

    const real = realDe(ficha.real);
    expect(real.final).toBe(realDe(antes.real).final - CAIXA);
    if ("erro" in ficha.ponte) throw new Error("ponte sem cálculo no fixture");
    const linhas = ficha.ponte;
    expect(linhas.find((l) => l.rotulo === "Caixa de experiência")).toEqual({ rotulo: "Caixa de experiência", valor: -CAIXA });
    expect(linhas.some((l) => l.rotulo === "Reembolsos")).toBe(false);
    const meio = linhas.slice(1, -1).reduce((s, l) => s + l.valor, 0n);
    expect(meio).toBe(real.final - ficha.planejada.final);
    expect(linhas.at(-1)).toEqual({ rotulo: "Margem real", valor: real.final });
  });

  it("ajustesDaViagem: só a caixa confirmada conta; rascunho e cancelada (mesmo com custo) dão 0; reembolsos 0", async () => {
    const x = await vendida();
    expect(await ajustesDaViagem(db, x.viagemId)).toEqual({ caixa: 0n, reembolsos: 0n });

    await db.insert(caixasExperiencia).values({
      viagemId: x.viagemId,
      filial: "RS",
      situacao: "cancelada",
      custoTotal: 99999n,
      confirmadaEm: new Date(),
      confirmadaPor: x.d.id,
      canceladaEm: new Date(),
      canceladaPor: x.d.id,
      motivoCancelamento: "Montada por engano",
      criadoPor: x.d.id,
    });
    const [rascunho] = await db
      .insert(caixasExperiencia)
      .values({ viagemId: x.viagemId, filial: "MT", criadoPor: x.d.id })
      .returning({ id: caixasExperiencia.id });
    expect(await ajustesDaViagem(db, x.viagemId)).toEqual({ caixa: 0n, reembolsos: 0n });
    const margemComRascunho = (await margensVendidas([x.viagemId])).get(x.viagemId)!.real;
    expect(realDe(margemComRascunho).ajustes).toBe(0n);

    await db
      .update(caixasExperiencia)
      .set({ situacao: "confirmada", custoTotal: CAIXA, confirmadaEm: new Date(), confirmadaPor: x.d.id })
      .where(eq(caixasExperiencia.id, rascunho.id));
    expect(await ajustesDaViagem(db, x.viagemId)).toEqual({ caixa: CAIXA, reembolsos: 0n });
    // Também dentro de uma transação.
    expect(await db.transaction((tx) => ajustesDaViagem(tx, x.viagemId))).toEqual({ caixa: CAIXA, reembolsos: 0n });
  });
});
