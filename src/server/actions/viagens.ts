"use server";

import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cambioAplicado, converter, type Moeda } from "@/domain/cambio";
import type { TipoItem } from "@/domain/precificacao";
import type { Regras } from "@/domain/regras";
import { formatarCodigoViagem } from "@/domain/viagens";
import { MSG_VIAGEM_VENDIDA } from "@/domain/venda-entrada";
import {
  cotacaoSchema,
  itemSchema,
  MSG_PASSAGEIRO_ALHEIO,
  MSG_TAXA_AUTOMATICA,
  novoOrcamentoSchema,
  orcamentoSchema,
} from "@/domain/viagens-entrada";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { clientes, cotacoes, fornecedores, itensViagem, pessoas, viagemPassageiros, viagens } from "@/server/db/schema";
import { regrasVigentes } from "@/server/queries/regras";
import { proximaOrdem, sincronizarTaxaRoteiro } from "@/server/taxa-roteiro";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).

export type OrcamentoEntrada = {
  destino: string;
  inicio: string;
  fim: string;
  /** Ids de pessoas ativas do cliente. */
  passageiros: string[];
  observacoes?: string | null;
  /** Padrão `true` no novo; omitido na edição, mantém. */
  internacional?: boolean;
};

export type NovoOrcamentoEntrada = OrcamentoEntrada & { clienteId: string };

export type ItemEntrada = {
  /** `Taxa` é recusado: a taxa de roteiro é mantida pelo servidor. */
  tipo: TipoItem;
  servico: string;
  cidade?: string | null;
  checkin?: string | null;
  checkout?: string | null;
  diarias?: number | null;
};

/** Valores em formato brasileiro ("1.000,00"), em centavos da moeda. Sem câmbio: vem dos Parâmetros vigentes. */
export type CotacaoEntrada = {
  valor: string;
  /** Obrigatória, também na edição. */
  moeda: Moeda;
  fornecedorId?: string | null;
  /** "4", "4,5" (%). */
  comissao?: string | null;
  descontoAVista?: string | null;
  /** Aéreo: tarifa fixa por bilhete, em reais. */
  tarifaFixa?: string | null;
};

type Falha = { ok: false; erro: string; campos?: Record<string, string>; conflito?: true };
const ORCAMENTO_NAO_ENCONTRADO: Falha = { ok: false, erro: "Orçamento não encontrado" };
const CLIENTE_NAO_ENCONTRADO: Falha = { ok: false, erro: "Cliente não encontrado" };
const ITEM_NAO_ENCONTRADO: Falha = { ok: false, erro: "Item não encontrado" };
const COTACAO_NAO_ENCONTRADA: Falha = { ok: false, erro: "Cotação não encontrada" };
const FORNECEDOR_NAO_ENCONTRADO: Falha = { ok: false, erro: "Fornecedor não encontrado" };
const PASSAGEIRO_ALHEIO: Falha = { ok: false, erro: MSG_PASSAGEIRO_ALHEIO };
const TAXA_AUTOMATICA: Falha = { ok: false, erro: MSG_TAXA_AUTOMATICA };
const AGUARDANDO: Falha = {
  ok: false,
  erro: "Orçamento aguardando aprovação. Peça ao Diretor para devolver antes de alterar.",
};
const VENDIDA: Falha = { ok: false, erro: MSG_VIAGEM_VENDIDA };
const CONCORRENCIA: Falha = {
  ok: false,
  erro: "Este orçamento foi alterado por outra pessoa. Recarregue a página.",
  conflito: true,
};

type ViagemLinha = typeof viagens.$inferSelect;
type ItemLinha = typeof itensViagem.$inferSelect;
type CotacaoLinha = typeof cotacoes.$inferSelect;

const ehFalha = (x: unknown): x is Falha => typeof x === "object" && x !== null && "ok" in x;

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

function falhaDeValidacao(erro: import("zod").ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Viagem auditada: sem id e datas de controle, com os ids dos passageiros. */
function agregadoViagem(v: ViagemLinha, passageiros: string[]) {
  const omitidos = new Set(["id", "criadoEm", "atualizadoEm"]);
  return { ...Object.fromEntries(Object.entries(v).filter(([k]) => !omitidos.has(k))), passageiros };
}

/** Linha auditada sem o id (que já é o `registroId`). */
const semControle = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id"));

/** Passageiros ativos deste cliente; algum fora disso → falha. */
async function conferirPassageiros(tx: Transacao, clienteId: string, ids: string[]): Promise<Falha | null> {
  const achadas = await tx
    .select({ id: pessoas.id })
    .from(pessoas)
    .where(and(inArray(pessoas.id, ids), eq(pessoas.clienteId, clienteId), isNull(pessoas.removidoEm)));
  return achadas.length === ids.length ? null : PASSAGEIRO_ALHEIO;
}

/**
 * Trava a viagem (`for update`) para uma alteração de item/cotação/cabeçalho.
 * Em `aguardando_aprovacao` ou `vendida` recusa.
 */
async function travarViagem(tx: Transacao, viagemId: string): Promise<ViagemLinha | Falha> {
  const [v] = await tx
    .select()
    .from(viagens)
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)))
    .for("update");
  if (!v) return ORCAMENTO_NAO_ENCONTRADO;
  if (v.status === "aguardando_aprovacao") return AGUARDANDO;
  if (v.status === "vendida") return VENDIDA;
  return v;
}

/** Toca `atualizado_em`; aprovado/devolvido volta a `em_edicao` (a versão aprovada fica). */
async function marcarAlterada(tx: Transacao, v: ViagemLinha, usuarioId: string, agora: Date): Promise<void> {
  const status = v.status === "aprovado" || v.status === "devolvido" ? "em_edicao" : v.status;
  await tx.update(viagens).set({ status, atualizadoEm: agora }).where(eq(viagens.id, v.id));
  if (status !== v.status) {
    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "viagens",
      registroId: v.id,
      acao: "alterar",
      antes: { status: v.status },
      depois: { status },
    });
  }
}

function revalidar(viagemId: string) {
  revalidatePath("/viagens");
  revalidatePath(`/viagens/${viagemId}`);
}

// ---------------------------------------------------------------------------
// Orçamento (cabeçalho)
// ---------------------------------------------------------------------------

/** Novo orçamento para o cliente; qualquer perfil. Código = código do cliente + sequencial do cliente. */
export async function criarOrcamento(
  dados: NovoOrcamentoEntrada,
): Promise<{ ok: true; id: string; codigo: string } | Falha> {
  return comPerfil([], async (usuario) => {
    const p = novoOrcamentoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const { clienteId, passageiros, ...campos } = p.data;

    let r: { id: string; codigo: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        // A trava na linha do cliente serializa o sequencial das viagens dele.
        const [cli] = await tx
          .select()
          .from(clientes)
          .where(and(eq(clientes.id, clienteId), isNull(clientes.excluidoEm)))
          .for("update");
        if (!cli) return CLIENTE_NAO_ENCONTRADO;
        const alheio = await conferirPassageiros(tx, cli.id, passageiros);
        if (alheio) return alheio;

        const seq = cli.proximaViagem;
        await tx.update(clientes).set({ proximaViagem: seq + 1 }).where(eq(clientes.id, cli.id));
        const agora = new Date();
        const [v] = await tx
          .insert(viagens)
          .values({
            ...campos,
            clienteId: cli.id,
            seq,
            filial: cli.filial,
            consultorId: usuario.id,
            criadoEm: agora,
            atualizadoEm: agora,
          })
          .returning();
        await tx.insert(viagemPassageiros).values(passageiros.map((pessoaId) => ({ viagemId: v.id, pessoaId })));
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "viagens",
          registroId: v.id,
          acao: "criar",
          depois: agregadoViagem(v, passageiros),
        });
        return { id: v.id, codigo: formatarCodigoViagem(cli.codigo, seq) };
      });
    } catch (e) {
      throw erroDeBanco("Erro ao criar orçamento", e);
    }
    if (ehFalha(r)) return r;
    revalidar(r.id);
    return { ok: true, ...r };
  });
}

/** Edita destino, datas, passageiros e observações. Controle de concorrência por `atualizadoEm`. */
export async function alterarOrcamento(
  id: string,
  dados: OrcamentoEntrada,
  atualizadoEmEsperado: string,
): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([], async (usuario) => {
    const p = orcamentoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    if (!ehUuid(id)) return ORCAMENTO_NAO_ENCONTRADO;
    const { passageiros, internacional, ...resto } = p.data;
    const campos = internacional === undefined ? resto : { ...resto, internacional };

    let r: Falha | null;
    try {
      r = await db.transaction(async (tx) => {
        const [atual] = await tx
          .select()
          .from(viagens)
          .where(and(eq(viagens.id, id), isNull(viagens.excluidoEm)))
          .for("update");
        if (!atual) return ORCAMENTO_NAO_ENCONTRADO;
        if (atual.status === "vendida") return VENDIDA;
        if (!atualizadoEmEsperado || new Date(atualizadoEmEsperado).getTime() !== atual.atualizadoEm.getTime()) {
          return CONCORRENCIA;
        }
        if (atual.status === "aguardando_aprovacao") return AGUARDANDO;
        const alheio = await conferirPassageiros(tx, atual.clienteId, passageiros);
        if (alheio) return alheio;

        const antesPass = (
          await tx.select({ id: viagemPassageiros.pessoaId }).from(viagemPassageiros).where(eq(viagemPassageiros.viagemId, id))
        ).map((x) => x.id);
        const agora = new Date();
        const status = atual.status === "aprovado" || atual.status === "devolvido" ? "em_edicao" : atual.status;
        const [linha] = await tx
          .update(viagens)
          .set({ ...campos, status, atualizadoEm: agora })
          .where(eq(viagens.id, id))
          .returning();
        await tx.delete(viagemPassageiros).where(eq(viagemPassageiros.viagemId, id));
        await tx.insert(viagemPassageiros).values(passageiros.map((pessoaId) => ({ viagemId: id, pessoaId })));
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "viagens",
          registroId: id,
          acao: "alterar",
          antes: agregadoViagem(atual, antesPass),
          depois: agregadoViagem(linha, passageiros),
        });
        return null;
      });
    } catch (e) {
      throw erroDeBanco("Erro ao alterar orçamento", e);
    }
    if (r) return r;
    revalidar(id);
    return { ok: true, id };
  });
}

// ---------------------------------------------------------------------------
// Itens
// ---------------------------------------------------------------------------

/** Cria (sem `itemId`) ou edita um item. A taxa de roteiro é automática e não se edita. */
export async function salvarItem(
  viagemId: string,
  item: ItemEntrada,
  itemId?: string,
): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([], async (usuario) => {
    const p = itemSchema.safeParse(item);
    if (!p.success) return falhaDeValidacao(p.error);
    if (!ehUuid(viagemId)) return ORCAMENTO_NAO_ENCONTRADO;
    if (itemId !== undefined && !ehUuid(itemId)) return ITEM_NAO_ENCONTRADO;
    const regras = (await regrasVigentes()).valores;

    let r: { id: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const v = await travarViagem(tx, viagemId);
        if (ehFalha(v)) return v;
        const agora = new Date();
        let linha: ItemLinha;
        let antes: ItemLinha | null = null;
        if (itemId !== undefined) {
          [antes] = await tx
            .select()
            .from(itensViagem)
            .where(and(eq(itensViagem.id, itemId), eq(itensViagem.viagemId, viagemId), isNull(itensViagem.excluidoEm)))
            .for("update");
          if (!antes) return ITEM_NAO_ENCONTRADO;
          if (antes.automatico) return TAXA_AUTOMATICA;
          [linha] = await tx.update(itensViagem).set(p.data).where(eq(itensViagem.id, itemId)).returning();
        } else {
          [linha] = await tx
            .insert(itensViagem)
            .values({ ...p.data, viagemId, ordem: await proximaOrdem(tx, viagemId) })
            .returning();
        }
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "itens_viagem",
          registroId: linha.id,
          acao: antes ? "alterar" : "criar",
          ...(antes ? { antes: semControle(antes) } : {}),
          depois: semControle(linha),
        });
        await sincronizarTaxaRoteiro(tx, viagemId, regras, usuario.id, agora);
        await marcarAlterada(tx, v, usuario.id, agora);
        return { id: linha.id };
      });
    } catch (e) {
      throw erroDeBanco("Erro ao salvar item", e);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    return { ok: true, id: r.id };
  });
}

/** Viagem do item (sem trava), para travar a viagem antes do item. */
async function viagemDoItem(itemId: string): Promise<string | null> {
  const [x] = await db.select({ viagemId: itensViagem.viagemId }).from(itensViagem).where(eq(itensViagem.id, itemId));
  return x?.viagemId ?? null;
}

/** Item ativo da viagem, travado. */
async function travarItem(tx: Transacao, viagemId: string, itemId: string): Promise<ItemLinha | Falha> {
  const [i] = await tx
    .select()
    .from(itensViagem)
    .where(and(eq(itensViagem.id, itemId), eq(itensViagem.viagemId, viagemId), isNull(itensViagem.excluidoEm)))
    .for("update");
  if (!i) return ITEM_NAO_ENCONTRADO;
  if (i.automatico) return TAXA_AUTOMATICA;
  return i;
}

/** Exclusão lógica do item. */
export async function removerItem(itemId: string): Promise<{ ok: true } | Falha> {
  return comPerfil([], async (usuario) => {
    if (!ehUuid(itemId)) return ITEM_NAO_ENCONTRADO;
    const viagemId = await viagemDoItem(itemId);
    if (!viagemId) return ITEM_NAO_ENCONTRADO;
    const regras = (await regrasVigentes()).valores;

    let r: Falha | null;
    try {
      r = await db.transaction(async (tx) => {
        const v = await travarViagem(tx, viagemId);
        if (ehFalha(v)) return v.erro === ORCAMENTO_NAO_ENCONTRADO.erro ? ITEM_NAO_ENCONTRADO : v;
        const i = await travarItem(tx, viagemId, itemId);
        if (ehFalha(i)) return i;
        const agora = new Date();
        await tx.update(itensViagem).set({ excluidoEm: agora }).where(eq(itensViagem.id, itemId));
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "itens_viagem",
          registroId: itemId,
          acao: "excluir",
          antes: semControle(i),
          depois: { excluidoEm: agora },
        });
        await sincronizarTaxaRoteiro(tx, viagemId, regras, usuario.id, agora);
        await marcarAlterada(tx, v, usuario.id, agora);
        return null;
      });
    } catch (e) {
      throw erroDeBanco("Erro ao remover item", e);
    }
    if (r) return r;
    revalidar(viagemId);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Cotações
// ---------------------------------------------------------------------------

/** Câmbio gravado na cotação: BRL sem câmbio; estrangeira com o comercial e a data dos Parâmetros vigentes. */
function cambioDosParametros(moeda: Moeda, valor: bigint, regras: Regras) {
  if (moeda === "BRL") return { cambioComercial: null, cambioAplicado: null, cambioData: null, valorBrl: valor };
  const { comercial, data } = regras.cambio[moeda];
  const aplicado = cambioAplicado(comercial, regras.acrescimoCambioPct);
  return { cambioComercial: comercial, cambioAplicado: aplicado, cambioData: data, valorBrl: converter(valor, aplicado) };
}

/**
 * Cria (sem `cotacaoId`) ou edita uma cotação do item. A primeira cotação ativa do item é a escolhida.
 * Câmbio: cotação nova (ou que troca de moeda) usa o dos Parâmetros vigentes; editar sem trocar a moeda
 * mantém o câmbio já gravado.
 */
export async function salvarCotacao(
  itemId: string,
  cotacao: CotacaoEntrada,
  cotacaoId?: string,
): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([], async (usuario) => {
    const p = cotacaoSchema.safeParse(cotacao);
    if (!p.success) return falhaDeValidacao(p.error);
    if (!ehUuid(itemId)) return ITEM_NAO_ENCONTRADO;
    if (cotacaoId !== undefined && !ehUuid(cotacaoId)) return COTACAO_NAO_ENCONTRADA;
    const viagemId = await viagemDoItem(itemId);
    if (!viagemId) return ITEM_NAO_ENCONTRADO;
    const regras = (await regrasVigentes()).valores;
    const { valor, comissao, descontoAVista, ...resto } = p.data;

    let r: { id: string } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const v = await travarViagem(tx, viagemId);
        if (ehFalha(v)) return v.erro === ORCAMENTO_NAO_ENCONTRADO.erro ? ITEM_NAO_ENCONTRADO : v;
        const i = await travarItem(tx, viagemId, itemId);
        if (ehFalha(i)) return i;
        if (resto.fornecedorId) {
          const [f] = await tx
            .select({ id: fornecedores.id })
            .from(fornecedores)
            .where(and(eq(fornecedores.id, resto.fornecedorId), isNull(fornecedores.excluidoEm)));
          if (!f) return FORNECEDOR_NAO_ENCONTRADO;
        }
        const agora = new Date();
        const campos = { ...resto, valorOriginal: valor, comissaoPct: comissao, descontoAVistaPct: descontoAVista };

        let linha: CotacaoLinha;
        let antes: CotacaoLinha | null = null;
        if (cotacaoId !== undefined) {
          [antes] = await tx
            .select()
            .from(cotacoes)
            .where(and(eq(cotacoes.id, cotacaoId), eq(cotacoes.itemId, itemId), isNull(cotacoes.excluidoEm)))
            .for("update");
          if (!antes) return COTACAO_NAO_ENCONTRADA;
          const cambio =
            antes.moeda === resto.moeda && antes.cambioAplicado
              ? {
                  cambioComercial: antes.cambioComercial,
                  cambioAplicado: antes.cambioAplicado,
                  cambioData: antes.cambioData,
                  valorBrl: converter(valor, antes.cambioAplicado),
                }
              : cambioDosParametros(resto.moeda, valor, regras);
          [linha] = await tx
            .update(cotacoes)
            .set({ ...campos, ...cambio })
            .where(eq(cotacoes.id, cotacaoId))
            .returning();
        } else {
          const [jaEscolhida] = await tx
            .select({ id: cotacoes.id })
            .from(cotacoes)
            .where(and(eq(cotacoes.itemId, itemId), eq(cotacoes.escolhida, true), isNull(cotacoes.excluidoEm)));
          [linha] = await tx
            .insert(cotacoes)
            .values({
              ...campos,
              ...cambioDosParametros(resto.moeda, valor, regras),
              itemId,
              escolhida: !jaEscolhida,
              criadoEm: agora,
            })
            .returning();
        }
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "cotacoes",
          registroId: linha.id,
          acao: antes ? "alterar" : "criar",
          ...(antes ? { antes: semControle(antes) } : {}),
          depois: semControle(linha),
        });
        await sincronizarTaxaRoteiro(tx, viagemId, regras, usuario.id, agora);
        await marcarAlterada(tx, v, usuario.id, agora);
        return { id: linha.id };
      });
    } catch (e) {
      throw erroDeBanco("Erro ao salvar cotação", e);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    return { ok: true, id: r.id };
  });
}

/** Cotação ativa (de item ativo e não automático), com a viagem e o item travados. */
async function abrirCotacao(
  cotacaoId: string,
  /** Devolve `false` quando nada mudou (então a viagem não é tocada). */
  fn: (tx: Transacao, ctx: { c: CotacaoLinha; agora: Date }) => Promise<boolean>,
  usuarioId: string,
  mensagemErro: string,
): Promise<{ ok: true } | Falha> {
  if (!ehUuid(cotacaoId)) return COTACAO_NAO_ENCONTRADA;
  const [ref] = await db
    .select({ itemId: cotacoes.itemId, viagemId: itensViagem.viagemId })
    .from(cotacoes)
    .innerJoin(itensViagem, eq(itensViagem.id, cotacoes.itemId))
    .where(eq(cotacoes.id, cotacaoId));
  if (!ref) return COTACAO_NAO_ENCONTRADA;
  const regras = (await regrasVigentes()).valores;

  let r: Falha | null;
  try {
    r = await db.transaction(async (tx) => {
      const v = await travarViagem(tx, ref.viagemId);
      if (ehFalha(v)) return v.erro === ORCAMENTO_NAO_ENCONTRADO.erro ? COTACAO_NAO_ENCONTRADA : v;
      const i = await travarItem(tx, ref.viagemId, ref.itemId);
      if (ehFalha(i)) return i.erro === ITEM_NAO_ENCONTRADO.erro ? COTACAO_NAO_ENCONTRADA : i;
      const [c] = await tx
        .select()
        .from(cotacoes)
        .where(and(eq(cotacoes.id, cotacaoId), isNull(cotacoes.excluidoEm)))
        .for("update");
      if (!c) return COTACAO_NAO_ENCONTRADA;
      const agora = new Date();
      if (!(await fn(tx, { c, agora }))) return null;
      await sincronizarTaxaRoteiro(tx, ref.viagemId, regras, usuarioId, agora);
      await marcarAlterada(tx, v, usuarioId, agora);
      return null;
    });
  } catch (e) {
    throw erroDeBanco(mensagemErro, e);
  }
  if (r) return r;
  revalidar(ref.viagemId);
  return { ok: true };
}

async function trocarEscolhida(tx: Transacao, usuarioId: string, de: string | null, para: string | null): Promise<void> {
  if (de) {
    await tx.update(cotacoes).set({ escolhida: false }).where(eq(cotacoes.id, de));
    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "cotacoes",
      registroId: de,
      acao: "alterar",
      antes: { escolhida: true },
      depois: { escolhida: false },
    });
  }
  if (para) {
    await tx.update(cotacoes).set({ escolhida: true }).where(eq(cotacoes.id, para));
    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "cotacoes",
      registroId: para,
      acao: "alterar",
      antes: { escolhida: false },
      depois: { escolhida: true },
    });
  }
}

/** Exclusão lógica. Se era a escolhida, a mais antiga que restar passa a ser. */
export async function removerCotacao(cotacaoId: string): Promise<{ ok: true } | Falha> {
  return comPerfil([], (usuario) =>
    abrirCotacao(
      cotacaoId,
      async (tx, { c, agora }) => {
        await tx.update(cotacoes).set({ excluidoEm: agora, escolhida: false }).where(eq(cotacoes.id, c.id));
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "cotacoes",
          registroId: c.id,
          acao: "excluir",
          antes: semControle(c),
          depois: { excluidoEm: agora, escolhida: false },
        });
        if (!c.escolhida) return true;
        const [proxima] = await tx
          .select({ id: cotacoes.id })
          .from(cotacoes)
          .where(and(eq(cotacoes.itemId, c.itemId), isNull(cotacoes.excluidoEm), ne(cotacoes.id, c.id)))
          .orderBy(asc(cotacoes.criadoEm), asc(cotacoes.id))
          .limit(1);
        if (proxima) await trocarEscolhida(tx, usuario.id, null, proxima.id);
        return true;
      },
      usuario.id,
      "Erro ao remover cotação",
    ),
  );
}

/** Torna esta a cotação escolhida do item (troca atômica com a anterior). */
export async function escolherCotacao(cotacaoId: string): Promise<{ ok: true } | Falha> {
  return comPerfil([], (usuario) =>
    abrirCotacao(
      cotacaoId,
      async (tx, { c }) => {
        if (c.escolhida) return false;
        const [anterior] = await tx
          .select({ id: cotacoes.id })
          .from(cotacoes)
          .where(and(eq(cotacoes.itemId, c.itemId), eq(cotacoes.escolhida, true), isNull(cotacoes.excluidoEm)));
        // Desmarca antes de marcar: o índice único parcial permite uma escolhida por item.
        await trocarEscolhida(tx, usuario.id, anterior?.id ?? null, c.id);
        return true;
      },
      usuario.id,
      "Erro ao escolher cotação",
    ),
  );
}
