"use server";

import { eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { MSG_NAO_CALCULA, resultadoDaVersao, type ResultadoVersao, type Snapshot } from "@/domain/aprovacoes";
import type { FormaPagamento, Rateio } from "@/domain/precificacao";
import {
  alocarTaxasPrevistas,
  aplicarFormaFornecedor,
  contasDoSnapshot,
  cronogramaRecebimento,
  meioDaForma,
  vencimentoPadraoFornecedor,
} from "@/domain/venda";
import {
  alteracaoNovaForma,
  fechamentoSchema,
  MSG_AGUARDANDO_DIRETOR,
  MSG_FORMA_DIFERENTE,
  MSG_FORMA_IGUAL,
  MSG_FORNECEDOR_CARTAO,
  MSG_JA_VENDIDA,
  MSG_MUDOU_DEPOIS_DA_APROVACAO,
  MSG_NAO_APROVADO,
  MSG_PARCELAS,
  MSG_VIAGEM_VENDIDA,
  novaFormaSchema,
  pedidoClienteSchema,
} from "@/domain/venda-entrada";
import { hojeEmCuiaba } from "@/domain/clientes";
import { tarefasDaVenda } from "@/domain/tarefas";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import {
  comissoes,
  contasPagar,
  fornecedores,
  pagamentosFornecedor,
  parcelasReceber,
  vendas,
  versoesPrecificacao,
  viagens,
} from "@/server/db/schema";
import { agendarEnvios, enfileirarCartaoDaViagem, enfileirarPastaDaViagem } from "@/server/integracoes/eventos";
import { criarTarefasAutomaticas } from "@/server/operacao/tarefas-automaticas";
import { regrasDaVersao } from "@/server/queries/regras";
import { travarViagem } from "@/server/trava-viagem";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Trava (mesma ordem da 3a): lock consultivo da viagem → viagem `for update` → versão aprovada `for update`,
// antes de qualquer escrita em venda, parcelas, contas, pagamentos e comissões. Respostas só com ids.

const PERFIS_VENDA = ["consultor", "operacional", "diretor"] as const;

export type FechamentoEntrada = {
  /** "AAAA-MM-DD". */
  aceiteEm: string;
  /** Tem de ser a forma da versão aprovada (tipo, antecipação e parcelas). */
  forma: FormaPagamento;
  /** Parcelas a receber do cliente (as da forma). */
  parcelas: number;
  primeiroVencimento: string;
  faturaNome: string;
  /** CPF ou CNPJ, com ou sem pontuação. */
  faturaDocumento: string;
  /** Comprovante do aceite, como texto. */
  comprovante?: string | null;
  /** Observação para o financeiro. */
  observacao?: string | null;
  /** Cartão direto no fornecedor: o fornecedor (com conta na viagem) que recebeu no cartão; ignorado nas outras formas. */
  fornecedorCartaoId?: string | null;
};

export type NovaFormaEntrada = { forma: FormaPagamento; nota?: string | null };

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
const ORCAMENTO_NAO_ENCONTRADO: Falha = { ok: false, erro: "Orçamento não encontrado" };
const JA_VENDIDA: Falha = { ok: false, erro: MSG_JA_VENDIDA };
const VENDIDA: Falha = { ok: false, erro: MSG_VIAGEM_VENDIDA };
const MUDOU: Falha = { ok: false, erro: MSG_MUDOU_DEPOIS_DA_APROVACAO };
const NAO_APROVADO: Falha = { ok: false, erro: MSG_NAO_APROVADO };
const AGUARDANDO: Falha = { ok: false, erro: MSG_AGUARDANDO_DIRETOR };
const FORMA_DIFERENTE: Falha = { ok: false, erro: MSG_FORMA_DIFERENTE };
const FORMA_IGUAL: Falha = { ok: false, erro: MSG_FORMA_IGUAL };
const PARCELAS: Falha = { ok: false, erro: MSG_PARCELAS, campos: { parcelas: MSG_PARCELAS } };
const NAO_CALCULA: Falha = { ok: false, erro: MSG_NAO_CALCULA };
const FORNECEDOR_CARTAO: Falha = { ok: false, erro: MSG_FORNECEDOR_CARTAO, campos: { fornecedorCartaoId: MSG_FORNECEDOR_CARTAO } };

type ViagemLinha = typeof viagens.$inferSelect;
type VersaoLinha = typeof versoesPrecificacao.$inferSelect;

/** Recusa dentro da transação que precisa desfazer o que já foi gravado; vira a `falha` fora dela. */
class Desfazer extends Error {
  constructor(readonly falha: Falha) {
    super(falha.erro);
  }
}

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

const semId = (x: Record<string, unknown>) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "id"));

/**
 * Viagem travada em `aprovado`, com a versão aprovada travada. `vendida` → `vendidaFalha`; editada depois da
 * aprovação (em edição ou devolvida, com versão aprovada) → "O orçamento mudou…".
 */
async function travarAprovada(
  tx: Transacao,
  viagemId: string,
  vendidaFalha: Falha,
): Promise<{ v: ViagemLinha; ver: VersaoLinha } | Falha> {
  const v = await travarViagem(tx, viagemId);
  if (!v) return ORCAMENTO_NAO_ENCONTRADO;
  if (v.status === "vendida") return vendidaFalha;
  if (v.status === "aguardando_aprovacao") return AGUARDANDO;
  if (v.status !== "aprovado" || !v.versaoAprovadaId) return v.versaoAprovadaId ? MUDOU : NAO_APROVADO;
  const [ver] = await tx.select().from(versoesPrecificacao).where(eq(versoesPrecificacao.id, v.versaoAprovadaId)).for("update");
  if (!ver) return NAO_APROVADO;
  return { v, ver };
}

async function mudarViagem(
  tx: Transacao,
  usuarioId: string,
  v: ViagemLinha,
  depois: Partial<Pick<ViagemLinha, "status" | "vendidaEm" | "notaCliente">>,
  agora: Date,
): Promise<void> {
  await tx
    .update(viagens)
    .set({ ...depois, atualizadoEm: agora })
    .where(eq(viagens.id, v.id));
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, v[k as keyof ViagemLinha]]));
  await registrarAuditoria(tx, { usuarioId, tabela: "viagens", registroId: v.id, acao: "alterar", antes, depois });
}

const mesmaForma = (a: FormaPagamento, b: FormaPagamento) =>
  a.tipo === b.tipo && a.parcelas === b.parcelas && Boolean(a.antecipado) === Boolean(b.antecipado);

/** Preço ao cliente gravado na versão; versões antigas, sem ele, recalculam com as regras da versão. */
async function totalAReceber(tx: Transacao, ver: VersaoLinha): Promise<bigint> {
  const res = ver.resultado as ResultadoVersao;
  if (res.precoCliente !== undefined) return BigInt(res.precoCliente);
  const regras = await regrasDaVersao(ver.regrasVersaoId, tx);
  return ver.preco + BigInt(ver.dias) * BigInt(regras.taxaServicoPorDia);
}

function revalidar(viagemId: string) {
  revalidatePath("/vendas");
  revalidatePath("/viagens");
  revalidatePath(`/viagens/${viagemId}`);
  revalidatePath("/aprovacoes");
  revalidatePath("/tarefas");
}

// ---------------------------------------------------------------------------
// Fechamento
// ---------------------------------------------------------------------------

/**
 * Fecha a venda da versão aprovada: venda, parcelas a receber (preço ao cliente da versão em `parcelas` meses a
 * partir do primeiro vencimento, taxa financeira da aprovação repartida), uma conta a pagar por item não-Taxa
 * com a cotação escolhida (pagamento à vista padrão, 30 dias antes do início e nunca antes do aceite), comissões
 * a receber dos fornecedores comissionados; viagem `vendida`. Consultor, operacional e Diretor.
 */
export async function fecharVenda(viagemId: string, dados: FechamentoEntrada): Promise<{ ok: true; id: string } | Falha> {
  return comPerfil([...PERFIS_VENDA], async (usuario) => {
    if (!ehUuid(viagemId)) return ORCAMENTO_NAO_ENCONTRADO;
    const p = fechamentoSchema().safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const e = p.data;

    let r: { id: string } | Falha;
    let enfileirou = false;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarAprovada(tx, viagemId, JA_VENDIDA);
        if (ehFalha(t)) return t;
        const { v, ver } = t;
        const [jaHa] = await tx.select({ id: vendas.id }).from(vendas).where(eq(vendas.viagemId, viagemId));
        if (jaHa) return JA_VENDIDA;
        const aprovadaForma = ver.forma as FormaPagamento;
        if (!mesmaForma(e.forma, aprovadaForma) || e.parcelas !== aprovadaForma.parcelas) return FORMA_DIFERENTE;

        const total = await totalAReceber(tx, ver);
        if (BigInt(e.parcelas) > total) return PARCELAS;
        const res = ver.resultado as ResultadoVersao;
        const cronograma = cronogramaRecebimento(total, e.parcelas, e.primeiroVencimento);
        const taxas = alocarTaxasPrevistas(BigInt(res.taxa), cronograma.map((x) => x.valor));
        const snapshot = ver.snapshot as Snapshot;
        const idsFornecedores = [
          ...new Set(snapshot.itens.map((i) => i.escolhida.fornecedorId).filter((x): x is string => x !== null)),
        ];
        const modalidades =
          idsFornecedores.length === 0
            ? []
            : await tx
                .select({ id: fornecedores.id, modalidade: fornecedores.modalidade })
                .from(fornecedores)
                .where(inArray(fornecedores.id, idsFornecedores));
        const contas = contasDoSnapshot(snapshot, Object.fromEntries(modalidades.map((m) => [m.id, m.modalidade])), v.fim);
        // Cartão direto no fornecedor: quem recebeu no cartão tem de ter conta na viagem (as que nascem aqui).
        const cartaoFornecedor = aprovadaForma.tipo === "cartao_fornecedor";
        const fornecedorCartaoId = cartaoFornecedor ? (e.fornecedorCartaoId ?? null) : null;
        if (cartaoFornecedor && !contas.some((c) => c.fornecedorId !== null && c.fornecedorId === fornecedorCartaoId)) return FORNECEDOR_CARTAO;
        const vencimento = vencimentoPadraoFornecedor(v.inicio, e.aceiteEm);
        const agora = new Date();
        const audit = (tabela: string, linha: { id: string } & Record<string, unknown>) =>
          registrarAuditoria(tx, { usuarioId: usuario.id, tabela, registroId: linha.id, acao: "criar", depois: semId(linha) });

        // Daqui em diante, recusa desfaz a transação (Desfazer).
        const [venda] = await tx
          .insert(vendas)
          .values({
            viagemId,
            versaoId: ver.id,
            aceiteEm: e.aceiteEm,
            forma: aprovadaForma,
            parcelas: e.parcelas,
            primeiroVencimento: e.primeiroVencimento,
            total,
            faturaNome: e.faturaNome,
            faturaDocumento: e.faturaDocumento,
            comprovante: e.comprovante,
            observacao: e.observacao,
            fornecedorCartaoId,
            criadoPor: usuario.id,
            criadoEm: agora,
          })
          .returning();
        await audit("vendas", venda);

        const meio = meioDaForma(aprovadaForma);
        const parcelas = await tx
          .insert(parcelasReceber)
          .values(
            cronograma.map((x, i) => ({
              viagemId,
              vendaId: venda.id,
              numero: x.numero,
              totalParcelas: e.parcelas,
              vencimento: x.vencimento,
              valor: x.valor,
              meio,
              taxaPrevista: taxas[i],
            })),
          )
          .returning();
        for (const x of parcelas) await audit("parcelas_receber", x);

        for (const c of contas) {
          let linhas;
          try {
            linhas = aplicarFormaFornecedor(c, { tipo: "a_vista", vencimento }, c.descontoAVistaPct);
          } catch {
            throw new Desfazer(NAO_CALCULA);
          }
          const [conta] = await tx
            .insert(contasPagar)
            .values({
              viagemId,
              itemId: c.itemId,
              cotacaoId: c.cotacaoId,
              fornecedorId: c.fornecedorId,
              descricao: c.descricao,
              aereo: c.aereo,
              moeda: c.moeda,
              valorOriginal: c.valorOriginal,
              cambioAplicado: c.cambioAplicado,
              previstoVendaBrl: c.previstoBrl,
              previstoBrl: c.previstoBrl,
              comissaoPct: c.comissaoPct,
              comissaoTipo: c.comissaoTipo,
              comissaoTipoVenda: c.comissaoTipo,
              descontoAVistaPct: c.descontoAVistaPct,
              forma: "a_vista",
            })
            .returning();
          await audit("contas_pagar", conta);
          const pags = await tx
            .insert(pagamentosFornecedor)
            .values(
              linhas.map((l) => ({
                contaId: conta.id,
                numero: l.numero,
                vencimento: l.vencimento ?? vencimento,
                valorOriginal: l.valorOriginal,
                valorBrlPrevisto: l.valorBrlPrevisto,
              })),
            )
            .returning();
          for (const x of pags) await audit("pagamentos_fornecedor", x);
          if (c.comissao) {
            const [com] = await tx
              .insert(comissoes)
              .values({
                viagemId,
                contaId: conta.id,
                fornecedorId: c.fornecedorId,
                baseBrl: c.comissao.baseBrl,
                pct: c.comissao.pct,
                valorPrevisto: c.comissao.valor,
                previstaPara: c.comissao.previstaPara,
              })
              .returning();
            await audit("comissoes", com);
          }
        }

        await mudarViagem(tx, usuario.id, v, { status: "vendida", vendidaEm: agora }, agora);
        // As 5 tarefas da venda nascem na mesma transação (viagem travada); "venda" = o dia de `vendidaEm` em Cuiabá.
        const daVenda = tarefasDaVenda(hojeEmCuiaba(agora), v.inicio);
        await criarTarefasAutomaticas(tx, usuario.id, v, daVenda, "venda");
        // Cartão no Trello (se ligado): entra na fila nesta transação; a chamada vai depois do commit.
        const cartao = await enfileirarCartaoDaViagem(tx, viagemId, daVenda.map((x) => x.item));
        // Pastas no Drive (se ligado), idem.
        const pasta = await enfileirarPastaDaViagem(tx, viagemId);
        enfileirou = cartao !== null || pasta !== null;
        return { id: venda.id };
      });
    } catch (x) {
      if (x instanceof Desfazer) return x.falha;
      throw erroDeBanco("Erro ao fechar a venda", x);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    if (enfileirou) agendarEnvios();
    return { ok: true, id: r.id };
  });
}

// ---------------------------------------------------------------------------
// Nova forma acordada
// ---------------------------------------------------------------------------

/**
 * Cliente acordou outra forma de pagamento: nova versão `aguardando` com o snapshot, preço, dias, regras e rateio
 * da aprovada e a nova forma (o resultado é recalculado: a taxa muda a margem); viagem `aguardando_aprovacao`
 * (a versão aprovada fica até a decisão). Consultor, operacional e Diretor.
 */
export async function pedirNovaForma(
  viagemId: string,
  dados: NovaFormaEntrada,
): Promise<{ ok: true; id: string; numero: number } | Falha> {
  return comPerfil([...PERFIS_VENDA], async (usuario) => {
    if (!ehUuid(viagemId)) return ORCAMENTO_NAO_ENCONTRADO;

    let r: { id: string; numero: number } | Falha;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarAprovada(tx, viagemId, VENDIDA);
        if (ehFalha(t)) return t;
        const { v, ver } = t;
        const regras = await regrasDaVersao(ver.regrasVersaoId, tx);
        const p = novaFormaSchema(regras.parcelamentoMaximo).safeParse(dados);
        if (!p.success) return falhaDeValidacao(p.error);
        const { forma, nota } = p.data;
        if (mesmaForma(forma, ver.forma as FormaPagamento)) return FORMA_IGUAL;
        const snapshot = ver.snapshot as Snapshot;
        let resultado: ResultadoVersao;
        try {
          resultado = { ...resultadoDaVersao(snapshot, ver.preco, forma, ver.dias, ver.rateio as Rateio, regras), origem: "nova_forma" };
        } catch {
          return NAO_CALCULA;
        }
        const agora = new Date();
        const [max] = await tx
          .select({ n: sql<number>`coalesce(max(${versoesPrecificacao.numero}), 0)::int` })
          .from(versoesPrecificacao)
          .where(eq(versoesPrecificacao.viagemId, viagemId));
        const [nova] = await tx
          .insert(versoesPrecificacao)
          .values({
            viagemId,
            numero: max.n + 1,
            status: "aguardando",
            snapshot,
            preco: ver.preco,
            forma,
            dias: ver.dias,
            regrasVersaoId: ver.regrasVersaoId,
            rateio: ver.rateio,
            resultado,
            alteracao: alteracaoNovaForma(nota),
            enviadoPor: usuario.id,
            enviadoEm: agora,
          })
          .returning();
        await registrarAuditoria(tx, {
          usuarioId: usuario.id,
          tabela: "versoes_precificacao",
          registroId: nova.id,
          acao: "criar",
          depois: semId(nova),
        });
        await mudarViagem(tx, usuario.id, v, { status: "aguardando_aprovacao" }, agora);
        return { id: nova.id, numero: nova.numero };
      });
    } catch (x) {
      throw erroDeBanco("Erro ao enviar a nova forma", x);
    }
    if (ehFalha(r)) return r;
    revalidar(viagemId);
    return { ok: true, ...r };
  });
}

// ---------------------------------------------------------------------------
// Ajustes pedidos pelo cliente
// ---------------------------------------------------------------------------

/** Cliente pediu ajustes: viagem volta a `em_edicao` com a nota (a versão aprovada fica). Consultor, operacional e Diretor. */
export async function registrarAjustesCliente(viagemId: string, nota: string): Promise<{ ok: true } | Falha> {
  return comPerfil([...PERFIS_VENDA], async (usuario) => {
    if (!ehUuid(viagemId)) return ORCAMENTO_NAO_ENCONTRADO;
    const p = pedidoClienteSchema.safeParse(nota);
    if (!p.success) return { ok: false, erro: p.error.issues[0].message, campos: { nota: p.error.issues[0].message } };

    let r: Falha | null;
    try {
      r = await db.transaction(async (tx) => {
        const t = await travarAprovada(tx, viagemId, VENDIDA);
        if (ehFalha(t)) return t;
        await mudarViagem(tx, usuario.id, t.v, { status: "em_edicao", notaCliente: p.data }, new Date());
        return null;
      });
    } catch (x) {
      throw erroDeBanco("Erro ao registrar os ajustes do cliente", x);
    }
    if (r) return r;
    revalidar(viagemId);
    return { ok: true };
  });
}
