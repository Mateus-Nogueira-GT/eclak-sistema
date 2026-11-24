/**
 * Conciliação do seed local: um extrato sintético (descrições fictícias) na conta "Banco do Brasil" com três
 * transações: uma que confere com a baixa "Comissões de outubro", uma com diferença de R$ 2,00 em relação à baixa do
 * "Aluguel do escritório" e uma tarifa pendente (a que aparece no aviso da Visão geral). Idempotente: o extrato é
 * identificado pelo hash fixo (conta + hash é único) e as transações pelo FITID (conta + FITID é único).
 */
import { hojeEmCuiaba } from "../src/domain/clientes";
import { somarDias } from "../src/domain/venda";
import { centavos, type Sql } from "./seed-orcamentos";

const HASH = "seed-local-extrato-sintetico-v1";

/** Devolve quantas transações foram criadas nesta execução. */
export async function semearConciliacao(sql: Sql): Promise<number> {
  const [conta] = await sql`select id from contas_bancarias where nome = 'Banco do Brasil' and ativa and excluido_em is null`;
  const [dir] = await sql`select id from usuarios where email = 'diretor@eclak.local'`;
  if (!conta || !dir) throw new Error("Faltam a conta Banco do Brasil e o diretor do seed");

  const baixa = async (descricao: string) => {
    const [l] = await sql`
      select id, baixado_em::text as data, valor_pago from lancamentos
      where descricao = ${descricao} and status = 'baixado' and baixa_conta_bancaria_id = ${conta.id}
      order by baixado_em desc limit 1`;
    return l;
  };
  const comissao = await baixa("Comissões de outubro");
  const aluguel = await baixa("Aluguel do escritório");
  const hoje = hojeEmCuiaba();

  return sql.begin(async (tx) => {
    let [ext] = await tx`select id from extratos where conta_bancaria_id = ${conta.id} and arquivo_hash = ${HASH}`;
    if (!ext) {
      [ext] = await tx`
        insert into extratos (conta_bancaria_id, arquivo_nome, arquivo_hash, banco_ofx, conta_ofx, inicio, fim, transacoes, repetidas, importado_por)
        values (${conta.id}, 'extrato-exemplo.ofx', ${HASH}, '0001', '12345-6', ${somarDias(hoje, -30)}, ${hoje}, 0, 0, ${dir.id}) returning id`;
    }
    const transacoes = [
      { fitid: "SEED-CONFERE", data: comissao?.data ?? somarDias(hoje, -18), valor: centavos(1824), descricao: "CREDITO COMISSAO HOTEIS EXEMPLO", par: comissao },
      { fitid: "SEED-DIFERENCA", data: aluguel?.data ?? somarDias(hoje, -27), valor: -centavos(4202), descricao: "PAGTO ALUGUEL IMOBILIARIA EXEMPLO", par: aluguel },
      { fitid: "SEED-TARIFA", data: somarDias(hoje, -8), valor: -centavos(45), descricao: "TARIFA MANUTENCAO DE CONTA", par: null },
    ];
    let criadas = 0;
    for (const t of transacoes) {
      const [existe] = await tx`select 1 from extrato_transacoes where conta_bancaria_id = ${conta.id} and fitid = ${t.fitid}`;
      if (existe) continue;
      // Sem a baixa no banco (seed parcial), a transação fica pendente em vez de falhar.
      const conciliada = t.par !== null && t.par !== undefined;
      await tx`
        insert into extrato_transacoes (extrato_id, conta_bancaria_id, fitid, data, valor, tipo, descricao, situacao, linha_origem, linha_id, conciliada_por, conciliada_em)
        values (${ext.id}, ${conta.id}, ${t.fitid}, ${t.data}, ${t.valor.toString()}, 'OTHER', ${t.descricao},
                ${conciliada ? "conciliada" : "pendente"}::situacao_extrato, ${conciliada ? "manual" : null}, ${conciliada ? t.par.id : null},
                ${conciliada ? dir.id : null}, ${conciliada ? new Date() : null})`;
      criadas++;
    }
    if (criadas > 0) {
      const [n] = await tx`select count(*)::int as n from extrato_transacoes where extrato_id = ${ext.id}`;
      await tx`update extratos set transacoes = ${n.n} where id = ${ext.id}`;
    }
    return criadas;
  });
}
