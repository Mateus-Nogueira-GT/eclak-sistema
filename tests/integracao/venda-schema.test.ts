import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "@/server/db/client";
import { criarUsuarioTeste, limparBanco } from "../helpers/db";

describe("esquema da venda: restrições", () => {
  let viagemId: string;
  let versaoId: string;
  let usuarioId: string;

  beforeEach(async () => {
    await limparBanco();
    const u = await criarUsuarioTeste("diretor");
    usuarioId = u.id;
    const [c] = await sql`insert into clientes (grupo, tipo, filial, telefone) values ('G', 'familia', 'Rondonópolis', '66999999999') returning id`;
    const [v] = await sql`insert into viagens (cliente_id, seq, destino, inicio, fim, filial, consultor_id) values (${c.id}, 1, 'X', '2027-08-14', '2027-09-01', 'Rondonópolis', ${u.id}) returning id, internacional, status`;
    expect(v.internacional).toBe(true);
    viagemId = v.id;
    const [r] = await sql`insert into regras_versoes (valores) values ('{}') returning id`;
    const [ver] = await sql`insert into versoes_precificacao (viagem_id, numero, snapshot, preco, forma, dias, regras_versao_id, rateio, resultado, enviado_por) values (${v.id}, 1, '{}', 1, '{}', 1, ${r.id}, 'pax', '{}', ${u.id}) returning id`;
    versaoId = ver.id;
  });

  const inserirVenda = (doc: string, total = 100n) =>
    sql`insert into vendas (viagem_id, versao_id, aceite_em, forma, parcelas, primeiro_vencimento, total, fatura_nome, fatura_documento, criado_por)
        values (${viagemId}, ${versaoId}, '2027-01-01', '{}', 1, '2027-02-01', ${total}, 'N', ${doc}, ${usuarioId})`;

  it("aceita status vendida na viagem", async () => {
    await sql`update viagens set status = 'vendida' where id = ${viagemId}`;
  });

  it("aceita CPF e CNPJ só com dígitos", async () => {
    await inserirVenda("12345678901");
  });

  it("recusa documento com máscara ou tamanho errado", async () => {
    await expect(inserirVenda("123.456.789-01")).rejects.toThrow(/vendas_fatura_documento/);
    await expect(inserirVenda("1234567890")).rejects.toThrow(/vendas_fatura_documento/);
  });

  it("recusa total negativo", async () => {
    await expect(inserirVenda("12345678901", -1n)).rejects.toThrow(/vendas_total_nao_negativo/);
  });

  it("recusa segunda venda da mesma viagem", async () => {
    await inserirVenda("12345678901");
    await expect(inserirVenda("12345678000199")).rejects.toThrow(/vendas_viagem_unico/);
  });
});
