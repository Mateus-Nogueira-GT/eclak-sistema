import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { SETORES_DO_PERFIL, type AvisoCentral } from "@/domain/avisos";
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarReais } from "@/domain/dinheiro";
import type { Perfil } from "@/domain/perfis";
import { somarDias } from "@/domain/venda";
import { contarAvisos, criarComunicado, desfazerDispensa, dispensarAviso, resolverComunicado } from "@/server/actions/avisos";
import { confirmarCaixa, salvarCaixa } from "@/server/actions/caixa-experiencia";
import { enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { salvarCliente } from "@/server/actions/clientes";
import { gerarDaily } from "@/server/actions/dailies";
import { registrarEntrada, salvarProduto } from "@/server/actions/estoque";
import { criarLancamento } from "@/server/actions/financeiro";
import { marcarPedido, registrarReembolso } from "@/server/actions/reembolsos";
import { aprovarRoteiro, criarRoteiro } from "@/server/actions/roteiros";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { concluirTarefa, criarTarefa } from "@/server/actions/tarefas";
import { avisosComerciais, avisosDaCentral, avisosDeEstoque, avisosDeReembolsos, avisosDispensados, avisosOperacionais } from "@/server/avisos";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import { auditoria, avisosComunicados, dailies, avisosDispensados as tabelaDispensados, categoriasFinanceiras, parcelasReceber, pessoas, reembolsos, viagemPassageiros, viagens } from "@/server/db/schema";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { cotacao, item, souza, vendida, type Fixture } from "../helpers/venda";

const HOJE = hojeEmCuiaba();
const AMANHA = somarDias(HOJE, 1);
const br = (iso: string) => iso.split("-").reverse().join("/");
const DIA_MS = 24 * 60 * 60 * 1000;

const ok = <T extends { ok: boolean; erro?: string }>(r: T): T => {
  if (!r.ok) throw new Error(r.erro);
  return r;
};
const id = (r: { ok: boolean; id?: string; erro?: string }) => {
  if (!r.ok || !r.id) throw new Error(r.ok ? "sem id" : r.erro);
  return r.id;
};

type Usuarios = Record<Perfil, { id: string }>;

/** Os cinco perfis: consultor, diretor e financeiro operacional da fixture; financeiro estratégico e operacional novos. */
async function usuariosDa(x: Fixture): Promise<Usuarios> {
  return {
    diretor: x.d,
    consultor: x.u,
    fin_operacional: x.fin,
    fin_estrategico: await criarUsuarioTeste("fin_estrategico"),
    operacional: await criarUsuarioTeste("operacional"),
  };
}

const central = (uid: string, filtro: Parameters<typeof avisosDaCentral>[0] = {}) => comSessao(uid, () => avisosDaCentral(filtro));
const abertos = async (uid: string, filtro: Parameters<typeof avisosDaCentral>[0] = {}) => (await central(uid, filtro)).abertos;
const doTipo = async (uid: string, tipo: AvisoCentral["tipo"]) => (await abertos(uid)).filter((a) => a.tipo === tipo);
const chaves = async (uid: string) => (await abertos(uid)).map((a) => a.chave);

async function moverViagem(viagemId: string, inicio: string, fim: string) {
  await db.update(viagens).set({ inicio, fim }).where(eq(viagens.id, viagemId));
}

async function produto(fin: string, nome: string, minimoRs: number) {
  return id(await comSessao(fin, () => salvarProduto({ nome, uso: "caixa_experiencia", minimoMt: 0, minimoRs })));
}

async function entrada(fin: string, produtoId: string, quantidade: number) {
  return id(
    await comSessao(fin, () =>
      registrarEntrada({
        produtoId,
        filial: "RS",
        quantidade,
        valorUnitario: "10,00",
        fornecedorId: "",
        fornecedorTexto: "Papelaria do Zé",
        vencimento: somarDias(HOJE, 30),
        forma: "PIX",
        cartaoId: "",
      }),
    ),
  );
}

async function tarefaVencida(uid: string, viagemId: string, item: string, prazo: string) {
  return id(await comSessao(uid, () => criarTarefa(viagemId, { categoria: "conferir", item, prazo: { tipo: "data", data: prazo } })));
}

/** Uma conta a pagar de 9 milhões vencida ontem: o fluxo de caixa fica negativo (aviso de caixa, não dispensável). */
async function caixaNegativo(fin: string) {
  const [aluguel] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, "Aluguel"));
  ok(
    await comSessao(fin, () =>
      criarLancamento({
        lado: "pagar",
        descricao: "Conta da empresa",
        fornecedorId: "",
        clienteId: "",
        pessoaTexto: "Fornecedor local",
        categoriaId: aluguel.id,
        centro: "MT",
        competencia: somarDias(HOJE, -1).slice(0, 7),
        emissao: somarDias(HOJE, -1),
        vencimento: somarDias(HOJE, -1),
        valor: "9.000.000,00",
        forma: "PIX",
        contaBancariaId: "",
        observacao: "",
        repeticao: { tipo: "unica" },
      }),
    ),
  );
}

/** Um orçamento novo enviado para aprovação (um pedido aguardando). */
async function pedidoAguardando(uid: string) {
  const c = await comSessao(uid, () => salvarCliente(souza));
  if (!c.ok) throw new Error(c.erro);
  const passageiros = (await comSessao(uid, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
  const o = await comSessao(uid, () => criarOrcamento({ clienteId: c.id, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros }));
  if (!o.ok) throw new Error(o.erro);
  await cotacao(uid, await item(uid, o.id, { servico: "Belém", cidade: "Lisboa" }), { valor: "900,00" });
  ok(await comSessao(uid, () => enviarParaAprovacao(o.id, { forma: { tipo: "pix", parcelas: 1 }, alteracao: "Primeira versão" })));
}

const reembolso = (x: Fixture, extra: Record<string, unknown> = {}) => ({
  viagemId: x.viagemId,
  contaPagarId: x.hotel.id,
  servico: "Palazzo Barocci",
  ocorridoEm: HOJE,
  ocorrido: "O hotel cancelou uma diária na chegada.",
  valorCobrar: "385,00",
  valorDevolver: "411,45",
  formaDevolucao: "pix",
  prazoCliente: somarDias(HOJE, 10),
  previstoFornecedor: somarDias(HOJE, 20),
  ...extra,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("quem pode chamar cada função de avisos", () => {
  beforeEach(limparBanco);

  it("cada função recusa os perfis que não recebem o setor dela", async () => {
    const casos: [() => Promise<unknown>, Perfil[]][] = [
      [avisosOperacionais, ["fin_operacional", "fin_estrategico"]],
      [avisosComerciais, ["operacional", "fin_operacional", "fin_estrategico"]],
      [avisosDeEstoque, ["consultor", "operacional"]],
      [avisosDeReembolsos, ["consultor", "operacional"]],
    ];
    for (const [fn, recusados] of casos) {
      for (const perfil of recusados) {
        const u = await criarUsuarioTeste(perfil);
        await expect(comSessao(u.id, fn)).rejects.toBeInstanceOf(ErroAcesso);
      }
    }
    const d = await criarUsuarioTeste("diretor");
    for (const [fn] of casos) await expect(comSessao(d.id, fn)).resolves.toEqual([]);
  }, 60_000);
});

describe("avisos novos da central", () => {
  let x: Fixture;
  let us: Usuarios;

  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
    us = await usuariosDa(x);
  });

  it("tarefa_vencida: uma linha por viagem com a contagem; some quando as tarefas são concluídas", async () => {
    const t1 = await tarefaVencida(x.u.id, x.viagemId, "Conferir vouchers", somarDias(HOJE, -3));
    const t2 = await tarefaVencida(x.u.id, x.viagemId, "Conferir seguro", somarDias(HOJE, -1));
    await tarefaVencida(x.u.id, x.viagemId, "Vence hoje", HOJE);
    let [a] = await doTipo(us.operacional.id, "tarefa_vencida");
    expect(a).toEqual({
      chave: `tarefa_vencida:${x.viagemId}`,
      tipo: "tarefa_vencida",
      titulo: "Tarefas vencidas na ECL-0001-01",
      detalhe: `Família Souza (Itália): 2 tarefas vencidas, a mais antiga de ${br(somarDias(HOJE, -3))}`,
      passo: "Abrir as tarefas da viagem",
      setor: "Operacional",
      href: `/viagens/${x.viagemId}/tarefas`,
      dispensavel: true,
    });
    ok(await comSessao(x.u.id, () => concluirTarefa(t1)));
    [a] = await doTipo(us.operacional.id, "tarefa_vencida");
    expect(a.detalhe).toBe(`Família Souza (Itália): 1 tarefa vencida, a mais antiga de ${br(somarDias(HOJE, -1))}`);
    ok(await comSessao(x.u.id, () => concluirTarefa(t2)));
    expect(await doTipo(us.operacional.id, "tarefa_vencida")).toEqual([]);
  }, 60_000);

  it("daily_a_gerar: hoje e amanhã sem linha (ou pendente), roteiro aprovado; some ao gerar", async () => {
    await moverViagem(x.viagemId, somarDias(HOJE, -2), somarDias(HOJE, 5));
    const r = await comSessao(us.operacional.id, () => criarRoteiro(x.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
    if (!r.ok || !("id" in r)) throw new Error(r.ok ? "sem id" : r.erro);
    // Roteiro em rascunho: nada.
    expect(await doTipo(us.operacional.id, "daily_a_gerar")).toEqual([]);
    ok(await comSessao(us.operacional.id, () => aprovarRoteiro(r.id)));
    let avisos = await doTipo(us.operacional.id, "daily_a_gerar");
    expect(avisos.map((a) => [a.chave, a.titulo, a.detalhe, a.href, a.passo, a.setor])).toEqual([
      [`daily_a_gerar:${x.viagemId}:${HOJE}`, `Daily de ${br(HOJE)} a gerar na ECL-0001-01`, `Família Souza (Itália): daily de ${br(HOJE)}`, `/viagens/${x.viagemId}/dailies`, "Gerar o daily", "Operacional"],
      [`daily_a_gerar:${x.viagemId}:${AMANHA}`, `Daily de ${br(AMANHA)} a gerar na ECL-0001-01`, `Família Souza (Itália): daily de ${br(AMANHA)}`, `/viagens/${x.viagemId}/dailies`, "Gerar o daily", "Operacional"],
    ]);
    // Linha de amanhã pendente (sem texto) continua a gerar.
    await db.insert(dailies).values({ roteiroId: r.id, data: AMANHA, estado: "pendente" });
    expect((await doTipo(us.operacional.id, "daily_a_gerar")).map((a) => a.chave)).toEqual([`daily_a_gerar:${x.viagemId}:${HOJE}`, `daily_a_gerar:${x.viagemId}:${AMANHA}`]);
    ok(await comSessao(us.operacional.id, () => gerarDaily(r.id, HOJE)));
    avisos = await doTipo(us.operacional.id, "daily_a_gerar");
    expect(avisos.map((a) => a.chave)).toEqual([`daily_a_gerar:${x.viagemId}:${AMANHA}`]);
  }, 60_000);

  it("aniversario: passageiro faz aniversário durante a viagem (nos próximos 60 dias); Comercial: consultor e diretor", async () => {
    const inicio = somarDias(HOJE, 30);
    await moverViagem(x.viagemId, inicio, somarDias(inicio, 6));
    const [julia] = await db
      .select({ id: pessoas.id })
      .from(viagemPassageiros)
      .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
      .where(and(eq(viagemPassageiros.viagemId, x.viagemId), eq(pessoas.nome, "Júlia Souza")));
    const aniversario = somarDias(inicio, 2);
    await db.update(pessoas).set({ nascimento: `1990${aniversario.slice(4)}` }).where(eq(pessoas.id, julia.id));
    const idade = Number(aniversario.slice(0, 4)) - 1990;
    const [a] = await doTipo(us.consultor.id, "aniversario");
    expect(a).toEqual({
      chave: `aniversario:${x.viagemId}:${julia.id}`,
      tipo: "aniversario",
      titulo: "Aniversário de Júlia Souza na ECL-0001-01",
      detalhe: `Júlia Souza faz ${idade} anos em ${br(aniversario)}, no 3º dia da viagem`,
      passo: "Combinar a surpresa e incluir no roteiro",
      setor: "Comercial",
      href: `/viagens/${x.viagemId}/roteiro`,
      dispensavel: true,
    });
    expect((await doTipo(us.diretor.id, "aniversario")).map((v) => v.chave)).toEqual([a.chave]);
    expect(await doTipo(us.operacional.id, "aniversario")).toEqual([]);
    // Viagem em andamento (começou anteontem) com o aniversário amanhã: aparece.
    await moverViagem(x.viagemId, somarDias(HOJE, -2), somarDias(HOJE, 4));
    await db.update(pessoas).set({ nascimento: `1990${AMANHA.slice(4)}` }).where(eq(pessoas.id, julia.id));
    expect((await doTipo(us.consultor.id, "aniversario")).map((v) => v.detalhe)).toEqual([
      `Júlia Souza faz ${Number(AMANHA.slice(0, 4)) - 1990} anos em ${br(AMANHA)}, no 4º dia da viagem`,
    ]);
    // A viagem passa a começar daqui a 70 dias: fora da janela.
    await moverViagem(x.viagemId, somarDias(HOJE, 70), somarDias(HOJE, 76));
    expect(await doTipo(us.consultor.id, "aniversario")).toEqual([]);
  }, 60_000);

  it("estoque_minimo: produto abaixo do mínimo por filial; some ao repor; só o Financeiro", async () => {
    const p = await produto(x.fin.id, "Vinho Malbec", 5);
    await produto(x.fin.id, "Caneta", 0);
    // Sem saldo nenhum: 0 de 5 em RS. MT tem mínimo 0: nada.
    expect((await doTipo(x.fin.id, "estoque_minimo")).map((a) => [a.chave, a.titulo, a.detalhe, a.href, a.setor])).toEqual([
      [`estoque_minimo:${p}:RS`, "Vinho Malbec abaixo do mínimo em RS", "0 em estoque, mínimo de 5", "/financeiro/estoque?filial=RS&abaixo=1", "Financeiro"],
    ]);
    await entrada(x.fin.id, p, 3);
    expect((await doTipo(x.fin.id, "estoque_minimo")).map((a) => a.detalhe)).toEqual(["3 em estoque, mínimo de 5"]);
    await entrada(x.fin.id, p, 2);
    expect(await doTipo(x.fin.id, "estoque_minimo")).toEqual([]);
  }, 60_000);

  it("caixa_a_montar: embarque em até 30 dias sem caixa confirmada, sem valores; some ao confirmar", async () => {
    const inicio = somarDias(HOJE, 10);
    await moverViagem(x.viagemId, inicio, somarDias(inicio, 6));
    const [a] = await doTipo(us.operacional.id, "caixa_a_montar");
    expect(a).toEqual({
      chave: `caixa_a_montar:${x.viagemId}`,
      tipo: "caixa_a_montar",
      titulo: "Caixa de experiência a montar na ECL-0001-01",
      detalhe: `Família Souza (Itália): embarque em ${br(inicio)}, sem caixa confirmada`,
      passo: "Montar a caixa na viagem",
      setor: "Operacional",
      href: `/viagens/${x.viagemId}#caixa-experiencia`,
      dispensavel: true,
    });
    const p = await produto(x.fin.id, "Vinho Malbec", 0);
    await entrada(x.fin.id, p, 3);
    ok(await comSessao(x.u.id, () => salvarCaixa(x.viagemId, [{ produtoId: p, quantidade: 1 }])));
    // Rascunho ainda não basta.
    expect(await doTipo(us.operacional.id, "caixa_a_montar")).toHaveLength(1);
    ok(await comSessao(x.u.id, () => confirmarCaixa(x.viagemId)));
    expect(await doTipo(us.operacional.id, "caixa_a_montar")).toEqual([]);
    // Embarque daqui a 31 dias sem caixa: fora da janela.
    const outra = await vendida();
    await moverViagem(outra.viagemId, somarDias(HOJE, 31), somarDias(HOJE, 40));
    expect(await doTipo(us.operacional.id, "caixa_a_montar")).toEqual([]);
  }, 90_000);

  it("os três de reembolso: pedir, cobrar o fornecedor (previsto vencido) e reembolsar o cliente (prazo em até 3 dias)", async () => {
    const casoId = id(await comSessao(x.fin.id, () => registrarReembolso(reembolso(x))));
    const tipos = async () => (await abertos(x.fin.id)).filter((a) => a.tipo.startsWith("reembolso_"));
    let r = await tipos();
    expect(r).toEqual([
      {
        chave: `reembolso_pedir:${casoId}`,
        tipo: "reembolso_pedir",
        titulo: "Reembolso a pedir ao fornecedor: ECL-0001-01",
        detalhe: `Palazzo Barocci: ${formatarReais(38500n)} a cobrar de Palazzo Hotels`,
        passo: "Pedir o reembolso ao fornecedor",
        setor: "Financeiro",
        href: "/financeiro/reembolsos",
        dispensavel: true,
      },
    ]);
    ok(await comSessao(x.fin.id, () => marcarPedido(casoId, { pedidoEm: HOJE, protocolo: "PZ-123" })));
    expect(await tipos()).toEqual([]);
    // Previsto do fornecedor vencido e prazo do cliente em 3 dias.
    await db.update(reembolsos).set({ previstoFornecedor: somarDias(HOJE, -1), prazoCliente: somarDias(HOJE, 3) }).where(eq(reembolsos.id, casoId));
    r = await tipos();
    expect(r.map((a) => [a.chave, a.titulo, a.detalhe, a.passo])).toEqual([
      [`reembolso_fornecedor:${casoId}`, "Fornecedor não pagou o reembolso: ECL-0001-01", `Palazzo Barocci: ${formatarReais(38500n)} a receber de Palazzo Hotels, previsto para ${br(somarDias(HOJE, -1))}`, "Cobrar o fornecedor"],
      [`reembolso_cliente:${casoId}`, "Reembolsar o cliente: ECL-0001-01", `Família Souza: ${formatarReais(41145n)} a devolver por PIX, prazo ${br(somarDias(HOJE, 3))}`, "Reembolsar o cliente"],
    ]);
    // Prazo do cliente em 4 dias: sai.
    await db.update(reembolsos).set({ prazoCliente: somarDias(HOJE, 4) }).where(eq(reembolsos.id, casoId));
    expect((await tipos()).map((a) => a.tipo)).toEqual(["reembolso_fornecedor"]);
  }, 60_000);

  it("cada perfil recebe só os seus setores; consultor e operacional sem Gestão, Financeiro nem valores", async () => {
    await caixaNegativo(x.fin.id);
    await db.update(parcelasReceber).set({ vencimento: somarDias(HOJE, -3) }).where(eq(parcelasReceber.id, x.parcelas[0].id));
    const inicio = somarDias(HOJE, 10);
    await moverViagem(x.viagemId, inicio, somarDias(inicio, 6));
    await tarefaVencida(x.u.id, x.viagemId, "Conferir vouchers", somarDias(HOJE, -3));
    await db.update(pessoas).set({ nascimento: `1990${somarDias(inicio, 1).slice(4)}` }).where(eq(pessoas.nome, "Júlia Souza"));
    await produto(x.fin.id, "Vinho Malbec", 5);
    await comSessao(x.fin.id, () => registrarReembolso(reembolso(x)));

    const setores: Record<Perfil, string[]> = {} as Record<Perfil, string[]>;
    for (const perfil of Object.keys(us) as Perfil[]) {
      const lista = await abertos(us[perfil].id);
      for (const a of lista) expect(SETORES_DO_PERFIL[perfil]).toContain(a.setor);
      setores[perfil] = [...new Set(lista.map((a) => a.setor))].sort();
      if (perfil === "consultor" || perfil === "operacional") {
        for (const a of lista) expect(`${a.titulo} ${a.detalhe}`).not.toMatch(/R\$/);
      }
    }
    expect(setores).toEqual({
      diretor: ["Comercial", "Financeiro", "Gestão", "Operacional"],
      fin_estrategico: ["Financeiro", "Gestão"],
      fin_operacional: ["Financeiro"],
      consultor: ["Comercial", "Operacional"],
      operacional: ["Operacional"],
    });
    // O caixa negativo não é dispensável.
    expect((await abertos(us.diretor.id)).find((a) => a.chave === "caixa")).toMatchObject({ dispensavel: false });
  }, 90_000);

  it("filtro do Diretor por setor e 'todos'; para os outros o filtro é ignorado", async () => {
    await db.update(parcelasReceber).set({ vencimento: somarDias(HOJE, -3) }).where(eq(parcelasReceber.id, x.parcelas[0].id));
    await tarefaVencida(x.u.id, x.viagemId, "Conferir vouchers", somarDias(HOJE, -3));
    ok(await comSessao(x.u.id, () => criarComunicado({ setor: "Operacional", texto: "Conferir os vouchers da semana" })));
    ok(await comSessao(x.u.id, () => criarComunicado({ setor: "Financeiro", texto: "Nota fiscal do hotel chegou" })));

    const op = await central(us.diretor.id, { setor: "Operacional" });
    expect(op.abertos.map((a) => a.chave)).toEqual([`tarefa_vencida:${x.viagemId}`]);
    expect(op.comunicados.map((c) => c.setor)).toEqual(["Operacional"]);
    const todos = await central(us.diretor.id, { setor: "todos" });
    expect(todos.abertos.map((a) => a.chave)).toEqual(expect.arrayContaining(["parcela", `tarefa_vencida:${x.viagemId}`]));
    expect(todos.comunicados.map((c) => c.setor).sort()).toEqual(["Financeiro", "Operacional"]);
    expect(await central(us.diretor.id)).toEqual(todos);

    const operacional = await central(us.operacional.id, { setor: "Financeiro" });
    expect(operacional.abertos.map((a) => a.chave)).toEqual([`tarefa_vencida:${x.viagemId}`]);
    expect(operacional.comunicados.map((c) => c.setor)).toEqual(["Operacional"]);
  }, 60_000);
});

describe("dispensa", () => {
  let x: Fixture;
  let us: Usuarios;
  const JUSTIFICATIVA = "Cliente avisou que paga na sexta";

  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
    us = await usuariosDa(x);
    await db.update(parcelasReceber).set({ vencimento: somarDias(HOJE, -3) }).where(eq(parcelasReceber.id, x.parcelas[0].id));
  });

  it("grava tipo, título, detalhe, quem e quando, com auditoria; some para todos os que recebem", async () => {
    const [parcela] = await doTipo(x.fin.id, "parcela");
    expect(await comSessao(x.fin.id, () => dispensarAviso("parcela", "curta"))).toMatchObject({ ok: false, campos: { justificativa: "Escreva a justificativa (10 a 500 caracteres)" } });
    expect(await comSessao(x.fin.id, () => dispensarAviso("parcela", "a".repeat(501)))).toMatchObject({ ok: false });
    expect(await db.select().from(tabelaDispensados)).toEqual([]);

    const antes = new Date();
    expect(await comSessao(x.fin.id, () => dispensarAviso("parcela", `  ${JUSTIFICATIVA}  `))).toEqual({ ok: true });
    const [d] = await db.select().from(tabelaDispensados);
    expect(d).toMatchObject({ chave: "parcela", tipo: "parcela", titulo: parcela.titulo, detalhe: parcela.detalhe, usuarioId: x.fin.id, justificativa: JUSTIFICATIVA });
    expect(d.criadoEm.getTime()).toBeGreaterThanOrEqual(antes.getTime() - 1000);
    const [aud] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "avisos_dispensados"), eq(auditoria.registroId, d.id)));
    expect(aud).toMatchObject({ usuarioId: x.fin.id, acao: "criar" });

    for (const perfil of ["diretor", "fin_estrategico", "fin_operacional"] as const) expect(await chaves(us[perfil].id)).not.toContain("parcela");

    // Aba "Dispensados": quem recebe o Financeiro vê; o consultor não.
    const lista = await comSessao(us.diretor.id, () => avisosDispensados());
    expect(lista).toMatchObject([{ id: d.id, chave: "parcela", tipo: "parcela", setor: "Financeiro", titulo: parcela.titulo, detalhe: parcela.detalhe, justificativa: JUSTIFICATIVA, por: expect.any(String), podeDesfazer: true }]);
    expect(await comSessao(us.fin_estrategico.id, () => avisosDispensados())).toMatchObject([{ id: d.id, podeDesfazer: false }]);
    expect(await comSessao(us.consultor.id, () => avisosDispensados())).toEqual([]);
  }, 60_000);

  it("caixa negativo não pode ser dispensado; chave que a pessoa não recebe → Aviso não encontrado", async () => {
    await caixaNegativo(x.fin.id);
    expect(await comSessao(us.diretor.id, () => dispensarAviso("caixa", JUSTIFICATIVA))).toEqual({ ok: false, erro: "Este aviso não pode ser dispensado" });
    // O fin_operacional não recebe Gestão; o consultor não recebe Financeiro; chave inexistente.
    expect(await comSessao(x.fin.id, () => dispensarAviso("caixa", JUSTIFICATIVA))).toEqual({ ok: false, erro: "Aviso não encontrado" });
    expect(await comSessao(us.consultor.id, () => dispensarAviso("parcela", JUSTIFICATIVA))).toEqual({ ok: false, erro: "Aviso não encontrado" });
    expect(await comSessao(x.fin.id, () => dispensarAviso("margem:qualquer", JUSTIFICATIVA))).toEqual({ ok: false, erro: "Aviso não encontrado" });
    expect(await db.select().from(tabelaDispensados)).toEqual([]);
  }, 60_000);

  it("Review Focus 5: o detalhe mudou (mais uma parcela vencida) ou a dispensa tem 31 dias: o aviso volta", async () => {
    ok(await comSessao(x.fin.id, () => dispensarAviso("parcela", JUSTIFICATIVA)));
    expect(await chaves(x.fin.id)).not.toContain("parcela");
    // A segunda parcela também vence: título e detalhe mudam (2 parcelas, outro total).
    await db.update(parcelasReceber).set({ vencimento: somarDias(HOJE, -2) }).where(eq(parcelasReceber.id, x.parcelas[1].id));
    const [voltou] = await doTipo(x.fin.id, "parcela");
    expect(voltou.titulo).toBe("2 parcelas de cliente vencidas");

    // Volta para uma parcela: a dispensa vale de novo; com 31 dias, não vale.
    await db.update(parcelasReceber).set({ vencimento: somarDias(HOJE, 30) }).where(eq(parcelasReceber.id, x.parcelas[1].id));
    expect(await chaves(x.fin.id)).not.toContain("parcela");
    await db.update(tabelaDispensados).set({ criadoEm: new Date(Date.now() - 29 * DIA_MS) });
    expect(await chaves(x.fin.id)).not.toContain("parcela");
    await db.update(tabelaDispensados).set({ criadoEm: new Date(Date.now() - 31 * DIA_MS) });
    expect(await chaves(x.fin.id)).toContain("parcela");
  }, 60_000);

  it("dispensa vale por título e detalhe: aprovação com 1 pedido dispensada volta com 2 pedidos", async () => {
    await pedidoAguardando(x.u.id);
    const [aprovacao] = await doTipo(us.diretor.id, "aprovacao");
    expect(aprovacao).toMatchObject({ chave: "aprovacao", titulo: "1 pedido aguardando aprovação", detalhe: "Decidir em Aprovações" });
    ok(await comSessao(us.diretor.id, () => dispensarAviso("aprovacao", JUSTIFICATIVA)));
    expect(await doTipo(us.diretor.id, "aprovacao")).toEqual([]);
    await pedidoAguardando(x.u.id);
    expect((await doTipo(us.diretor.id, "aprovacao")).map((a) => a.titulo)).toEqual(["2 pedidos aguardando aprovação"]);
  }, 60_000);

  it("aba Dispensados: só os últimos 90 dias", async () => {
    ok(await comSessao(x.fin.id, () => dispensarAviso("parcela", JUSTIFICATIVA)));
    await db.update(tabelaDispensados).set({ criadoEm: new Date(Date.now() - 89 * DIA_MS) });
    expect(await comSessao(x.fin.id, () => avisosDispensados())).toHaveLength(1);
    await db.update(tabelaDispensados).set({ criadoEm: new Date(Date.now() - 91 * DIA_MS) });
    expect(await comSessao(x.fin.id, () => avisosDispensados())).toEqual([]);
  }, 60_000);

  it("desfazer: quem dispensou ou o Diretor; outra pessoa é recusada", async () => {
    ok(await comSessao(x.fin.id, () => dispensarAviso("parcela", JUSTIFICATIVA)));
    let [d] = await db.select().from(tabelaDispensados);
    expect(await comSessao(us.fin_estrategico.id, () => desfazerDispensa(d.id))).toEqual({ ok: false, erro: "Só quem dispensou ou o Diretor pode desfazer a dispensa" });
    expect(await comSessao(us.consultor.id, () => desfazerDispensa(d.id))).toEqual({ ok: false, erro: "Dispensa não encontrada" });
    expect(await comSessao(x.fin.id, () => desfazerDispensa("nao-e-uuid"))).toEqual({ ok: false, erro: "Dispensa não encontrada" });
    expect(await chaves(x.fin.id)).not.toContain("parcela");
    expect(await comSessao(x.fin.id, () => desfazerDispensa(d.id))).toEqual({ ok: true });
    expect(await chaves(x.fin.id)).toContain("parcela");
    const [aud] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "avisos_dispensados"), eq(auditoria.registroId, d.id), eq(auditoria.acao, "excluir")));
    expect(aud).toMatchObject({ usuarioId: x.fin.id, antes: expect.objectContaining({ chave: "parcela" }) });

    ok(await comSessao(x.fin.id, () => dispensarAviso("parcela", JUSTIFICATIVA)));
    [d] = await db.select().from(tabelaDispensados);
    expect(await comSessao(us.diretor.id, () => desfazerDispensa(d.id))).toEqual({ ok: true });
    expect(await db.select().from(tabelaDispensados)).toEqual([]);
  }, 60_000);
});

describe("comunicados e contador", () => {
  let x: Fixture;
  let us: Usuarios;

  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
    us = await usuariosDa(x);
  });

  it("comunicado para Operacional: operacional, consultor e Diretor veem; o financeiro operacional não", async () => {
    expect(await comSessao(x.u.id, () => criarComunicado({ setor: "Vendas", texto: "Oi" }))).toMatchObject({ ok: false, campos: { setor: expect.any(String), texto: expect.any(String) } });
    expect(await comSessao(x.u.id, () => criarComunicado({ setor: "Operacional", texto: "Conferir os vouchers da semana", passo: "Abrir a pasta da viagem" }))).toEqual({ ok: true });
    const [c] = await db.select().from(avisosComunicados);
    expect(c).toMatchObject({ setor: "Operacional", texto: "Conferir os vouchers da semana", passo: "Abrir a pasta da viagem", criadoPor: x.u.id, resolvidoEm: null });
    const [aud] = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "avisos_comunicados"), eq(auditoria.registroId, c.id)));
    expect(aud).toMatchObject({ usuarioId: x.u.id, acao: "criar" });

    const vistos = async (uid: string) => (await central(uid)).comunicados.map((k) => k.id);
    for (const perfil of ["operacional", "consultor", "diretor"] as const) expect(await vistos(us[perfil].id)).toEqual([c.id]);
    for (const perfil of ["fin_operacional", "fin_estrategico"] as const) expect(await vistos(us[perfil].id)).toEqual([]);
    expect((await central(us.operacional.id)).comunicados[0]).toMatchObject({
      id: c.id,
      setor: "Operacional",
      texto: "Conferir os vouchers da semana",
      passo: "Abrir a pasta da viagem",
      por: expect.any(String),
      criadoPor: x.u.id,
    });

    // Resolver: o financeiro (não recebe, não criou) recusado; o operacional resolve; sai das listas.
    expect(await comSessao(x.fin.id, () => resolverComunicado(c.id))).toEqual({ ok: false, erro: "Aviso não encontrado" });
    expect(await comSessao(us.operacional.id, () => resolverComunicado(c.id))).toEqual({ ok: true });
    for (const perfil of ["operacional", "consultor", "diretor"] as const) expect(await vistos(us[perfil].id)).toEqual([]);
    const [resolvido] = await db.select().from(avisosComunicados);
    expect(resolvido).toMatchObject({ resolvidoPor: us.operacional.id, resolvidoEm: expect.any(Date) });
    expect(await comSessao(x.u.id, () => resolverComunicado(c.id))).toEqual({ ok: false, erro: "Este aviso já foi resolvido" });
    const auds = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "avisos_comunicados"), eq(auditoria.registroId, c.id))).orderBy(asc(auditoria.id));
    expect(auds.map((a) => a.acao)).toEqual(["criar", "alterar"]);
  }, 60_000);

  it("quem criou vê e resolve mesmo sem receber o setor", async () => {
    ok(await comSessao(x.u.id, () => criarComunicado({ setor: "Financeiro", texto: "Nota fiscal do hotel chegou" })));
    const [c] = await db.select().from(avisosComunicados);
    // "Para mim" do consultor inclui o que ele criou, mesmo sendo do Financeiro (e conta no contador).
    expect((await central(x.u.id)).comunicados.map((k) => k.id)).toEqual([c.id]);
    expect(await comSessao(x.u.id, () => contarAvisos())).toBe(1);
    // Com o Diretor filtrando um setor, só o setor: o comunicado dele de outro setor não entra.
    ok(await comSessao(us.diretor.id, () => criarComunicado({ setor: "Financeiro", texto: "Reunião de fechamento" })));
    expect((await central(us.diretor.id, { setor: "Operacional" })).comunicados).toEqual([]);
    expect(await comSessao(us.operacional.id, () => resolverComunicado(c.id))).toEqual({ ok: false, erro: "Aviso não encontrado" });
    expect(await comSessao(x.u.id, () => resolverComunicado(c.id))).toEqual({ ok: true });
  }, 60_000);

  it("contarAvisos conta só os 'para mim' (automáticos e comunicados), com cache de 60 s invalidado pelas gravações", async () => {
    await tarefaVencida(x.u.id, x.viagemId, "Conferir vouchers", somarDias(HOJE, -3));
    await db.update(parcelasReceber).set({ vencimento: somarDias(HOJE, -3) }).where(eq(parcelasReceber.id, x.parcelas[0].id));
    ok(await comSessao(x.u.id, () => criarComunicado({ setor: "Financeiro", texto: "Nota fiscal do hotel chegou" })));

    const conta = (uid: string) => comSessao(uid, () => contarAvisos());
    const paraMim = async (uid: string) => {
      const r = await central(uid);
      return r.abertos.length + r.comunicados.length;
    };
    // Operacional: a tarefa vencida (não a parcela, nem o comunicado do Financeiro).
    expect(await conta(us.operacional.id)).toBe(1);
    expect(await conta(x.fin.id)).toBe(await paraMim(x.fin.id));
    expect(await conta(x.fin.id)).toBe(2);

    // Mudança direta no banco: o cache segura por 60 s.
    await db.update(parcelasReceber).set({ vencimento: somarDias(HOJE, 30) }).where(eq(parcelasReceber.id, x.parcelas[0].id));
    expect(await conta(x.fin.id)).toBe(2);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    expect(await conta(x.fin.id)).toBe(1);
    vi.useRealTimers();

    // Uma gravação (comunicado novo) invalida para todos.
    expect(await conta(us.operacional.id)).toBe(1);
    ok(await comSessao(x.fin.id, () => criarComunicado({ setor: "Operacional", texto: "Conferir os vouchers da semana" })));
    expect(await conta(us.operacional.id)).toBe(2);
  }, 60_000);
});
