/**
 * Orçamentos do seed local: Itália (aguardando), Portugal (aprovado) e Paris (devolvido). Idempotente por cliente + destino.
 * Calcula snapshot e resultado com os mesmos módulos de domínio do servidor (src/domain), sem imports de servidor.
 */
import type postgres from "postgres";
import {
  custosDoSnapshot,
  itensDoSnapshot,
  precoCalculado,
  resultadoDaVersao,
  type ItemLido,
  type Snapshot,
} from "../src/domain/aprovacoes";
import { converter, type Moeda } from "../src/domain/cambio";
import type { FormaPagamento } from "../src/domain/precificacao";
import { normalizarRegras, REGRAS_INICIAIS, type Regras } from "../src/domain/regras";
import { diasDaViagem } from "../src/domain/viagens";

export type Sql = postgres.Sql;
type Transacao = postgres.TransactionSql;

/** [tipo, cidade, serviço, check-in, check-out, diárias, valor do fornecedor (reais), comissão %, desconto à vista %, fornecedor]. */
export type Linha = [
  string,
  string | null,
  string,
  string | null,
  string | null,
  number | null,
  number,
  number | null,
  number | null,
  string?,
  /** Cotação em moeda estrangeira: valor em centavos da moeda, câmbio comercial e aplicado; o valor em reais é a conversão. */
  { moeda: Moeda; original: bigint; comercial: string; aplicado: string }?,
];

// Os 14 itens do caso Itália do protótipo (a Taxa de roteiro é o item automático, no valor dos Parâmetros).
const ITALIA: Linha[] = [
  ["Hotelaria", "Veneza", "Palazzo Barocci", "2027-08-14", "2027-08-16", 2, 3106, 4, 4, "Palazzo Barocci"],
  ["Hotelaria", "Florença", "Orto de' Medici", "2027-08-16", "2027-08-19", 3, 3928, 10.5, 4, "Orto de' Medici"],
  ["Hotelaria", "Toscana", "Il Borro", "2027-08-19", "2027-08-21", 2, 10585, 8, 4, "Il Borro"],
  ["Hotelaria", "Sorrento", "Hotel Belair", "2027-08-21", "2027-08-25", 4, 9266, 8, 4, "Hotel Belair"],
  ["Hotelaria", "Capri", "Hotel Syrene", "2027-08-25", "2027-08-28", 3, 10457, 8, null, "Hotel Syrene"],
  ["Hotelaria", "Roma", "Leonardo Boutique", "2027-08-28", "2027-09-01", 4, 10844, 10.5, null, "Leonardo Boutique"],
  ["Trem", "Veneza", "Veneza-Florença", null, null, null, 713, null, null, "Trenitalia Parceiros"],
  ["Trem", "Nápoles", "Nápoles-Roma", null, null, null, 579.6, null, null, "Trenitalia Parceiros"],
  ["Transfer", "Veneza", "Trans boat", null, null, null, 1714, null, null, "TransEuropa Transfers"],
  ["Transfer", "Roma", "Hotel-aeroporto", null, null, null, 605, null, null, "TransEuropa Transfers"],
  ["Carro", "Florença", "Florença-Nápoles", null, null, null, 1954.3, 10, null, "Locadora Toscana Auto"],
  ["Outro", "Nápoles", "Ferry boat", null, null, null, 560, null, null, "Ferry Golfo di Napoli"],
  ["Outro", "Capri", "Ferry boat", null, null, null, 519, null, null, "Ferry Golfo di Napoli"],
  ["Taxa", null, "Taxa de roteiro", null, null, null, 250, null, null],
];

const PORTUGAL: Linha[] = [
  ["Hotelaria", "Lisboa", "Hotel Miradouro Sete", "2027-05-10", "2027-05-14", 4, 4800, null, null, "Hotel Miradouro Sete"],
  ["Hotelaria", "Porto", "Quinta Ribeira Alta", "2027-05-14", "2027-05-17", 3, 3600, null, null, "Quinta Ribeira Alta"],
  ["Transfer", "Lisboa", "Aeroporto-hotel", null, null, null, 450, null, null, "TransEuropa Transfers"],
  ["Passeio", "Sintra", "Sintra Privé Tours", null, null, null, 900, null, null, "Sintra Privé Tours"],
];

const PARIS: Linha[] = [
  ["Hotelaria", "Paris", "Maison Rivoli Seize", "2027-03-05", "2027-03-09", 4, 7200, null, 7, "Maison Rivoli Seize"],
  ["Hotelaria", "Paris", "Hôtel du Marais", "2027-03-09", "2027-03-12", 3, 4500, 8, null],
  ["Transfer", "Paris", "Aeroporto-hotel", null, null, null, 520, null, null],
  ["Passeio", "Paris", "Versalhes privativo", null, null, null, 1300, null, null],
];

export type Orcamento = {
  cliente: string;
  destino: string;
  inicio: string;
  fim: string;
  linhas: Linha[];
  forma: FormaPagamento;
  desfecho: "aguardando" | "aprovada" | "devolvida";
  alteracao: string;
  comentario?: string;
};

const ORCAMENTOS: Orcamento[] = [
  {
    cliente: "Casal Souza",
    destino: "Itália",
    inicio: "2027-08-14",
    fim: "2027-09-01",
    linhas: ITALIA,
    forma: { tipo: "credito", parcelas: 6 },
    desfecho: "aguardando",
    alteracao: "Primeira versão do roteiro.",
  },
  {
    cliente: "Casal Fontana",
    destino: "Portugal",
    inicio: "2027-05-10",
    fim: "2027-05-17",
    linhas: PORTUGAL,
    forma: { tipo: "pix", parcelas: 1 },
    desfecho: "aprovada",
    alteracao: "Primeira versão do roteiro.",
  },
  {
    cliente: "Família Moretti",
    destino: "Paris",
    inicio: "2027-03-05",
    fim: "2027-03-12",
    linhas: PARIS,
    forma: { tipo: "credito", parcelas: 6 },
    desfecho: "devolvida",
    alteracao: "Primeira versão do roteiro.",
    comentario: "Rever a cotação do hotel no Marais e confirmar o câmbio antes de reenviar.",
  },
];

export const centavos = (reais: number) => BigInt(Math.round(reais * 100));
const pct = (n: number | null) => (n === null ? null : n.toFixed(3));

export async function regrasLocais(sql: Sql): Promise<{ id: string; regras: Regras }> {
  const [v] = await sql`select id, valores from regras_versoes where vigente_desde <= now() order by vigente_desde desc, seq desc limit 1`;
  if (v) return { id: v.id as string, regras: normalizarRegras(v.valores) };
  const [novo] = await sql`insert into regras_versoes (valores, vigente_desde) values (${sql.json(REGRAS_INICIAIS as never)}, to_timestamp(0)) returning id`;
  return { id: novo.id as string, regras: REGRAS_INICIAIS };
}

export type Contexto = { consultorId: string; diretorId: string; regrasId: string; regras: Regras };

export async function contextoSeed(sql: Sql): Promise<Contexto> {
  const [consultor] = await sql`select id from usuarios where email = 'consultor@eclak.local'`;
  const [diretor] = await sql`select id from usuarios where email = 'diretor@eclak.local'`;
  if (!consultor || !diretor) throw new Error("Usuários do seed não encontrados");
  const { id, regras } = await regrasLocais(sql);
  return { consultorId: consultor.id as string, diretorId: diretor.id as string, regrasId: id, regras };
}

export type Criado = {
  viagemId: string;
  versaoId: string;
  snapshot: Snapshot;
  preco: bigint;
  precoCliente: bigint;
  resultado: ReturnType<typeof resultadoDaVersao>;
  forma: FormaPagamento;
  dias: number;
  inicio: string;
  fim: string;
};

/** Preço calculado e ao cliente (com a taxa de serviço) para as linhas, sem gravar nada. */
export function precoDasLinhas(linhas: Linha[], forma: FormaPagamento, dias: number, regras: Regras): { preco: bigint; precoCliente: bigint } {
  const itens = linhas.map((l, i) => {
    const [tipo, , servico, , , diarias, valor, com, desc, , eur] = l;
    const automatico = tipo === "Taxa";
    const valorBrl = automatico ? BigInt(regras.taxaRoteiro.valor) : eur ? converter(eur.original, eur.aplicado) : centavos(valor);
    return {
      id: `x${i}`,
      ordem: i + 1,
      tipo: tipo as ItemLido["tipo"],
      cidade: null,
      servico,
      checkin: null,
      checkout: null,
      diarias,
      automatico,
      cotacoes: [
        {
          id: `c${i}`,
          fornecedorId: null,
          fornecedor: null,
          moeda: (eur?.moeda ?? "BRL") as Moeda,
          valorOriginal: eur ? eur.original : valorBrl,
          cambioComercial: eur?.comercial ?? null,
          cambioAplicado: eur?.aplicado ?? null,
          cambioData: null,
          valorBrl,
          comissaoPct: pct(com) ?? "0.000",
          descontoAVistaPct: pct(desc),
          tarifaFixa: 0n,
          escolhida: true,
        },
      ],
    } satisfies ItemLido;
  });
  const its = itensDoSnapshot(itens);
  if ("erro" in its) throw new Error(its.erro);
  const snapshot: Snapshot = { destino: "x", inicio: "2000-01-01", fim: "2000-01-02", passageiros: [], itens: its };
  const preco = precoCalculado(custosDoSnapshot(snapshot).custo, forma, regras);
  if (preco === null) throw new Error("Não foi possível calcular o preço do seed");
  return { preco, precoCliente: preco + BigInt(dias) * BigInt(regras.taxaServicoPorDia) };
}

/**
 * Cria o orçamento (viagem, passageiros, itens, cotações e a versão 1) se ainda não existe (cliente + destino).
 * `depois` roda na mesma transação (a venda do seed); devolve `null` quando já existia.
 */
export async function inserirOrcamento(
  sql: Sql,
  ctx: Contexto,
  o: Orcamento,
  depois?: (tx: Transacao, criado: Criado) => Promise<void>,
): Promise<Criado | null> {
  const { consultorId, diretorId, regrasId, regras } = ctx;
  const [cli] = await sql`select id, filial, proxima_viagem from clientes where grupo = ${o.cliente} and excluido_em is null`;
  if (!cli) throw new Error(`Cliente do seed não encontrado: ${o.cliente}`);
  const [existe] = await sql`select 1 from viagens where cliente_id = ${cli.id} and destino = ${o.destino} and excluido_em is null`;
  if (existe) return null;

  return sql.begin(async (tx) => {
    const seq = cli.proxima_viagem as number;
    await tx`update clientes set proxima_viagem = ${seq + 1} where id = ${cli.id}`;
    const [v] = await tx`
      insert into viagens (cliente_id, seq, destino, inicio, fim, filial, consultor_id, status)
      values (${cli.id}, ${seq}, ${o.destino}, ${o.inicio}, ${o.fim}, ${cli.filial}, ${consultorId}, 'aguardando_aprovacao')
      returning id`;
    const pax = await tx`select id, nome from pessoas where cliente_id = ${cli.id} and removido_em is null order by ordem, nome`;
    for (const p of pax) await tx`insert into viagem_passageiros (viagem_id, pessoa_id) values (${v.id}, ${p.id})`;

    const lidos: ItemLido[] = [];
    for (const [ordem, l] of o.linhas.entries()) {
      const [tipo, cidade, servico, checkin, checkout, diarias, valor, com, desc, forn, eur] = l;
      const automatico = tipo === "Taxa";
      const valorBrl = automatico ? BigInt(regras.taxaRoteiro.valor) : eur ? converter(eur.original, eur.aplicado) : centavos(valor);
      const moeda = eur?.moeda ?? "BRL";
      const valorOriginal = eur ? eur.original : valorBrl;
      const [fornecedor] = forn ? await tx`select id from fornecedores where nome = ${forn} and excluido_em is null` : [];
      if (forn && !fornecedor) throw new Error(`Fornecedor do seed não encontrado: ${forn}`);
      const [item] = await tx`
        insert into itens_viagem (viagem_id, ordem, tipo, cidade, servico, checkin, checkout, diarias, automatico)
        values (${v.id}, ${ordem + 1}, ${tipo}, ${cidade}, ${servico}, ${checkin}, ${checkout}, ${diarias}, ${automatico})
        returning id`;
      const [cot] = await tx`
        insert into cotacoes (item_id, fornecedor_id, moeda, valor_original, cambio_comercial, cambio_aplicado, valor_brl, comissao_pct, desconto_a_vista_pct, escolhida)
        values (${item.id}, ${fornecedor?.id ?? null}, ${moeda}, ${valorOriginal.toString()}, ${eur?.comercial ?? null}, ${eur?.aplicado ?? null},
                ${valorBrl.toString()}, ${pct(com) ?? "0.000"}, ${pct(desc)}, true)
        returning id`;
      lidos.push({
        id: item.id,
        ordem: ordem + 1,
        tipo: tipo as ItemLido["tipo"],
        cidade,
        servico,
        checkin,
        checkout,
        diarias,
        automatico,
        cotacoes: [
          {
            id: cot.id,
            fornecedorId: fornecedor?.id ?? null,
            fornecedor: forn && fornecedor ? forn : null,
            moeda,
            valorOriginal,
            cambioComercial: eur?.comercial ?? null,
            cambioAplicado: eur?.aplicado ?? null,
            cambioData: null,
            valorBrl,
            comissaoPct: pct(com) ?? "0.000",
            descontoAVistaPct: pct(desc),
            tarifaFixa: 0n,
            escolhida: true,
          },
        ],
      });
    }

    const itens = itensDoSnapshot(lidos);
    if ("erro" in itens) throw new Error(itens.erro);
    const snapshot: Snapshot = {
      destino: o.destino,
      inicio: o.inicio,
      fim: o.fim,
      passageiros: pax.map((p) => ({ id: p.id as string, nome: p.nome as string })),
      itens,
    };
    const dias = diasDaViagem(o.inicio, o.fim);
    const preco = precoCalculado(custosDoSnapshot(snapshot).custo, o.forma, regras);
    if (preco === null) throw new Error("Não foi possível calcular o preço do seed");
    const resultado = resultadoDaVersao(snapshot, preco, o.forma, dias, regras.rateio.metodo, regras);

    const decidida = o.desfecho !== "aguardando";
    const [ver] = await tx`
      insert into versoes_precificacao
        (viagem_id, numero, status, snapshot, preco, forma, dias, regras_versao_id, rateio, resultado, alteracao,
         enviado_por, decidido_por, decidido_em, comentario)
      values (${v.id}, 1, ${o.desfecho}, ${tx.json(snapshot as never)}, ${preco.toString()}, ${tx.json(o.forma as never)}, ${dias},
              ${regrasId}, ${regras.rateio.metodo}, ${tx.json(resultado as never)}, ${o.alteracao},
              ${consultorId}, ${decidida ? diretorId : null}, ${decidida ? new Date() : null}, ${o.comentario ?? null})
      returning id`;
    if (o.desfecho === "aprovada") {
      await tx`update viagens set status = 'aprovado', versao_aprovada_id = ${ver.id} where id = ${v.id}`;
    } else if (o.desfecho === "devolvida") {
      await tx`update viagens set status = 'devolvido' where id = ${v.id}`;
    }
    const criado: Criado = {
      viagemId: v.id as string,
      versaoId: ver.id as string,
      snapshot,
      preco,
      precoCliente: BigInt(resultado.precoCliente ?? preco),
      resultado,
      forma: o.forma,
      dias,
      inicio: o.inicio,
      fim: o.fim,
    };
    if (depois) await depois(tx, criado);
    return criado;
  });
}

/** Cria os orçamentos que ainda não existem (cliente + destino); devolve quantos foram criados. */
export async function semearOrcamentos(sql: Sql): Promise<number> {
  const ctx = await contextoSeed(sql);
  let criados = 0;
  for (const o of ORCAMENTOS) if (await inserirOrcamento(sql, ctx, o)) criados++;
  return criados;
}
