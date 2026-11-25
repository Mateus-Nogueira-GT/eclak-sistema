import "server-only";
import { supabaseAdmin } from "@/server/supabase";
import type { TipoAnexo } from "@/domain/anexos";

// Supabase Storage, só no servidor e só pela service role (nenhuma política em storage.objects). O bucket privado
// `anexos` nasce na migração 0028 (INSERT em storage.buckets, idempotente).
export const BUCKET_ANEXOS = "anexos";

/** Validade da URL assinada de download, em segundos. */
export const VALIDADE_LINK_S = 60;

const bucket = () => supabaseAdmin().storage.from(BUCKET_ANEXOS);

/** Sobe o arquivo; o `contentType` é o tipo reconhecido pelos bytes (o bucket recusa outros). */
export async function subirObjeto(caminho: string, bytes: Uint8Array, tipo: TipoAnexo): Promise<{ ok: true } | { ok: false }> {
  const { error } = await bucket().upload(caminho, bytes, { contentType: tipo, upsert: false });
  if (error) {
    console.error("Falha ao subir o anexo no Storage", { code: (error as { statusCode?: string }).statusCode ?? error.name });
    return { ok: false };
  }
  return { ok: true };
}

/** Remove o objeto (só para desfazer um envio cuja gravação falhou; anexo removido mantém o objeto). */
export async function removerObjeto(caminho: string): Promise<void> {
  const { error } = await bucket().remove([caminho]);
  if (error) console.error("Falha ao remover o anexo do Storage", { code: (error as { statusCode?: string }).statusCode ?? error.name });
}

/** URL assinada de download (60 s). */
export async function linkAssinado(caminho: string): Promise<string | null> {
  const { data, error } = await bucket().createSignedUrl(caminho, VALIDADE_LINK_S);
  if (error || !data) {
    console.error("Falha ao assinar o link do anexo", { code: (error as { statusCode?: string } | null)?.statusCode ?? error?.name });
    return null;
  }
  return data.signedUrl;
}

/** Baixa os bytes de um objeto do bucket `anexos`; devolve `null` se não existir ou falhar. */
export async function baixarObjeto(caminho: string): Promise<Uint8Array | null> {
  const { data, error } = await bucket().download(caminho);
  if (error || !data) {
    console.error("Falha ao baixar o anexo do Storage", { code: (error as { statusCode?: string } | null)?.statusCode ?? error?.name });
    return null;
  }
  return new Uint8Array(await data.arrayBuffer());
}
