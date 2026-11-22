import "server-only";
import { and, asc, desc, eq, gte, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  custosDoSnapshot,
  MSG_PROPOSTA_INDISPONIVEL,
  RATEIOS,
  rotuloForma,
  VALIDADE_PROPOSTA,
  type ResultadoVersao,
  type Snapshot,
} from "@/domain/aprovacoes";
import type { Moeda } from "@/domain/cambio";
import { arredondar } from "@/domain/decimal";
import {
  custoLiquido,
  FORMA_REFERENCIA,
  margemDaAprovacao,
  precificar,
  type FormaPagamento,
  type ItemCalc,
  type Precificacao,
  type Rateio,
  type TipoItem,
} from "@/domain/precificacao";
import { veCamadaEstrategica } from "@/domain/perfis";
import type { Regras } from "@/domain/regras";
import { hojeEmCuiaba } from "@/domain/clientes";
import { ROTULO_STATUS_VIAGEM, statusDaViagem, type StatusViagem } from "@/domain/venda";
import { diasDaViagem, formatarCodigoViagem, noites, type StatusOrcamento, type StatusVersao } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import {
  clientes,
  cotacoes,
  fornecedores,
  itensViagem,
  pessoas,
  usuarios,
  versoesPrecificacao,
  viagemPassageiros,
  viagens,
} from "@/server/db/schema";
import { regrasDaVersao, regrasVigentes } from "@/server/queries/regras";
import { margensVendidas } from "@/server/queries/vendas";

// Segurança: a camada estratégica (custo líquido, venda, compensação, margem) só é montada dentro de
// `estrategico`, e só quando `veCamadaEstrategica(perfil)`. Para os demais perfis ela nunca é calculada.
// Valor do fornecedor, comissão e desconto são operacionais (visíveis para todos).

export type CotacaoFicha = {
  id: string;
  fornecedor: { id: string; nome: string } | null;
  moeda: Moeda;
  /** Centavos da moeda original. */
  valorOriginal: bigint;
  /** 4 casas ("5.8930"); nulo em BRL. */
  cambioComercial: string | null;
  cambioAplicado: string | null;
  cambioData: string | null;
  /** Centavos de real. */
  valorBrl: bigint;
  /** "4.000". */
  comissaoPct: string;
  descontoAVistaPct: string | null;
  /** Aéreo: tarifa fixa por bilhete (centavos). */
  tarifaFixa: bigint;
  escolhida: boolean;
};

export type ItemFicha = {
  id: string;
  ordem: number;
  tipo: TipoItem;
  cidade: string | null;
  servico: string;
  checkin: string | null;
  checkout: string | null;
  diarias: number | null;
  /** Taxa de roteiro, mantida pelo servidor. */
  automatico: boolean;
  cotacoes: CotacaoFicha[];
  /** Média do valor em reais de cotações de outras viagens (mesmo tipo, serviço e cidade), com ≥ `cotacoesParaSugestao`. */
  sugestao: { quantidade: number; media: bigint } | null;
};

export type CamadaEstrategica = {
  /** Calculada com o pior custo (maior custo líquido) de cada item cotado. */
  precificacao: Precificacao;
  /** Soma do custo líquido das cotações escolhidas. */
  custoEscolhidas: bigint;
  /** Pior custo − custo com as escolhidas: margem extra, sem mexer no preço. */
  margemExtra: bigint;
};

export type FichaPrecificacao = {
  id: string;
  codigo: string;
  clienteId: string;
  cliente: string;
  destino: string;
  inicio: string;
  fim: string;
  dias: number;
  noites: number;
  passageiros: { id: string; nome: string }[];
  consultor: { id: string; nome: string };
  status: StatusOrcamento;
  versaoAprovadaId: string | null;
  observacoes: string | null;
  /** Viagem internacional (aviso de passaporte × volta). */
  internacional: boolean;
  /** Pedido de ajustes do cliente (registrado na resposta à proposta); limpo no próximo envio. */
  notaCliente: string | null;
  /** ISO em milissegundos; devolvido em `alterarOrcamento` para controle de concorrência. */
  atualizadoEm: string;
  /** Itens do terrestre (sem Aéreo), na ordem; a taxa de roteiro por último. */
  itens: ItemFicha[];
  /** Aéreo, vendido à parte (fora da precificação). */
  aereo: ItemFicha[];
  /** Itens sem cotação, Aéreo incluso (o envio exige cotação em todos), na ordem do envio. */
  itensSemCotacao: { id: string; servico: string }[];
  /** Versões enviadas, mais recentes primeiro. */
  versoes: VersaoFicha[];
  /**
   * Só para diretor, fin_operacional e fin_estrategico. `erro` quando as regras vigentes não permitem calcular
   * (ex.: taxas e margem somam 100% ou mais).
   */
  estrategico?: CamadaEstrategica | { erro: string };
  /**
   * Valor de referência para o cliente (visível a todos os perfis): preço do pacote + taxa de serviço, no pior custo
   * e na forma de referência. Centavos como texto. `null` sem item cotado ou se o cálculo não for possível.
   */
  referencia: { precoCliente: string; porPessoa: string; forma: string } | null;
  /** Visível a todos: há item cotado, mas os Parâmetros vigentes não permitem calcular o valor de referência. */
  referenciaErro: boolean;
};

export type VersaoFicha = {
  id: string;
  numero: number;
  status: StatusVersao;
  /** Preço do pacote da versão (centavos); só para a camada estratégica. */
  preco?: bigint;
  enviadoPor: string;
  enviadoEm: Date;
  decididoPor: string | null;
  decididoEm: Date | null;
  comentario: string | null;
  alteracao: string | null;
};

export type OrcamentoLista = {
  id: string;
  codigo: string;
  clienteId: string;
  cliente: string;
  destino: string;
  inicio: string;
  fim: string;
  passageiros: string[];
  consultor: string;
  status: StatusOrcamento;
  /** Número da versão aprovada. */
  versaoAprovada: number | null;
  /**
   * Só para a camada estratégica: preço do pacote e margem líquida na forma de referência, pelo pior custo
   * (a mesma do cartão "Margem líquida" da ficha). Nulos sem item cotado; `erro` quando as regras
   * vigentes não permitem calcular (ex.: taxas e margem somam 100% ou mais).
   */
  estrategico?: { preco: bigint | null; margemPct: string | null } | { erro: string };
  /** Só `vendida`: status derivado (Vendida, Em viagem, Recebendo, Conciliada). */
  statusViagem?: { status: StatusViagem; rotulo: string };
  /** Só `vendida` e camada estratégica: margem planejada × real (percentuais em texto; real nulo se não calculou). */
  margemVendida?: { planejadaPct: string; realPct: string | null };
};

type ItemLinha = typeof itensViagem.$inferSelect;
type ItemComCotacoes = { item: ItemLinha; cotacoes: CotacaoFicha[] };

/** Escapa curingas do LIKE para a busca ser literal. */
const literal = (t: string) => t.replace(/[\\%_]/g, "\\$&");

/** `ECL-0001`, `ECL-0001-02`, `ecl1-2`. */
const CODIGO = /^\s*ECL-?\s*(\d{1,6})(?:\s*-\s*(\d{1,4}))?\s*$/i;

/** Itens ativos das viagens, com as cotações ativas (mais antigas primeiro). Taxa automática por último. */
async function itensDe(viagemIds: string[]): Promise<Map<string, ItemComCotacoes[]>> {
  const porViagem = new Map<string, ItemComCotacoes[]>();
  if (viagemIds.length === 0) return porViagem;
  const itens = await db
    .select()
    .from(itensViagem)
    .where(and(inArray(itensViagem.viagemId, viagemIds), isNull(itensViagem.excluidoEm)))
    .orderBy(asc(itensViagem.automatico), asc(itensViagem.ordem));
  const cots =
    itens.length === 0
      ? []
      : await db
          .select({ c: cotacoes, fornecedorNome: fornecedores.nome })
          .from(cotacoes)
          .leftJoin(fornecedores, eq(fornecedores.id, cotacoes.fornecedorId))
          .where(and(inArray(cotacoes.itemId, itens.map((i) => i.id)), isNull(cotacoes.excluidoEm)))
          .orderBy(asc(cotacoes.criadoEm), asc(cotacoes.id));
  const porItem = new Map<string, CotacaoFicha[]>();
  for (const { c, fornecedorNome } of cots) {
    const lista = porItem.get(c.itemId) ?? [];
    lista.push({
      id: c.id,
      fornecedor: c.fornecedorId ? { id: c.fornecedorId, nome: fornecedorNome ?? "" } : null,
      moeda: c.moeda,
      valorOriginal: c.valorOriginal,
      cambioComercial: c.cambioComercial,
      cambioAplicado: c.cambioAplicado,
      cambioData: c.cambioData,
      valorBrl: c.valorBrl,
      comissaoPct: c.comissaoPct,
      descontoAVistaPct: c.descontoAVistaPct,
      tarifaFixa: c.tarifaFixa,
      escolhida: c.escolhida,
    });
    porItem.set(c.itemId, lista);
  }
  for (const item of itens) {
    const lista = porViagem.get(item.viagemId) ?? [];
    lista.push({ item, cotacoes: porItem.get(item.id) ?? [] });
    porViagem.set(item.viagemId, lista);
  }
  return porViagem;
}

/**
 * Camada estratégica: preço pelo pior custo de cada item cotado (Aéreo fora), custo com as escolhidas e a
 * margem extra. Chamar só para perfis com `veCamadaEstrategica`.
 */
function camadaEstrategica(itens: ItemComCotacoes[], dias: number, regras: Regras): CamadaEstrategica {
  const calc: ItemCalc[] = [];
  let custoEscolhidas = 0n;
  for (const { item, cotacoes: cs } of itens) {
    if (item.tipo === "Aéreo" || cs.length === 0) continue;
    const comoCalc = (c: CotacaoFicha): ItemCalc => ({
      id: item.id,
      tipo: item.tipo,
      nome: item.servico,
      diarias: item.diarias,
      valorFornecedor: c.valorBrl,
      comissaoPct: c.comissaoPct,
      descontoAVistaPct: c.descontoAVistaPct,
    });
    let pior = comoCalc(cs[0]);
    let piorCusto = custoLiquido(pior);
    for (const c of cs.slice(1)) {
      const x = comoCalc(c);
      const cl = custoLiquido(x);
      if (cl > piorCusto) [pior, piorCusto] = [x, cl];
    }
    calc.push(pior);
    const escolhida = cs.find((c) => c.escolhida);
    custoEscolhidas += escolhida ? custoLiquido(comoCalc(escolhida)) : piorCusto;
  }
  const precificacao = precificar(calc, dias, regras);
  return { precificacao, custoEscolhidas, margemExtra: precificacao.custo - custoEscolhidas };
}

/** Passageiros das viagens, na ordem das pessoas do cliente. */
async function passageirosDe(viagemIds: string[]) {
  if (viagemIds.length === 0) return [];
  return db
    .select({ viagemId: viagemPassageiros.viagemId, id: pessoas.id, nome: pessoas.nome })
    .from(viagemPassageiros)
    .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
    .where(inArray(viagemPassageiros.viagemId, viagemIds))
    .orderBy(asc(pessoas.ordem), asc(pessoas.nome));
}

/**
 * Orçamentos não excluídos, mais recentes primeiro. Busca pelo código (`ECL-0001-02` ou `ECL-0001`) ou,
 * sem acento e sem caixa, por cliente, destino e nome de passageiro. Exige login; preço e margem só
 * para a camada estratégica.
 */
export async function listarOrcamentos(filtro: { busca?: string; status?: StatusOrcamento } = {}): Promise<OrcamentoLista[]> {
  const usuario = await exigirPerfil();
  const condicoes: (SQL | undefined)[] = [isNull(viagens.excluidoEm)];
  const busca = filtro.busca?.trim();
  const codigo = busca ? CODIGO.exec(busca) : null;
  if (codigo) {
    condicoes.push(eq(clientes.codigo, Number(codigo[1])));
    if (codigo[2]) condicoes.push(eq(viagens.seq, Number(codigo[2])));
  } else if (busca) {
    const padrao = `%${literal(busca)}%`;
    condicoes.push(
      sql`(${sql.join(
        [
          sql`extensions.unaccent(${clientes.grupo}) ilike extensions.unaccent(${padrao})`,
          sql`extensions.unaccent(${viagens.destino}) ilike extensions.unaccent(${padrao})`,
          sql`exists (select 1 from ${viagemPassageiros} vp join ${pessoas} p on p.id = vp.pessoa_id where vp.viagem_id = ${viagens.id} and extensions.unaccent(p.nome) ilike extensions.unaccent(${padrao}))`,
        ],
        sql` or `,
      )})`,
    );
  }
  if (filtro.status) condicoes.push(eq(viagens.status, filtro.status));

  const linhas = await db
    .select({
      v: viagens,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      consultor: usuarios.nome,
      versaoAprovada: versoesPrecificacao.numero,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .leftJoin(versoesPrecificacao, eq(versoesPrecificacao.id, viagens.versaoAprovadaId))
    .where(and(...condicoes))
    .orderBy(desc(viagens.criadoEm), desc(viagens.seq));

  const ids = linhas.map((l) => l.v.id);
  const passageiros = await passageirosDe(ids);
  const estrategico = veCamadaEstrategica(usuario.perfil);
  const itens = estrategico ? await itensDe(ids) : null;
  const regras = estrategico ? (await regrasVigentes()).valores : null;

  const hoje = hojeEmCuiaba();
  // Margem planejada × real das vendidas: uma leitura em lote (nunca uma consulta por linha).
  const margens = estrategico ? await margensVendidas(linhas.filter((l) => l.v.status === "vendida").map((l) => l.v.id)) : null;
  return linhas.map((l) => {
    const linha: OrcamentoLista = {
      id: l.v.id,
      codigo: formatarCodigoViagem(l.clienteCodigo, l.v.seq),
      clienteId: l.v.clienteId,
      cliente: l.cliente,
      destino: l.v.destino,
      inicio: l.v.inicio,
      fim: l.v.fim,
      passageiros: passageiros.filter((p) => p.viagemId === l.v.id).map((p) => p.nome),
      consultor: l.consultor,
      status: l.v.status,
      versaoAprovada: l.versaoAprovada ?? null,
    };
    if (l.v.status === "vendida") {
      const status = statusDaViagem({
        status: l.v.status,
        inicio: l.v.inicio,
        fim: l.v.fim,
        conciliadaEm: l.v.conciliadaEm ? l.v.conciliadaEm.toISOString() : null,
        hoje,
      });
      linha.statusViagem = { status, rotulo: ROTULO_STATUS_VIAGEM[status] };
      const m = margens?.get(l.v.id);
      if (m) linha.margemVendida = { planejadaPct: m.planejada.finalPct, realPct: "erro" in m.real ? null : m.real.finalPct };
    }
    if (itens && regras) {
      const doItem = itens.get(l.v.id) ?? [];
      const cotados = doItem.filter((x) => x.item.tipo !== "Aéreo" && x.cotacoes.length > 0);
      if (cotados.length === 0) {
        linha.estrategico = { preco: null, margemPct: null };
      } else {
        // Uma linha que não dá para calcular não derruba a lista inteira.
        try {
          const e = camadaEstrategica(doItem, diasDaViagem(l.v.inicio, l.v.fim), regras);
          // Mesma margem do cartão da ficha: forma de referência, pelo pior custo.
          const f = e.precificacao.porForma[FORMA_REFERENCIA];
          linha.estrategico = { preco: f.preco, margemPct: f.margemLiquidaPct };
        } catch (e) {
          console.error("Erro ao calcular orçamento da lista", { viagemId: l.v.id, erro: (e as Error)?.message });
          linha.estrategico = { erro: "Não foi possível calcular" };
        }
      }
    }
    return linha;
  });
}

/** Sugestão de custo de referência por item da viagem (média em centavos de real, arredondada). */
async function sugestoesDe(viagemId: string, minimo: number): Promise<Map<string, { quantidade: number; media: bigint }>> {
  const linhas = await db.execute<{ item_id: string; quantidade: number; media: string }>(sql`
    select i.id as item_id, count(c.id)::int as quantidade, round(avg(c.valor_brl))::bigint::text as media
    from ${itensViagem} i
    join ${itensViagem} o
      on o.tipo = i.tipo
      and o.viagem_id <> i.viagem_id
      and o.excluido_em is null
      and not o.automatico
      and lower(extensions.unaccent(o.servico)) = lower(extensions.unaccent(i.servico))
      and lower(extensions.unaccent(coalesce(o.cidade, ''))) = lower(extensions.unaccent(coalesce(i.cidade, '')))
    join ${viagens} v on v.id = o.viagem_id and v.excluido_em is null
    join ${cotacoes} c on c.item_id = o.id and c.excluido_em is null
    where i.viagem_id = ${viagemId} and i.excluido_em is null and not i.automatico
    group by i.id`);
  const mapa = new Map<string, { quantidade: number; media: bigint }>();
  for (const l of Array.from(linhas)) {
    if (l.quantidade >= minimo) mapa.set(l.item_id, { quantidade: l.quantidade, media: BigInt(l.media) });
  }
  return mapa;
}

/** Ficha de precificação. `null` se não existe. Exige login; camada estratégica só para quem a vê. */
export async function obterPrecificacao(viagemId: string): Promise<FichaPrecificacao | null> {
  const usuario = await exigirPerfil();
  if (!ehUuid(viagemId)) return null;
  const [l] = await db
    .select({
      v: viagens,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      consultor: usuarios.nome,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)))
    .limit(1);
  if (!l) return null;

  const v = l.v;
  const regras = (await regrasVigentes()).valores;
  const todos = (await itensDe([v.id])).get(v.id) ?? [];
  const sugestoes = await sugestoesDe(v.id, regras.cotacoesParaSugestao);
  const dias = diasDaViagem(v.inicio, v.fim);
  const ficha = (x: ItemComCotacoes): ItemFicha => ({
    id: x.item.id,
    ordem: x.item.ordem,
    tipo: x.item.tipo,
    cidade: x.item.cidade,
    servico: x.item.servico,
    checkin: x.item.checkin,
    checkout: x.item.checkout,
    diarias: x.item.diarias,
    automatico: x.item.automatico,
    cotacoes: x.cotacoes,
    sugestao: sugestoes.get(x.item.id) ?? null,
  });
  const terrestre = todos.filter((x) => x.item.tipo !== "Aéreo");

  const resposta: FichaPrecificacao = {
    id: v.id,
    codigo: formatarCodigoViagem(l.clienteCodigo, v.seq),
    clienteId: v.clienteId,
    cliente: l.cliente,
    destino: v.destino,
    inicio: v.inicio,
    fim: v.fim,
    dias,
    noites: noites(v.inicio, v.fim),
    passageiros: (await passageirosDe([v.id])).map((p) => ({ id: p.id, nome: p.nome })),
    consultor: { id: v.consultorId, nome: l.consultor },
    status: v.status,
    versaoAprovadaId: v.versaoAprovadaId,
    observacoes: v.observacoes,
    internacional: v.internacional,
    notaCliente: v.notaCliente,
    atualizadoEm: v.atualizadoEm.toISOString(),
    itens: terrestre.map(ficha),
    aereo: todos.filter((x) => x.item.tipo === "Aéreo").map(ficha),
    itensSemCotacao: todos.filter((x) => x.cotacoes.length === 0).map((x) => ({ id: x.item.id, servico: x.item.servico })),
    versoes: [],
    referencia: null,
    referenciaErro: false,
  };
  const estrategico = veCamadaEstrategica(usuario.perfil);
  // A conta usa a camada estratégica, mas só o preço ao cliente sai dela.
  if (todos.some((x) => x.item.tipo !== "Aéreo" && x.cotacoes.length > 0)) {
    try {
      const preco = camadaEstrategica(todos, dias, regras).precificacao.porForma[FORMA_REFERENCIA];
      const n = BigInt(Math.max(resposta.passageiros.length, 1));
      resposta.referencia = {
        precoCliente: preco.precoCliente.toString(),
        porPessoa: arredondar(preco.precoCliente, n).toString(),
        forma: preco.rotulo,
      };
    } catch (e) {
      console.error("Erro ao calcular o valor de referência", { viagemId: v.id, erro: (e as Error)?.message });
      resposta.referenciaErro = true;
    }
  }
  resposta.versoes = await versoesDe(v.id, estrategico);
  if (estrategico) {
    // Parâmetros que não permitem calcular não derrubam a ficha.
    try {
      resposta.estrategico = camadaEstrategica(todos, dias, regras);
    } catch (e) {
      console.error("Erro ao calcular a precificação", { viagemId: v.id, erro: (e as Error)?.message });
      resposta.estrategico = { erro: "Não foi possível calcular" };
    }
  }
  return resposta;
}

const decisor = alias(usuarios, "decisor");

/** Versões da viagem, mais recentes primeiro; `preco` só com `estrategico`. */
async function versoesDe(viagemId: string, estrategico: boolean): Promise<VersaoFicha[]> {
  const linhas = await db
    .select({ ver: versoesPrecificacao, enviadoPor: usuarios.nome, decididoPor: decisor.nome })
    .from(versoesPrecificacao)
    .innerJoin(usuarios, eq(usuarios.id, versoesPrecificacao.enviadoPor))
    .leftJoin(decisor, eq(decisor.id, versoesPrecificacao.decididoPor))
    .where(eq(versoesPrecificacao.viagemId, viagemId))
    .orderBy(desc(versoesPrecificacao.numero));
  return linhas.map(({ ver, enviadoPor, decididoPor }) => ({
    id: ver.id,
    numero: ver.numero,
    status: ver.status,
    ...(estrategico ? { preco: ver.preco } : {}),
    enviadoPor,
    enviadoEm: ver.enviadoEm,
    decididoPor: decididoPor ?? null,
    decididoEm: ver.decididoEm,
    comentario: ver.comentario,
    alteracao: ver.alteracao,
  }));
}

// ---------------------------------------------------------------------------
// Aprovação (Diretor) e proposta (cliente)
// ---------------------------------------------------------------------------

export type PedidoLista = {
  versaoId: string;
  viagemId: string;
  codigo: string;
  cliente: string;
  destino: string;
  inicio: string;
  fim: string;
  numero: number;
  status: StatusVersao;
  preco: bigint;
  /** Rótulo da forma ("Cartão em 6x"). */
  forma: string;
  /** Margem final (depois do rateio) gravada na versão, 1 casa. */
  margemFinalPct: string;
  alteracao: string | null;
  comentario: string | null;
  enviadoPor: string;
  enviadoEm: Date;
  decididoPor: string | null;
  decididoEm: Date | null;
};

const DIAS_DECIDIDOS = 30;

/** Pedidos do Diretor: `aguardando` (mais antigo primeiro) e decididos nos últimos 30 dias (mais recente primeiro). */
export async function listarPedidosAprovacao(): Promise<{ aguardando: PedidoLista[]; decididos: PedidoLista[] }> {
  await exigirPerfil("diretor");
  const desde = new Date(Date.now() - DIAS_DECIDIDOS * 86_400_000);
  const linhas = await db
    .select({
      ver: versoesPrecificacao,
      v: viagens,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      enviadoPor: usuarios.nome,
      decididoPor: decisor.nome,
    })
    .from(versoesPrecificacao)
    .innerJoin(viagens, eq(viagens.id, versoesPrecificacao.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, versoesPrecificacao.enviadoPor))
    .leftJoin(decisor, eq(decisor.id, versoesPrecificacao.decididoPor))
    .where(
      and(
        isNull(viagens.excluidoEm),
        or(
          eq(versoesPrecificacao.status, "aguardando"),
          and(ne(versoesPrecificacao.status, "aguardando"), gte(versoesPrecificacao.decididoEm, desde)),
        ),
      ),
    );
  const lista = linhas.map(
    (l): PedidoLista => ({
      versaoId: l.ver.id,
      viagemId: l.v.id,
      codigo: formatarCodigoViagem(l.clienteCodigo, l.v.seq),
      cliente: l.cliente,
      destino: (l.ver.snapshot as Snapshot).destino,
      inicio: (l.ver.snapshot as Snapshot).inicio,
      fim: (l.ver.snapshot as Snapshot).fim,
      numero: l.ver.numero,
      status: l.ver.status,
      preco: l.ver.preco,
      forma: rotuloForma(l.ver.forma as FormaPagamento),
      margemFinalPct: (l.ver.resultado as ResultadoVersao).finalPct,
      alteracao: l.ver.alteracao,
      comentario: l.ver.comentario,
      enviadoPor: l.enviadoPor,
      enviadoEm: l.ver.enviadoEm,
      decididoPor: l.decididoPor ?? null,
      decididoEm: l.ver.decididoEm,
    }),
  );
  const t = (d: Date | null) => d?.getTime() ?? 0;
  return {
    aguardando: lista.filter((x) => x.status === "aguardando").sort((a, b) => t(a.enviadoEm) - t(b.enviadoEm) || a.numero - b.numero),
    decididos: lista.filter((x) => x.status !== "aguardando").sort((a, b) => t(b.decididoEm) - t(a.decididoEm) || b.numero - a.numero),
  };
}

export type MargemAprovacao = ReturnType<typeof margemDaAprovacao>;

export type Pedido = Omit<PedidoLista, "forma" | "margemFinalPct"> & {
  consultor: string;
  passageiros: string[];
  forma: FormaPagamento;
  formaRotulo: string;
  dias: number;
  rateio: Rateio;
  snapshot: Snapshot;
  resultado: ResultadoVersao;
  /** Pior custo e custo com as escolhidas, recalculados do snapshot. */
  custo: bigint;
  custoEscolhidas: bigint;
  /** `margemDaAprovacao` do preço da versão nos três rateios, com as regras da versão. */
  margens: Record<Rateio, MargemAprovacao>;
  /** Margem de referência das regras da versão (só indica). */
  referenciaPct: string;
  /** Regras vigentes quando a versão foi enviada (para a simulação do Diretor no navegador). */
  regras: Regras;
};

/** Pedido de aprovação com o snapshot e as margens nos três rateios. Só o Diretor. `null` se não existe. */
export async function obterPedido(versaoId: string): Promise<Pedido | null> {
  await exigirPerfil("diretor");
  if (!ehUuid(versaoId)) return null;
  const [l] = await db
    .select({
      ver: versoesPrecificacao,
      v: viagens,
      clienteCodigo: clientes.codigo,
      cliente: clientes.grupo,
      enviadoPor: usuarios.nome,
      decididoPor: decisor.nome,
    })
    .from(versoesPrecificacao)
    .innerJoin(viagens, eq(viagens.id, versoesPrecificacao.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, versoesPrecificacao.enviadoPor))
    .leftJoin(decisor, eq(decisor.id, versoesPrecificacao.decididoPor))
    .where(and(eq(versoesPrecificacao.id, versaoId), isNull(viagens.excluidoEm)))
    .limit(1);
  if (!l) return null;
  const [consultor] = await db.select({ nome: usuarios.nome }).from(usuarios).where(eq(usuarios.id, l.v.consultorId));
  const regras = await regrasDaVersao(l.ver.regrasVersaoId);
  const snapshot = l.ver.snapshot as Snapshot;
  const forma = l.ver.forma as FormaPagamento;
  const { custo, custoEscolhidas } = custosDoSnapshot(snapshot);
  const margens = Object.fromEntries(
    RATEIOS.map((r) => [r, margemDaAprovacao(l.ver.preco, custo, forma, l.ver.dias, r, regras)]),
  ) as Record<Rateio, MargemAprovacao>;
  return {
    versaoId: l.ver.id,
    viagemId: l.v.id,
    codigo: formatarCodigoViagem(l.clienteCodigo, l.v.seq),
    cliente: l.cliente,
    consultor: consultor?.nome ?? "",
    destino: snapshot.destino,
    inicio: snapshot.inicio,
    fim: snapshot.fim,
    passageiros: snapshot.passageiros.map((p) => p.nome),
    numero: l.ver.numero,
    status: l.ver.status,
    preco: l.ver.preco,
    forma,
    formaRotulo: rotuloForma(forma),
    dias: l.ver.dias,
    rateio: l.ver.rateio as Rateio,
    alteracao: l.ver.alteracao,
    comentario: l.ver.comentario,
    enviadoPor: l.enviadoPor,
    enviadoEm: l.ver.enviadoEm,
    decididoPor: l.decididoPor ?? null,
    decididoEm: l.ver.decididoEm,
    snapshot,
    resultado: l.ver.resultado as ResultadoVersao,
    custo,
    custoEscolhidas,
    margens,
    referenciaPct: regras.margemReferenciaPct,
    regras,
  };
}

/** Só dados para o cliente: nunca fornecedor, comissão, custo ou margem. */
export type Proposta = {
  codigo: string;
  cliente: string;
  numeroVersao: number;
  destino: string;
  inicio: string;
  fim: string;
  dias: number;
  noites: number;
  passageiros: string[];
  /** Terrestre da versão aprovada (sem Aéreo); a taxa de roteiro aparece como "Taxa de roteiro", sem valor. */
  itens: {
    tipo: TipoItem;
    cidade: string | null;
    servico: string;
    checkin: string | null;
    checkout: string | null;
    diarias: number | null;
  }[];
  /** Preço do pacote + taxa de serviço (dias × taxa por dia das regras da versão), em centavos. */
  total: bigint;
  /** Taxa de serviço (dias × taxa por dia), já incluída no total. */
  taxaServico: bigint;
  /** total ÷ passageiros, meio para cima. */
  porPessoa: bigint;
  /** "Cartão em 6x". */
  forma: string;
  validade: string;
  /** Quando o Diretor aprovou a versão. */
  aprovadaEm: Date | null;
  /** O orçamento mudou depois da aprovação (status ≠ aprovado): a proposta mostra a versão aprovada, não o atual. */
  desatualizada: boolean;
};

/**
 * Proposta da última versão aprovada (mesmo com o orçamento já em edição de novo). Qualquer perfil. Os dados
 * da viagem (destino, datas, passageiros, itens) vêm do snapshot da versão.
 */
export async function obterProposta(viagemId: string): Promise<{ ok: true; proposta: Proposta } | { ok: false; erro: string }> {
  await exigirPerfil();
  const naoEncontrado = { ok: false as const, erro: "Orçamento não encontrado" };
  if (!ehUuid(viagemId)) return naoEncontrado;
  const [l] = await db
    .select({ v: viagens, clienteCodigo: clientes.codigo, cliente: clientes.grupo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)))
    .limit(1);
  if (!l) return naoEncontrado;
  if (!l.v.versaoAprovadaId) return { ok: false, erro: MSG_PROPOSTA_INDISPONIVEL };
  const [ver] = await db.select().from(versoesPrecificacao).where(eq(versoesPrecificacao.id, l.v.versaoAprovadaId));
  const s = ver.snapshot as Snapshot;
  const res = ver.resultado as ResultadoVersao;
  // Valores para o cliente gravados na versão; versões antigas, sem eles, recalculam com as regras da versão.
  let taxaServico: bigint, total: bigint, porPessoa: bigint;
  if (res.taxaServico !== undefined && res.precoCliente !== undefined && res.porPessoa !== undefined) {
    taxaServico = BigInt(res.taxaServico);
    total = BigInt(res.precoCliente);
    porPessoa = BigInt(res.porPessoa);
  } else {
    const regras = await regrasDaVersao(ver.regrasVersaoId);
    taxaServico = BigInt(ver.dias) * BigInt(regras.taxaServicoPorDia);
    total = ver.preco + taxaServico;
    porPessoa = arredondar(total, BigInt(Math.max(s.passageiros.length, 1)));
  }
  return {
    ok: true,
    proposta: {
      codigo: formatarCodigoViagem(l.clienteCodigo, l.v.seq),
      cliente: l.cliente,
      numeroVersao: ver.numero,
      destino: s.destino,
      inicio: s.inicio,
      fim: s.fim,
      dias: ver.dias,
      noites: noites(s.inicio, s.fim),
      passageiros: s.passageiros.map((p) => p.nome),
      itens: s.itens
        .filter((i) => i.tipo !== "Aéreo")
        .map((i) =>
          i.tipo === "Taxa"
            ? { tipo: i.tipo, cidade: null, servico: "Taxa de roteiro", checkin: null, checkout: null, diarias: null }
            : { tipo: i.tipo, cidade: i.cidade, servico: i.servico, checkin: i.checkin, checkout: i.checkout, diarias: i.diarias },
        ),
      total,
      taxaServico,
      porPessoa,
      forma: rotuloForma(ver.forma as FormaPagamento),
      validade: VALIDADE_PROPOSTA,
      aprovadaEm: ver.decididoEm,
      desatualizada: l.v.status !== "aprovado",
    },
  };
}
