import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Moeda } from "@/domain/cambio";
import {
  custoLiquido,
  FORMA_REFERENCIA,
  FORMAS_SIMULADOR,
  precificar,
  resultadoDoPreco,
  type ItemCalc,
  type Precificacao,
  type TipoItem,
} from "@/domain/precificacao";
import { veCamadaEstrategica } from "@/domain/perfis";
import type { Regras } from "@/domain/regras";
import { diasDaViagem, formatarCodigoViagem, noites, type StatusOrcamento } from "@/domain/viagens";
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
import { regrasVigentes } from "@/server/queries/regras";

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
  /** ISO em milissegundos; devolvido em `alterarOrcamento` para controle de concorrência. */
  atualizadoEm: string;
  /** Itens do terrestre (sem Aéreo), na ordem; a taxa de roteiro por último. */
  itens: ItemFicha[];
  /** Aéreo, vendido à parte (fora da precificação). */
  aereo: ItemFicha[];
  /** Itens do terrestre sem cotação (ficam fora do cálculo). */
  itensSemCotacao: { id: string; servico: string }[];
  /** Só para diretor, fin_operacional e fin_estrategico. */
  estrategico?: CamadaEstrategica;
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
   * Só para a camada estratégica: preço do pacote na forma de referência (pior custo) e a margem
   * líquida desse preço com as cotações escolhidas. Nulos sem item cotado; `erro` quando as regras
   * vigentes não permitem calcular (ex.: taxas e margem somam 100% ou mais).
   */
  estrategico?: { preco: bigint | null; margemPct: string | null } | { erro: string };
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
  const ref = FORMAS_SIMULADOR[FORMA_REFERENCIA].forma;

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
    if (itens && regras) {
      const doItem = itens.get(l.v.id) ?? [];
      const cotados = doItem.filter((x) => x.item.tipo !== "Aéreo" && x.cotacoes.length > 0);
      if (cotados.length === 0) {
        linha.estrategico = { preco: null, margemPct: null };
      } else {
        // Uma linha que não dá para calcular não derruba a lista inteira.
        try {
          const e = camadaEstrategica(doItem, diasDaViagem(l.v.inicio, l.v.fim), regras);
          const preco = e.precificacao.porForma[FORMA_REFERENCIA].preco;
          linha.estrategico = { preco, margemPct: resultadoDoPreco(preco, e.custoEscolhidas, ref, regras).margemLiquidaPct };
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
    atualizadoEm: v.atualizadoEm.toISOString(),
    itens: terrestre.map(ficha),
    aereo: todos.filter((x) => x.item.tipo === "Aéreo").map(ficha),
    itensSemCotacao: terrestre.filter((x) => x.cotacoes.length === 0).map((x) => ({ id: x.item.id, servico: x.item.servico })),
  };
  if (veCamadaEstrategica(usuario.perfil)) resposta.estrategico = camadaEstrategica(todos, dias, regras);
  return resposta;
}
