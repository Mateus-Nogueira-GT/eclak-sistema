import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { alternarCategoria } from "@/server/actions/financeiro";
import { sql, db } from "@/server/db/client";
import { categoriasFinanceiras } from "@/server/db/schema";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

describe("esquema do estoque e da caixa de experiência", () => {
  let x: Fixture;
  let produto: string;
  let produto2: string;

  const novoProduto = async (nome: string, uso = "caixa_experiencia", ativo = true) =>
    (await sql<{ id: string }[]>`insert into produtos_estoque (nome, uso, ativo) values (${nome}, ${uso}, ${ativo}) returning id`)[0].id;

  const movimento = (extra: Record<string, unknown> = {}) => {
    const linha = { produto_id: produto, filial: "MT", tipo: "entrada", quantidade: 5, custo_unitario: 1000, custo_medio_antes: 0, usuario_id: x.fin.id, ...extra };
    return sql`insert into estoque_movimentos ${sql(linha as unknown as Record<string, string>)}`;
  };

  const caixa = (extra: Record<string, unknown> = {}) => {
    const linha = { viagem_id: x.viagemId, filial: "MT", criado_por: x.fin.id, ...extra };
    return sql`insert into caixas_experiencia ${sql(linha as unknown as Record<string, string>)} returning id`;
  };

  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
    produto = await novoProduto("Caderno");
    produto2 = await novoProduto("Caneta", "papelaria");
  });

  it("saldo: um por produto e filial; quantidade e custo médio não negativos", async () => {
    await sql`insert into estoque_saldos (produto_id, filial, quantidade, custo_medio) values (${produto}, 'MT', 2, 1500)`;
    await expect(sql`insert into estoque_saldos (produto_id, filial) values (${produto}, 'MT')`).rejects.toThrow(/estoque_saldos_pk/);
    await sql`insert into estoque_saldos (produto_id, filial) values (${produto}, 'RS')`;
    await expect(sql`update estoque_saldos set quantidade = -1 where produto_id = ${produto} and filial = 'MT'`).rejects.toThrow(/estoque_saldos_quantidade/);
    await expect(sql`update estoque_saldos set custo_medio = -1 where produto_id = ${produto} and filial = 'MT'`).rejects.toThrow(/estoque_saldos_custo_medio/);
  });

  it("movimento: quantidade 0 recusada; negativa aceita; custo_medio_antes é obrigatório", async () => {
    await expect(movimento({ quantidade: 0 })).rejects.toThrow(/estoque_movimentos_quantidade/);
    await movimento({ tipo: "caixa", quantidade: -2 });
    await expect(sql`insert into estoque_movimentos (produto_id, filial, tipo, quantidade, custo_unitario, usuario_id)
                     values (${produto}, 'MT', 'entrada', 1, 100, ${x.fin.id})`).rejects.toThrow(/custo_medio_antes/);
  });

  it("movimento: o sinal da quantidade segue o tipo (ajuste vai para qualquer lado)", async () => {
    await expect(movimento({ quantidade: -1 })).rejects.toThrow(/estoque_movimentos_sinal/);
    await expect(movimento({ tipo: "devolucao_caixa", quantidade: -1 })).rejects.toThrow(/estoque_movimentos_sinal/);
    await expect(movimento({ tipo: "saida", quantidade: 1, motivo: "Brinde avulso" })).rejects.toThrow(/estoque_movimentos_sinal/);
    await expect(movimento({ tipo: "caixa", quantidade: 2 })).rejects.toThrow(/estoque_movimentos_sinal/);
    await movimento({ tipo: "devolucao_caixa", quantidade: 1 });
    await movimento({ tipo: "ajuste", quantidade: 2, motivo: "Contagem" });
    await movimento({ tipo: "ajuste", quantidade: -2, motivo: "Contagem" });
  });

  it("movimento: motivo de 5 a 200 caracteres em saída e ajuste; fornecedor só na entrada e no máximo um", async () => {
    await expect(movimento({ tipo: "saida", quantidade: -1 })).rejects.toThrow(/estoque_movimentos_motivo/);
    await expect(movimento({ tipo: "ajuste", quantidade: -1, motivo: "ab" })).rejects.toThrow(/estoque_movimentos_motivo/);
    await expect(movimento({ tipo: "saida", quantidade: -1, motivo: "x".repeat(201) })).rejects.toThrow(/estoque_movimentos_motivo/);
    await movimento({ tipo: "saida", quantidade: -1, motivo: "Brinde avulso" });
    await expect(movimento({ fornecedor_id: x.fornecedores.roma, fornecedor_texto: "Loja" })).rejects.toThrow(/estoque_movimentos_um_fornecedor/);
    await expect(movimento({ tipo: "ajuste", quantidade: 1, motivo: "Contagem", fornecedor_texto: "Loja" })).rejects.toThrow(/estoque_movimentos_fornecedor_so_entrada/);
    await movimento({ fornecedor_texto: "Papelaria do Zé" });
  });

  it("produto: segundo ativo com o mesmo nome (sem diferenciar caixa) é recusado; desativado libera o nome", async () => {
    await expect(novoProduto("caderno", "papelaria")).rejects.toThrow(/produtos_estoque_nome_ativo_unico/);
    await expect(novoProduto("CADERNO")).rejects.toThrow(/produtos_estoque_nome_ativo_unico/);
    await novoProduto("Caderno", "caixa_experiencia", false);
    await sql`update produtos_estoque set ativo = false where id = ${produto}`;
    await novoProduto("caderno");
    await expect(sql`update produtos_estoque set minimo_mt = -1 where id = ${produto2}`).rejects.toThrow(/produtos_estoque_minimos/);
  });

  it("caixa: só uma não cancelada por viagem; depois de cancelar a primeira, aceita outra", async () => {
    const [{ id: primeira }] = await caixa();
    await expect(caixa()).rejects.toThrow(/caixas_experiencia_viagem_ativa_unico/);
    await sql`update caixas_experiencia set situacao = 'cancelada', cancelada_em = now(), cancelada_por = ${x.fin.id}, motivo_cancelamento = 'Desistência' where id = ${primeira}`;
    const [{ id: segunda }] = await caixa();
    await sql`update caixas_experiencia set situacao = 'confirmada', custo_total = 4500, confirmada_em = now(), confirmada_por = ${x.fin.id} where id = ${segunda}`;
    await expect(caixa()).rejects.toThrow(/caixas_experiencia_viagem_ativa_unico/);
  });

  it("caixa: confirmada exige custo total, data e quem; cancelada exige data, quem e motivo", async () => {
    const [{ id }] = await caixa();
    await expect(sql`update caixas_experiencia set situacao = 'confirmada' where id = ${id}`).rejects.toThrow(/caixas_experiencia_confirmacao/);
    await expect(sql`update caixas_experiencia set situacao = 'cancelada' where id = ${id}`).rejects.toThrow(/caixas_experiencia_cancelamento/);
    await expect(sql`update caixas_experiencia set custo_total = -1 where id = ${id}`).rejects.toThrow(/caixas_experiencia_custo_total|caixas_experiencia_confirmacao/);
  });

  it("item: produto repetido na mesma caixa recusado; quantidade ≥ 1; custo nulo no rascunho", async () => {
    const [{ id }] = await caixa();
    await sql`insert into caixa_itens (caixa_id, produto_id, quantidade) values (${id}, ${produto}, 2)`;
    await expect(sql`insert into caixa_itens (caixa_id, produto_id, quantidade) values (${id}, ${produto}, 1)`).rejects.toThrow(/caixa_itens_caixa_produto_unico/);
    await expect(sql`insert into caixa_itens (caixa_id, produto_id, quantidade) values (${id}, ${produto2}, 0)`).rejects.toThrow(/caixa_itens_quantidade/);
    await expect(sql`insert into caixa_itens (caixa_id, produto_id, quantidade, custo_unitario) values (${id}, ${produto2}, 1, -5)`).rejects.toThrow(/caixa_itens_custo_unitario/);
    const [item] = await sql`select custo_unitario from caixa_itens where caixa_id = ${id}`;
    expect(item.custo_unitario).toBeNull();
  });

  it("lançamento ligado ao movimento de entrada; o movimento não pode ser apagado enquanto a conta o referencia", async () => {
    const [cat] = await sql`select id from categorias_financeiras where sistema = 'caixa_experiencia'`;
    const [mov] = await sql`insert into estoque_movimentos (produto_id, filial, tipo, quantidade, custo_unitario, custo_medio_antes, usuario_id)
                            values (${produto}, 'MT', 'entrada', 5, 1000, 0, ${x.fin.id}) returning id`;
    const [lan] = await sql`insert into lancamentos (lado, descricao, pessoa_texto, categoria_id, centro, competencia, emissao, vencimento, valor, forma, criado_por, estoque_movimento_id)
                            values ('pagar', 'Estoque: 5 × Caderno', 'Loja', ${cat.id}, 'MT', '2026-11', '2026-11-01', '2026-11-10', 5000, 'boleto', ${x.fin.id}, ${mov.id}) returning id`;
    await sql`update estoque_movimentos set lancamento_id = ${lan.id} where id = ${mov.id}`;
    await expect(sql`delete from estoque_movimentos where id = ${mov.id}`).rejects.toThrow(/foreign key|violates/);
  });

  it("as quatro categorias de sistema novas existem e não podem ser desativadas", async () => {
    const dir = await criarUsuarioTeste("diretor");
    for (const slug of ["reembolso_cliente", "reembolso_fornecedor", "caixa_experiencia", "papelaria"]) {
      const [cat] = await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, slug as "papelaria"));
      expect(cat).toBeDefined();
      const r = await comSessao(dir.id, () => alternarCategoria(cat.id, false));
      expect(r).toMatchObject({ ok: false, erro: expect.stringContaining("não pode ser desativada") });
      expect((await db.select().from(categoriasFinanceiras).where(eq(categoriasFinanceiras.id, cat.id)))[0].ativa).toBe(true);
    }
  });
});
