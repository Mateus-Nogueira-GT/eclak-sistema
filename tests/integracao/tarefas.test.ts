import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { somarDias } from "@/domain/venda";
import { db } from "@/server/db/client";
import { auditoria, tarefas } from "@/server/db/schema";
import { salvarCliente } from "@/server/actions/clientes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import {
  concluirTarefa,
  criarTarefa,
  criarTarefasDaVenda,
  desfazerConclusao,
  editarTarefa,
  excluirTarefa,
} from "@/server/actions/tarefas";
import type { TarefaEntrada } from "@/domain/tarefas";
import { listarTarefas, tarefasDaViagem } from "@/server/queries/operacao";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { souza, vendida, type Fixture } from "../helpers/venda";

let f: Fixture;
beforeEach(async () => {
  await limparBanco();
  f = await vendida();
});

const trem: TarefaEntrada = {
  categoria: "ingressos",
  dia: "2027-08-16",
  item: "Trem Veneza > Florença",
  prazo: { tipo: "dias_antes", dias: 15 },
  responsavel: { tipo: "customer_care" },
};

const daViagem = (viagemId: string) =>
  db.select().from(tarefas).where(eq(tarefas.viagemId, viagemId));

async function criar(uid: string, dados: TarefaEntrada = trem, viagemId = f.viagemId) {
  const r = await comSessao(uid, () => criarTarefa(viagemId, dados));
  if (!r.ok || !("id" in r) || !r.id) throw new Error(r.ok ? "sem id" : r.erro);
  return r.id;
}

async function linha(uid: string, id: string) {
  const r = await comSessao(uid, () => tarefasDaViagem(f.viagemId));
  return r!.tarefas.find((t) => t.id === id)!;
}

describe("Review Focus 1: tarefas automáticas da venda", () => {
  it("fecharVenda cria exatamente 5, do consultor, com prazo venda + N", async () => {
    const ts = await daViagem(f.viagemId);
    expect(ts).toHaveLength(5);
    for (const t of ts) expect(t).toMatchObject({ origem: "venda", responsavelId: f.u.id, customerCare: false, fazer: "" });
    const whatsapp = ts.find((t) => t.chave === "venda.whatsapp")!;
    expect(whatsapp).toMatchObject({ prazoTipo: "data", prazoData: somarDias(hojeEmCuiaba(), 1), categoria: "envio" });
    expect(new Set(ts.map((t) => t.ordem)).size).toBe(5);
  });

  it("criarTarefasDaVenda é idempotente; a automática excluída não renasce", async () => {
    expect(await comSessao(f.u.id, () => criarTarefasDaVenda(f.viagemId))).toEqual({ ok: true, criadas: 0 });
    const drive = (await daViagem(f.viagemId)).find((t) => t.chave === "venda.drive")!;
    expect(await comSessao(f.u.id, () => excluirTarefa(drive.id))).toEqual({ ok: true });
    expect(await comSessao(f.u.id, () => criarTarefasDaVenda(f.viagemId))).toEqual({ ok: true, criadas: 0 });
    const ts = await daViagem(f.viagemId);
    expect(ts).toHaveLength(5);
    expect(ts.find((t) => t.chave === "venda.drive")!.excluidoEm).toBeInstanceOf(Date);
    const r = await comSessao(f.u.id, () => tarefasDaViagem(f.viagemId));
    expect(r!.tarefas).toHaveLength(4);
    expect(r!.temDaVenda).toBe(true);
  });

  it("viagem vendida sem tarefas (antes da 5a): cria as 5 com o dia da venda", async () => {
    await db.delete(tarefas).where(eq(tarefas.viagemId, f.viagemId));
    expect((await comSessao(f.u.id, () => tarefasDaViagem(f.viagemId)))!.temDaVenda).toBe(false);
    expect(await comSessao(f.u.id, () => criarTarefasDaVenda(f.viagemId))).toEqual({ ok: true, criadas: 5 });
    const ts = await daViagem(f.viagemId);
    expect(ts).toHaveLength(5);
    expect(ts.find((t) => t.chave === "venda.fatura")!.prazoData).toBe(somarDias(hojeEmCuiaba(), 2));
    expect(await comSessao(f.u.id, () => criarTarefasDaVenda(f.viagemId))).toEqual({ ok: true, criadas: 0 });
  });

  it("duas chamadas ao mesmo tempo não duplicam", async () => {
    await db.delete(tarefas).where(eq(tarefas.viagemId, f.viagemId));
    const rs = await comSessao(f.u.id, () => Promise.all([criarTarefasDaVenda(f.viagemId), criarTarefasDaVenda(f.viagemId)]));
    expect(rs.map((r) => (r.ok ? r.criadas : -1)).sort()).toEqual([0, 5]);
    expect(await daViagem(f.viagemId)).toHaveLength(5);
  });
});

describe("tarefa manual", () => {
  it("consultor cria; a tela traz o rótulo do prazo e o customer care", async () => {
    const id = await criar(f.u.id);
    const t = await linha(f.u.id, id);
    expect(t).toMatchObject({
      categoria: "ingressos",
      dia: "2027-08-16",
      item: "Trem Veneza > Florença",
      fazer: "",
      prazo: { tipo: "dias_antes", dias: 15 },
      prazoEfetivo: "2027-07-30",
      rotuloPrazo: "15 dias antes (30/07/2027)",
      situacao: "no_prazo",
      responsavel: { tipo: "customer_care" },
      observacao: null,
      origem: "manual",
      concluidaEm: null,
      concluidaPor: null,
    });
    const [db1] = await db.select().from(tarefas).where(eq(tarefas.id, id));
    expect(db1.ordem).toBe(6);
  });

  it("ordenadas por categoria, Geral primeiro, dia e ordem", async () => {
    await criar(f.u.id, { ...trem, dia: null, item: "Geral" });
    const r = await comSessao(f.u.id, () => tarefasDaViagem(f.viagemId));
    expect(r!.tarefas.map((t) => t.categoria)).toEqual(["ingressos", "hoteis_carro_voos", "conferir", "conferir", "envio", "envio"]);
    expect(r!.tarefas[0].item).toBe("Geral");
    const resp = r!.tarefas.find((t) => t.origem === "venda")!.responsavel;
    expect(resp).toEqual({ tipo: "usuario", id: f.u.id, nome: "Teste consultor" });
  });

  it("responsável precisa ser usuário ativo", async () => {
    const inativo = await criarUsuarioTeste("operacional", { ativo: false });
    const r = await comSessao(f.u.id, () => criarTarefa(f.viagemId, { ...trem, responsavel: { tipo: "usuario", id: inativo.id } }));
    expect(r).toMatchObject({ ok: false, erro: "Escolha um responsável ativo", campos: { responsavel: "Escolha um responsável ativo" } });
    const op = await criarUsuarioTeste("operacional");
    const id = await criar(f.u.id, { ...trem, responsavel: { tipo: "usuario", id: op.id } });
    expect((await linha(f.u.id, id)).responsavel).toEqual({ tipo: "usuario", id: op.id, nome: "Teste operacional" });
  });

  it("validação devolve campos", async () => {
    const r = await comSessao(f.u.id, () => criarTarefa(f.viagemId, { ...trem, item: " " }));
    expect(r).toMatchObject({ ok: false, erro: "Informe o item", campos: { item: "Informe o item" } });
  });

  it("viagem não vendida: 'A viagem ainda não foi vendida'", async () => {
    const c = await comSessao(f.u.id, () => salvarCliente({ ...souza, titular: { nome: "Ana Lima" }, acompanhantes: [] }));
    if (!c.ok) throw new Error(c.erro);
    const pessoas = (await comSessao(f.u.id, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
    const o = await comSessao(f.u.id, () => criarOrcamento({ clienteId: c.id, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros: pessoas }));
    if (!o.ok) throw new Error(o.erro);
    expect(await comSessao(f.u.id, () => criarTarefa(o.id, trem))).toEqual({ ok: false, erro: "A viagem ainda não foi vendida" });
    expect(await comSessao(f.u.id, () => criarTarefasDaVenda(o.id))).toEqual({ ok: false, erro: "A viagem ainda não foi vendida" });
  });

  it("concluir, concluir de novo, desfazer", async () => {
    const op = await criarUsuarioTeste("operacional");
    const id = await criar(f.u.id);
    expect(await comSessao(op.id, () => concluirTarefa(id))).toEqual({ ok: true });
    const t = await linha(op.id, id);
    expect(t.concluidaPor).toBe("Teste operacional");
    expect(t.concluidaEm).not.toBeNull();
    expect(t.situacao).toBe("concluida");
    const deNovo = await comSessao(f.u.id, () => concluirTarefa(id));
    expect(deNovo.ok).toBe(false);
    expect(!deNovo.ok && deNovo.erro).toBe(`Tarefa já concluída por Teste operacional em ${hojeEmCuiaba().split("-").reverse().join("/")}`);
    expect(await comSessao(f.u.id, () => desfazerConclusao(id))).toEqual({ ok: true });
    const [d] = await db.select().from(tarefas).where(eq(tarefas.id, id));
    expect(d.concluidaEm).toBeNull();
    expect(d.concluidaPor).toBeNull();
    expect(await comSessao(f.u.id, () => desfazerConclusao(id))).toEqual({ ok: false, erro: "A tarefa não está concluída" });
  });

  it("editar com atualizadoEmEsperado; velho → conflito", async () => {
    const id = await criar(f.u.id);
    const t = await linha(f.u.id, id);
    const r = await comSessao(f.u.id, () =>
      editarTarefa(id, { ...trem, item: "Trem Roma > Florença", prazo: { tipo: "data", data: "2027-07-01" }, responsavel: null, observacao: "Assentos juntos" }, t.atualizadoEm),
    );
    expect(r).toEqual({ ok: true, id });
    const e = await linha(f.u.id, id);
    expect(e).toMatchObject({ item: "Trem Roma > Florença", rotuloPrazo: "Até 01/07/2027", responsavel: null, observacao: "Assentos juntos" });
    expect(await comSessao(f.u.id, () => editarTarefa(id, trem, t.atualizadoEm))).toEqual({
      ok: false,
      conflito: true,
      erro: "Esta tarefa foi alterada por outra pessoa. Recarregue a página.",
    });
  });

  it("concluir e desfazer não invalidam um formulário de edição aberto", async () => {
    const id = await criar(f.u.id);
    const t = await linha(f.u.id, id);
    await comSessao(f.u.id, () => concluirTarefa(id));
    await comSessao(f.u.id, () => desfazerConclusao(id));
    await comSessao(f.u.id, () => concluirTarefa(id));
    expect(await comSessao(f.u.id, () => editarTarefa(id, { ...trem, item: "Trem 2" }, t.atualizadoEm))).toEqual({ ok: true, id });
    expect((await linha(f.u.id, id)).concluidaPor).toBe("Teste consultor");
  });

  it("excluída some da tela e não aceita mais ações", async () => {
    const id = await criar(f.u.id);
    expect(await comSessao(f.u.id, () => excluirTarefa(id))).toEqual({ ok: true });
    expect((await comSessao(f.u.id, () => tarefasDaViagem(f.viagemId)))!.tarefas.some((t) => t.id === id)).toBe(false);
    expect(await comSessao(f.u.id, () => concluirTarefa(id))).toEqual({ ok: false, erro: "Tarefa não encontrada" });
    expect(await comSessao(f.u.id, () => excluirTarefa(id))).toEqual({ ok: false, erro: "Tarefa não encontrada" });
  });

  it("auditoria: criar, concluir e excluir em 'tarefas'", async () => {
    const id = await criar(f.u.id);
    await comSessao(f.u.id, () => concluirTarefa(id));
    await comSessao(f.u.id, () => excluirTarefa(id));
    const aud = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "tarefas"), eq(auditoria.registroId, id)));
    const criar1 = aud.find((a) => a.acao === "criar")!;
    expect(criar1.depois).toMatchObject({ item: "Trem Veneza > Florença", customerCare: true });
    const concluir = aud.find((a) => a.acao === "alterar")!;
    expect(concluir.antes).toMatchObject({ concluidaEm: null, concluidaPor: null });
    expect(concluir.depois).toMatchObject({ concluidaPor: f.u.id });
    const excluir = aud.find((a) => a.acao === "excluir")!;
    expect(excluir.antes).toMatchObject({ item: "Trem Veneza > Florença" });
    expect(excluir.depois).toHaveProperty("excluidoEm");
  });
});

describe("lista entre viagens", () => {
  it("minhas abertas = só as do usuário; vencidas pelo prazo efetivo", async () => {
    const op = await criarUsuarioTeste("operacional");
    const dela = await criar(f.u.id, { ...trem, responsavel: { tipo: "usuario", id: op.id } });
    const minhas = await comSessao(f.u.id, () => listarTarefas({ visao: "minhas", situacao: "abertas" }));
    expect(minhas).toHaveLength(5);
    expect(minhas.every((t) => t.responsavel?.tipo === "usuario" && t.responsavel.id === f.u.id)).toBe(true);
    expect(minhas[0].viagem).toMatchObject({ id: f.viagemId, destino: "Itália", inicio: "2027-08-14" });
    expect(minhas[0].viagem.codigo).toMatch(/^ECL-\d{4}-01$/);
    // ordem por prazo efetivo: +1, +1, +2, +7, +7
    expect(minhas.map((t) => t.prazoEfetivo)).toEqual([...minhas.map((t) => t.prazoEfetivo)].sort());

    const delaLista = await comSessao(op.id, () => listarTarefas({ visao: "minhas", situacao: "abertas" }));
    expect(delaLista.map((t) => t.id)).toEqual([dela]);

    const ontem = somarDias(hojeEmCuiaba(), -1);
    const vencida = await criar(f.u.id, { ...trem, prazo: { tipo: "data", data: ontem }, responsavel: { tipo: "usuario", id: f.u.id } });
    const vencidas = await comSessao(f.u.id, () => listarTarefas({ visao: "minhas", situacao: "vencidas" }));
    expect(vencidas.map((t) => t.id)).toEqual([vencida]);
    expect(vencidas[0].situacao).toBe("vencida");
    const abertas = await comSessao(f.u.id, () => listarTarefas({ visao: "minhas", situacao: "abertas" }));
    expect(abertas[0].id).toBe(vencida);
  });

  it("todas, por responsável, concluídas e busca pela viagem", async () => {
    const cc = await criar(f.u.id);
    const ninguem = await criar(f.u.id, { ...trem, prazo: null, responsavel: null });
    const todas = await comSessao(f.u.id, () => listarTarefas({ visao: "todas", situacao: "abertas" }));
    expect(todas).toHaveLength(7);
    expect(todas.at(-1)!.id).toBe(ninguem); // sem prazo por último
    expect((await comSessao(f.u.id, () => listarTarefas({ visao: "todas", responsavel: "customer_care", situacao: "abertas" }))).map((t) => t.id)).toEqual([cc]);
    expect((await comSessao(f.u.id, () => listarTarefas({ visao: "todas", responsavel: "ninguem", situacao: "abertas" }))).map((t) => t.id)).toEqual([ninguem]);
    expect(await comSessao(f.u.id, () => listarTarefas({ visao: "todas", responsavel: f.u.id, situacao: "abertas" }))).toHaveLength(5);
    await comSessao(f.u.id, () => concluirTarefa(cc));
    const concluidas = await comSessao(f.u.id, () => listarTarefas({ visao: "todas", situacao: "concluidas" }));
    expect(concluidas.map((t) => t.id)).toEqual([cc]);
    expect(concluidas[0].concluidaPor).toBe("Teste consultor");
    const codigo = todas[0].viagem.codigo;
    expect(await comSessao(f.u.id, () => listarTarefas({ visao: "todas", situacao: "abertas", viagem: codigo.toLowerCase() }))).toHaveLength(6);
    expect(await comSessao(f.u.id, () => listarTarefas({ visao: "todas", situacao: "abertas", viagem: "ECL-9999" }))).toHaveLength(0);
  });
});

describe("Review Focus 5: todos os perfis e nada estratégico", () => {
  it("consultor, operacional e fin_estrategico leem e criam; o JSON não traz valores", async () => {
    for (const perfil of ["consultor", "operacional", "fin_estrategico", "fin_operacional", "diretor"] as const) {
      const x = await criarUsuarioTeste(perfil);
      await criar(x.id, { ...trem, item: `Tarefa de ${perfil}` });
      const r = await comSessao(x.id, () => tarefasDaViagem(f.viagemId));
      expect(r!.tarefas.some((t) => t.item === `Tarefa de ${perfil}`)).toBe(true);
      const l = await comSessao(x.id, () => listarTarefas({ visao: "todas", situacao: "abertas" }));
      for (const json of [JSON.stringify(r), JSON.stringify(l)]) {
        for (const proibido of ["valorBrl", "valorOriginal", "margem", "custo", "comissao"]) expect(json).not.toContain(`"${proibido}":`);
      }
    }
  });

  it("sem sessão: sem permissão", async () => {
    expect(await criarTarefa(f.viagemId, trem)).toEqual({ ok: false, erro: "Sem permissão" });
    await expect(tarefasDaViagem(f.viagemId)).rejects.toThrow();
  });
});
