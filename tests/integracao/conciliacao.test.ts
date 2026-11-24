import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { dataEmCuiaba, hojeEmCuiaba } from "@/domain/clientes";
import type { Origem } from "@/domain/financeiro";
import { somarDias } from "@/domain/venda";
import { ErroAcesso } from "@/server/auth";
import { db } from "@/server/db/client";
import {
  auditoria,
  categoriasFinanceiras,
  contasBancarias,
  extratoTransacoes,
  extratos,
  faturasCartao,
  lancamentos,
  lancamentosFinanceiros as lf,
} from "@/server/db/schema";
import { baixarLancamento, baixarLinha, criarLancamento, desfazerBaixaLancamento } from "@/server/actions/financeiro";
import { baixarParcela } from "@/server/actions/financeiro-viagem";
import {
  confirmarPar,
  criarLancamentoDaTransacao,
  desfazerConciliacao,
  ignorarTransacao,
  importarExtrato,
} from "@/server/actions/conciliacao";
import { GET } from "@/app/(app)/financeiro/relatorios/planilha/route";
import { obterConciliacao, pendentesParaAviso } from "@/server/queries/conciliacao";
import { obterVisaoGeral, relatorioConciliacao } from "@/server/queries/paineis";
import { listarLancamentos } from "@/server/queries/financeiro";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { cartaoCorporativo, contaBancaria, vendida } from "../helpers/venda";

const SEM_PERMISSAO = { ok: false, erro: "Sem permissão" };
const MSG_JA_CONCILIADA = "Esta baixa já está conciliada com outra transação";
const FIXTURE_SGML = readFileSync(join(__dirname, "../fixtures/ofx/sgml-1252.ofx"));

type Contexto = { fin: string; conta: string };
let c: Contexto;

/** Centavos → "1234,56" (entrada das actions). */
const reais = (v: bigint) => `${v / 100n},${(v % 100n).toString().padStart(2, "0")}`;

type T = { fitid: string; data: string; valor: string; nome: string };

/** Extrato OFX 1.x sintético (ASCII), de uma conta, com as transações dadas (`data` em AAAA-MM-DD). */
function ofx(ts: T[], inicio = "20261101", fim = "20261130"): string {
  const corpo = ts
    .map((t) => `<STMTTRN>\n<TRNTYPE>OTHER\n<DTPOSTED>${t.data.replaceAll("-", "")}\n<TRNAMT>${t.valor}\n<FITID>${t.fitid}\n<NAME>${t.nome}\n</STMTTRN>`)
    .join("\n");
  return `OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nENCODING:USASCII\nCHARSET:1252\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS><STMTRS>\n<CURDEF>BRL\n<BANKACCTFROM>\n<BANKID>0341\n<ACCTID>98765-4\n<ACCTTYPE>CHECKING\n</BANKACCTFROM>\n<BANKTRANLIST>\n<DTSTART>${inicio}\n<DTEND>${fim}\n${corpo}\n</BANKTRANLIST>\n</STMTRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>\n`;
}

function form(contaBancariaId: string, arquivo: string | Uint8Array | null, nome = "extrato.ofx"): FormData {
  const f = new FormData();
  f.append("contaBancariaId", contaBancariaId);
  if (arquivo !== null) {
    const bytes = typeof arquivo === "string" ? new TextEncoder().encode(arquivo) : arquivo;
    f.append("arquivo", new File([new Uint8Array(bytes)], nome, { type: "application/x-ofx" }));
  }
  return f;
}

async function importar(conteudo: string | Uint8Array, conta = c.conta, uid = c.fin) {
  const r = await comSessao(uid, () => importarExtrato(form(conta, conteudo)));
  if (!r.ok) throw new Error(r.erro);
  return r;
}

const transacao = async (fitid: string) => (await db.select().from(extratoTransacoes).where(eq(extratoTransacoes.fitid, fitid)))[0];

async function categoria(nome: string): Promise<string> {
  const [k] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.nome, nome));
  return k.id;
}

/** Lançamento manual a pagar (ou a receber) de `valor`, baixado em `data` na conta do contexto. */
async function manualBaixado(valor: string, data: string, lado: "pagar" | "receber" = "pagar", conta = c.conta): Promise<string> {
  const r = await comSessao(c.fin, () =>
    criarLancamento({
      lado,
      descricao: lado === "pagar" ? "Conta de luz" : "Reembolso",
      fornecedorId: "",
      clienteId: "",
      pessoaTexto: "",
      categoriaId: lado === "pagar" ? CAT.aluguel : CAT.rendimentos,
      centro: "MT",
      competencia: data.slice(0, 7),
      emissao: data,
      vencimento: data,
      valor,
      forma: "PIX",
      contaBancariaId: "",
      observacao: "",
      repeticao: { tipo: "unica" },
    }),
  );
  if (!r.ok) throw new Error(r.erro);
  const id = (r as { ids: string[] }).ids[0];
  const b = await comSessao(c.fin, () => baixarLancamento(id, { data, valorPago: valor, juros: "", desconto: "", observacao: "", contaBancariaId: conta }));
  if (!b.ok) throw new Error(b.erro);
  return id;
}

const PERIODO = { de: "2026-11-01", ate: "2026-11-30" };
const conciliacao = (extra: Record<string, unknown> = {}, uid = c.fin) =>
  comSessao(uid, () => obterConciliacao({ contaBancariaId: c.conta, ...PERIODO, ...extra } as Parameters<typeof obterConciliacao>[0]));
const linhaDe = async (fitid: string) => {
  const r = await conciliacao();
  const l = r!.linhas.find((x) => x.transacao.fitid === fitid);
  if (!l) throw new Error(`sem linha ${fitid}`);
  return l;
};

const CAT = { aluguel: "", rendimentos: "", tarifas: "" };

describe("conciliação do extrato OFX", () => {
  beforeEach(async () => {
    await limparBanco();
    const fin = await criarUsuarioTeste("fin_estrategico");
    c = { fin: fin.id, conta: await contaBancaria(fin.id, "Itaú") };
    CAT.aluguel = await categoria("Aluguel");
    CAT.rendimentos = await categoria("Rendimentos");
    CAT.tarifas = await categoria("Tarifas bancárias");
  });

  describe("importarExtrato", () => {
    it("SGML 1252: 3 novas, acentos certos, extrato e auditoria; o mesmo arquivo de novo é recusado pelo hash", async () => {
      const r = await importar(FIXTURE_SGML);
      expect(r).toMatchObject({ ok: true, novas: 3, repetidas: 0, inicio: "2026-11-01", fim: "2026-11-30" });
      const [e] = await db.select().from(extratos).where(eq(extratos.id, r.extratoId));
      expect(e).toMatchObject({ contaBancariaId: c.conta, arquivoNome: "extrato.ofx", transacoes: 3, repetidas: 0, bancoOfx: "0001", contaOfx: "3456", importadoPor: c.fin });
      expect(e.arquivoHash).toMatch(/^[0-9a-f]{64}$/);
      const ts = await db.select().from(extratoTransacoes).where(eq(extratoTransacoes.extratoId, r.extratoId)).orderBy(asc(extratoTransacoes.data));
      expect(ts.map((t) => [t.data, t.valor, t.situacao])).toEqual([
        ["2026-11-03", -286249n, "pendente"],
        ["2026-11-05", -4590n, "pendente"],
        ["2026-11-10", 150000n, "pendente"],
      ]);
      expect(ts[0].descricao).toContain("PAGTO ÁGUA");
      expect(ts[1].descricao).toContain("TARIFA BANCÁRIA");
      const a = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "extratos"), eq(auditoria.registroId, r.extratoId)));
      expect(a).toHaveLength(1);
      expect(a[0].acao).toBe("criar");

      const quando = dataEmCuiaba(e.importadoEm).split("-").reverse().join("/");
      expect(await comSessao(c.fin, () => importarExtrato(form(c.conta, FIXTURE_SGML)))).toEqual({
        ok: false,
        erro: `Este arquivo já foi importado nesta conta em ${quando}`,
      });
      expect(await db.select().from(extratos)).toHaveLength(1);
      // Em outra conta, o mesmo arquivo entra (o hash é por conta).
      const outra = await contaBancaria(c.fin, "Bradesco");
      expect(await importar(FIXTURE_SGML, outra)).toMatchObject({ novas: 3, repetidas: 0 });
    });

    it("Review Focus 2: extrato sobreposto (2 FITIDs já importados + 1 novo) → novas 1, repetidas 2, nada duplica", async () => {
      await importar(FIXTURE_SGML);
      const r = await importar(
        ofx([
          { fitid: "202611030001", data: "2026-11-03", valor: "-2862.49", nome: "PAGTO AGUA" },
          { fitid: "202611050002", data: "2026-11-05", valor: "-45.90", nome: "TARIFA" },
          { fitid: "202611200004", data: "2026-11-20", valor: "-10.00", nome: "IOF" },
        ]),
      );
      expect(r).toMatchObject({ novas: 1, repetidas: 2 });
      const [e] = await db.select().from(extratos).where(eq(extratos.id, r.extratoId));
      expect(e).toMatchObject({ transacoes: 1, repetidas: 2 });
      expect(await db.select().from(extratoTransacoes)).toHaveLength(4);
      // FITID repetido dentro do mesmo arquivo conta como repetida.
      const r2 = await importar(
        ofx([
          { fitid: "X1", data: "2026-11-21", valor: "-1.00", nome: "A" },
          { fitid: "X1", data: "2026-11-21", valor: "-1.00", nome: "A" },
        ]),
      );
      expect(r2).toMatchObject({ novas: 1, repetidas: 1 });
    });

    it("recusas: conta inexistente ou desativada, sem arquivo, maior que 5 MB, arquivo que não é OFX", async () => {
      const texto = ofx([{ fitid: "1", data: "2026-11-05", valor: "-1.00", nome: "A" }]);
      const naoEncontrada = { ok: false, erro: "Conta bancária não encontrada ou desativada" };
      expect(await comSessao(c.fin, () => importarExtrato(form("8a1c1a3e-6f7e-4a55-9b1a-1b2c3d4e5f60", texto)))).toMatchObject(naoEncontrada);
      expect(await comSessao(c.fin, () => importarExtrato(form("nada", texto)))).toMatchObject(naoEncontrada);
      await db.update(contasBancarias).set({ ativa: false }).where(eq(contasBancarias.id, c.conta));
      expect(await comSessao(c.fin, () => importarExtrato(form(c.conta, texto)))).toMatchObject(naoEncontrada);
      await db.update(contasBancarias).set({ ativa: true }).where(eq(contasBancarias.id, c.conta));

      expect(await comSessao(c.fin, () => importarExtrato(form(c.conta, null)))).toMatchObject({ ok: false, erro: "Escolha o arquivo OFX" });
      const grande = new Uint8Array(5 * 1024 * 1024 + 1).fill(32);
      expect(await comSessao(c.fin, () => importarExtrato(form(c.conta, grande)))).toEqual({ ok: false, erro: "O arquivo passa de 5 MB" });
      expect(await comSessao(c.fin, () => importarExtrato(form(c.conta, "isto não é um extrato")))).toEqual({
        ok: false,
        erro: "O arquivo não parece um extrato OFX",
      });
      expect(await db.select().from(extratos)).toHaveLength(0);
    });
  });

  describe("sugestão e confirmarPar", () => {
    it("manual baixado de mesmo valor a 2 dias é sugerido; confirmarPar concilia, audita e a linha confere", async () => {
      const manual = await manualBaixado("45,90", "2026-11-07");
      await manualBaixado("45,90", "2026-11-20"); // longe demais para sugerir (15 dias)
      await importar(FIXTURE_SGML);
      const l = await linhaDe("202611050002");
      expect(l.situacao).toMatchObject({ tipo: "nao_conciliado", rotulo: "Não conciliado" });
      expect(l.sugestao).toMatchObject({ origem: "manual", id: manual, data: "2026-11-07", valor: -4590n, descricao: "Conta de luz" });
      expect(l.opcoes.map((o) => o.id)).toEqual([manual]);

      const t = await transacao("202611050002");
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", manual))).toEqual({ ok: true });
      const depois = await transacao("202611050002");
      expect(depois).toMatchObject({ situacao: "conciliada", linhaOrigem: "manual", linhaId: manual, conciliadaPor: c.fin });
      expect(depois.conciliadaEm).toBeInstanceOf(Date);
      const a = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "extrato_transacoes"), eq(auditoria.registroId, t.id)));
      expect(a.map((x) => x.acao)).toEqual(["alterar"]);
      expect(a[0].antes).toMatchObject({ situacao: "pendente", linhaId: null });

      const conciliada = await linhaDe("202611050002");
      expect(conciliada.situacao).toMatchObject({ tipo: "confere", rotulo: "Confere" });
      expect(conciliada.linha).toMatchObject({ origem: "manual", id: manual });
      expect(conciliada.sugestao).toBeNull();
      // A baixa conciliada sai das opções das outras transações.
      const r = await conciliacao();
      expect(r!.linhas.flatMap((x) => x.opcoes.map((o) => o.id))).not.toContain(manual);
      expect(r!.totais.confere).toEqual({ qtd: 1, valor: -4590n });
      expect(r!.totais.nao_conciliado).toEqual({ qtd: 2, valor: -286249n + 150000n });
      // filtro por situação exibida
      expect((await conciliacao({ situacao: "confere" }))!.linhas.map((x) => x.transacao.fitid)).toEqual(["202611050002"]);
    });

    it("Review Focus 3: segunda transação na mesma baixa é recusada (índice único, em corrida e depois)", async () => {
      const manual = await manualBaixado("10,00", "2026-11-10");
      await importar(
        ofx([
          { fitid: "A", data: "2026-11-09", valor: "-10.00", nome: "PIX A" },
          { fitid: "B", data: "2026-11-11", valor: "-10.00", nome: "PIX B" },
          { fitid: "C", data: "2026-11-12", valor: "-10.00", nome: "PIX C" },
        ]),
      );
      // A sugestão é por transação (as três veem a mesma baixa); o índice único impede usá-la duas vezes.
      const [a, b, cc] = [await transacao("A"), await transacao("B"), await transacao("C")];
      const corrida = await Promise.all([
        comSessao(c.fin, () => confirmarPar(a.id, "manual", manual)),
        comSessao(c.fin, () => confirmarPar(b.id, "manual", manual)),
      ]);
      expect(corrida.filter((x) => x.ok)).toHaveLength(1);
      expect(corrida.filter((x) => !x.ok)).toEqual([{ ok: false, erro: MSG_JA_CONCILIADA }]);
      expect(await comSessao(c.fin, () => confirmarPar(cc.id, "manual", manual))).toEqual({ ok: false, erro: MSG_JA_CONCILIADA });
      expect(await db.select().from(extratoTransacoes).where(eq(extratoTransacoes.situacao, "conciliada"))).toHaveLength(1);
    });

    it("Review Focus 3: duas baixas iguais à mesma distância → sem sugestão automática, as duas nas opções", async () => {
      const antes = await manualBaixado("10,00", "2026-11-09");
      const depois = await manualBaixado("10,00", "2026-11-11");
      await importar(ofx([{ fitid: "A", data: "2026-11-10", valor: "-10.00", nome: "PIX A" }]));
      const l = await linhaDe("A");
      expect(l.sugestao).toBeNull();
      expect(l.opcoes.map((o) => o.id).sort()).toEqual([antes, depois].sort());
    });

    it("guardas do banco: segunda linha conciliada na mesma baixa (índice) e pendente com campos soltos (CHECK)", async () => {
      const manual = await manualBaixado("10,00", "2026-11-10");
      await importar(
        ofx([
          { fitid: "A", data: "2026-11-09", valor: "-10.00", nome: "PIX A" },
          { fitid: "B", data: "2026-11-11", valor: "-10.00", nome: "PIX B" },
        ]),
      );
      const [a, b] = [await transacao("A"), await transacao("B")];
      const conciliar = (id: string) =>
        db
          .update(extratoTransacoes)
          .set({ situacao: "conciliada", linhaOrigem: "manual", linhaId: manual, conciliadaPor: c.fin, conciliadaEm: new Date() })
          .where(eq(extratoTransacoes.id, id));
      await conciliar(a.id);
      await expect(conciliar(b.id)).rejects.toMatchObject({ cause: { code: "23505" } });
      await expect(db.update(extratoTransacoes).set({ conciliadaPor: c.fin }).where(eq(extratoTransacoes.id, b.id))).rejects.toMatchObject({
        cause: { code: "23514" },
      });
      await expect(db.update(extratoTransacoes).set({ ignoradaMotivo: "x" }).where(eq(extratoTransacoes.id, b.id))).rejects.toMatchObject({
        cause: { code: "23514" },
      });
    });

    it("recusas do confirmarPar: fora da janela, outro sinal, outra conta, não baixada, transação já conciliada ou ignorada", async () => {
      const longe = await manualBaixado("10,00", "2026-11-01");
      const entrada = await manualBaixado("10,00", "2026-11-20", "receber");
      const outraConta = await contaBancaria(c.fin, "Bradesco");
      const daOutra = await manualBaixado("10,00", "2026-11-20", "pagar", outraConta);
      const boa = await manualBaixado("10,00", "2026-11-19");
      await importar(ofx([{ fitid: "A", data: "2026-11-20", valor: "-10.00", nome: "PIX A" }]));
      const t = await transacao("A");
      const invalida = { ok: false, erro: "Esta baixa não pode ser conciliada com esta transação" };
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", longe))).toEqual(invalida); // 19 dias
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", entrada))).toEqual(invalida);
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", daOutra))).toEqual(invalida);
      expect(await comSessao(c.fin, () => desfazerBaixaLancamento(boa))).toMatchObject({ ok: true });
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", boa))).toEqual(invalida);
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "parcela", boa))).toEqual(invalida);
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "nada" as Origem, boa))).toEqual({ ok: false, erro: "Origem inválida" });
      expect(await comSessao(c.fin, () => confirmarPar("nada", "manual", boa))).toEqual({ ok: false, erro: "Transação do extrato não encontrada" });
      expect((await transacao("A")).situacao).toBe("pendente");

      const outra = await manualBaixado("12,00", "2026-11-18");
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", outra))).toEqual({ ok: true });
      expect((await linhaDe("A")).situacao).toMatchObject({ tipo: "diferenca", rotulo: "Diferença de R$ 2,00", diferenca: 200n });
      const mais = await manualBaixado("10,00", "2026-11-21");
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", mais))).toEqual({ ok: false, erro: "Esta transação já foi conciliada: desfaça antes" });
      expect(await comSessao(c.fin, () => desfazerConciliacao(t.id))).toEqual({ ok: true });
      expect(await comSessao(c.fin, () => ignorarTransacao(t.id, "Transferência entre contas"))).toEqual({ ok: true });
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", mais))).toEqual({ ok: false, erro: "Esta transação foi ignorada: desfaça antes" });
    });

    it("parcela de viagem baixada é candidata (origem parcela), pelo valor de caixa", async () => {
      const x = await vendida();
      const conta = await contaBancaria(x.fin.id, "Sicredi");
      const p = x.parcelas[0];
      const d = { recebidaEm: "2026-11-10", valorRecebido: reais(p.valor), contaBancariaId: conta };
      expect(await comSessao(x.fin.id, () => baixarParcela(p.id, d))).toEqual({ ok: true });
      const [v] = await db.select().from(lf).where(and(eq(lf.origem, "parcela"), eq(lf.id, p.id)));
      const caixa = v.valorCaixaBaixado!;
      await importar(ofx([{ fitid: "P", data: "2026-11-11", valor: reais(caixa).replace(",", "."), nome: "BOLETO" }]), conta, x.fin.id);
      const r = await comSessao(x.fin.id, () => obterConciliacao({ contaBancariaId: conta, ...PERIODO }));
      const l = r!.linhas[0];
      expect(l.sugestao).toMatchObject({ origem: "parcela", id: p.id, valor: caixa, data: "2026-11-10", pessoa: "Marcos Souza" });
      expect(await comSessao(x.fin.id, () => confirmarPar(l.transacao.id, "parcela", p.id))).toEqual({ ok: true });
    });

    it("Review Focus 4: fatura do cartão corporativo paga é candidata; a compra no cartão não", async () => {
      const cartao = await cartaoCorporativo(c.fin, c.conta);
      const r = await comSessao(c.fin, () =>
        criarLancamento({
          lado: "pagar",
          descricao: "Passagem do diretor",
          fornecedorId: "",
          clienteId: "",
          pessoaTexto: "",
          categoriaId: CAT.aluguel,
          centro: "MT",
          competencia: "2026-11",
          emissao: "2026-11-02",
          vencimento: "2026-11-02",
          valor: "300,00",
          forma: "Cartão de crédito",
          contaBancariaId: "",
          observacao: "",
          repeticao: { tipo: "unica" },
          cartaoId: cartao,
        }),
      );
      if (!r.ok) throw new Error(r.erro);
      const compra = (r as { ids: string[] }).ids[0];
      const [fatura] = await db.select().from(faturasCartao).where(eq(faturasCartao.cartaoId, cartao));
      expect(await comSessao(c.fin, () => baixarLinha("fatura_cartao", fatura.id, { data: "2026-11-20", contaBancariaId: c.conta }))).toEqual({ ok: true });
      expect((await db.select().from(lancamentos).where(eq(lancamentos.id, compra)))[0].status).toBe("baixado");
      await importar(ofx([{ fitid: "F", data: "2026-11-20", valor: "-300.00", nome: "FATURA VISA" }]));
      const l = await linhaDe("F");
      expect(l.sugestao).toMatchObject({ origem: "fatura_cartao", id: fatura.id, valor: -30000n });
      expect(l.opcoes.map((o) => o.origem)).toEqual(["fatura_cartao"]);
      expect(await comSessao(c.fin, () => confirmarPar(l.transacao.id, "manual", compra))).toEqual({
        ok: false,
        erro: "Esta baixa não pode ser conciliada com esta transação",
      });
      expect(await comSessao(c.fin, () => confirmarPar(l.transacao.id, "fatura_cartao", fatura.id))).toEqual({ ok: true });
    });

    it("desfazer a baixa da linha conciliada → 'A baixa mudou: confira'; desfazer a conciliação solta o par", async () => {
      const manual = await manualBaixado("45,90", "2026-11-05");
      await importar(FIXTURE_SGML);
      const t = await transacao("202611050002");
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", manual))).toEqual({ ok: true });
      expect(await comSessao(c.fin, () => desfazerBaixaLancamento(manual))).toMatchObject({ ok: true });
      const l = await linhaDe("202611050002");
      expect(l.situacao).toMatchObject({ tipo: "baixa_mudou", rotulo: "A baixa mudou: confira" });
      expect(l.linha).toBeNull();
      expect((await conciliacao())!.totais.baixa_mudou).toEqual({ qtd: 1, valor: -4590n });

      expect(await comSessao(c.fin, () => desfazerConciliacao(t.id))).toEqual({ ok: true });
      const solta = await transacao("202611050002");
      expect(solta).toMatchObject({
        situacao: "pendente",
        linhaOrigem: null,
        linhaId: null,
        conciliadaPor: null,
        conciliadaEm: null,
        ignoradaMotivo: null,
        ignoradaPor: null,
        ignoradaEm: null,
      });
      expect(await comSessao(c.fin, () => desfazerConciliacao(t.id))).toEqual({ ok: false, erro: "Esta transação já está pendente" });
      const a = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "extrato_transacoes"), eq(auditoria.registroId, t.id))).orderBy(asc(auditoria.id));
      expect(a.map((x) => x.acao)).toEqual(["alterar", "alterar"]);
      expect(a[1].antes).toMatchObject({ situacao: "conciliada", linhaId: manual });
    });

    it("baixa conciliada fora da janela do período continua 'Confere'", async () => {
      const manual = await manualBaixado("45,90", "2026-11-05");
      await importar(FIXTURE_SGML);
      const t = await transacao("202611050002");
      expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", manual))).toEqual({ ok: true });
      const r = await conciliacao({ de: "2026-11-05", ate: "2026-11-05" });
      expect(r!.linhas.map((x) => [x.transacao.fitid, x.situacao.tipo])).toEqual([["202611050002", "confere"]]);
    });
  });

  describe("criarLancamentoDaTransacao", () => {
    it("tarifa: cria o manual baixado na data e na conta, conciliado; aparece na lista única", async () => {
      await importar(FIXTURE_SGML);
      const t = await transacao("202611050002");
      const r = await comSessao(c.fin, () => criarLancamentoDaTransacao(t.id, { categoriaId: CAT.tarifas, descricao: "Tarifa do mês", centro: "MT" }));
      expect(r).toMatchObject({ ok: true });
      const id = (r as { id: string }).id;
      const [l] = await db.select().from(lancamentos).where(eq(lancamentos.id, id));
      expect(l).toMatchObject({
        lado: "pagar",
        descricao: "Tarifa do mês",
        categoriaId: CAT.tarifas,
        centro: "MT",
        valor: 4590n,
        competencia: "2026-11",
        emissao: "2026-11-05",
        vencimento: "2026-11-05",
        forma: "debito_conta",
        contaBancariaId: c.conta,
        status: "baixado",
        baixadoEm: "2026-11-05",
        valorPago: 4590n,
        baixaContaBancariaId: c.conta,
        criadoPor: c.fin,
      });
      expect(await transacao("202611050002")).toMatchObject({ situacao: "conciliada", linhaOrigem: "manual", linhaId: id });
      const lista = await comSessao(c.fin, () =>
        listarLancamentos({ lado: "todos", de: "2026-11-01", ate: "2026-11-30", base: "baixa", pagina: 1 } as Parameters<typeof listarLancamentos>[0]),
      );
      expect(lista.linhas.find((x) => x.id === id)).toMatchObject({ origem: "manual", baixadoEm: "2026-11-05" });
      expect((await linhaDe("202611050002")).situacao.tipo).toBe("confere");
      const a = await db.select().from(auditoria).where(eq(auditoria.registroId, id));
      expect(a.map((x) => x.acao).sort()).toEqual(["alterar", "criar"]);

      // rendimento (entrada): lado receber
      const e = await transacao("202611100003");
      const errado = await comSessao(c.fin, () => criarLancamentoDaTransacao(e.id, { categoriaId: CAT.tarifas, descricao: "Rendimento", centro: "MT" }));
      expect(errado).toEqual({ ok: false, erro: "A categoria é do outro lado (pagar/receber)", campos: { categoriaId: "A categoria é do outro lado (pagar/receber)" } });
      const ok = await comSessao(c.fin, () => criarLancamentoDaTransacao(e.id, { categoriaId: CAT.rendimentos, descricao: "Rendimento", centro: "RS" }));
      expect(ok).toMatchObject({ ok: true });
      const [rec] = await db.select().from(lancamentos).where(eq(lancamentos.id, (ok as { id: string }).id));
      expect(rec).toMatchObject({ lado: "receber", valor: 150000n, centro: "RS" });
    });

    it("recusas: sem categoria, categoria desativada, transação já conciliada; nada é gravado", async () => {
      await importar(FIXTURE_SGML);
      const t = await transacao("202611050002");
      const sem = await comSessao(c.fin, () => criarLancamentoDaTransacao(t.id, { categoriaId: "", descricao: "Tarifa", centro: "MT" }));
      expect(sem).toMatchObject({ ok: false, campos: { categoriaId: expect.any(String) } });
      const semDescricao = await comSessao(c.fin, () => criarLancamentoDaTransacao(t.id, { categoriaId: CAT.tarifas, descricao: " ", centro: "MT" }));
      expect(semDescricao).toMatchObject({ ok: false, campos: { descricao: "Informe a descrição" } });
      await db.update(categoriasFinanceiras).set({ ativa: false }).where(eq(categoriasFinanceiras.id, CAT.tarifas));
      expect(await comSessao(c.fin, () => criarLancamentoDaTransacao(t.id, { categoriaId: CAT.tarifas, descricao: "Tarifa", centro: "MT" }))).toMatchObject({
        ok: false,
        erro: "Categoria desativada",
      });
      expect(await db.select().from(lancamentos)).toHaveLength(0);
      await db.update(categoriasFinanceiras).set({ ativa: true }).where(eq(categoriasFinanceiras.id, CAT.tarifas));
      expect(await comSessao(c.fin, () => ignorarTransacao(t.id, "Estornada"))).toEqual({ ok: true });
      expect(await comSessao(c.fin, () => criarLancamentoDaTransacao(t.id, { categoriaId: CAT.tarifas, descricao: "Tarifa", centro: "MT" }))).toEqual({
        ok: false,
        erro: "Esta transação foi ignorada: desfaça antes",
      });
      expect(await db.select().from(lancamentos)).toHaveLength(0);
    });
  });

  describe("ignorarTransacao e desfazerConciliacao", () => {
    it("sem motivo → erro de campo; com motivo → ignorada e auditada; desfazer volta a pendente com tudo nulo", async () => {
      await importar(FIXTURE_SGML);
      const t = await transacao("202611030001");
      const MSG = "Informe o motivo (3 a 200 caracteres)";
      expect(await comSessao(c.fin, () => ignorarTransacao(t.id, ""))).toEqual({ ok: false, erro: MSG, campos: { motivo: MSG } });
      expect(await comSessao(c.fin, () => ignorarTransacao(t.id, "ab"))).toEqual({ ok: false, erro: MSG, campos: { motivo: MSG } });
      expect(await comSessao(c.fin, () => ignorarTransacao(t.id, "x".repeat(201)))).toEqual({ ok: false, erro: MSG, campos: { motivo: MSG } });
      expect(await comSessao(c.fin, () => ignorarTransacao(t.id, "  Transferência entre contas  "))).toEqual({ ok: true });
      expect(await transacao("202611030001")).toMatchObject({ situacao: "ignorada", ignoradaMotivo: "Transferência entre contas", ignoradaPor: c.fin });
      const l = await linhaDe("202611030001");
      expect(l.situacao).toMatchObject({ tipo: "ignorado", rotulo: "Ignorado" });
      expect(await comSessao(c.fin, () => ignorarTransacao(t.id, "De novo"))).toEqual({ ok: false, erro: "Esta transação foi ignorada: desfaça antes" });

      expect(await comSessao(c.fin, () => desfazerConciliacao(t.id))).toEqual({ ok: true });
      expect(await transacao("202611030001")).toMatchObject({
        situacao: "pendente",
        linhaOrigem: null,
        linhaId: null,
        conciliadaPor: null,
        conciliadaEm: null,
        ignoradaMotivo: null,
        ignoradaPor: null,
        ignoradaEm: null,
      });
      const a = await db.select().from(auditoria).where(and(eq(auditoria.tabela, "extrato_transacoes"), eq(auditoria.registroId, t.id)));
      expect(a).toHaveLength(2);
    });
  });

  describe("pendentesParaAviso", () => {
    it("conta só as pendentes com data de mais de 3 dias; valor em módulo", async () => {
      const hoje = hojeEmCuiaba();
      await importar(
        ofx(
          [
            { fitid: "V1", data: somarDias(hoje, -10), valor: "-10.00", nome: "A" },
            { fitid: "V2", data: somarDias(hoje, -4), valor: "25.00", nome: "B" },
            { fitid: "V3", data: somarDias(hoje, -3), valor: "-7.00", nome: "C" },
            { fitid: "V4", data: somarDias(hoje, -20), valor: "-1.00", nome: "D" },
          ],
          "20200101",
          "20991231",
        ),
      );
      const v4 = await transacao("V4");
      expect(await comSessao(c.fin, () => ignorarTransacao(v4.id, "Estornada"))).toEqual({ ok: true });
      expect(await pendentesParaAviso(hoje)).toMatchObject({ qtd: 2, valor: 3500n, contas: [{ contaId: c.conta, nome: "Itaú", maisAntiga: somarDias(hoje, -10) }] });
    });
  });

  describe("pendentesParaAviso: contas", () => {
    it("só conta transações de contas ativas e não excluídas", async () => {
      const hoje = hojeEmCuiaba();
      const outra = await contaBancaria(c.fin, "Bradesco");
      await importar(ofx([{ fitid: "A1", data: somarDias(hoje, -10), valor: "-10.00", nome: "A" }], "20200101", "20991231"));
      await importar(ofx([{ fitid: "B1", data: somarDias(hoje, -10), valor: "-20.00", nome: "B" }], "20200101", "20991231"), outra);
      expect(await pendentesParaAviso(hoje)).toMatchObject({ qtd: 2, valor: 3000n });
      await db.update(contasBancarias).set({ ativa: false }).where(eq(contasBancarias.id, outra));
      expect(await pendentesParaAviso(hoje)).toMatchObject({ qtd: 1, valor: 1000n });
      await db.update(contasBancarias).set({ excluidoEm: new Date() }).where(eq(contasBancarias.id, c.conta));
      expect(await pendentesParaAviso(hoje)).toMatchObject({ qtd: 0, valor: 0n, contas: [] });
    });
  });

  describe("relatório, planilha e aviso na Visão geral", () => {
    const intervalo = { de: "2026-11-01", ate: "2026-11-30" };
    const url = (q: string) => new Request(`http://localhost/financeiro/relatorios/planilha?${q}`);

    /** Confere (+1.824,00), Diferença (-4.202,00 no extrato x -4.200,00 no sistema) e uma tarifa pendente. */
    async function cenario() {
      const receber = await manualBaixado("1824,00", "2026-11-06", "receber");
      const pagar = await manualBaixado("4200,00", "2026-11-10", "pagar");
      await importar(
        ofx([
          { fitid: "R1", data: "2026-11-06", valor: "1824.00", nome: "PIX COMISSAO EXPEDIA" },
          { fitid: "R2", data: "2026-11-10", valor: "-4202.00", nome: "ALUGUEL ESCRITORIO" },
          { fitid: "R3", data: "2026-11-12", valor: "-35.00", nome: "TARIFA BANCARIA" },
        ]),
      );
      for (const [fitid, id] of [["R1", receber], ["R2", pagar]] as const) {
        const t = await transacao(fitid);
        expect(await comSessao(c.fin, () => confirmarPar(t.id, "manual", id))).toEqual({ ok: true });
      }
    }

    it("relatorioConciliacao: as três situações, valores e totais; filtro por conta", async () => {
      await cenario();
      const r = await comSessao(c.fin, () => relatorioConciliacao(intervalo));
      expect(r.linhas.map((l) => [l.data, l.conta, l.descricao, l.valorExtrato, l.valorSistema, l.situacao])).toEqual([
        ["2026-11-06", "Itaú", "PIX COMISSAO EXPEDIA", 182400n, 182400n, "Confere"],
        ["2026-11-10", "Itaú", "ALUGUEL ESCRITORIO", -420200n, -420000n, "Diferença de R$ 2,00"],
        ["2026-11-12", "Itaú", "TARIFA BANCARIA", -3500n, null, "Não conciliado"],
      ]);
      expect(r.totais.map((t) => [t.tipo, t.qtd, t.valor])).toEqual([
        ["confere", 1, 182400n],
        ["diferenca", 1, -420200n],
        ["nao_conciliado", 1, -3500n],
      ]);
      const outra = await contaBancaria(c.fin, "Bradesco");
      expect((await comSessao(c.fin, () => relatorioConciliacao(intervalo, outra))).linhas).toEqual([]);
      expect((await comSessao(c.fin, () => relatorioConciliacao(intervalo, c.conta))).linhas).toHaveLength(3);
      expect((await comSessao(c.fin, () => relatorioConciliacao({ de: "2026-12-01", ate: "2026-12-31" }))).linhas).toEqual([]);
    });

    it("planilha: CSV com BOM e ponto e vírgula; consultor e operacional recebem 403", async () => {
      await cenario();
      const resposta = await comSessao(c.fin, () => GET(url("rel=conciliacao&de=2026-11&ate=2026-11")));
      expect(resposta.status).toBe(200);
      expect(resposta.headers.get("content-disposition")).toBe('attachment; filename="relatorio-conciliacao-2026-11.csv"');
      const bytes = new Uint8Array(await resposta.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const texto = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      expect(texto.startsWith("\uFEFFData;Conta;Lançamento no extrato;Extrato (R$);Sistema (R$);Situação\r\n")).toBe(true);
      expect(texto).toContain("06/11/2026;Itaú;PIX COMISSAO EXPEDIA;1824,00;1824,00;Confere");
      expect(texto).toContain("10/11/2026;Itaú;ALUGUEL ESCRITORIO;-4202,00;-4200,00;Diferença de R$ 2,00");
      expect(texto).toContain("12/11/2026;Itaú;TARIFA BANCARIA;-35,00;;Não conciliado");

      for (const perfil of ["consultor", "operacional"] as const) {
        const u = await criarUsuarioTeste(perfil);
        const negada = await comSessao(u.id, () => GET(url("rel=conciliacao&de=2026-11&ate=2026-11")));
        expect(negada.status).toBe(403);
        expect(await negada.text()).toBe("");
        await expect(comSessao(u.id, () => relatorioConciliacao(intervalo))).rejects.toBeInstanceOf(ErroAcesso);
      }
    });

    it("Visão geral: aviso 'sem par no sistema' só com pendente de mais de 3 dias; some sem pendência", async () => {
      const hoje = hojeEmCuiaba();
      const diretor = await criarUsuarioTeste("diretor");
      expect((await comSessao(diretor.id, () => obterVisaoGeral("mes"))).avisos.some((a) => a.tipo === "conciliacao")).toBe(false);
      await importar(
        ofx(
          [
            { fitid: "N1", data: somarDias(hoje, -2), valor: "-50.00", nome: "RECENTE" },
            { fitid: "N2", data: somarDias(hoje, -9), valor: "-35.00", nome: "TARIFA BANCARIA" },
            { fitid: "N3", data: somarDias(hoje, -8), valor: "10.00", nome: "RENDIMENTO" },
          ],
          "20200101",
          "20991231",
        ),
      );
      const v = await comSessao(diretor.id, () => obterVisaoGeral("mes"));
      const a = v.avisos.find((x) => x.tipo === "conciliacao");
      expect(a).toMatchObject({
        titulo: "2 transações do extrato sem par no sistema",
        detalhe: "R$ 45,00 em transações sem par",
        href: `/financeiro/conciliacao?conta=${c.conta}&de=${somarDias(hoje, -9)}&ate=${hoje}&situacao=nao_conciliado`,
        responsavel: "Financeiro",
        agregado: true,
      });
      const um = await importar(ofx([{ fitid: "N4", data: somarDias(hoje, -30), valor: "-1.00", nome: "ANTIGA" }], "20200101", "20991231"), c.conta);
      expect(um.novas).toBe(1);
      const v2 = await comSessao(diretor.id, () => obterVisaoGeral("mes"));
      expect(v2.avisos.find((x) => x.tipo === "conciliacao")?.titulo).toBe("3 transações do extrato sem par no sistema");
    });
  });

  describe("aviso com várias contas", () => {
    it("abre a conta da pendência mais antiga, do dia dela até hoje, e diz que são 2 contas", async () => {
      const hoje = hojeEmCuiaba();
      const diretor = await criarUsuarioTeste("diretor");
      const outra = await contaBancaria(c.fin, "Bradesco");
      const mesPassado = somarDias(hoje, -35);
      await importar(ofx([{ fitid: "M1", data: somarDias(hoje, -6), valor: "-10.00", nome: "A" }], "20200101", "20991231"));
      await importar(ofx([{ fitid: "M2", data: mesPassado, valor: "-20.00", nome: "B" }], "20200101", "20991231"), outra);
      const a = (await comSessao(diretor.id, () => obterVisaoGeral("mes"))).avisos.find((x) => x.tipo === "conciliacao")!;
      expect(a.href).toBe(`/financeiro/conciliacao?conta=${outra}&de=${mesPassado}&ate=${hoje}&situacao=nao_conciliado`);
      expect(a.detalhe).toBe(`R$ 30,00 em transações sem par, em 2 contas`);
      // Os parâmetros do link são aceitos pela leitura da tela como estão e a pendência aparece.
      const q = new URL(a.href, "http://x").searchParams;
      const r = await comSessao(c.fin, () => obterConciliacao({ contaBancariaId: q.get("conta")!, de: q.get("de")!, ate: q.get("ate")!, situacao: q.get("situacao") as "nao_conciliado" }));
      expect(r!.linhas.map((l) => l.transacao.fitid)).toEqual(["M2"]);
    });
  });

  describe("planilha: descrição que parece fórmula e nome do arquivo", () => {
    it("= e @ no início da descrição são neutralizados; o nome do arquivo leva a conta", async () => {
      await importar(
        ofx([
          { fitid: "F1", data: "2026-11-05", valor: "-10.00", nome: "=SOMA(A1)" },
          { fitid: "F2", data: "2026-11-06", valor: "-11.00", nome: "@cmd" },
        ]),
      );
      const r = await comSessao(c.fin, () => GET(new Request(`http://localhost/x?rel=conciliacao&de=2026-11&ate=2026-11&conta=${c.conta}`)));
      expect(r.headers.get("content-disposition")).toBe('attachment; filename="relatorio-conciliacao-2026-11-conta-itau.csv"');
      const texto = await r.text();
      expect(texto).toContain("05/11/2026;Itaú; =SOMA(A1);-10,00");
      expect(texto).toContain("06/11/2026;Itaú; @cmd;-11,00");
      expect(texto).not.toMatch(/;[=@]/);
    });
  });

  describe("acesso", () => {
    it("consultor e operacional: 'Sem permissão' em todas as actions e ErroAcesso na query; diretor e fin_operacional entram", async () => {
      await importar(FIXTURE_SGML);
      const t = await transacao("202611050002");
      for (const perfil of ["consultor", "operacional"] as const) {
        const u = await criarUsuarioTeste(perfil);
        expect(await comSessao(u.id, () => importarExtrato(form(c.conta, "x")))).toEqual(SEM_PERMISSAO);
        expect(await comSessao(u.id, () => confirmarPar(t.id, "manual", t.id))).toEqual(SEM_PERMISSAO);
        expect(await comSessao(u.id, () => criarLancamentoDaTransacao(t.id, { categoriaId: CAT.tarifas, descricao: "x", centro: "MT" }))).toEqual(SEM_PERMISSAO);
        expect(await comSessao(u.id, () => ignorarTransacao(t.id, "Motivo"))).toEqual(SEM_PERMISSAO);
        expect(await comSessao(u.id, () => desfazerConciliacao(t.id))).toEqual(SEM_PERMISSAO);
        await expect(conciliacao({}, u.id)).rejects.toBeInstanceOf(ErroAcesso);
      }
      expect((await transacao("202611050002")).situacao).toBe("pendente");
      for (const perfil of ["diretor", "fin_operacional"] as const) {
        const u = await criarUsuarioTeste(perfil);
        expect((await conciliacao({}, u.id))!.linhas).toHaveLength(3);
      }
    });

    it("obterConciliacao: conta inexistente → null; histórico das importações da conta", async () => {
      await importar(FIXTURE_SGML);
      expect(await comSessao(c.fin, () => obterConciliacao({ contaBancariaId: "8a1c1a3e-6f7e-4a55-9b1a-1b2c3d4e5f60", ...PERIODO }))).toBeNull();
      const r = await conciliacao();
      expect(r!.conta).toMatchObject({ id: c.conta, nome: "Itaú" });
      expect(r!.importacoes).toEqual([
        expect.objectContaining({ arquivoNome: "extrato.ofx", transacoes: 3, repetidas: 0, inicio: "2026-11-01", fim: "2026-11-30", importadoPorNome: "Teste fin_estrategico" }),
      ]);
    });

    it("obterConciliacao: data inexistente ou período invertido é recusado; situação desconhecida não filtra", async () => {
      await importar(FIXTURE_SGML);
      await expect(conciliacao({ de: "2026-13-45" })).rejects.toThrow("Período inválido");
      await expect(conciliacao({ ate: "2026-02-30" })).rejects.toThrow("Período inválido");
      await expect(conciliacao({ de: "2026-11-30", ate: "2026-11-01" })).rejects.toThrow("Período inválido");
      expect((await conciliacao({ situacao: "qualquer" }))!.linhas).toHaveLength(3);
      expect((await conciliacao({ situacao: "ignorado" }))!.linhas).toHaveLength(0);
    });
  });
});
