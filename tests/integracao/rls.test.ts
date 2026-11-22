import { beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { db } from "@/server/db/client";
import {
  auditoria,
  clientes,
  comissoes,
  contasPagar,
  cotacoes,
  itensViagem,
  pagamentosFornecedor,
  parcelasReceber,
  pessoas,
  regrasVersoes,
  vendas,
  versoesPrecificacao,
  viagemPassageiros,
  viagens,
} from "@/server/db/schema";
import { criarUsuarioTeste, limparBanco } from "../helpers/db";

const anon = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

describe("RLS: anon não lê nada", () => {
  beforeEach(async () => {
    await limparBanco();
    const u = await criarUsuarioTeste("diretor");
    await db.insert(auditoria).values({
      usuarioId: u.id,
      tabela: "usuarios",
      registroId: u.id,
      acao: "criar",
      depois: { ok: true },
    });
    const [c] = await db
      .insert(clientes)
      .values({ grupo: "Família Teste", tipo: "familia", filial: "Rondonópolis", telefone: "66999999999" })
      .returning();
    const [p] = await db
      .insert(pessoas)
      .values({ clienteId: c.id, titular: true, ordem: 1, nome: "Titular Teste" })
      .returning();
    const [v] = await db
      .insert(viagens)
      .values({
        clienteId: c.id,
        seq: 1,
        destino: "Itália",
        inicio: "2027-08-14",
        fim: "2027-09-01",
        filial: "Rondonópolis",
        consultorId: u.id,
      })
      .returning();
    await db.insert(viagemPassageiros).values({ viagemId: v.id, pessoaId: p.id });
    const [i] = await db
      .insert(itensViagem)
      .values({ viagemId: v.id, ordem: 1, tipo: "Hotelaria", servico: "Hotel Teste" })
      .returning();
    const [cot] = await db.insert(cotacoes).values({ itemId: i.id, valorOriginal: 100000n, valorBrl: 100000n }).returning();
    const [r] = await db.insert(regrasVersoes).values({ valores: {} as never }).returning();
    const [ver] = await db.insert(versoesPrecificacao).values({
      viagemId: v.id,
      numero: 1,
      snapshot: {},
      preco: 100000n,
      forma: {},
      dias: 19,
      regrasVersaoId: r.id,
      rateio: "pax",
      resultado: {},
      enviadoPor: u.id,
    }).returning();
    const [venda] = await db
      .insert(vendas)
      .values({
        viagemId: v.id,
        versaoId: ver.id,
        aceiteEm: "2027-01-10",
        forma: {},
        parcelas: 1,
        primeiroVencimento: "2027-02-10",
        total: 100000n,
        faturaNome: "Titular Teste",
        faturaDocumento: "12345678901",
        criadoPor: u.id,
      })
      .returning();
    await db.insert(parcelasReceber).values({
      viagemId: v.id,
      vendaId: venda.id,
      numero: 1,
      totalParcelas: 1,
      vencimento: "2027-02-10",
      valor: 100000n,
      meio: "pix",
      taxaPrevista: 0n,
    });
    const [conta] = await db
      .insert(contasPagar)
      .values({
        viagemId: v.id,
        itemId: i.id,
        cotacaoId: cot.id,
        descricao: "Hotel Teste",
        aereo: false,
        moeda: "BRL",
        valorOriginal: 100000n,
        previstoVendaBrl: 100000n,
        previstoBrl: 100000n,
        comissaoPct: "10.000",
        comissaoTipo: "a_receber",
      })
      .returning();
    await db.insert(pagamentosFornecedor).values({
      contaId: conta.id,
      numero: 1,
      vencimento: "2027-03-01",
      valorOriginal: 100000n,
      valorBrlPrevisto: 100000n,
    });
    await db.insert(comissoes).values({
      viagemId: v.id,
      contaId: conta.id,
      baseBrl: 100000n,
      pct: "10.000",
      valorPrevisto: 10000n,
      previstaPara: "2027-04-15",
    });
  });

  for (const tabela of [
    "usuarios",
    "auditoria",
    "clientes",
    "pessoas",
    "viagens",
    "viagem_passageiros",
    "itens_viagem",
    "cotacoes",
    "versoes_precificacao",
    "vendas",
    "parcelas_receber",
    "contas_pagar",
    "pagamentos_fornecedor",
    "comissoes",
  ]) {
    it(`anon não enxerga linhas de ${tabela}`, async () => {
      const { data, error } = await anon().from(tabela).select("*");
      expect(error ? [] : data).toEqual([]);
    });
  }
});
