import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { sql } from "@/server/db/client";
import { limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

describe("esquema dos reembolsos", () => {
  let x: Fixture;

  const caso = (extra: Record<string, unknown> = {}) => {
    const linha = {
      viagem_id: x.viagemId,
      servico: "Hotel Palazzo",
      ocorrido_em: "2027-01-05",
      ocorrido: "O hotel cancelou a reserva.",
      valor_cobrar: 10000,
      valor_devolver: 8000,
      forma_devolucao: "pix",
      prazo_cliente: "2027-01-20",
      previsto_fornecedor: "2027-01-30",
      criado_por: x.fin.id,
      ...extra,
    };
    return sql`insert into reembolsos ${sql(linha as unknown as Record<string, string>)} returning id`;
  };

  beforeEach(async () => {
    await limparBanco();
    x = await vendida();
  });

  it("não guarda situação nem o estado das baixas (o caso lê as contas)", async () => {
    const cols = (await sql<{ column_name: string }[]>`select column_name from information_schema.columns where table_name = 'reembolsos'`).map((c) => c.column_name);
    for (const c of ["situacao", "recebido_em", "valor_recebido", "valor_devolvido"]) expect(cols).not.toContain(c);
    expect(cols).toEqual(expect.arrayContaining(["reembolsado_em", "cancelado_em", "cancelado_por", "motivo_cancelamento"]));
    const enums = await sql`select 1 from pg_type where typname = 'situacao_reembolso'`;
    expect(enums).toHaveLength(0);
  });

  it("aceita o caso completo, só cobrar (sem devolver) e só devolver (sem previsto)", async () => {
    await caso();
    await caso({ valor_devolver: 0 });
    await caso({ valor_cobrar: 0, previsto_fornecedor: null });
  });

  it("valores: não negativos e pelo menos um maior que zero", async () => {
    await expect(caso({ valor_cobrar: 0, valor_devolver: 0, previsto_fornecedor: null })).rejects.toThrow(/reembolsos_valores/);
    await expect(caso({ valor_devolver: -1 })).rejects.toThrow(/reembolsos_valores/);
    await expect(caso({ valor_cobrar: -1, valor_devolver: 5 })).rejects.toThrow(/reembolsos_valores/);
  });

  it("previsto do fornecedor é obrigatório quando há valor a cobrar", async () => {
    await expect(caso({ previsto_fornecedor: null })).rejects.toThrow(/reembolsos_previsto/);
  });

  it("ocorrido: 10 a 1.000 caracteres", async () => {
    await expect(caso({ ocorrido: "curto" })).rejects.toThrow(/reembolsos_ocorrido/);
    await caso({ ocorrido: "x".repeat(10) });
    await caso({ ocorrido: "x".repeat(1000) });
    await expect(caso({ ocorrido: "x".repeat(1001) })).rejects.toThrow(/reembolsos_ocorrido/);
  });

  it("cancelamento: os três campos juntos", async () => {
    await expect(caso({ cancelado_em: "2027-02-01T10:00:00Z" })).rejects.toThrow(/reembolsos_cancelamento/);
    await expect(caso({ cancelado_em: "2027-02-01T10:00:00Z", cancelado_por: x.fin.id })).rejects.toThrow(/reembolsos_cancelamento/);
    await expect(caso({ motivo_cancelamento: "Erro" })).rejects.toThrow(/reembolsos_cancelamento/);
    await caso({ cancelado_em: "2027-02-01T10:00:00Z", cancelado_por: x.fin.id, motivo_cancelamento: "Lançado por engano" });
  });

  it("forma de devolução fora do enum é recusada", async () => {
    await expect(caso({ forma_devolucao: "dinheiro" })).rejects.toThrow(/forma_devolucao/);
  });

  it("lancamentos.reembolso_id tem FK: id inexistente recusado e caso com conta ligada não se apaga", async () => {
    const [{ id }] = await caso();
    const [cat] = await sql<{ id: string }[]>`select id from categorias_financeiras where nome = 'Aluguel'`;
    const conta = (reembolsoId: string) => sql`
      insert into lancamentos (lado, descricao, categoria_id, centro, competencia, emissao, vencimento, valor, forma, reembolso_id, criado_por)
      values ('receber', 'Reembolso', ${cat.id}, 'MT', '2027-01', '2027-01-05', '2027-01-30', 10000, 'transferencia', ${reembolsoId}, ${x.fin.id})`;
    await expect(conta("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/lancamentos_reembolso_id_reembolsos_id_fk/);
    await conta(id);
    await expect(sql`delete from reembolsos where id = ${id}`).rejects.toThrow(/lancamentos_reembolso_id_reembolsos_id_fk/);
  });
});
