/**
 * Viagens vendidas do seed local: Família Ribeiro (Portugal e Espanha, em viagem, caso do protótipo) e Casal
 * Vasconcelos (Roma e Amalfi, conciliada). Idempotente por cliente + destino. Usa as mesmas funções de domínio
 * do fechamento da venda (src/domain/venda.ts), sem imports de servidor.
 */
import type postgres from "postgres";
import { converter } from "../src/domain/cambio";
import { hojeEmCuiaba } from "../src/domain/clientes";
import type { ResultadoVersao } from "../src/domain/aprovacoes";
import { formatarReais } from "../src/domain/dinheiro";
import type { FormaPagamento } from "../src/domain/precificacao";
import {
  alocarTaxasPrevistas,
  aplicarFormaFornecedor,
  contasDoSnapshot,
  cronogramaRecebimento,
  meioDaForma,
  reprevisarLinhas,
  vencimentoPadraoFornecedor,
} from "../src/domain/venda";
import { diasDaViagem } from "../src/domain/viagens";
import {
  centavos,
  contextoSeed,
  inserirOrcamento,
  precoDasLinhas,
  type Contexto,
  type Criado,
  type Linha,
  type Sql,
} from "./seed-orcamentos";

type Transacao = postgres.TransactionSql;

function somarDias(data: string, dias: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** Linha de hotel: check-in `de` dias depois do início, `noites` diárias. */
function hotel(inicio: string, de: number, noites: number, cidade: string, nome: string, valor: number): Linha {
  return ["Hotelaria", cidade, nome, somarDias(inicio, de), somarDias(inicio, de + noites), noites, valor, null, null, nome];
}

/** `seguro` em centavos de real (fecha o preço no centavo). */
function linhasRibeiro(inicio: string, seguro: bigint): Linha[] {
  return [
    hotel(inicio, 0, 2, "Lisboa", "Hotel Miradouro Sete", 3900),
    hotel(inicio, 2, 1, "Porto", "Quinta Ribeira Alta", 1800),
    hotel(inicio, 3, 2, "Madri", "Residencia Alcalá Norte", 3600),
    hotel(inicio, 5, 1, "Sevilha", "Casa del Azahar", 1700),
    hotel(inicio, 6, 2, "Barcelona", "Hotel Passeig Modernista", 4200),
    hotel(inicio, 8, 1, "Nice", "Hôtel Promenade Azur", 2600),
    hotel(inicio, 9, 2, "Florença", "Palazzo Lungarno Nove", 4100),
    hotel(inicio, 11, 1, "Veneza", "Ca' Laguna Antica", 3400),
    hotel(inicio, 12, 2, "Roma", "Hotel Travertino Roma", 5200),
    [
      "Hotelaria", "Paris", "Maison Rivoli Seize", somarDias(inicio, 14), somarDias(inicio, 17), 3, 0, null, null,
      "Maison Rivoli Seize", { moeda: "EUR", original: 210000n, comercial: "5.9500", aplicado: "6.2000" },
    ],
    ["Transfer", null, "Transfers aeroportos e trens entre cidades", null, null, null, 4800, null, null, "TransEuropa Transfers"],
    ["Passeio", "Lisboa", "Passeio privativo Sintra e Cascais", null, null, null, 2980, null, null, "Sintra Privé Tours"],
    ["Passeio", "Roma", "Passeio privativo Vaticano e Coliseu", null, null, null, 3900, null, null, "Guias Privados Roma"],
    ["Seguro", null, "Seguro viagem Europa, 4 pessoas", null, null, null, Number(seguro) / 100, null, null, "Proteção Viagem Corretora"],
    ["Passeio", "Toscana", "Circuito Toscana e Cinque Terre", null, null, null, 9500, 10, null, "Operadora Mediterrânea"],
    ["Taxa", null, "Taxa de roteiro", null, null, null, 250, null, null],
  ];
}

const FORMA_RIBEIRO: FormaPagamento = { tipo: "boleto", parcelas: 5 };
const ENTRADA = 2_500_000n; // R$ 25.000 em Pix, no aceite
const ALVO_RIBEIRO = 9_000_000n; // R$ 90.000: entrada + 5 boletos de R$ 13.000

/**
 * Valor do seguro (centavos de real) que leva o preço ao cliente a R$ 90.000 (entrada de R$ 25.000 + 5 boletos de
 * R$ 13.000), ou o preço mais perto abaixo. O preço cresce 1,36 centavo por centavo de custo, então nem todo valor
 * é alcançável: o seed testa durações de 16 a 22 dias até achar uma que feche no centavo.
 */
function valoresParaAlvo(hoje: string, ctx: Contexto): { fim: string; seguro: bigint; exato: boolean } {
  const inicio = somarDias(hoje, -5);
  let melhor = { fim: somarDias(hoje, 10), seguro: 0n, preco: -1n };
  for (const dias of [18, 17, 19, 16, 20, 21, 22]) {
    const fim = somarDias(inicio, dias - 1);
    let lo = 0n;
    let hi = 3_000_000n;
    while (lo < hi) {
      const meio = (lo + hi + 1n) / 2n;
      const { precoCliente } = precoDasLinhas(linhasRibeiro(inicio, meio), FORMA_RIBEIRO, diasDaViagem(inicio, fim), ctx.regras);
      if (precoCliente <= ALVO_RIBEIRO) lo = meio;
      else hi = meio - 1n;
    }
    const { precoCliente } = precoDasLinhas(linhasRibeiro(inicio, lo), FORMA_RIBEIRO, diasDaViagem(inicio, fim), ctx.regras);
    if (precoCliente > melhor.preco) melhor = { fim, seguro: lo, preco: precoCliente };
    if (precoCliente === ALVO_RIBEIRO) break;
  }
  return { fim: melhor.fim, seguro: melhor.seguro, exato: melhor.preco === ALVO_RIBEIRO };
}

async function garantirFornecedor(tx: Transacao, nome: string, modalidade: "net" | "comissionado", comissaoPct: string, tipos: string[]) {
  const [e] = await tx`select 1 from fornecedores where nome = ${nome} and excluido_em is null`;
  if (e) return;
  await tx`
    insert into fornecedores (nome, tipos, modalidade, comissao_pct, tarifa_fixa, desconto_a_vista)
    values (${nome}, ${tipos as unknown as string}::tipo_servico[], ${modalidade}, ${comissaoPct}, 0, 'Não oferece')`;
}

type Fechamento = {
  aceiteEm: string;
  faturaNome: string;
  comprovante: string;
  observacao: string;
  /** Entrada em Pix recebida no aceite; o resto vai no cronograma da forma aprovada. */
  entrada: bigint;
  primeiroVencimento: string;
  /** Marcar tudo como baixado (viagem conciliada). */
  baixarTudo: boolean;
};

type Linhas = {
  parcelas: { id: string; numero: number; valor: bigint; meio: string }[];
  contas: { id: string; descricao: string; moeda: string; previstoBrl: bigint; pagamentos: { id: string; valorOriginal: bigint; valorBrlPrevisto: bigint }[] }[];
  comissoes: { id: string; contaId: string; valorPrevisto: bigint }[];
};

/** Fechamento da venda com as mesmas funções de domínio do servidor (parcelas, contas, pagamentos, comissões). */
async function fechar(tx: Transacao, ctx: Contexto, c: Criado, clienteId: string, f: Fechamento, contaBancariaId: string): Promise<Linhas> {
  const resultado = c.resultado as ResultadoVersao;
  const total = c.precoCliente;
  const forma = c.forma;
  const resto = total - f.entrada;
  const boletos = cronogramaRecebimento(resto, forma.parcelas, f.primeiroVencimento);
  const taxas = alocarTaxasPrevistas(BigInt(resultado.taxa), boletos.map((x) => x.valor));
  const [titular] = await tx`select cpf from pessoas where cliente_id = ${clienteId} and titular and removido_em is null`;
  const [venda] = await tx`
    insert into vendas (viagem_id, versao_id, aceite_em, forma, parcelas, primeiro_vencimento, total, fatura_nome, fatura_documento, comprovante, observacao, criado_por)
    values (${c.viagemId}, ${c.versaoId}, ${f.aceiteEm}, ${tx.json(forma as never)}, ${forma.parcelas}, ${f.primeiroVencimento}, ${total.toString()},
            ${f.faturaNome}, ${titular.cpf}, ${f.comprovante}, ${f.observacao}, ${ctx.consultorId})
    returning id`;

  const nParcelas = boletos.length + (f.entrada > 0n ? 1 : 0);
  const parcelas: Linhas["parcelas"] = [];
  const meio = meioDaForma(forma);
  let numero = 1;
  if (f.entrada > 0n) {
    const [p] = await tx`
      insert into parcelas_receber (viagem_id, venda_id, numero, total_parcelas, vencimento, valor, meio, taxa_prevista, status, recebida_em, valor_recebido, taxa_efetiva, conta_bancaria_id)
      values (${c.viagemId}, ${venda.id}, 1, ${nParcelas}, ${f.aceiteEm}, ${f.entrada.toString()}, 'pix', 0, 'recebida', ${f.aceiteEm}, ${f.entrada.toString()}, 0, ${contaBancariaId})
      returning id`;
    parcelas.push({ id: p.id, numero: 1, valor: f.entrada, meio: "pix" });
    numero = 2;
  }
  for (const [i, b] of boletos.entries()) {
    const [p] = await tx`
      insert into parcelas_receber (viagem_id, venda_id, numero, total_parcelas, vencimento, valor, meio, taxa_prevista, status, recebida_em, valor_recebido, taxa_efetiva, conta_bancaria_id)
      values (${c.viagemId}, ${venda.id}, ${numero + i}, ${nParcelas}, ${b.vencimento}, ${b.valor.toString()}, ${meio}, ${taxas[i].toString()},
              ${f.baixarTudo ? "recebida" : "a_receber"}, ${f.baixarTudo ? b.vencimento : null}, ${f.baixarTudo ? b.valor.toString() : null}, ${f.baixarTudo ? taxas[i].toString() : null},
              ${f.baixarTudo ? contaBancariaId : null})
      returning id`;
    parcelas.push({ id: p.id, numero: numero + i, valor: b.valor, meio });
  }

  const ids = [...new Set(c.snapshot.itens.map((i) => i.escolhida.fornecedorId).filter((x): x is string => x !== null))];
  const mods = ids.length ? await tx`select id, modalidade from fornecedores where id in ${tx(ids)}` : [];
  const contas = contasDoSnapshot(c.snapshot, Object.fromEntries(mods.map((m) => [m.id as string, m.modalidade as "net" | "comissionado"])), c.fim);
  const venc = vencimentoPadraoFornecedor(c.inicio, f.aceiteEm);
  const saida: Linhas = { parcelas, contas: [], comissoes: [] };
  for (const k of contas) {
    const [conta] = await tx`
      insert into contas_pagar (viagem_id, item_id, cotacao_id, fornecedor_id, descricao, aereo, moeda, valor_original, cambio_aplicado,
                                previsto_venda_brl, previsto_brl, comissao_pct, comissao_tipo, comissao_tipo_venda, desconto_a_vista_pct, forma)
      values (${c.viagemId}, ${k.itemId}, ${k.cotacaoId}, ${k.fornecedorId}, ${k.descricao}, ${k.aereo}, ${k.moeda}, ${k.valorOriginal.toString()}, ${k.cambioAplicado},
              ${k.previstoBrl.toString()}, ${k.previstoBrl.toString()}, ${k.comissaoPct}, ${k.comissaoTipo}, ${k.comissaoTipo}, ${k.descontoAVistaPct}, 'a_vista')
      returning id`;
    const linhas = aplicarFormaFornecedor(k, { tipo: "a_vista", vencimento: venc }, k.descontoAVistaPct);
    const pagamentos: Linhas["contas"][number]["pagamentos"] = [];
    for (const l of linhas) {
      const [p] = await tx`
        insert into pagamentos_fornecedor (conta_id, numero, vencimento, valor_original, valor_brl_previsto)
        values (${conta.id}, ${l.numero}, ${l.vencimento ?? venc}, ${l.valorOriginal.toString()}, ${l.valorBrlPrevisto.toString()})
        returning id`;
      pagamentos.push({ id: p.id, valorOriginal: l.valorOriginal, valorBrlPrevisto: l.valorBrlPrevisto });
    }
    saida.contas.push({ id: conta.id, descricao: k.descricao, moeda: k.moeda, previstoBrl: k.previstoBrl, pagamentos });
    if (k.comissao) {
      const [com] = await tx`
        insert into comissoes (viagem_id, conta_id, fornecedor_id, base_brl, pct, valor_previsto, prevista_para)
        values (${c.viagemId}, ${conta.id}, ${k.fornecedorId}, ${k.comissao.baseBrl.toString()}, ${k.comissao.pct}, ${k.comissao.valor.toString()}, ${k.comissao.previstaPara})
        returning id`;
      saida.comissoes.push({ id: com.id, contaId: conta.id, valorPrevisto: k.comissao.valor });
    }
  }
  await tx`update viagens set status = 'vendida', vendida_em = now() where id = ${c.viagemId}`;
  return saida;
}

/** Baixa o pagamento pela conta bancária: BRL pelo previsto; moeda estrangeira com o câmbio efetivo informado. */
async function pagar(
  tx: Transacao,
  pag: Linhas["contas"][number]["pagamentos"][number],
  conta: Linhas["contas"][number],
  pagoEm: string,
  contaBancariaId: string,
  cambio?: string,
) {
  const brl = conta.moeda === "BRL" ? pag.valorBrlPrevisto : converter(pag.valorOriginal, cambio!);
  await tx`
    update pagamentos_fornecedor set status = 'pago', pago_em = ${pagoEm}, valor_original_pago = ${pag.valorOriginal.toString()},
           cambio_efetivo = ${conta.moeda === "BRL" ? null : cambio!}, valor_brl_pago = ${brl.toString()}, conta_bancaria_id = ${contaBancariaId}
    where id = ${pag.id}`;
  await tx`update contas_pagar set status = 'paga' where id = ${conta.id}`;
}

const NOMES_PAGOS_RIBEIRO = [
  "Hotel Miradouro Sete",
  "Quinta Ribeira Alta",
  "Residencia Alcalá Norte",
  "Passeio privativo Sintra e Cascais",
  "Circuito Toscana e Cinque Terre",
  "Maison Rivoli Seize",
];

async function semearRibeiro(sql: Sql, ctx: Contexto, contaBancariaId: string): Promise<boolean> {
  const hoje = hojeEmCuiaba();
  const inicio = somarDias(hoje, -5);
  await sql.begin((tx) => garantirFornecedor(tx, "Operadora Mediterrânea", "comissionado", "10.000", ["Passeio guiado", "Hotelaria"]));
  const { fim, seguro } = valoresParaAlvo(hoje, ctx);
  const [cli] = await sql`select id from clientes where grupo = 'Família Ribeiro' and excluido_em is null`;
  const r = await inserirOrcamento(
    sql,
    ctx,
    {
      cliente: "Família Ribeiro",
      destino: "Portugal e Espanha",
      inicio,
      fim,
      linhas: linhasRibeiro(inicio, seguro),
      forma: FORMA_RIBEIRO,
      desfecho: "aprovada",
      alteracao: "Primeira versão do roteiro.",
    },
    async (tx, c) => {
      const aceiteEm = somarDias(hoje, -50);
      const l = await fechar(tx, ctx, c, cli.id, {
        aceiteEm,
        faturaNome: "Ricardo Ribeiro",
        comprovante: "Aceite por WhatsApp, com o roteiro em PDF.",
        observacao: `Entrada de ${formatarReais(ENTRADA)} em Pix e o restante em ${c.forma.parcelas} boletos mensais.`,
        entrada: ENTRADA,
        primeiroVencimento: somarDias(hoje, 6),
        baixarTudo: false,
      }, contaBancariaId);
      // Pagamentos feitos: cartão e Pix já saíram; Paris em euro com câmbio efetivo acima do da venda.
      for (const conta of l.contas.filter((x) => NOMES_PAGOS_RIBEIRO.includes(x.descricao))) {
        for (const pag of conta.pagamentos) {
          await pagar(tx, pag, conta, somarDias(hoje, -12), contaBancariaId, conta.moeda === "BRL" ? undefined : "6.3500");
        }
      }
      // Florença: o hotel cobrou R$ 1.840 a mais; contestado com o fornecedor.
      const flo = l.contas.find((x) => x.descricao === "Palazzo Lungarno Nove")!;
      const novo = flo.previstoBrl + centavos(1840);
      const novas = reprevisarLinhas(
        flo.pagamentos.map((p) => ({ ...p, pago: false })),
        { original: flo.previstoBrl, brl: flo.previstoBrl },
        { original: novo, brl: novo },
      );
      for (const [i, p] of flo.pagamentos.entries()) {
        await tx`update pagamentos_fornecedor set valor_original = ${novas[i].valorOriginal.toString()}, valor_brl_previsto = ${novas[i].valorBrlPrevisto.toString()} where id = ${p.id}`;
      }
      await tx`
        update contas_pagar set previsto_brl = ${novo.toString()}, valor_original = ${novo.toString()}, motivo_previsto = 'Hotel cobrou R$ 1.840 a mais',
               contestacao = 'Diária reajustada após a cotação e city tax não prevista; pedimos revisão da cobrança.', contestada_em = now()
        where id = ${flo.id}`;
      // A comissão da Mediterrânea (10% sobre R$ 9.500) segue pendente.
    },
  );
  return r !== null;
}

const LINHAS_CONCILIADA = (inicio: string): Linha[] => [
  hotel(inicio, 0, 3, "Roma", "Hotel Travertino Roma", 5200),
  hotel(inicio, 3, 3, "Amalfi", "Grand Hotel Scogliera", 6800),
  ["Passeio", "Amalfi", "Passeio de barco pela Costa Amalfitana", null, null, null, 1800, null, null, "Mare Blu Barche"],
  ["Transfer", "Roma", "Hotel-aeroporto", null, null, null, 900, null, null, "TransEuropa Transfers"],
  ["Passeio", "Roma", "Circuito Roma imperial", null, null, null, 6000, 12, null, "Atlântica Operadora"],
  ["Taxa", null, "Taxa de roteiro", null, null, null, 250, null, null],
];

async function semearConciliada(sql: Sql, ctx: Contexto, contaBancariaId: string): Promise<boolean> {
  const inicio = "2026-05-04";
  const fim = "2026-05-14";
  const [cli] = await sql`select id from clientes where grupo = 'Casal Vasconcelos' and excluido_em is null`;
  const r = await inserirOrcamento(
    sql,
    ctx,
    {
      cliente: "Casal Vasconcelos",
      destino: "Roma e Amalfi",
      inicio,
      fim,
      linhas: LINHAS_CONCILIADA(inicio),
      forma: { tipo: "pix", parcelas: 1 },
      desfecho: "aprovada",
      alteracao: "Primeira versão do roteiro.",
    },
    async (tx, c) => {
      const aceiteEm = "2026-02-10";
      const l = await fechar(tx, ctx, c, cli.id, {
        aceiteEm,
        faturaNome: "Ricardo Vasconcelos",
        comprovante: "Aceite por e-mail.",
        observacao: "Pago à vista em Pix.",
        entrada: 0n,
        primeiroVencimento: aceiteEm,
        baixarTudo: true,
      }, contaBancariaId);
      for (const conta of l.contas) for (const pag of conta.pagamentos) await pagar(tx, pag, conta, "2026-03-20", contaBancariaId);
      for (const com of l.comissoes) {
        await tx`
          update comissoes set status = 'recebida', recebida_em = '2026-06-15', valor_recebido = ${com.valorPrevisto.toString()}, conta_bancaria_id = ${contaBancariaId}
          where id = ${com.id}`;
      }
      await tx`update viagens set conciliada_em = '2026-06-20T12:00:00Z' where id = ${c.viagemId}`;
    },
  );
  return r !== null;
}

const CONTA_SEED = "Sicredi";

/** Conta bancária ativa das baixas do seed (toda baixa nova tem conta); cria se não existe. */
async function garantirContaBancaria(sql: Sql): Promise<string> {
  const [e] = await sql`select id from contas_bancarias where nome = ${CONTA_SEED} and ativa and excluido_em is null`;
  if (e) return e.id as string;
  const [c] = await sql`
    insert into contas_bancarias (nome, banco, saldo_inicial, saldo_inicial_em)
    values (${CONTA_SEED}, '748', 0, '2026-01-01')
    returning id`;
  return c.id as string;
}

/** Cria as viagens vendidas que ainda não existem; devolve quantas foram criadas. */
export async function semearVendas(sql: Sql): Promise<number> {
  const ctx = await contextoSeed(sql);
  const contaBancariaId = await garantirContaBancaria(sql);
  let n = 0;
  if (await semearRibeiro(sql, ctx, contaBancariaId)) n++;
  if (await semearConciliada(sql, ctx, contaBancariaId)) n++;
  return n;
}
