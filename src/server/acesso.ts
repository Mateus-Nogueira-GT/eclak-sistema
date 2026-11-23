import "server-only";
import type { z } from "zod";
import type { Perfil } from "@/domain/perfis";
import { ErroAcesso, exigirPerfil, type UsuarioAtual } from "@/server/auth";

export type SemPermissao = { ok: false; erro: "Sem permissão" };

/**
 * Roda `fn` com o usuário logado se ele tiver um dos `perfis` (vazio = qualquer usuário ativo).
 * Sem acesso, devolve `{ ok: false, erro: "Sem permissão" }` em vez de lançar.
 */
export async function comPerfil<T>(
  perfis: Perfil[],
  fn: (usuario: UsuarioAtual) => Promise<T>,
): Promise<T | SemPermissao> {
  let usuario: UsuarioAtual;
  try {
    usuario = await exigirPerfil(...perfis);
  } catch (e) {
    if (e instanceof ErroAcesso) return { ok: false, erro: "Sem permissão" };
    throw e;
  }
  return fn(usuario);
}

/**
 * Primeira mensagem por campo. A chave é o caminho até o primeiro índice de lista
 * (`markupServicos.ate`, `tipos` para `tipos[0]`).
 */
export function errosDeCampo(erro: z.ZodError): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const i of erro.issues) {
    const fim = i.path.findIndex((p) => typeof p === "number");
    const chave = (fim === -1 ? i.path : i.path.slice(0, fim)).map(String).join(".");
    if (!(chave in campos)) campos[chave] = i.message;
  }
  return campos;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ehUuid(s: string): boolean {
  return UUID.test(s);
}
