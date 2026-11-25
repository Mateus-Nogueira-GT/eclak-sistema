import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { chavePasta } from "@/domain/drive";
import { chaveVenda } from "@/domain/trello";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, integracaoEnvios, pessoas, viagens } from "@/server/db/schema";
import type { ClienteDrive, ItemDrive } from "@/server/integracoes/drive";
import { viagemPorCodigo } from "@/server/queries/operacao";

// Alcance do agente do chat (spec §4): resolve referências externas (Trello e Drive) contra viagens não excluídas
// e confere descendência no Drive até 12 níveis. También lê os valores conhecidos para a máscara de privacidade (R-A4).

export const MAX_NIVEIS_DRIVE = 12;

export type RefsDaViagem = {
  viagemId: string;
  codigo: string;
  cliente: string;
  cartaoId: string | null;
  pastaId: string | null;
  publicaId: string | null;
  internaId: string | null;
};

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

function extrairRefs(
  base: { viagemId: string; codigo: string; cliente: string },
  envios: { integracao: "trello" | "drive"; situacao: string; resultado: unknown }[],
): RefsDaViagem {
  const trello = envios.find((e) => e.integracao === "trello" && e.situacao === "enviado");
  const drive = envios.find((e) => e.integracao === "drive" && e.situacao === "enviado");
  const rt = (typeof trello?.resultado === "object" && trello.resultado !== null ? trello.resultado : null) as Json | null;
  const rd = (typeof drive?.resultado === "object" && drive.resultado !== null ? drive.resultado : null) as Json | null;
  return {
    ...base,
    cartaoId: str(rt?.cartaoId),
    pastaId: str(rd?.pastaId),
    publicaId: str(rd?.publicaId),
    internaId: str(rd?.internaId),
  };
}

async function enviosEnviadosDaViagem(viagemId: string) {
  return db
    .select({
      integracao: integracaoEnvios.integracao,
      situacao: integracaoEnvios.situacao,
      resultado: integracaoEnvios.resultado,
    })
    .from(integracaoEnvios)
    .where(
      sql`((${integracaoEnvios.integracao} = 'trello' and ${integracaoEnvios.chave} = ${chaveVenda(viagemId)})
        or (${integracaoEnvios.integracao} = 'drive' and ${integracaoEnvios.chave} = ${chavePasta(viagemId)}))
        and ${integracaoEnvios.situacao} = 'enviado'`,
    );
}

/** Referências externas (cartão do Trello e pastas do Drive) de uma viagem pelo código `ECL-0001-01`. */
export async function refsDaViagem(codigo: string): Promise<RefsDaViagem | null> {
  const v = await viagemPorCodigo(codigo);
  if (!v) return null;
  const envios = await enviosEnviadosDaViagem(v.id);
  return extrairRefs({ viagemId: v.id, codigo: v.codigo, cliente: v.cliente }, envios);
}

/** Referências externas de uma viagem pelo id do banco (reconfere que não foi excluída). */
export async function refsDaViagemPorId(viagemId: string): Promise<RefsDaViagem | null> {
  await exigirPerfil();
  const [v] = await db
    .select({ id: viagens.id, seq: viagens.seq, clienteCodigo: clientes.codigo, grupo: clientes.grupo })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)))
    .limit(1);
  if (!v) return null;
  const envios = await enviosEnviadosDaViagem(v.id);
  return extrairRefs({ viagemId: v.id, codigo: formatarCodigoViagem(v.clienteCodigo, v.seq), cliente: v.grupo }, envios);
}

/** Se o `cartaoId` pertence a uma viagem não excluída (envio `enviado`), devolve as refs dela; senão `null`. */
export async function viagemDoCartao(cartaoId: string): Promise<RefsDaViagem | null> {
  await exigirPerfil();
  const [linha] = await db
    .select({
      viagemId: viagens.id,
      seq: viagens.seq,
      clienteCodigo: clientes.codigo,
      grupo: clientes.grupo,
    })
    .from(integracaoEnvios)
    .innerJoin(viagens, eq(viagens.id, integracaoEnvios.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(
      and(
        eq(integracaoEnvios.integracao, "trello"),
        eq(integracaoEnvios.tipo, "cartao_viagem"),
        eq(integracaoEnvios.situacao, "enviado"),
        isNull(viagens.excluidoEm),
        sql`${integracaoEnvios.resultado}->>'cartaoId' = ${cartaoId}`,
      ),
    )
    .limit(1);
  if (!linha) return null;
  const envios = await enviosEnviadosDaViagem(linha.viagemId);
  return extrairRefs(
    { viagemId: linha.viagemId, codigo: formatarCodigoViagem(linha.clienteCodigo, linha.seq), cliente: linha.grupo },
    envios,
  );
}

/** Mapa `cartaoId -> código da viagem` para marcar cartões de viagem nas listagens do Trello. */
export async function codigosPorCartao(): Promise<Map<string, string>> {
  await exigirPerfil();
  const linhas = await db
    .select({
      resultado: integracaoEnvios.resultado,
      seq: viagens.seq,
      clienteCodigo: clientes.codigo,
    })
    .from(integracaoEnvios)
    .innerJoin(viagens, eq(viagens.id, integracaoEnvios.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(
      and(
        eq(integracaoEnvios.integracao, "trello"),
        eq(integracaoEnvios.tipo, "cartao_viagem"),
        eq(integracaoEnvios.situacao, "enviado"),
        isNull(viagens.excluidoEm),
      ),
    );
  const mapa = new Map<string, string>();
  for (const l of linhas) {
    const cid = str((l.resultado as Json | null)?.cartaoId);
    if (cid) mapa.set(cid, formatarCodigoViagem(l.clienteCodigo, l.seq));
  }
  return mapa;
}

async function obterComCache(drive: ClienteDrive, id: string, cache?: Map<string, ItemDrive | null>): Promise<ItemDrive | null> {
  if (cache?.has(id)) return cache.get(id) ?? null;
  const item = await drive.obter(id);
  cache?.set(id, item);
  return item;
}

/** Sobe por `pais` no Drive até achar `ancestralId` (máximo 12 níveis); o próprio ancestral conta. */
export async function descendeDe(
  drive: ClienteDrive,
  itemId: string,
  ancestralId: string,
  cache?: Map<string, ItemDrive | null>,
): Promise<boolean> {
  if (itemId === ancestralId) return true;
  let atual = itemId;
  const vistos = new Set<string>([atual]);
  for (let nivel = 0; nivel < MAX_NIVEIS_DRIVE; nivel++) {
    const item = await obterComCache(drive, atual, cache);
    if (!item || item.pais.length === 0) return false;
    if (item.pais.includes(ancestralId)) return true;
    const pai = item.pais[0];
    if (vistos.has(pai)) return false;
    vistos.add(pai);
    atual = pai;
  }
  return false;
}

/** Encontra a viagem dona de um arquivo ou pasta no Drive (sobe por `pais` até achar o `pastaId` de uma viagem). */
export async function viagemDoItem(
  drive: ClienteDrive,
  itemId: string,
  cache?: Map<string, ItemDrive | null>,
): Promise<RefsDaViagem | null> {
  await exigirPerfil();
  const linhas = await db
    .select({
      viagemId: viagens.id,
      seq: viagens.seq,
      clienteCodigo: clientes.codigo,
      grupo: clientes.grupo,
      resultado: integracaoEnvios.resultado,
    })
    .from(integracaoEnvios)
    .innerJoin(viagens, eq(viagens.id, integracaoEnvios.viagemId))
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(
      and(
        eq(integracaoEnvios.integracao, "drive"),
        eq(integracaoEnvios.tipo, "pasta_viagem"),
        eq(integracaoEnvios.situacao, "enviado"),
        isNull(viagens.excluidoEm),
      ),
    );
  const porPasta = new Map<string, RefsDaViagem>();
  for (const l of linhas) {
    const r = (typeof l.resultado === "object" && l.resultado !== null ? l.resultado : null) as Json | null;
    const pastaId = str(r?.pastaId);
    if (!pastaId) continue;
    porPasta.set(pastaId, {
      viagemId: l.viagemId,
      codigo: formatarCodigoViagem(l.clienteCodigo, l.seq),
      cliente: l.grupo,
      cartaoId: null,
      pastaId,
      publicaId: str(r?.publicaId),
      internaId: str(r?.internaId),
    });
  }
  if (porPasta.size === 0) return null;
  if (porPasta.has(itemId)) return porPasta.get(itemId)!;

  let atual = itemId;
  const vistos = new Set<string>([atual]);
  for (let nivel = 0; nivel < MAX_NIVEIS_DRIVE; nivel++) {
    const item = await obterComCache(drive, atual, cache);
    if (!item || item.pais.length === 0) return null;
    for (const p of item.pais) {
      const achada = porPasta.get(p);
      if (achada) return achada;
    }
    const pai = item.pais[0];
    if (vistos.has(pai)) return null;
    vistos.add(pai);
    atual = pai;
  }
  return null;
}

/**
 * Caminho de nomes de pastas da raiz até o item (sem incluir a raiz nem o próprio item).
 * Devolve `null` se o item não existir ou não descender de `raizId` em até 12 níveis.
 */
export async function caminhoAteARaiz(
  drive: ClienteDrive,
  itemId: string,
  raizId: string,
  cache?: Map<string, ItemDrive | null>,
): Promise<string[] | null> {
  if (itemId === raizId) return [];
  const itemInicial = await obterComCache(drive, itemId, cache);
  if (!itemInicial || itemInicial.pais.length === 0) return null;
  if (itemInicial.pais.includes(raizId)) return [];

  const pastas: string[] = [];
  let atual = itemInicial.pais[0];
  const vistos = new Set<string>([itemId, atual]);
  // O primeiro salto já foi do item ao seu pai; faltam até MAX_NIVEIS_DRIVE - 1 saltos.
  for (let nivel = 1; nivel < MAX_NIVEIS_DRIVE; nivel++) {
    const pasta = await obterComCache(drive, atual, cache);
    if (!pasta) return null;
    pastas.unshift(pasta.nome);
    if (pasta.pais.length === 0) return null;
    if (pasta.pais.includes(raizId)) return pastas;
    const pai = pasta.pais[0];
    if (vistos.has(pai)) return null;
    vistos.add(pai);
    atual = pai;
  }
  return null;
}

/**
 * Nascimentos e documentos (CPF e passaporte) de todas as pessoas não excluídas, lidos uma vez por pergunta
 * para alimentar `protegerTexto` (R-A4).
 */
export async function conhecidosDoSistema(): Promise<{ nascimentos: string[]; documentos: string[] }> {
  await exigirPerfil();
  const ps = await db
    .select({ nascimento: pessoas.nascimento, cpf: pessoas.cpf, passaporte: pessoas.passaporte })
    .from(pessoas)
    .innerJoin(clientes, eq(clientes.id, pessoas.clienteId))
    .where(and(isNull(pessoas.removidoEm), isNull(clientes.excluidoEm)));
  return {
    nascimentos: ps.flatMap((p) => (p.nascimento ? [p.nascimento] : [])),
    documentos: ps.flatMap((p) => [p.cpf, p.passaporte].filter((d): d is string => !!d)),
  };
}
