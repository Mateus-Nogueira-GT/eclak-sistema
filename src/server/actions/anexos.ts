"use server";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { DONOS_ANEXO, MSG_TAMANHO_ANEXO, MSG_TIPO_ANEXO, TAMANHO_MAXIMO_ANEXO, tipoPelosBytes, type DonoAnexo } from "@/domain/anexos";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { comPerfil, ehUuid } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { anexos, comissoes, faturasCartao, lancamentos, notasFiscais, pagamentosFornecedor, parcelasReceber, reembolsos } from "@/server/db/schema";
import { linkAssinado, removerObjeto, subirObjeto } from "@/server/storage";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Anexos de linhas da lista (e, nas próximas tasks, de faturas do cartão e notas fiscais). Só Diretor e
// financeiros. O arquivo vai para o bucket privado do Storage; a linha e a auditoria na mesma transação (se a
// gravação falhar, o objeto é removido). Remover = `excluido_em` (o objeto fica). Download por URL assinada de 60 s.

type Falha = { ok: false; erro: string };
const falha = (erro: string): Falha => ({ ok: false, erro });
const DONO_NAO_ENCONTRADO = falha("Lançamento não encontrado");
const NOTA_NAO_ENCONTRADA = falha("Nota fiscal não encontrada");
const FATURA_CARTAO_NAO_ENCONTRADA = falha("Fatura do cartão não encontrada");
const REEMBOLSO_NAO_ENCONTRADO = falha("Reembolso não encontrado");
const ANEXO_NAO_ENCONTRADO = falha("Anexo não encontrado");
const FALHA_ENVIO = falha("Não foi possível enviar o arquivo. Tente de novo.");

const FINANCEIRO = [...PERFIS_FINANCEIRO];

const ehDono = (t: unknown): t is DonoAnexo => typeof t === "string" && (DONOS_ANEXO as readonly string[]).includes(t);

/**
 * O dono existe? Um caso por tabela.
 */
async function donoExiste(tipo: DonoAnexo, id: string, origem: typeof db | Transacao = db): Promise<boolean> {
  switch (tipo) {
    case "manual":
      return (await origem.select({ id: lancamentos.id }).from(lancamentos).where(eq(lancamentos.id, id))).length > 0;
    case "parcela":
      return (await origem.select({ id: parcelasReceber.id }).from(parcelasReceber).where(eq(parcelasReceber.id, id))).length > 0;
    case "pagamento":
      return (await origem.select({ id: pagamentosFornecedor.id }).from(pagamentosFornecedor).where(eq(pagamentosFornecedor.id, id))).length > 0;
    case "comissao":
      return (await origem.select({ id: comissoes.id }).from(comissoes).where(eq(comissoes.id, id))).length > 0;
    case "nota_fiscal":
      return (await origem.select({ id: notasFiscais.id }).from(notasFiscais).where(eq(notasFiscais.id, id))).length > 0;
    case "fatura_cartao":
      return (await origem.select({ id: faturasCartao.id }).from(faturasCartao).where(eq(faturasCartao.id, id))).length > 0;
    case "reembolso":
      return (await origem.select({ id: reembolsos.id }).from(reembolsos).where(eq(reembolsos.id, id))).length > 0;
    default:
      return false;
  }
}

/** Erro de banco inesperado: loga só o código (sem parâmetros) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

function revalidar() {
  revalidatePath("/financeiro", "layout");
}

/** Envia um anexo. FormData: `donoTipo`, `donoId`, `arquivo` (PDF, PNG ou JPEG até 10 MB, conferido pelos bytes). */
export async function enviarAnexo(formData: FormData) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true; id: string } | Falha> => {
    const donoTipo = formData.get("donoTipo");
    const donoId = formData.get("donoId");
    if (!ehDono(donoTipo) || typeof donoId !== "string" || !ehUuid(donoId)) return DONO_NAO_ENCONTRADO;
    const falhaDono = () =>
      donoTipo === "nota_fiscal"
        ? NOTA_NAO_ENCONTRADA
        : donoTipo === "fatura_cartao"
          ? FATURA_CARTAO_NAO_ENCONTRADA
          : donoTipo === "reembolso"
            ? REEMBOLSO_NAO_ENCONTRADO
            : DONO_NAO_ENCONTRADO;
    if (!(await donoExiste(donoTipo, donoId))) return falhaDono();

    const arquivo = formData.get("arquivo");
    if (!(arquivo instanceof File) || arquivo.size === 0) return falha(MSG_TIPO_ANEXO);
    if (arquivo.size > TAMANHO_MAXIMO_ANEXO) return falha(MSG_TAMANHO_ANEXO);
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    if (bytes.length > TAMANHO_MAXIMO_ANEXO) return falha(MSG_TAMANHO_ANEXO);
    const mime = tipoPelosBytes(bytes);
    if (!mime) return falha(MSG_TIPO_ANEXO);

    // O nome original só na coluna `nome` (nada do usuário no caminho).
    const caminho = `${donoTipo}/${donoId}/${randomUUID()}`;
    // Por code point (não por unidade UTF-16): o corte em 255 não parte um emoji ou outro par substituto ao meio.
    const nome = Array.from(arquivo.name || "arquivo").slice(0, 255).join("");
    const subiu = await subirObjeto(caminho, bytes, mime);
    if (!subiu.ok) return FALHA_ENVIO;

    let id: string | null;
    try {
      id = await db.transaction(async (tx) => {
        if (!(await donoExiste(donoTipo, donoId, tx))) return null;
        const valores = { donoTipo, donoId, caminho, nome, mime, tamanho: bytes.length, enviadoPor: u.id };
        const [novo] = await tx.insert(anexos).values(valores).returning({ id: anexos.id });
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "anexos", registroId: novo.id, acao: "criar", depois: valores });
        return novo.id;
      });
    } catch (e) {
      // A linha não foi gravada: o objeto não fica órfão no bucket.
      await removerObjeto(caminho);
      throw erroDeBanco("Falha ao gravar o anexo", e);
    }
    if (!id) {
      await removerObjeto(caminho);
      return falhaDono();
    }
    revalidar();
    return { ok: true, id };
  });
}

/** Remove o anexo da lista (`excluido_em`); o objeto fica no Storage. */
export async function removerAnexo(id: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<{ ok: true } | Falha> => {
    if (typeof id !== "string" || !ehUuid(id)) return ANEXO_NAO_ENCONTRADO;
    let r: { ok: true } | Falha;
    try {
      r = await db.transaction(async (tx): Promise<{ ok: true } | Falha> => {
        const [a] = await tx.select().from(anexos).where(and(eq(anexos.id, id), isNull(anexos.excluidoEm))).for("update");
        if (!a) return ANEXO_NAO_ENCONTRADO;
        const [depois] = await tx.update(anexos).set({ excluidoEm: new Date() }).where(eq(anexos.id, id)).returning({ excluidoEm: anexos.excluidoEm });
        await registrarAuditoria(tx, {
          usuarioId: u.id,
          tabela: "anexos",
          registroId: id,
          acao: "excluir",
          antes: { excluidoEm: null },
          depois: { excluidoEm: depois.excluidoEm },
        });
        return { ok: true };
      });
    } catch (e) {
      throw erroDeBanco("Falha ao remover o anexo", e);
    }
    if (r.ok) revalidar();
    return r;
  });
}

/** URL assinada (60 s) para abrir o anexo; anexo removido ou inexistente: "Anexo não encontrado". */
export async function linkDoAnexo(id: string): Promise<{ ok: true; url: string } | Falha> {
  return comPerfil(FINANCEIRO, async (): Promise<{ ok: true; url: string } | Falha> => {
    if (typeof id !== "string" || !ehUuid(id)) return ANEXO_NAO_ENCONTRADO;
    const [a] = await db.select({ caminho: anexos.caminho }).from(anexos).where(and(eq(anexos.id, id), isNull(anexos.excluidoEm)));
    if (!a) return ANEXO_NAO_ENCONTRADO;
    const url = await linkAssinado(a.caminho);
    return url ? { ok: true, url } : falha("Não foi possível abrir o arquivo. Tente de novo.");
  });
}
