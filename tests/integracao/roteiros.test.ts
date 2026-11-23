import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import type { ConteudoRoteiro } from "@/domain/roteiro";
import { db } from "@/server/db/client";
import { auditoria, itensViagem, pessoas, roteiros, tarefas } from "@/server/db/schema";
import { salvarCliente } from "@/server/actions/clientes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import {
  aprovarRoteiro,
  criarRoteiro,
  desfazerAprovacao,
  marcarEnviadoAoCliente,
  salvarRoteiro,
  trazerHoteisEVoos,
} from "@/server/actions/roteiros";
import { listarRoteiros, roteiroDaViagem } from "@/server/queries/operacao";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { souza, vendida, type Fixture } from "../helpers/venda";

const CONFLITO = { ok: false, conflito: true, erro: "Este roteiro foi alterado por outra pessoa. Recarregue a página." };

let f: Fixture;
let op: { id: string };
beforeEach(async () => {
  await limparBanco();
  f = await vendida();
  op = await criarUsuarioTeste("operacional");
  // O hotel do fixture não tem datas: 14/08 a 16/08.
  await db.update(itensViagem).set({ checkin: "2027-08-14", checkout: "2027-08-16" }).where(eq(itensViagem.id, f.hotel.itemId!));
});

async function criar(uid = op.id, viagemId = f.viagemId) {
  const r = await comSessao(uid, () => criarRoteiro(viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
  if (!r.ok || !("id" in r)) throw new Error(r.ok ? "sem id" : r.erro);
  return r.id;
}

async function tela(uid = op.id, viagemId = f.viagemId) {
  const r = await comSessao(uid, () => roteiroDaViagem(viagemId));
  if (!r?.roteiro) throw new Error("sem roteiro");
  return r.roteiro;
}

function comTitulo(c: ConteudoRoteiro, titulo: string): ConteudoRoteiro {
  return { ...c, dias: c.dias.map((d, i) => (i === 0 ? { ...d, titulo, itens: [{ hora: "09:00", titulo: `Item ${titulo}`, texto: "", mapa: null }] } : d)) };
}

const dadosDe = (r: Awaited<ReturnType<typeof tela>>, conteudo = r.conteudo) => ({ idioma: r.idioma, fuso: r.fuso, abertura: r.abertura, conteudo });

describe("criar", () => {
  it("operacional cria com 19 dias, hotéis e voos dos itens; de novo → já tem roteiro", async () => {
    const id = await criar();
    const r = await tela();
    expect(r.id).toBe(id);
    expect(r.status).toBe("rascunho");
    expect(r.conteudo.dias).toHaveLength(19);
    expect(r.conteudo.dias[0]).toEqual({ data: "2027-08-14", titulo: "", itens: [], dica: null, porque: null, gastro: [] });
    expect(r.conteudo.hoteis[0]).toMatchObject({ cidade: "Roma", nome: "Palazzo Barocci", entrada: "2027-08-14", saida: "2027-08-16" });
    expect(r.conteudo.voos[0].trecho).toBe("GRU-FCO");
    expect(r.conteudo.voos[0].voo).toBe("");
    expect(await comSessao(op.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }))).toEqual({
      ok: false,
      erro: "Esta viagem já tem roteiro",
    });
  });

  it("fuso inválido → erro no campo", async () => {
    expect(await comSessao(op.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europa/Nada" }))).toMatchObject({
      ok: false,
      campos: { fuso: "Fuso inválido" },
    });
  });

  it("item excluído não entra; viagem não vendida → 'A viagem ainda não foi vendida'", async () => {
    await db.update(itensViagem).set({ excluidoEm: new Date() }).where(eq(itensViagem.id, f.hotel.itemId!));
    await criar();
    expect((await tela()).conteudo.hoteis).toEqual([]);

    const c = await comSessao(f.u.id, () => salvarCliente({ ...souza, titular: { nome: "Ana Lima" }, acompanhantes: [] }));
    if (!c.ok) throw new Error(c.erro);
    const ps = (await comSessao(f.u.id, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
    const o = await comSessao(f.u.id, () => criarOrcamento({ clienteId: c.id, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros: ps }));
    if (!o.ok) throw new Error(o.erro);
    expect(await comSessao(op.id, () => criarRoteiro(o.id, { idioma: "portugues", fuso: "Europe/Lisbon" }))).toEqual({
      ok: false,
      erro: "A viagem ainda não foi vendida",
    });
  });
});

describe("salvar", () => {
  it("Review Focus 2: dois salvamentos com o mesmo atualizadoEm → um ok, um conflito; fica o vencedor inteiro", async () => {
    const id = await criar();
    const r = await tela();
    const a = comTitulo(r.conteudo, "A");
    const b = comTitulo(r.conteudo, "B");
    const rs = await comSessao(op.id, () =>
      Promise.all([salvarRoteiro(id, dadosDe(r, a), r.atualizadoEm), salvarRoteiro(id, dadosDe(r, b), r.atualizadoEm)]),
    );
    const oks = rs.filter((x) => x.ok);
    const falhas = rs.filter((x) => !x.ok);
    expect(oks).toHaveLength(1);
    expect(falhas).toEqual([CONFLITO]);
    const vencedor = rs[0].ok ? a : b;
    const [linha] = await db.select().from(roteiros).where(eq(roteiros.id, id));
    expect(linha.conteudo).toEqual(vencedor);
    expect((await tela()).atualizadoEm).toBe((oks[0] as { atualizadoEm: string }).atualizadoEm);
  });

  it("dias que não batem com as datas", async () => {
    const id = await criar();
    const r = await tela();
    const x = await comSessao(op.id, () => salvarRoteiro(id, dadosDe(r, { ...r.conteudo, dias: r.conteudo.dias.slice(1) }), r.atualizadoEm));
    expect(x).toMatchObject({ ok: false, erro: "Os dias do roteiro não batem com as datas da viagem" });
  });

  it("trazerHoteisEVoos repõe os hotéis apagados (e muda atualizadoEm)", async () => {
    const id = await criar();
    const r = await tela();
    const s = await comSessao(op.id, () => salvarRoteiro(id, dadosDe(r, { ...comTitulo(r.conteudo, "A"), hoteis: [], voos: [] }), r.atualizadoEm));
    if (!s.ok) throw new Error(s.erro);
    expect((await tela()).conteudo.hoteis).toEqual([]);
    expect(await comSessao(op.id, () => trazerHoteisEVoos(id, r.atualizadoEm))).toEqual(CONFLITO);
    const t = await comSessao(op.id, () => trazerHoteisEVoos(id, s.atualizadoEm));
    expect(t.ok).toBe(true);
    const depois = await tela();
    expect(depois.conteudo.hoteis[0]).toMatchObject({ nome: "Palazzo Barocci", entrada: "2027-08-14" });
    expect(depois.conteudo.voos[0].trecho).toBe("GRU-FCO");
    expect(depois.conteudo.dias[0].titulo).toBe("A");
    expect(depois.atualizadoEm).not.toBe(s.atualizadoEm);
  });
});

describe("Review Focus 1: aprovação e tarefas do roteiro", () => {
  const doRoteiro = (viagemId: string) =>
    db.select().from(tarefas).where(and(eq(tarefas.viagemId, viagemId), eq(tarefas.origem, "roteiro")));

  it("aprovar → 3; desfazer → as 3 continuam; aprovar de novo → 0", async () => {
    const id = await criar();
    const antes = await tela();
    expect(await comSessao(op.id, () => aprovarRoteiro(id))).toEqual({ ok: true, tarefasCriadas: 3 });
    const aprovado = await tela();
    expect(aprovado).toMatchObject({ status: "aprovado", aprovadoPor: "Teste operacional", alteradoDepoisDaAprovacao: false });
    expect(aprovado.atualizadoEm).toBe(antes.atualizadoEm);
    expect(aprovado.aprovadoEm).not.toBeNull();
    const ts = await doRoteiro(f.viagemId);
    expect(ts.map((t) => t.chave).sort()).toEqual(["roteiro.ingressos", "roteiro.passeios", "roteiro.trem"]);
    expect(ts.every((t) => t.responsavelId === f.u.id)).toBe(true);
    expect(await comSessao(op.id, () => aprovarRoteiro(id))).toEqual({ ok: false, erro: "Roteiro já aprovado pelo cliente" });

    expect(await comSessao(op.id, () => desfazerAprovacao(id))).toEqual({ ok: true });
    const desfeito = await tela();
    expect(desfeito).toMatchObject({ status: "aguardando_cliente", aprovadoEm: null, aprovadoPor: null });
    expect(await doRoteiro(f.viagemId)).toHaveLength(3);
    expect(await comSessao(op.id, () => desfazerAprovacao(id))).toEqual({ ok: false, erro: "O roteiro não está aprovado" });

    expect(await comSessao(op.id, () => aprovarRoteiro(id))).toEqual({ ok: true, tarefasCriadas: 0 });
    expect(await doRoteiro(f.viagemId)).toHaveLength(3);
  });

  it("duas aprovações ao mesmo tempo → uma cria 3, a outra recusa; 3 no total", async () => {
    const id = await criar();
    const rs = await comSessao(op.id, () => Promise.all([aprovarRoteiro(id), aprovarRoteiro(id)]));
    expect(rs).toContainEqual({ ok: true, tarefasCriadas: 3 });
    expect(rs).toContainEqual({ ok: false, erro: "Roteiro já aprovado pelo cliente" });
    expect(await doRoteiro(f.viagemId)).toHaveLength(3);
  });

  it("salvar depois da aprovação → 'alterado depois da aprovação', status continua aprovado", async () => {
    const id = await criar();
    const r = await tela();
    await comSessao(op.id, () => aprovarRoteiro(id));
    const s = await comSessao(op.id, () => salvarRoteiro(id, dadosDe(r, comTitulo(r.conteudo, "Depois")), r.atualizadoEm));
    expect(s.ok).toBe(true);
    expect(await tela()).toMatchObject({ status: "aprovado", alteradoDepoisDaAprovacao: true });
  });

  it("enviar ao cliente só do rascunho; aprovar direto do rascunho", async () => {
    const id = await criar();
    expect(await comSessao(op.id, () => marcarEnviadoAoCliente(id))).toEqual({ ok: true });
    const r = await tela();
    expect(r.status).toBe("aguardando_cliente");
    expect(r.enviadoClienteEm).not.toBeNull();
    expect((await comSessao(op.id, () => marcarEnviadoAoCliente(id))).ok).toBe(false);
  });
});

describe("tela", () => {
  it("aniversário durante a viagem", async () => {
    await criar();
    await db.update(pessoas).set({ nascimento: "1987-08-23" }).where(eq(pessoas.nome, "Júlia Souza"));
    const r = await comSessao(op.id, () => roteiroDaViagem(f.viagemId));
    expect(r!.aniversarios[0]).toMatchObject({ nome: "Júlia Souza", data: "2027-08-23", idade: 40, diaDaViagem: 10 });
    expect(r!.sugestao).toEqual({ idioma: "italiano", fuso: "Europe/Rome" });
  });

  it("Review Focus 5: consultor lê sem nada estratégico", async () => {
    await criar(f.u.id);
    const r = await comSessao(f.u.id, () => roteiroDaViagem(f.viagemId));
    expect(r!.roteiro).not.toBeNull();
    const l = await comSessao(f.u.id, () => listarRoteiros());
    for (const json of [JSON.stringify(r), JSON.stringify(l)]) {
      for (const proibido of ["valorBrl", "valorOriginal", "margem", "custo", "comissao"]) expect(json).not.toContain(`"${proibido}":`);
    }
  });

  it("listarRoteiros: vendidas não terminadas com a situação", async () => {
    const antes = await comSessao(op.id, () => listarRoteiros());
    expect(antes).toEqual([expect.objectContaining({ viagemId: f.viagemId, destino: "Itália", inicio: "2027-08-14", situacao: "sem_roteiro" })]);
    expect(antes[0].codigo).toMatch(/^ECL-\d{4}-01$/);
    const id = await criar();
    await comSessao(op.id, () => aprovarRoteiro(id));
    expect((await comSessao(op.id, () => listarRoteiros()))[0].situacao).toBe("aprovado");
  });

  it("sem sessão: sem permissão", async () => {
    expect(await criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" })).toEqual({ ok: false, erro: "Sem permissão" });
    await expect(roteiroDaViagem(f.viagemId)).rejects.toThrow();
  });
});

it("auditoria de criar, salvar e aprovar em 'roteiros'", async () => {
  const id = await criar();
  const r = await tela();
  await comSessao(op.id, () => salvarRoteiro(id, dadosDe(r, comTitulo(r.conteudo, "A")), r.atualizadoEm));
  await comSessao(op.id, () => aprovarRoteiro(id));
  const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "roteiros"), eq(auditoria.registroId, id)));
  expect(aud.find((a) => a.acao === "criar")!.depois).toMatchObject({ status: "rascunho", idioma: "italiano" });
  const alts = aud.filter((a) => a.acao === "alterar");
  const salvar = alts.find((a) => (a.depois as { conteudo?: ConteudoRoteiro }).conteudo)!;
  expect((salvar.antes as { conteudo: ConteudoRoteiro }).conteudo.dias[0].titulo).toBe("");
  expect((salvar.depois as { conteudo: ConteudoRoteiro }).conteudo.dias[0].titulo).toBe("A");
  expect(alts.some((a) => (a.depois as { status?: string }).status === "aprovado")).toBe(true);
});
