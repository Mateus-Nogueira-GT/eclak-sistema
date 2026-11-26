"use server";

import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { hojeEmCuiaba } from "@/domain/clientes";
import { centroDaFilial, ROTULO_FORMA_FINANCEIRO, type Centro } from "@/domain/financeiro";
import { baixaLancamentoSchema } from "@/domain/financeiro-entrada";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { geraContaAPagar } from "@/domain/reembolsos";
import { motivoCancelamentoSchema, pedidoSchema, reembolsadoEmSchema, reembolsoSchema } from "@/domain/reembolsos-entrada";
import { MSG_NAO_VENDIDA } from "@/domain/venda-entrada";
import { formatarCodigoViagem } from "@/domain/viagens";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { categoriasFinanceiras, clientes, contasPagar, lancamentos, reembolsos, viagens } from "@/server/db/schema";
import {
  alterarEmAbertoNa,
  baixarLancamentoNa,
  cancelarLancamentoNa,
  criarLancamentosNa,
  desfazerBaixaLancamentoNa,
  Desfazer,
  falha,
  type Falha,
  type LancamentoLinha,
  type Ok,
} from "@/server/financeiro/lancamentos";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Reembolsos (fatia 5b, spec §6 e §14): a ECLAK cobra o fornecedor (conta a receber) e devolve ao cliente (conta a
// pagar, só em PIX e transferência). O caso lê as contas, não as copia: os marcos "Fornecedor pagou" e "Cliente
// reembolsado" são a baixa dessas contas pelo núcleo de lançamentos, a mesma da lista única. Só Diretor e
// financeiros; viagem vendida (conciliada ou não: o caso não altera a viagem e não a trava). Travas na ordem caso
// (`for update`) → contas do caso (`for update`, por id). Toda escrita audita na mesma transação.

const FINANCEIRO = [...PERFIS_FINANCEIRO];
const REEMBOLSO_NAO_ENCONTRADO = falha("Reembolso não encontrado");
const VIAGEM_NAO_ENCONTRADA = falha("Viagem não encontrada");
const NAO_VENDIDA = falha(MSG_NAO_VENDIDA);
const CANCELADO = falha("Reembolso cancelado");
const SERVICO_INVALIDO = falha("Escolha um serviço desta viagem", "contaPagarId");
const VIAGEM_E_SERVICO_FIXOS = falha("A viagem e o serviço do caso não mudam: cancele e registre outro", "contaPagarId");
const SEM_COBRAR = falha("Sem valor a cobrar do fornecedor");
const SEM_DEVOLVER = falha("Sem valor a devolver ao cliente");
const JA_REEMBOLSADO = falha("O cliente já foi reembolsado");
const FORNECEDOR_NAO_PAGOU = falha("O fornecedor ainda não pagou");
const CLIENTE_NAO_REEMBOLSADO = falha("O cliente ainda não foi reembolsado");
const DESFACA_BAIXAS = falha("Desfaça as baixas antes de cancelar");
const MSG_FORNECEDOR_PAGOU = "O fornecedor já pagou: desfaça a baixa para alterar o valor a cobrar";
const MSG_CLIENTE_REEMBOLSADO = "O cliente já foi reembolsado: desfaça o marco para alterar o valor ou a forma";
const MOTIVO_CONTA_ALTERADA = "Reembolso alterado";

type Caso = typeof reembolsos.$inferSelect;
type ViagemDoCaso = { id: string; status: string; centro: Centro; clienteId: string; codigo: string };
/** As contas do caso que não foram canceladas, uma por lado. */
type ContasDoCaso = { receber?: LancamentoLinha; pagar?: LancamentoLinha };

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Recusa do núcleo depois de alguma escrita: desfaz a transação. */
function exigirOk(r: Ok | Falha): void {
  if (!r.ok) throw new Desfazer(r);
}

/** Transação com `Desfazer`; outro erro loga só o código e relança genérico. No sucesso revalida as telas. */
async function transacao(mensagemErro: string, fn: (tx: Transacao) => Promise<Ok | Falha>): Promise<Ok | Falha> {
  try {
    const r = await db.transaction(fn);
    if (r.ok) {
      revalidatePath("/financeiro", "layout");
      revalidatePath("/viagens/[id]", "page");
      revalidatePath("/visao-geral");
    }
    return r;
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    const e = x as { code?: string; cause?: { code?: string } } | null;
    console.error(mensagemErro, { code: e?.cause?.code ?? e?.code });
    throw new Error(mensagemErro);
  }
}

/** A viagem do caso, não excluída (sem trava: o caso não altera a viagem), com o código e o centro da filial. */
async function viagemDoCaso(tx: Transacao, viagemId: string): Promise<ViagemDoCaso | null> {
  const [v] = await tx
    .select({ id: viagens.id, status: viagens.status, filial: viagens.filial, clienteId: viagens.clienteId, seq: viagens.seq, codigoCliente: clientes.codigo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)));
  return v ? { id: v.id, status: v.status, centro: centroDaFilial(v.filial), clienteId: v.clienteId, codigo: formatarCodigoViagem(v.codigoCliente, v.seq) } : null;
}

function recusaDaViagem(v: ViagemDoCaso | null): Falha | null {
  if (!v) return VIAGEM_NAO_ENCONTRADA;
  return v.status === "vendida" ? null : NAO_VENDIDA;
}

/** "Reembolso <código da viagem>: <serviço>", cortada em 200 caracteres (o limite da descrição na lista única). */
const descricaoDaConta = (codigo: string, servico: string) => `Reembolso ${codigo}: ${servico}`.slice(0, 200);

const ladoFornecedorBaixado = (contas: ContasDoCaso) => contas.receber?.status === "baixado";
const ladoClienteBaixado = (caso: Caso, contas: ContasDoCaso) => contas.pagar?.status === "baixado" || caso.reembolsadoEm !== null;

/** O caso pede a conta do lado: a receber com valor a cobrar; a pagar com valor a devolver em PIX ou transferência. */
const pedeConta = (caso: Caso, lado: "receber" | "pagar") =>
  lado === "receber" ? caso.valorCobrar > 0n : caso.valorDevolver > 0n && geraContaAPagar(caso.formaDevolucao);

/** Os campos da conta do lado, a partir do caso. */
function contaDoLado(caso: Caso, v: ViagemDoCaso, lado: "receber" | "pagar") {
  return lado === "receber"
    ? { valor: caso.valorCobrar, vencimento: caso.previstoFornecedor!, descricao: descricaoDaConta(v.codigo, caso.servico) }
    : { valor: caso.valorDevolver, vencimento: caso.prazoCliente, descricao: descricaoDaConta(v.codigo, caso.servico) };
}

/**
 * Cria a conta do lado pelo núcleo (categoria de sistema, centro da filial da viagem, emissão hoje e competência do
 * mês de hoje; a receber do fornecedor em transferência, a pagar ao cliente na forma do caso) e a liga ao caso.
 */
async function criarConta(tx: Transacao, usuarioId: string, caso: Caso, v: ViagemDoCaso, lado: "receber" | "pagar"): Promise<void> {
  const sistema = lado === "receber" ? "reembolso_fornecedor" : "reembolso_cliente";
  const [cat] = await tx.select({ id: categoriasFinanceiras.id }).from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, sistema));
  if (!cat) throw new Error(`Categoria de sistema ausente: ${sistema}`);
  const hoje = hojeEmCuiaba();
  const campos = contaDoLado(caso, v, lado);
  const [l] = await criarLancamentosNa(tx, usuarioId, {
    lado,
    descricao: campos.descricao,
    fornecedorId: lado === "receber" ? caso.fornecedorId : null,
    clienteId: lado === "pagar" ? v.clienteId : null,
    pessoaTexto: null,
    categoriaId: cat.id,
    centro: v.centro,
    competencia: hoje.slice(0, 7),
    emissao: hoje,
    vencimento: campos.vencimento,
    valor: campos.valor,
    forma: ROTULO_FORMA_FINANCEIRO[lado === "receber" || caso.formaDevolucao !== "pix" ? "transferencia" : "pix"],
    contaBancariaId: null,
    observacao: null,
    repeticao: { tipo: "unica" },
    cartaoId: null,
  });
  await tx.update(lancamentos).set({ reembolsoId: caso.id }).where(eq(lancamentos.id, l.id));
  await registrarAuditoria(tx, { usuarioId, tabela: "lancamentos", registroId: l.id, acao: "alterar", antes: { reembolsoId: null }, depois: { reembolsoId: caso.id } });
}

/**
 * A conta em aberto do lado acompanha o caso: cancelada se o caso não a pede mais (ou a forma da conta a pagar
 * mudou), criada se o caso passou a pedir, senão valor, vencimento e descrição alterados. Só para lado não baixado.
 */
async function sincronizarConta(tx: Transacao, usuarioId: string, caso: Caso, v: ViagemDoCaso, lado: "receber" | "pagar", conta: LancamentoLinha | undefined): Promise<void> {
  const pede = pedeConta(caso, lado);
  if (conta && (!pede || (lado === "pagar" && conta.forma !== caso.formaDevolucao))) {
    exigirOk(await cancelarLancamentoNa(tx, usuarioId, conta.id, MOTIVO_CONTA_ALTERADA));
    conta = undefined;
  }
  if (!pede) return;
  if (!conta) return criarConta(tx, usuarioId, caso, v, lado);
  exigirOk(await alterarEmAbertoNa(tx, usuarioId, conta.id, contaDoLado(caso, v, lado)));
}

async function auditarCaso(tx: Transacao, usuarioId: string, caso: Caso, depois: Partial<Caso>): Promise<void> {
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, caso[k as keyof Caso]]));
  await registrarAuditoria(tx, { usuarioId, tabela: "reembolsos", registroId: caso.id, acao: "alterar", antes, depois });
}

async function gravarCaso(tx: Transacao, usuarioId: string, caso: Caso, depois: Partial<Caso>): Promise<void> {
  await tx.update(reembolsos).set({ ...depois, atualizadoEm: new Date() }).where(eq(reembolsos.id, caso.id));
  await auditarCaso(tx, usuarioId, caso, depois);
}

/**
 * Trava o caso (`for update`; cancelado recusa), confere a viagem vendida, trava as contas não canceladas do caso
 * (`for update`, por id) e roda `fn` numa transação nova.
 */
async function noCaso(id: string, mensagemErro: string, fn: (tx: Transacao, caso: Caso, contas: ContasDoCaso, v: ViagemDoCaso) => Promise<Ok | Falha>): Promise<Ok | Falha> {
  if (!ehUuid(id)) return REEMBOLSO_NAO_ENCONTRADO;
  return transacao(mensagemErro, async (tx) => {
    const [caso] = await tx.select().from(reembolsos).where(eq(reembolsos.id, id)).for("update");
    if (!caso) return REEMBOLSO_NAO_ENCONTRADO;
    if (caso.canceladoEm) return CANCELADO;
    const v = await viagemDoCaso(tx, caso.viagemId);
    const recusa = recusaDaViagem(v);
    if (recusa) return recusa;
    const linhas = await tx
      .select()
      .from(lancamentos)
      .where(and(eq(lancamentos.reembolsoId, id), ne(lancamentos.status, "cancelado")))
      .orderBy(asc(lancamentos.id))
      .for("update");
    const contas: ContasDoCaso = { receber: linhas.find((l) => l.lado === "receber"), pagar: linhas.find((l) => l.lado === "pagar") };
    const r = await fn(tx, caso, contas, v!);
    return r.ok ? { ok: true, id } : r;
  });
}

/** Registra o caso e, na mesma transação, as contas que ele pede (spec §6.2). */
export async function registrarReembolso(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = reembolsoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const e = p.data;
    return transacao("Falha ao registrar o reembolso", async (tx) => {
      const v = await viagemDoCaso(tx, e.viagemId);
      const recusa = recusaDaViagem(v);
      if (recusa) return recusa;
      let fornecedorId: string | null = null;
      if (e.contaPagarId) {
        const [c] = await tx
          .select({ fornecedorId: contasPagar.fornecedorId })
          .from(contasPagar)
          .where(and(eq(contasPagar.id, e.contaPagarId), eq(contasPagar.viagemId, e.viagemId), isNull(contasPagar.excluidoEm)));
        if (!c) return SERVICO_INVALIDO;
        fornecedorId = c.fornecedorId;
      }
      const [caso] = await tx
        .insert(reembolsos)
        .values({
          viagemId: e.viagemId,
          contaPagarId: e.contaPagarId,
          servico: e.servico,
          fornecedorId,
          ocorridoEm: e.ocorridoEm,
          ocorrido: e.ocorrido,
          valorCobrar: e.valorCobrar,
          valorDevolver: e.valorDevolver,
          formaDevolucao: e.formaDevolucao,
          prazoCliente: e.prazoCliente,
          previstoFornecedor: e.previstoFornecedor,
          criadoPor: u.id,
        })
        .returning();
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "reembolsos", registroId: caso.id, acao: "criar", depois: caso });
      for (const lado of ["receber", "pagar"] as const) {
        if (pedeConta(caso, lado)) await criarConta(tx, u.id, caso, v!, lado);
      }
      return { ok: true, id: caso.id };
    });
  });
}

/**
 * Texto, prazos e datas sempre; valor a cobrar só com o lado do fornecedor em aberto; valor a devolver e forma só com
 * o lado do cliente em aberto. A viagem e o serviço não mudam. A conta em aberto de cada lado acompanha o caso.
 */
export async function editarReembolso(id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = reembolsoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const e = p.data;
    return noCaso(id, "Falha ao editar o reembolso", async (tx, caso, contas, v) => {
      if (e.viagemId !== caso.viagemId || e.contaPagarId !== caso.contaPagarId) return VIAGEM_E_SERVICO_FIXOS;
      const fornecedorBaixado = ladoFornecedorBaixado(contas);
      const clienteBaixado = ladoClienteBaixado(caso, contas);
      if (fornecedorBaixado && e.valorCobrar !== caso.valorCobrar) return falha(MSG_FORNECEDOR_PAGOU, "valorCobrar");
      if (clienteBaixado && e.formaDevolucao !== caso.formaDevolucao) return falha(MSG_CLIENTE_REEMBOLSADO, "formaDevolucao");
      if (clienteBaixado && e.valorDevolver !== caso.valorDevolver) return falha(MSG_CLIENTE_REEMBOLSADO, "valorDevolver");
      const novos = {
        servico: e.servico,
        ocorridoEm: e.ocorridoEm,
        ocorrido: e.ocorrido,
        valorCobrar: e.valorCobrar,
        valorDevolver: e.valorDevolver,
        formaDevolucao: e.formaDevolucao,
        prazoCliente: e.prazoCliente,
        previstoFornecedor: e.previstoFornecedor,
      };
      const depois = Object.fromEntries(Object.entries(novos).filter(([k, x]) => caso[k as keyof typeof novos] !== x)) as Partial<Caso>;
      if (Object.keys(depois).length === 0) return { ok: true };
      await gravarCaso(tx, u.id, caso, depois);
      const atual = { ...caso, ...depois };
      if (!fornecedorBaixado) await sincronizarConta(tx, u.id, atual, v, "receber", contas.receber);
      if (!clienteBaixado) await sincronizarConta(tx, u.id, atual, v, "pagar", contas.pagar);
      return { ok: true };
    });
  });
}

/** "Marcar como pedido": a data do pedido ao fornecedor e o protocolo (só registro). */
export async function marcarPedido(id: string, dados: { pedidoEm: string; protocolo: string }) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = pedidoSchema(hojeEmCuiaba()).safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    return noCaso(id, "Falha ao marcar o pedido", async (tx, caso) => {
      if (caso.valorCobrar === 0n) return SEM_COBRAR;
      const depois = Object.fromEntries(Object.entries(p.data).filter(([k, x]) => caso[k as keyof typeof p.data] !== x)) as Partial<Caso>;
      if (Object.keys(depois).length > 0) await gravarCaso(tx, u.id, caso, depois);
      return { ok: true };
    });
  });
}

/** "Fornecedor pagou": a baixa da conta a receber do caso (a mesma da lista única). */
export async function fornecedorPagou(id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = baixaLancamentoSchema(hojeEmCuiaba()).safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    return noCaso(id, "Falha ao registrar o pagamento do fornecedor", async (tx, _caso, contas) => {
      if (!contas.receber) return SEM_COBRAR;
      return baixarLancamentoNa(tx, u.id, contas.receber.id, p.data);
    });
  });
}

/**
 * "Cliente reembolsado": em PIX e transferência, a baixa da conta a pagar do caso (os campos da baixa da lista); em
 * abatimento e crédito, que não têm conta, só a data (`{ data }`).
 */
export async function clienteReembolsado(id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    return noCaso(id, "Falha ao registrar o reembolso do cliente", async (tx, caso, contas) => {
      if (caso.valorDevolver === 0n) return SEM_DEVOLVER;
      if (geraContaAPagar(caso.formaDevolucao)) {
        const p = baixaLancamentoSchema(hojeEmCuiaba()).safeParse(dados);
        if (!p.success) return falhaDeValidacao(p.error);
        if (!contas.pagar) return SEM_DEVOLVER;
        return baixarLancamentoNa(tx, u.id, contas.pagar.id, p.data);
      }
      const p = reembolsadoEmSchema(hojeEmCuiaba()).safeParse(dados);
      if (!p.success) return falhaDeValidacao(p.error);
      if (caso.reembolsadoEm) return JA_REEMBOLSADO;
      await gravarCaso(tx, u.id, caso, { reembolsadoEm: p.data.data });
      return { ok: true };
    });
  });
}

/** Desfaz o marco do lado: a baixa da conta, ou a data do caso nas formas sem conta. */
export async function desfazerMarco(id: string, lado: "fornecedor" | "cliente") {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (lado !== "fornecedor" && lado !== "cliente") return falha("Lado inválido");
    return noCaso(id, "Falha ao desfazer o marco", async (tx, caso, contas) => {
      if (lado === "fornecedor") {
        if (contas.receber?.status !== "baixado") return FORNECEDOR_NAO_PAGOU;
        return desfazerBaixaLancamentoNa(tx, u.id, contas.receber.id);
      }
      if (contas.pagar?.status === "baixado") return desfazerBaixaLancamentoNa(tx, u.id, contas.pagar.id);
      if (!caso.reembolsadoEm) return CLIENTE_NAO_REEMBOLSADO;
      await gravarCaso(tx, u.id, caso, { reembolsadoEm: null });
      return { ok: true };
    });
  });
}

/** Cancela o caso sem nenhuma baixa (motivo de 5 a 200 caracteres) e as contas em aberto dele. */
export async function cancelarReembolso(id: string, motivo: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const m = motivoCancelamentoSchema.safeParse(motivo);
    if (!m.success) return falha(m.error.issues[0].message, "motivo");
    return noCaso(id, "Falha ao cancelar o reembolso", async (tx, caso, contas) => {
      if (ladoFornecedorBaixado(contas) || ladoClienteBaixado(caso, contas)) return DESFACA_BAIXAS;
      for (const conta of [contas.receber, contas.pagar]) {
        if (conta) exigirOk(await cancelarLancamentoNa(tx, u.id, conta.id, `Reembolso cancelado: ${m.data}`));
      }
      await gravarCaso(tx, u.id, caso, { canceladoEm: new Date(), canceladoPor: u.id, motivoCancelamento: m.data });
      return { ok: true };
    });
  });
}
