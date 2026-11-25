import { beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { db, sql } from "@/server/db/client";
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
        comissaoTipoVenda: "a_receber",
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
    // Financeiro (fatia 4a): categorias e contador já vêm do limparBanco; uma linha em cada tabela nova.
    const [cat] = await sql`select id from categorias_financeiras where sistema = 'vendas_viagem'`;
    const [cb] = await sql`insert into contas_bancarias (nome, saldo_inicial, saldo_inicial_em) values ('Banco', 0, '2027-01-01') returning id`;
    await sql`insert into lancamentos (lado, descricao, categoria_id, centro, competencia, emissao, vencimento, valor, forma, conta_bancaria_id, criado_por)
              values ('receber', 'Teste', ${cat.id}, 'MT', '2027-01', '2027-01-01', '2027-01-10', 100, 'pix', ${cb.id}, ${u.id})`;
    const [fat] = await sql`insert into faturas (venda_id, numero, emitida_por) values (${venda.id}, 1405, ${u.id}) returning id`;
    await sql`insert into faturas_versoes (fatura_id, versao, emitida_por, dados) values (${fat.id}, 1, ${u.id}, '{}')`;
    // Fatia 4b: um anexo (só a linha; o objeto no Storage não importa para o RLS da tabela).
    await sql`insert into anexos (dono_tipo, dono_id, caminho, nome, mime, tamanho, enviado_por)
              values ('parcela', ${venda.id}, 'parcela/teste/rls', 'rls.pdf', 'application/pdf', 10, ${u.id})`;
    // Fatia 4b: um cartão corporativo e uma fatura dele.
    const [cartao] = await sql`insert into cartoes_corporativos (nome, final, dia_fechamento, dia_vencimento, conta_bancaria_id, centro)
              values ('Visa', '1234', 15, 25, ${cb.id}, 'MT') returning id`;
    await sql`insert into faturas_cartao (cartao_id, fechamento, vencimento) values (${cartao.id}, '2027-01-15', '2027-01-25')`;
    // Operação (fatia 5a): uma linha em cada tabela nova.
    await sql`insert into tarefas (viagem_id, categoria, item, ordem) values (${v.id}, 'conferir', 'Teste', 1)`;
    const [rot] = await sql`insert into roteiros (viagem_id, idioma, fuso, conteudo) values (${v.id}, 'italiano', 'Europe/Rome', '{"dias":[],"hoteis":[],"voos":[]}') returning id`;
    await sql`insert into dailies (roteiro_id, data) values (${rot.id}, '2027-08-14')`;
    // Conciliação (fatia 6b): um extrato e uma transação.
    const [ext] = await sql`insert into extratos (conta_bancaria_id, arquivo_nome, arquivo_hash, transacoes, repetidas, importado_por)
              values (${cb.id}, 'teste.ofx', 'hash-rls', 1, 0, ${u.id}) returning id`;
    await sql`insert into extrato_transacoes (extrato_id, conta_bancaria_id, fitid, data, valor, descricao)
              values (${ext.id}, ${cb.id}, 'F1', '2027-01-10', 100, 'Teste')`;
    // Integrações (fatia 6c): um envio na fila.
    await sql`insert into integracao_envios (integracao, tipo, viagem_id, chave, payload)
              values ('trello', 'cartao_viagem', ${v.id}, ${"venda:" + v.id}, '{}')`;
    // IA (fatia 6c): um uso registrado.
    await sql`insert into ia_usos (usuario_id, recurso, modelo, tokens_entrada, tokens_saida)
              values (${u.id}, 'reescrever:dica', 'claude-opus-5-5', 10, 5)`;
    // Estoque e caixa de experiência (fatia 5b).
    const [prod] = await sql<{ id: string }[]>`insert into produtos_estoque (nome, uso) values ('Caderno', 'caixa_experiencia') returning id`;
    await sql`insert into estoque_saldos (produto_id, filial, quantidade, custo_medio) values (${prod.id}, 'MT', 3, 1500)`;
    await sql`insert into estoque_movimentos (produto_id, filial, tipo, quantidade, custo_unitario, custo_medio_antes, usuario_id)
              values (${prod.id}, 'MT', 'entrada', 3, 1500, 0, ${u.id})`;
    const [cx] = await sql<{ id: string }[]>`insert into caixas_experiencia (viagem_id, filial, criado_por) values (${v.id}, 'MT', ${u.id}) returning id`;
    await sql`insert into caixa_itens (caixa_id, produto_id, quantidade) values (${cx.id}, ${prod.id}, 1)`;
    // Reembolsos (fatia 5b).
    await sql`insert into reembolsos (viagem_id, servico, ocorrido_em, ocorrido, valor_cobrar, valor_devolver, forma_devolucao, prazo_cliente, previsto_fornecedor, criado_por)
              values (${v.id}, 'Hotel', '2027-01-05', 'O hotel cancelou a reserva.', 10000, 8000, 'pix', '2027-01-20', '2027-01-30', ${u.id})`;
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from lancamentos_financeiros`;
    expect(n).toBeGreaterThan(0);
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
    "categorias_financeiras",
    "contas_bancarias",
    "lancamentos",
    "faturas_contador",
    "faturas",
    "faturas_versoes",
    "lancamentos_financeiros",
    "anexos",
    "notas_fiscais",
    "cartoes_corporativos",
    "faturas_cartao",
    "tarefas",
    "roteiros",
    "dailies",
    "extratos",
    "extrato_transacoes",
    "integracao_envios",
    "ia_usos",
    "produtos_estoque",
    "estoque_saldos",
    "estoque_movimentos",
    "caixas_experiencia",
    "caixa_itens",
    "reembolsos",
  ]) {
    it(`anon não enxerga linhas de ${tabela}`, async () => {
      const { data, error } = await anon().from(tabela).select("*");
      expect(error ? [] : data).toEqual([]);
    });
  }

  it("tabelas do financeiro com RLS ligado", async () => {
    const tabelas = ["categorias_financeiras", "contas_bancarias", "lancamentos", "faturas_contador", "faturas", "faturas_versoes", "anexos", "notas_fiscais", "cartoes_corporativos", "faturas_cartao", "extratos", "extrato_transacoes"];
    const rs = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ${sql(tabelas)}`;
    expect(rs.map((r) => [r.relname, r.relrowsecurity]).sort()).toEqual(tabelas.map((t) => [t, true]).sort());
  });

  it("tabelas da operação com RLS ligado", async () => {
    const tabelas = ["tarefas", "roteiros", "dailies"];
    const rs = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ${sql(tabelas)}`;
    expect(rs.map((r) => [r.relname, r.relrowsecurity]).sort()).toEqual(tabelas.map((t) => [t, true]).sort());
  });

  it("tabelas das integrações com RLS ligado", async () => {
    const tabelas = ["integracao_envios", "ia_usos"];
    const rs = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ${sql(tabelas)}`;
    expect(rs.map((r) => [r.relname, r.relrowsecurity]).sort()).toEqual(tabelas.map((t) => [t, true]).sort());
  });

  it("tabelas do estoque e da caixa com RLS ligado", async () => {
    const tabelas = ["produtos_estoque", "estoque_saldos", "estoque_movimentos", "caixas_experiencia", "caixa_itens", "reembolsos"];
    const rs = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname in ${sql(tabelas)}`;
    expect(rs.map((r) => [r.relname, r.relrowsecurity]).sort()).toEqual(tabelas.map((t) => [t, true]).sort());
  });

  it("view lancamentos_financeiros: security_invoker e sem privilégio para anon/authenticated", async () => {
    const [v] = await sql<{ reloptions: string[] | null }[]>`
      select reloptions from pg_class where relnamespace = 'public'::regnamespace and relname = 'lancamentos_financeiros' and relkind = 'v'`;
    expect(v.reloptions).toContain("security_invoker=true");
    for (const papel of ["anon", "authenticated"]) {
      const [p] = await sql<{ ok: boolean }[]>`select has_table_privilege(${papel}, 'public.lancamentos_financeiros', 'SELECT') as ok`;
      expect(p.ok).toBe(false);
    }
  });
});
