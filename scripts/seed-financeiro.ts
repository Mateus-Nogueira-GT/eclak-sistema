/**
 * Financeiro do seed local: duas contas bancárias, os lançamentos "lançados à mão" do protótipo (contasIniciais, sem
 * origem) com datas relativas a hoje (America/Cuiabá), alguns baixados, e a fatura da venda da Família Ribeiro
 * emitida pelo mesmo núcleo do app (`emitirFaturaNa`, numeração sem buracos a partir do contador), um cartão
 * corporativo com três compras no ciclo atual (a fatura vem do `cicloDoCartao`, a regra do app) e uma nota fiscal sem anexo.
 * Idempotente: conta por nome, lançamento (ou série) pela descrição, fatura por venda, cartão por nome, compra
 * por descrição + cartão e nota pelo número.
 */
import { hojeEmCuiaba } from "../src/domain/clientes";
import { cicloDoCartao } from "../src/domain/caixa";
import { dividirEmParcelas, datasRecorrentes } from "../src/domain/financeiro";
import { somarMeses } from "../src/domain/venda";
import { centavos, type Sql } from "./seed-orcamentos";

const CONTAS = [
  { nome: "Banco do Brasil", banco: "001", saldo: 25000 },
  { nome: "Bradesco PJ", banco: "237", saldo: 8000 },
] as const;

function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

type Slug = "boleto" | "pix" | "transferencia";

type Serie = {
  lado: "pagar" | "receber";
  descricao: string;
  /** Texto livre (`pessoa_texto`) ou, em `cliente`, o grupo de um cliente do seed. */
  pessoa: string;
  cliente?: string;
  categoria: string;
  centro: "MT" | "RS";
  forma: Slug;
  valor: bigint; // total do parcelado ou valor de cada ocorrência
  /** Vencimento da primeira linha da série. */
  primeiro: string;
  repeticao: { tipo: "unica" } | { tipo: "parcelado"; n: number } | { tipo: "recorrente"; n: number };
  /** Quantas linhas, desde a primeira, já estão baixadas (na conta dada). */
  baixadas?: number;
  conta?: (typeof CONTAS)[number]["nome"];
  competenciaAtrasada?: boolean;
};

function series(hoje: string): Serie[] {
  return [
    { lado: "pagar", descricao: "Celular da agência", pessoa: "Vivo", categoria: "Telefone", centro: "MT", forma: "boleto", valor: centavos(168.23 * 6), primeiro: somarMeses(somarDias(hoje, -5), -4), repeticao: { tipo: "parcelado", n: 6 }, baixadas: 4, conta: "Banco do Brasil" },
    { lado: "pagar", descricao: "Seguro do escritório", pessoa: "Seguradora", categoria: "Seguros", centro: "MT", forma: "pix", valor: centavos(10349.24), primeiro: hoje, repeticao: { tipo: "parcelado", n: 11 } },
    { lado: "pagar", descricao: "Aluguel do escritório", pessoa: "Imobiliária Centro", categoria: "Aluguel", centro: "MT", forma: "boleto", valor: centavos(4200), primeiro: somarMeses(somarDias(hoje, 3), -3), repeticao: { tipo: "recorrente", n: 12 }, baixadas: 3, conta: "Banco do Brasil" },
    { lado: "pagar", descricao: "Honorários da consultoria contábil", pessoa: "Consultoria contábil", categoria: "Serviços contratados", centro: "MT", forma: "pix", valor: centavos(6000), primeiro: somarMeses(somarDias(hoje, 1), -2), repeticao: { tipo: "recorrente", n: 12 }, baixadas: 2, conta: "Bradesco PJ" },
    { lado: "pagar", descricao: "DARF", pessoa: "Receita Federal", categoria: "Impostos federais", centro: "MT", forma: "boleto", valor: centavos(778.71), primeiro: somarDias(hoje, -2), repeticao: { tipo: "unica" } },
    { lado: "pagar", descricao: "FGTS Digital", pessoa: "Caixa Econômica", categoria: "FGTS", centro: "RS", forma: "boleto", valor: centavos(377.08), primeiro: hoje, repeticao: { tipo: "unica" } },
    { lado: "pagar", descricao: "Reembolso do táxi ao aeroporto em Santorini", pessoa: "Casal Fontana", cliente: "Casal Fontana", categoria: "Reembolso a cliente", centro: "MT", forma: "pix", valor: centavos(411.45), primeiro: somarDias(hoje, 2), repeticao: { tipo: "unica" } },
    { lado: "receber", descricao: "Comissões de outubro", pessoa: "Expedia TAAP", categoria: "Comissões de hotel", centro: "MT", forma: "transferencia", valor: centavos(1824), primeiro: somarDias(hoje, -18), repeticao: { tipo: "unica" }, baixadas: 1, conta: "Banco do Brasil" },
    { lado: "receber", descricao: "Rendimentos da aplicação", pessoa: "Banco do Brasil", categoria: "Rendimentos", centro: "MT", forma: "transferencia", valor: centavos(312.5), primeiro: somarDias(hoje, 5), repeticao: { tipo: "unica" } },
  ];
}

async function garantirContas(sql: Sql): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const c of CONTAS) {
    const [e] = await sql`select id from contas_bancarias where nome = ${c.nome} and ativa and excluido_em is null`;
    if (e) {
      ids.set(c.nome, e.id as string);
      continue;
    }
    const [n] = await sql`
      insert into contas_bancarias (nome, banco, saldo_inicial, saldo_inicial_em)
      values (${c.nome}, ${c.banco}, ${centavos(c.saldo).toString()}, '2026-01-01') returning id`;
    ids.set(c.nome, n.id as string);
  }
  return ids;
}

async function semearLancamentos(sql: Sql, contas: Map<string, string>): Promise<number> {
  const [dir] = await sql`select id from usuarios where email = 'diretor@eclak.local'`;
  if (!dir) throw new Error("Falta o usuário diretor do seed");
  const hoje = hojeEmCuiaba();
  let criados = 0;
  for (const s of series(hoje)) {
    const [existe] = await sql`select 1 from lancamentos where descricao = ${s.descricao} and criado_por = ${dir.id}`;
    if (existe) continue;
    const [cat] = await sql`select id from categorias_financeiras where lado = ${s.lado} and nome = ${s.categoria}`;
    if (!cat) throw new Error(`Categoria do seed não existe: ${s.categoria}`);
    let clienteId: string | null = null;
    if (s.cliente) {
      const [cl] = await sql`select id from clientes where grupo = ${s.cliente} and excluido_em is null`;
      clienteId = (cl?.id as string | undefined) ?? null;
    }
    const itens =
      s.repeticao.tipo === "unica"
        ? [{ vencimento: s.primeiro, valor: s.valor, numero: null as number | null, total: null as number | null }]
        : s.repeticao.tipo === "parcelado"
          ? dividirEmParcelas(s.valor, s.repeticao.n, s.primeiro).map((x) => ({ vencimento: x.vencimento, valor: x.valor, numero: x.numero as number | null, total: x.total as number | null }))
          : datasRecorrentes(s.primeiro, "mensal", s.repeticao.n).map((d, i) => ({ vencimento: d, valor: s.valor, numero: i + 1 as number | null, total: s.repeticao.tipo === "recorrente" ? s.repeticao.n : null }));
    const grupoId = s.repeticao.tipo === "unica" ? null : crypto.randomUUID();
    const contaId = s.conta ? contas.get(s.conta)! : null;
    await sql.begin(async (tx) => {
      for (const [i, it] of itens.entries()) {
        const baixada = i < (s.baixadas ?? 0);
        const mesesDeslocados = (Number(it.vencimento.slice(0, 4)) * 12 + Number(it.vencimento.slice(5, 7))) - (Number(s.primeiro.slice(0, 4)) * 12 + Number(s.primeiro.slice(5, 7)));
        const competencia = somarMeses(`${s.primeiro.slice(0, 7)}-01`, mesesDeslocados).slice(0, 7);
        await tx`
          insert into lancamentos (lado, descricao, cliente_id, pessoa_texto, categoria_id, centro, competencia, emissao, vencimento, valor, forma,
                                   conta_bancaria_id, grupo_id, parcela_numero, parcela_total, status, baixado_em, valor_pago, juros, desconto,
                                   baixa_conta_bancaria_id, criado_por)
          values (${s.lado}, ${s.descricao}, ${clienteId}, ${clienteId ? null : s.pessoa}, ${cat.id}, ${s.centro}, ${competencia}, ${somarDias(it.vencimento, -10)},
                  ${it.vencimento}, ${it.valor.toString()}, ${s.forma}, ${contaId}, ${grupoId}, ${it.numero}, ${it.total},
                  ${baixada ? "baixado" : "em_aberto"}, ${baixada ? it.vencimento : null}, ${baixada ? it.valor.toString() : null},
                  ${baixada ? "0" : null}, ${baixada ? "0" : null}, ${baixada ? contaId : null}, ${dir.id})`;
        criados++;
      }
    });
  }
  return criados;
}

/** Emite a fatura da venda da Família Ribeiro pelo núcleo do app (uma vez; a numeração vem do contador). */
async function emitirFaturas(sql: Sql): Promise<number> {
  const [v] = await sql`
    select v.id from vendas v join viagens vi on vi.id = v.viagem_id join clientes c on c.id = vi.cliente_id
    where c.grupo = 'Família Ribeiro' and not exists (select 1 from faturas f where f.venda_id = v.id)
    order by v.criado_em limit 1`;
  if (!v) return 0;
  const [dir] = await sql`select id from usuarios where email = 'diretor@eclak.local'`;
  // Imports dinâmicos: o cliente do app lê DATABASE_URL no carregamento (o dotenv já rodou) e `server-only`
  // exige a condição `react-server` (ver o script `seed:local`).
  const { db, sql: appSql } = await import("../src/server/db/client");
  const { emitirFaturaNa } = await import("../src/server/financeiro/faturas");
  try {
    const r = await db.transaction((tx) => emitirFaturaNa(tx, dir.id as string, v.id as string));
    if (!r.ok) throw new Error(`Fatura do seed recusada: ${JSON.stringify(r)}`);
    return 1;
  } finally {
    await appSql.end();
  }
}

/** Um cartão corporativo com três compras manuais no ciclo atual; cada compra aponta para a fatura do seu ciclo. */
async function semearCartao(sql: Sql, contas: Map<string, string>): Promise<{ cartoes: number; compras: number }> {
  const [dir] = await sql`select id from usuarios where email = 'diretor@eclak.local'`;
  if (!dir) throw new Error("Falta o usuário diretor do seed");
  const fechamentoDia = 5;
  const vencimentoDia = 15;
  let cartoes = 0;
  let [cartao] = await sql`select id from cartoes_corporativos where nome = 'Visa Corporativo' and ativo`;
  if (!cartao) {
    [cartao] = await sql`
      insert into cartoes_corporativos (nome, final, dia_fechamento, dia_vencimento, conta_bancaria_id, centro)
      values ('Visa Corporativo', '4821', ${fechamentoDia}, ${vencimentoDia}, ${contas.get("Banco do Brasil")!}, 'MT') returning id`;
    cartoes++;
  }
  const hoje = hojeEmCuiaba();
  const [cat] = await sql`select id from categorias_financeiras where lado = 'pagar' and nome = 'Serviços contratados'`;
  const [catPapelaria] = await sql`select id from categorias_financeiras where lado = 'pagar' and nome = 'Papelaria'`;
  if (!cat || !catPapelaria) throw new Error("Categorias do seed do cartão não existem");
  const compras = [
    { descricao: "Assinatura de ferramenta de reservas", pessoa: "Provedor de software", categoria: cat.id, dias: -6, valor: centavos(389.9) },
    { descricao: "Material de escritório no cartão", pessoa: "Papelaria Central", categoria: catPapelaria.id, dias: -3, valor: centavos(215.4) },
    { descricao: "Hospedagem do site da agência", pessoa: "Provedor de hospedagem", categoria: cat.id, dias: -1, valor: centavos(129) },
  ];
  let criadas = 0;
  for (const c of compras) {
    const [existe] = await sql`select 1 from lancamentos where descricao = ${c.descricao} and cartao_id = ${cartao.id}`;
    if (existe) continue;
    const data = somarDias(hoje, c.dias);
    const ciclo = cicloDoCartao(data, fechamentoDia, vencimentoDia);
    await sql.begin(async (tx) => {
      await tx`
        insert into faturas_cartao (cartao_id, fechamento, vencimento) values (${cartao.id}, ${ciclo.fechamento}, ${ciclo.vencimento})
        on conflict (cartao_id, fechamento) do nothing`;
      const [fat] = await tx`select id from faturas_cartao where cartao_id = ${cartao.id} and fechamento = ${ciclo.fechamento}`;
      await tx`
        insert into lancamentos (lado, descricao, pessoa_texto, categoria_id, centro, competencia, emissao, vencimento, valor, forma,
                                 cartao_id, fatura_cartao_id, status, criado_por)
        values ('pagar', ${c.descricao}, ${c.pessoa}, ${c.categoria}, 'MT', ${data.slice(0, 7)}, ${data}, ${data}, ${c.valor.toString()},
                'cartao_credito', ${cartao.id}, ${fat.id}, 'em_aberto', ${dir.id})`;
    });
    criadas++;
  }
  return { cartoes, compras: criadas };
}

/** Uma nota fiscal emitida, sem PDF anexo. */
async function semearNotaFiscal(sql: Sql): Promise<number> {
  const numero = "1001";
  const [existe] = await sql`select 1 from notas_fiscais where numero = ${numero}`;
  if (existe) return 0;
  const [dir] = await sql`select id from usuarios where email = 'diretor@eclak.local'`;
  if (!dir) throw new Error("Falta o usuário diretor do seed");
  const hoje = hojeEmCuiaba();
  await sql`
    insert into notas_fiscais (numero, emitida_em, competencia, valor, destinatario, documento, observacao, criado_por)
    values (${numero}, ${somarDias(hoje, -7)}, ${hoje.slice(0, 7)}, ${centavos(2500).toString()}, 'Família Ribeiro', '11144477735',
            'Serviço de assessoria de viagem (seed local)', ${dir.id})`;
  return 1;
}

/** Devolve quantos lançamentos, faturas, cartões, compras no cartão e notas foram criados nesta execução. */
export async function semearFinanceiro(sql: Sql): Promise<{ lancamentos: number; faturas: number; cartoes: number; compras: number; notas: number }> {
  const contas = await garantirContas(sql);
  const lancamentos = await semearLancamentos(sql, contas);
  const faturas = await emitirFaturas(sql);
  const { cartoes, compras } = await semearCartao(sql, contas);
  const notas = await semearNotaFiscal(sql);
  return { lancamentos, faturas, cartoes, compras, notas };
}
