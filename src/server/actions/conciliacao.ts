"use server";

import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { dataEmCuiaba, hojeEmCuiaba } from "@/domain/clientes";
import { opcoesDeEscolha } from "@/domain/conciliacao";
import { ORIGENS, type Origem } from "@/domain/financeiro";
import { lancamentoDaTransacaoSchema, motivoIgnorarSchema } from "@/domain/financeiro-entrada";
import { TAMANHO_MAXIMO_OFX, decodificarOfx, lerOfx, type ExtratoOfx, type TransacaoOfx } from "@/domain/ofx";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { contasBancarias, extratoTransacoes, extratos } from "@/server/db/schema";
import { candidataNa, travarTransacaoExtrato, type TransacaoExtratoLinha } from "@/server/financeiro/conciliacao";
import { Desfazer, baixarLancamentoNa, criarLancamentosNa, falha, type Falha } from "@/server/financeiro/lancamentos";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Conciliação do extrato OFX com as baixas do sistema (fatia 6b): importar o arquivo, confirmar o par (sugerido ou
// escolhido), criar o lançamento a partir da transação (já baixado e conciliado), ignorar com motivo e desfazer.
// Só Diretor e financeiros. Toda escrita trava a transação do extrato (`for update`) e audita na mesma transação.
// Não mexe nas baixas: a validade do par é conferida na leitura ("A baixa mudou").

type Ok = { ok: true };
/** `novas` = transações gravadas (inclui as `ajustadas`: FITID já usado com outra data ou valor, gravadas com FITID ajustado). */
type Importado = { ok: true; extratoId: string; novas: number; repetidas: number; ajustadas: number; inicio: string | null; fim: string | null };
/** Banco ou final da conta do arquivo diferente dos extratos já importados na conta: a tela pede confirmação. */
type OutraConta = Falha & { outraConta: true };

const FINANCEIRO = [...PERFIS_FINANCEIRO];
const CONTA_NAO_ENCONTRADA = falha("Conta bancária não encontrada ou desativada");
const TRANSACAO_NAO_ENCONTRADA = falha("Transação do extrato não encontrada");
const ORIGEM_INVALIDA = falha("Origem inválida");
const PAR_INVALIDO = falha("Esta baixa não pode ser conciliada com esta transação");
const JA_CONCILIADA = falha("Esta baixa já está conciliada com outra transação");
const EXTRATO_NAO_ENCONTRADO = falha("Extrato não encontrado");
const MSG_ARQUIVO = "Escolha o arquivo OFX";
const MSG_TAMANHO = "O arquivo passa de 5 MB";
/** Linhas por INSERT e valores por `IN (...)` (abaixo do limite de parâmetros do Postgres). */
const LOTE_INSERT = 1000;

const ehOrigem = (o: unknown): o is Origem => typeof o === "string" && (ORIGENS as readonly string[]).includes(o);

const erroDoBanco = (e: unknown): { code?: string; constraint?: string } => {
  const x = e as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } } | null;
  return { code: x?.cause?.code ?? x?.code, constraint: x?.cause?.constraint_name ?? x?.constraint_name };
};

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  console.error(mensagem, { code: erroDoBanco(e).code });
  return new Error(mensagem);
}

/** Transação com `Desfazer`; a violação do índice de "uma baixa, uma transação" vira `JA_CONCILIADA`. */
async function transacao<T extends { ok: true }>(mensagemErro: string, fn: (tx: Transacao) => Promise<T | Falha>): Promise<T | Falha> {
  try {
    return await db.transaction(fn);
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    const e = erroDoBanco(x);
    if (e.code === "23505" && e.constraint === "extrato_transacoes_linha_unica") return JA_CONCILIADA;
    throw erroDeBanco(mensagemErro, x);
  }
}

function revalidar() {
  revalidatePath("/financeiro", "layout");
}

/** A transação precisa estar pendente para conciliar, criar o lançamento ou ignorar. */
function recusaSeNaoPendente(t: TransacaoExtratoLinha): Falha | null {
  if (t.situacao === "conciliada") return falha("Esta transação já foi conciliada: desfaça antes");
  if (t.situacao === "ignorada") return falha("Esta transação foi ignorada: desfaça antes");
  return null;
}

/** Grava a transação (travada) como conciliada com a linha da view e audita. */
async function conciliarNa(tx: Transacao, usuarioId: string, t: TransacaoExtratoLinha, origem: Origem, linhaId: string): Promise<void> {
  const depois = { situacao: "conciliada" as const, linhaOrigem: origem, linhaId, conciliadaPor: usuarioId, conciliadaEm: new Date() };
  await tx.update(extratoTransacoes).set(depois).where(eq(extratoTransacoes.id, t.id));
  const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, t[k as keyof TransacaoExtratoLinha]]));
  await registrarAuditoria(tx, { usuarioId, tabela: "extrato_transacoes", registroId: t.id, acao: "alterar", antes, depois });
}

const dataBr = (d: Date) => dataEmCuiaba(d).split("-").reverse().join("/");

async function jaImportadoEm(contaId: string, hash: string): Promise<Date | null> {
  const [e] = await db
    .select({ importadoEm: extratos.importadoEm })
    .from(extratos)
    .where(and(eq(extratos.contaBancariaId, contaId), eq(extratos.arquivoHash, hash)));
  return e?.importadoEm ?? null;
}

const msgJaImportado = (em: Date) => falha(`Este arquivo já foi importado nesta conta em ${dataBr(em)}`);

type Gravar = TransacaoOfx & { fitidGravado: string; ajustada: boolean };

/** FITID de uma transação cujo FITID original já está na conta (ou no arquivo) com outra data ou valor. */
const fitidAjustado = (t: TransacaoOfx) => `${t.fitid}#${t.data}#${t.valor}`;

/**
 * Separa o que gravar do que já está na conta (`existentes`: FITID → data e valor gravados). Já gravada como
 * `fitid#data#valor` → repetida (mesmo se o FITID original ficou livre, por exemplo depois de desfazer a importação
 * que o tinha); FITID livre → nova; FITID com a mesma data e valor (na conta ou antes no próprio arquivo) →
 * repetida; com outra data ou valor → grava com `fitid#data#valor` (ajustada).
 */
function separarTransacoes(transacoes: TransacaoOfx[], existentes: Map<string, { data: string; valor: bigint }>): { gravar: Gravar[]; repetidas: number } {
  const vistos = new Map(existentes);
  const gravar: Gravar[] = [];
  let repetidas = 0;
  for (const t of transacoes) {
    const ajustado = fitidAjustado(t);
    const original = vistos.get(t.fitid);
    if (vistos.has(ajustado) || (original && original.data === t.data && original.valor === t.valor)) {
      repetidas++;
      continue;
    }
    const fitid = original ? ajustado : t.fitid;
    vistos.set(fitid, { data: t.data, valor: t.valor });
    gravar.push({ ...t, fitidGravado: fitid, ajustada: fitid !== t.fitid });
  }
  // Ordem fixa por FITID: duas importações na mesma conta nunca travam linhas em ordens cruzadas.
  gravar.sort((x, y) => (x.fitidGravado < y.fitidGravado ? -1 : x.fitidGravado > y.fitidGravado ? 1 : 0));
  return { gravar, repetidas };
}

async function fitidsNaConta(tx: Transacao, contaId: string, transacoes: TransacaoOfx[]): Promise<Map<string, { data: string; valor: bigint }>> {
  const procurados = [...new Set(transacoes.flatMap((t) => [t.fitid, fitidAjustado(t)]))];
  const existentes = new Map<string, { data: string; valor: bigint }>();
  for (let i = 0; i < procurados.length; i += LOTE_INSERT) {
    const linhas = await tx
      .select({ fitid: extratoTransacoes.fitid, data: extratoTransacoes.data, valor: extratoTransacoes.valor })
      .from(extratoTransacoes)
      .where(and(eq(extratoTransacoes.contaBancariaId, contaId), inArray(extratoTransacoes.fitid, procurados.slice(i, i + LOTE_INSERT))));
    for (const l of linhas) existentes.set(l.fitid, { data: l.data, valor: l.valor });
  }
  return existentes;
}

/** Extrato já importado na conta com banco ou final diferente do arquivo (só compara o que os dois têm). */
async function outraContaNa(tx: Transacao, contaId: string, extrato: ExtratoOfx): Promise<OutraConta | null> {
  const anteriores = await tx.selectDistinct({ banco: extratos.bancoOfx, conta: extratos.contaOfx }).from(extratos).where(eq(extratos.contaBancariaId, contaId));
  const difere = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  if (!anteriores.some((e) => difere(e.banco, extrato.banco) || difere(e.conta, extrato.conta))) return null;
  const quem = [extrato.banco && `banco ${extrato.banco}`, extrato.conta && `final ${extrato.conta}`].filter(Boolean).join(", ");
  return { ok: false, erro: `Este extrato parece ser de outra conta (${quem}). Confirme para importar mesmo assim.`, outraConta: true };
}

/**
 * Importa um extrato OFX. FormData: `contaBancariaId`, `arquivo` (até 5 MB) e `confirmarOutraConta=1` (opcional). O
 * arquivo não é guardado (só o SHA-256, para recusar o mesmo arquivo na mesma conta). Transação com FITID já
 * importado na conta (deste ou de outro arquivo, ou repetido no próprio arquivo) e mesma data e valor conta como
 * repetida e não duplica; com outra data ou valor entra separada, com FITID ajustado (`ajustadas`). Se a conta já
 * tem extrato de outro banco ou outro final de conta, recusa com `outraConta` até vir a confirmação. Trava a conta
 * (`for no key update`): importações na mesma conta entram uma de cada vez.
 */
export async function importarExtrato(form: FormData) {
  return comPerfil(FINANCEIRO, async (u): Promise<Importado | OutraConta | Falha> => {
    const contaId = form.get("contaBancariaId");
    if (typeof contaId !== "string" || !ehUuid(contaId)) return CONTA_NAO_ENCONTRADA;
    const arquivo = form.get("arquivo");
    if (!(arquivo instanceof File) || arquivo.size === 0) return falha(MSG_ARQUIVO);
    if (arquivo.size > TAMANHO_MAXIMO_OFX) return falha(MSG_TAMANHO);
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    if (bytes.length > TAMANHO_MAXIMO_OFX) return falha(MSG_TAMANHO);
    const lido = lerOfx(decodificarOfx(bytes));
    if (!lido.ok) return falha(lido.erro);
    const { extrato } = lido;
    const confirmarOutraConta = form.get("confirmarOutraConta") === "1";
    const hash = createHash("sha256").update(bytes).digest("hex");
    const nome = Array.from(arquivo.name || "extrato.ofx").slice(0, 255).join("");

    let r: Importado | OutraConta | Falha;
    try {
      r = await db.transaction(async (tx): Promise<Importado | OutraConta | Falha> => {
        // `no key update`: serializa as importações da conta sem barrar inserts que só referenciam a conta pela FK
        // (as baixas, que conferem a conta com `for share`, esperam a importação terminar).
        const [conta] = await tx
          .select({ id: contasBancarias.id })
          .from(contasBancarias)
          .where(and(eq(contasBancarias.id, contaId), eq(contasBancarias.ativa, true), isNull(contasBancarias.excluidoEm)))
          .for("no key update");
        if (!conta) return CONTA_NAO_ENCONTRADA;
        const [repetido] = await tx
          .select({ importadoEm: extratos.importadoEm })
          .from(extratos)
          .where(and(eq(extratos.contaBancariaId, contaId), eq(extratos.arquivoHash, hash)));
        if (repetido) return msgJaImportado(repetido.importadoEm);
        if (!confirmarOutraConta) {
          const outra = await outraContaNa(tx, contaId, extrato);
          if (outra) return outra;
        }
        const { gravar, repetidas } = separarTransacoes(extrato.transacoes, await fitidsNaConta(tx, contaId, extrato.transacoes));
        const novas = gravar.length;
        const ajustadas = gravar.filter((t) => t.ajustada).length;
        const [gravado] = await tx
          .insert(extratos)
          .values({
            contaBancariaId: contaId,
            arquivoNome: nome,
            arquivoHash: hash,
            bancoOfx: extrato.banco,
            contaOfx: extrato.conta,
            inicio: extrato.inicio,
            fim: extrato.fim,
            transacoes: novas,
            repetidas,
            importadoPor: u.id,
          })
          .returning();
        for (let i = 0; i < gravar.length; i += LOTE_INSERT) {
          await tx.insert(extratoTransacoes).values(
            gravar.slice(i, i + LOTE_INSERT).map((t) => ({
              extratoId: gravado.id,
              contaBancariaId: contaId,
              fitid: t.fitidGravado,
              data: t.data,
              valor: t.valor,
              tipo: t.tipo,
              descricao: t.descricao,
            })),
          );
        }
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "extratos", registroId: gravado.id, acao: "criar", depois: { ...gravado, ajustadas } });
        return { ok: true, extratoId: gravado.id, novas, repetidas, ajustadas, inicio: extrato.inicio, fim: extrato.fim };
      });
    } catch (x) {
      // Mesmo arquivo importado ao mesmo tempo por outra pessoa: a segunda cai no único (conta, hash).
      const e = erroDoBanco(x);
      if (e.code === "23505" && e.constraint === "extratos_conta_hash_unico") {
        const em = await jaImportadoEm(contaId, hash);
        if (em) return msgJaImportado(em);
      }
      throw erroDeBanco("Falha ao importar o extrato", x);
    }
    if (r.ok) revalidar();
    return r;
  });
}

/**
 * Desfaz a importação de um extrato (arquivo da conta errada, por exemplo): apaga as transações e o extrato, com a
 * auditoria (antes) na mesma transação. Só enquanto todas as transações dele estão pendentes; com alguma conciliada
 * ou ignorada, pede para desfazer antes. Trava o extrato e as transações (`for update`).
 */
export async function desfazerImportacao(extratoId: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (typeof extratoId !== "string" || !ehUuid(extratoId)) return EXTRATO_NAO_ENCONTRADO;
    const r = await transacao("Falha ao desfazer a importação", async (tx): Promise<Ok | Falha> => {
      const [e] = await tx.select().from(extratos).where(eq(extratos.id, extratoId)).for("update");
      if (!e) return EXTRATO_NAO_ENCONTRADO;
      const ts = await tx.select().from(extratoTransacoes).where(eq(extratoTransacoes.extratoId, e.id)).orderBy(asc(extratoTransacoes.id)).for("update");
      if (ts.some((t) => t.situacao !== "pendente")) return falha("Desfaça as conciliações deste extrato antes");
      await tx.delete(extratoTransacoes).where(eq(extratoTransacoes.extratoId, e.id));
      for (const t of ts) {
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "extrato_transacoes", registroId: t.id, acao: "excluir", antes: t });
      }
      await tx.delete(extratos).where(eq(extratos.id, e.id));
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "extratos", registroId: e.id, acao: "excluir", antes: e });
      return { ok: true };
    });
    if (r.ok) revalidar();
    return r;
  });
}

/**
 * Concilia a transação pendente com uma baixa (origem + id da view): a sugerida ou outra escolhida. A baixa precisa
 * ser candidata para esta transação (baixada no caixa da mesma conta, mesmo sinal, a até `DIAS_ESCOLHA` dias); "ainda
 * não conciliada" é garantido pelo índice único parcial (também na corrida de duas pessoas).
 */
export async function confirmarPar(transacaoId: string, origem: Origem, linhaId: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (!ehOrigem(origem)) return ORIGEM_INVALIDA;
    if (typeof transacaoId !== "string" || !ehUuid(transacaoId)) return TRANSACAO_NAO_ENCONTRADA;
    if (typeof linhaId !== "string" || !ehUuid(linhaId)) return PAR_INVALIDO;
    const r = await transacao("Falha ao conciliar a transação", async (tx): Promise<Ok | Falha> => {
      const t = await travarTransacaoExtrato(tx, transacaoId);
      if (!t) return TRANSACAO_NAO_ENCONTRADA;
      const recusa = recusaSeNaoPendente(t);
      if (recusa) return recusa;
      const c = await candidataNa(tx, t.contaBancariaId, origem, linhaId);
      if (!c || opcoesDeEscolha(t, [c]).length === 0) return PAR_INVALIDO;
      await conciliarNa(tx, u.id, t, origem, linhaId);
      return { ok: true };
    });
    if (r.ok) revalidar();
    return r;
  });
}

/**
 * Cria o lançamento manual da transação pendente (tarifa, IOF, rendimento…): lado pelo sinal, valor em módulo,
 * competência, vencimento e baixa na data da transação, na conta do extrato, forma "Débito em conta", categoria e
 * centro escolhidos; já baixado e conciliado, tudo numa transação (o núcleo de criar e baixar do financeiro).
 */
export async function criarLancamentoDaTransacao(transacaoId: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<(Ok & { id: string }) | Falha> => {
    const p = lancamentoDaTransacaoSchema.safeParse(dados);
    if (!p.success) return { ok: false, erro: p.error.issues[0].message, campos: errosDeCampo(p.error) };
    if (typeof transacaoId !== "string" || !ehUuid(transacaoId)) return TRANSACAO_NAO_ENCONTRADA;
    const r = await transacao("Falha ao criar o lançamento da transação", async (tx): Promise<(Ok & { id: string }) | Falha> => {
      const t = await travarTransacaoExtrato(tx, transacaoId);
      if (!t) return TRANSACAO_NAO_ENCONTRADA;
      const recusa = recusaSeNaoPendente(t);
      if (recusa) return recusa;
      if (t.valor === 0n) return falha("Transação sem valor: ignore-a");
      if (t.data > hojeEmCuiaba()) return falha("A transação tem data futura");
      const valor = t.valor < 0n ? -t.valor : t.valor;
      const [l] = await criarLancamentosNa(tx, u.id, {
        lado: t.valor > 0n ? "receber" : "pagar",
        descricao: p.data.descricao,
        fornecedorId: null,
        clienteId: null,
        pessoaTexto: null,
        categoriaId: p.data.categoriaId,
        centro: p.data.centro,
        competencia: t.data.slice(0, 7),
        emissao: t.data,
        vencimento: t.data,
        valor,
        forma: "Débito em conta",
        contaBancariaId: t.contaBancariaId,
        observacao: null,
        repeticao: { tipo: "unica" },
        cartaoId: null,
      });
      const b = await baixarLancamentoNa(tx, u.id, l.id, { data: t.data, valorPago: valor, juros: 0n, desconto: 0n, contaBancariaId: t.contaBancariaId, observacao: null });
      if (!b.ok) throw new Desfazer(b);
      await conciliarNa(tx, u.id, t, "manual", l.id);
      return { ok: true, id: l.id };
    });
    if (r.ok) revalidar();
    return r;
  });
}

/** Ignora a transação pendente (transferência entre contas, estorno…) com motivo de 3 a 200 caracteres. */
export async function ignorarTransacao(transacaoId: string, motivo: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const m = motivoIgnorarSchema.safeParse(motivo);
    if (!m.success) return falha(m.error.issues[0].message, "motivo");
    if (typeof transacaoId !== "string" || !ehUuid(transacaoId)) return TRANSACAO_NAO_ENCONTRADA;
    const r = await transacao("Falha ao ignorar a transação", async (tx): Promise<Ok | Falha> => {
      const t = await travarTransacaoExtrato(tx, transacaoId);
      if (!t) return TRANSACAO_NAO_ENCONTRADA;
      const recusa = recusaSeNaoPendente(t);
      if (recusa) return recusa;
      const depois = { situacao: "ignorada" as const, ignoradaMotivo: m.data, ignoradaPor: u.id, ignoradaEm: new Date() };
      await tx.update(extratoTransacoes).set(depois).where(eq(extratoTransacoes.id, t.id));
      const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, t[k as keyof TransacaoExtratoLinha]]));
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "extrato_transacoes", registroId: t.id, acao: "alterar", antes, depois });
      return { ok: true };
    });
    if (r.ok) revalidar();
    return r;
  });
}

/**
 * Volta a transação conciliada ou ignorada a pendente, limpando o par e o motivo. O lançamento criado a partir da
 * transação (se houver) fica como está: é desfeito ou cancelado pela lista, como qualquer outro.
 */
export async function desfazerConciliacao(transacaoId: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (typeof transacaoId !== "string" || !ehUuid(transacaoId)) return TRANSACAO_NAO_ENCONTRADA;
    const r = await transacao("Falha ao desfazer a conciliação", async (tx): Promise<Ok | Falha> => {
      const t = await travarTransacaoExtrato(tx, transacaoId);
      if (!t) return TRANSACAO_NAO_ENCONTRADA;
      if (t.situacao === "pendente") return falha("Esta transação já está pendente");
      const depois = {
        situacao: "pendente" as const,
        linhaOrigem: null,
        linhaId: null,
        conciliadaPor: null,
        conciliadaEm: null,
        ignoradaMotivo: null,
        ignoradaPor: null,
        ignoradaEm: null,
      };
      await tx.update(extratoTransacoes).set(depois).where(eq(extratoTransacoes.id, t.id));
      const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, t[k as keyof TransacaoExtratoLinha]]));
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "extrato_transacoes", registroId: t.id, acao: "alterar", antes, depois });
      return { ok: true };
    });
    if (r.ok) revalidar();
    return r;
  });
}
