"use server";

import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { MSG_TIPO_ANEXO, tipoPelosBytes } from "@/domain/anexos";
import {
  MAX_ANEXOS_ESPERANDO,
  MSG_TAMANHO_ANEXO_CHAT,
  TAMANHO_MAXIMO_ANEXO_CHAT,
  VALIDADE_ANEXO_MIN,
} from "@/domain/chat-acoes";
import { comPerfil, ehUuid } from "@/server/acesso";
import { db } from "@/server/db/client";
import { chatAnexos, usuarios } from "@/server/db/schema";
import { PERFIS_ACAO_CHAT } from "@/server/ia/acoes";
import { configDrive } from "@/server/integracoes/config";
import { removerObjeto, subirObjeto } from "@/server/storage";

// Só as Server Actions são exportadas. Anexos enviados pelo chat ficam no bucket privado `anexos`
// em `chat/<usuario>/<uuid>` por 60 min (até irem ao Drive ou expirarem). Só PDF, PNG ou JPEG até 5 MB,
// conferidos pelos bytes. Máximo de 3 anexos esperando por pessoa.

type Falha = { ok: false; erro: string };
const falha = (erro: string): Falha => ({ ok: false, erro });
const LIMITE_ANEXOS = falha("Você já tem 3 arquivos anexados esperando. Use ou remova um.");
const ANEXO_NAO_ENCONTRADO = falha("Anexo não encontrado");
const FALHA_ENVIO = falha("Não foi possível enviar o arquivo. Tente de novo.");

/** Sobe um arquivo do chat para aguardar envio ao Google Drive. FormData: `arquivo`. */
export async function anexarNoChat(
  formData: FormData,
): Promise<{ ok: true; id: string; nome: string; tamanho: number } | Falha> {
  return comPerfil([...PERFIS_ACAO_CHAT], async (u): Promise<{ ok: true; id: string; nome: string; tamanho: number } | Falha> => {
    if (!configDrive()) return falha("O Google Drive não está configurado");

    const arquivo = formData.get("arquivo");
    if (!(arquivo instanceof File) || arquivo.size === 0) return falha(MSG_TIPO_ANEXO);
    if (arquivo.size > TAMANHO_MAXIMO_ANEXO_CHAT) return falha(MSG_TAMANHO_ANEXO_CHAT);
    const bytes = new Uint8Array(await arquivo.arrayBuffer());
    if (bytes.length === 0) return falha(MSG_TIPO_ANEXO);
    if (bytes.length > TAMANHO_MAXIMO_ANEXO_CHAT) return falha(MSG_TAMANHO_ANEXO_CHAT);
    const mime = tipoPelosBytes(bytes);
    if (!mime) return falha(MSG_TIPO_ANEXO);

    const agora = new Date();
    const existentes = await db
      .select({ id: chatAnexos.id })
      .from(chatAnexos)
      .where(and(eq(chatAnexos.usuarioId, u.id), isNull(chatAnexos.usadoEm), gt(chatAnexos.expiraEm, agora)));
    if (existentes.length >= MAX_ANEXOS_ESPERANDO) return LIMITE_ANEXOS;

    const caminho = `chat/${u.id}/${randomUUID()}`;
    const nome = Array.from(arquivo.name || "arquivo").slice(0, 255).join("");
    const subiu = await subirObjeto(caminho, bytes, mime);
    if (!subiu.ok) return FALHA_ENVIO;

    let id: string | null = null;
    try {
      id = await db.transaction(async (tx) => {
        // Serializa envios simultâneos da mesma pessoa para respeitar o limite de 3.
        await tx.select({ id: usuarios.id }).from(usuarios).where(eq(usuarios.id, u.id)).for("no key update");
        const atuais = await tx
          .select({ id: chatAnexos.id })
          .from(chatAnexos)
          .where(and(eq(chatAnexos.usuarioId, u.id), isNull(chatAnexos.usadoEm), gt(chatAnexos.expiraEm, new Date())));
        if (atuais.length >= MAX_ANEXOS_ESPERANDO) return null;
        const expiraEm = new Date(Date.now() + VALIDADE_ANEXO_MIN * 60_000);
        const [novo] = await tx
          .insert(chatAnexos)
          .values({ usuarioId: u.id, nome, mime, tamanho: bytes.length, caminho, expiraEm })
          .returning({ id: chatAnexos.id });
        return novo.id;
      });
    } catch (e) {
      await removerObjeto(caminho);
      const x = e as { code?: string; cause?: { code?: string } } | null;
      console.error("Falha ao gravar anexo do chat", { code: x?.cause?.code ?? x?.code });
      return FALHA_ENVIO;
    }

    if (!id) {
      await removerObjeto(caminho);
      return LIMITE_ANEXOS;
    }
    return { ok: true, id, nome, tamanho: bytes.length };
  });
}

/** Remove um anexo do chat ainda não usado (só quem anexou) e apaga o objeto do bucket. */
export async function removerAnexoDoChat(id: string): Promise<{ ok: true } | Falha> {
  return comPerfil([...PERFIS_ACAO_CHAT], async (u): Promise<{ ok: true } | Falha> => {
    if (typeof id !== "string" || !ehUuid(id)) return ANEXO_NAO_ENCONTRADO;
    const removido = await db.transaction(async (tx) => {
      const [linha] = await tx
        .delete(chatAnexos)
        .where(and(eq(chatAnexos.id, id), eq(chatAnexos.usuarioId, u.id), isNull(chatAnexos.usadoEm)))
        .returning({ caminho: chatAnexos.caminho });
      return linha ?? null;
    });
    if (!removido) return ANEXO_NAO_ENCONTRADO;
    await removerObjeto(removido.caminho);
    return { ok: true };
  });
}
