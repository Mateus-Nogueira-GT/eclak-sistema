import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarReais } from "@/domain/dinheiro";
import { somarDias } from "@/domain/venda";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, comissoes, parcelasReceber, vendas } from "@/server/db/schema";
import { salvarCliente } from "@/server/actions/clientes";
import { importarExtrato } from "@/server/actions/conciliacao";
import { criarLancamento } from "@/server/actions/financeiro";
import { baixarPagamento } from "@/server/actions/financeiro-viagem";
import { salvarRegras } from "@/server/actions/regras";
import { enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { criarOrcamento } from "@/server/actions/viagens";
import { obterCliente } from "@/server/queries/clientes";
import { avisosDeGestao, avisosFinanceiros } from "@/server/avisos";
import { ErroAcesso } from "@/server/auth";
import { obterVisaoGeral } from "@/server/queries/paineis";
import { regrasVigentes } from "@/server/queries/regras";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { contaBancaria, cotacao, item, souza, vendida } from "../helpers/venda";

async function aceite(viagemId: string, data: string) {
  await db.update(vendas).set({ aceiteEm: data }).where(eq(vendas.viagemId, viagemId));
}

async function pedidoAguardando(uid: string) {
  const c = await comSessao(uid, () => salvarCliente(souza));
  if (!c.ok) throw new Error(c.erro);
  const pessoas = (await comSessao(uid, () => obterCliente(c.id)))!.pessoas.map((x) => x.id);
  const o = await comSessao(uid, () => criarOrcamento({ clienteId: c.id, destino: "Portugal", inicio: "2027-05-01", fim: "2027-05-10", passageiros: pessoas }));
  if (!o.ok) throw new Error(o.erro);
  const passeio = await item(uid, o.id, { servico: "Belém", cidade: "Lisboa" });
  await cotacao(uid, passeio, { valor: "900,00" });
  const e = await comSessao(uid, () => enviarParaAprovacao(o.id, { forma: { tipo: "pix", parcelas: 1 }, alteracao: "Primeira versão" }));
  if (!e.ok) throw new Error(e.erro);
}

/** Extrato OFX sintético com uma transação (banco e conta do fixture de conciliação). */
function ofx(data: string, valor: string): string {
  const d = data.replaceAll("-", "");
  return `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nENCODING:USASCII\nCHARSET:1252\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><STMTRS>\n<CURDEF>BRL\n<BANKACCTFROM>\n<BANKID>0001\n<ACCTID>12345-6\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>\n<BANKTRANLIST>\n<DTSTART>20200101\n<DTEND>20991231\n<STMTTRN>\n<TRNTYPE>OTHER\n<DTPOSTED>${d}\n<TRNAMT>${valor}\n<FITID>T1\n<NAME>TARIFA BANCARIA\n</STMTTRN>\n</BANKTRANLIST>\n</STMTRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>\n`;
}

/**
 * Cenário das cinco viagens de `paineis.test.ts` (caixa negativo, 5 margens abaixo da referência, parcela, comissão,
 * contas a pagar, pedido aguardando) acrescido de uma transação de extrato sem par há 9 dias: os sete avisos.
 */
async function cenario() {
  const hoje = hojeEmCuiaba();
  const vs = [];
  for (let n = 0; n < 5; n++) vs.push(await vendida());
  const [a] = vs;
  for (const v of vs) await aceite(v.viagemId, somarDias(hoje, -5));
  const cb = await contaBancaria(a.fin.id);
  expect(await comSessao(a.fin.id, () => baixarPagamento(a.pagPasseio.id, { pagoEm: hoje, valorOriginalPago: "800,00", contaBancariaId: cb }))).toEqual({ ok: true });
  const vig = await comSessao(a.d.id, () => regrasVigentes());
  expect((await comSessao(a.d.id, () => salvarRegras({ ...vig.valores, margemReferenciaPct: "99.000" }))).ok).toBe(true);
  await db.update(parcelasReceber).set({ vencimento: somarDias(hoje, -3) }).where(eq(parcelasReceber.id, a.parcelas[0].id));
  await db.update(comissoes).set({ previstaPara: somarDias(hoje, -3) }).where(eq(comissoes.id, a.comissao.id));
  const [aluguel] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, "Aluguel"));
  const l = await comSessao(a.fin.id, () =>
    criarLancamento({
      lado: "pagar",
      descricao: "Conta da empresa",
      fornecedorId: "",
      clienteId: "",
      pessoaTexto: "Fornecedor local",
      categoriaId: aluguel.id,
      centro: "MT",
      competencia: somarDias(hoje, -1).slice(0, 7),
      emissao: somarDias(hoje, -1),
      vencimento: somarDias(hoje, -1),
      valor: "9.000.000,00",
      forma: "PIX",
      contaBancariaId: "",
      observacao: "",
      repeticao: { tipo: "unica" },
    }),
  );
  if (!l.ok) throw new Error(l.erro);
  await pedidoAguardando(a.u.id);
  const f = new FormData();
  f.append("contaBancariaId", cb);
  f.append("arquivo", new File([new TextEncoder().encode(ofx(somarDias(hoje, -9), "-35.00"))], "extrato.ofx", { type: "application/x-ofx" }));
  const imp = await comSessao(a.fin.id, () => importarExtrato(f));
  if (!imp.ok) throw new Error(imp.erro);
  const [vendasViagem] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, "vendas_viagem"));
  return { hoje, vs, cb, d: a.d, categoriaVendas: vendasViagem.id };
}

/** O que `obterVisaoGeral` devolvia antes da extração (congelado do código intocado; só ids, datas e semanas interpolados). */
function esperado(s: Awaited<ReturnType<typeof cenario>>, semanas: { rotulo: string; saldoFinal: bigint }[], diretor: boolean) {
  const [v0, v1, v2] = s.vs.map((v) => v.viagemId);
  const menor = semanas.reduce((m, x) => (x.saldoFinal < m.saldoFinal ? x : m));
  const avisos = [
    {
      tipo: "caixa",
      titulo: `Caixa negativo em 8 das próximas 8 semanas, a partir da semana de ${semanas[0].rotulo}`,
      detalhe: `Menor saldo projetado: ${formatarReais(menor.saldoFinal)}, na semana de ${menor.rotulo}`,
      href: "/financeiro/caixa",
      responsavel: "Gestão",
      agregado: false,
    },
    { tipo: "margem", titulo: "ECL-0001-01 abaixo da margem de referência", detalhe: "Família Souza: margem real de -19,4%, referência de 99%", href: `/viagens/${v0}`, responsavel: "Gestão", agregado: false },
    { tipo: "margem", titulo: "ECL-0002-01 abaixo da margem de referência", detalhe: "Família Souza: margem real de -17,1%, referência de 99%", href: `/viagens/${v1}`, responsavel: "Gestão", agregado: false },
    { tipo: "margem", titulo: "ECL-0003-01 abaixo da margem de referência", detalhe: "Família Souza: margem real de -17,1%, referência de 99%", href: `/viagens/${v2}`, responsavel: "Gestão", agregado: false },
    {
      tipo: "margem",
      titulo: "e mais 2 viagens abaixo da margem de referência",
      detalhe: "Margem real abaixo de 99%; veja a margem por viagem nos relatórios",
      href: "/financeiro/relatorios?rel=margens",
      responsavel: "Gestão",
      agregado: true,
    },
    {
      tipo: "parcela",
      titulo: "1 parcela de cliente vencida",
      detalhe: "R$ 7.643,01 em aberto",
      href: `/financeiro/lancamentos?lado=receber&base=vencimento&situacao=vencida&origem=viagem&categoriaId=${s.categoriaVendas}&de=${somarDias(s.hoje, -3)}&ate=${somarDias(s.hoje, -1)}`,
      responsavel: "Financeiro",
      agregado: true,
    },
    {
      tipo: "comissao",
      titulo: "1 comissão de fornecedor vencida",
      detalhe: "R$ 124,24 a receber",
      href: `/financeiro/lancamentos?lado=receber&base=vencimento&situacao=vencida&origem=viagem&de=${somarDias(s.hoje, -3)}&ate=${somarDias(s.hoje, -1)}`,
      responsavel: "Financeiro",
      agregado: true,
    },
    {
      tipo: "pagar",
      titulo: "1 conta a pagar vencida ou vencendo em 7 dias",
      detalhe: "R$ 9.000.000,00 em aberto",
      href: `/financeiro/lancamentos?lado=pagar&base=vencimento&situacao=em_aberto&de=${somarDias(s.hoje, -1)}&ate=${somarDias(s.hoje, 7)}`,
      responsavel: "Financeiro",
      agregado: true,
    },
  ];
  const ocultos = [
    {
      tipo: "conciliacao",
      titulo: "1 transação do extrato sem par no sistema",
      detalhe: "R$ 35,00 em transações sem par com mais de 3 dias",
      href: `/financeiro/conciliacao?conta=${s.cb}&de=${somarDias(s.hoje, -9)}&ate=${s.hoje}&situacao=nao_conciliado`,
      responsavel: "Financeiro",
      agregado: true,
    },
    ...(diretor ? [{ tipo: "aprovacao", titulo: "1 pedido aguardando aprovação", detalhe: "Decidir em Aprovações", href: "/aprovacoes", responsavel: "Gestão", agregado: true }] : []),
  ];
  return { avisos, avisosOcultos: ocultos };
}

describe("extração dos sete avisos", () => {
  beforeEach(limparBanco);

  it("a Visão geral devolve exatamente os mesmos avisos de antes da extração (diretor e fin_estrategico)", async () => {
    const s = await cenario();
    const r = await comSessao(s.d.id, () => obterVisaoGeral("30d"));
    expect(r.semanas.every((x) => x.saldoFinal < 0n)).toBe(true);
    expect({ avisos: r.avisos, avisosOcultos: r.avisosOcultos }).toEqual(esperado(s, r.semanas, true));
    expect(r.viagensAbaixoReferencia).toBe(5);
    const fe = await criarUsuarioTeste("fin_estrategico");
    const rf = await comSessao(fe.id, () => obterVisaoGeral("30d"));
    expect({ avisos: rf.avisos, avisosOcultos: rf.avisosOcultos }).toEqual(esperado(s, rf.semanas, false));
  }, 60_000);

  it("avisosFinanceiros responde para o fin_operacional; consultor e operacional recusados", async () => {
    const s = await cenario();
    const fo = await criarUsuarioTeste("fin_operacional");
    const r = await comSessao(fo.id, () => avisosFinanceiros());
    expect(r.map((a) => [a.chave, a.tipo, a.setor, a.dispensavel])).toEqual([
      ["parcela", "parcela", "Financeiro", true],
      ["comissao", "comissao", "Financeiro", true],
      ["pagar", "pagar", "Financeiro", true],
      ["conciliacao", "conciliacao", "Financeiro", true],
    ]);
    const visao = esperado(s, [{ rotulo: "", saldoFinal: 0n }], true);
    const doPainel = [...visao.avisos, ...visao.avisosOcultos].filter((a) => r.some((x) => x.tipo === a.tipo));
    expect(r.map(({ titulo, detalhe, href }) => ({ titulo, detalhe, href }))).toEqual(doPainel.map(({ titulo, detalhe, href }) => ({ titulo, detalhe, href })));
    expect(r.map((a) => a.passo)).toEqual(["Cobrar o cliente", "Cobrar a comissão do fornecedor", "Pagar ou reprogramar as contas", "Conciliar o extrato"]);
    for (const perfil of ["consultor", "operacional"] as const) {
      const u = await criarUsuarioTeste(perfil);
      await expect(comSessao(u.id, () => avisosFinanceiros())).rejects.toBeInstanceOf(ErroAcesso);
    }
  }, 60_000);

  it("avisosDeGestao: recusa o fin_operacional; margem uma por viagem sem corte; caixa não dispensável; aprovação só para o diretor", async () => {
    const s = await cenario();
    for (const perfil of ["fin_operacional", "consultor", "operacional"] as const) {
      const u = await criarUsuarioTeste(perfil);
      await expect(comSessao(u.id, () => avisosDeGestao())).rejects.toBeInstanceOf(ErroAcesso);
    }
    const r = await comSessao(s.d.id, () => avisosDeGestao());
    expect(r.map((a) => a.tipo)).toEqual(["caixa", "margem", "margem", "margem", "margem", "margem", "aprovacao"]);
    expect(r[0]).toMatchObject({ chave: "caixa", setor: "Gestão", dispensavel: false, href: "/financeiro/caixa", passo: "Rever o fluxo de caixa" });
    const margem = r.filter((a) => a.tipo === "margem");
    // A de maior perda primeiro, depois as outras pelo código, como na Visão geral.
    expect(margem.map((a) => a.chave)).toEqual(s.vs.map((v) => `margem:${v.viagemId}`));
    expect(margem.map((a) => a.href)).toEqual(s.vs.map((v) => `/viagens/${v.viagemId}`));
    expect(margem.map((a) => a.titulo)).toEqual([1, 2, 3, 4, 5].map((n) => `ECL-000${n}-01 abaixo da margem de referência`));
    expect(margem.every((a) => a.setor === "Gestão" && a.dispensavel && a.passo === "Rever os custos lançados na viagem")).toBe(true);
    expect(r.at(-1)).toEqual({
      chave: "aprovacao",
      tipo: "aprovacao",
      titulo: "1 pedido aguardando aprovação",
      detalhe: "Decidir em Aprovações",
      passo: "Aprovar ou devolver os pedidos",
      setor: "Gestão",
      href: "/aprovacoes",
      dispensavel: true,
    });
    const fe = await criarUsuarioTeste("fin_estrategico");
    expect((await comSessao(fe.id, () => avisosDeGestao())).map((a) => a.tipo)).not.toContain("aprovacao");
  }, 60_000);
});
