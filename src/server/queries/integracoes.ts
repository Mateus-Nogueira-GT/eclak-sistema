import "server-only";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  INTEGRACOES,
  linkHttps,
  rotuloDoErro,
  type ClasseErro,
  type Integracao,
  type IntegracaoFila,
  type SituacaoEnvio,
} from "@/domain/integracoes";
import { formatarCodigoViagem } from "@/domain/viagens";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { auditoria, clientes, integracaoEnvios, viagens } from "@/server/db/schema";
import { estadoIntegracao } from "@/server/integracoes/config";
import { temTesteDeConexao } from "@/server/integracoes/testes";

// Admin › Integrações: estado real de cada integração (pelo ambiente, só os NOMES do que falta), último teste de
// conexão (auditoria `integracoes`) e a fila de envios. Nada de payload nem segredo sai daqui.

const NOMES: Record<Integracao, { nome: string; descricao: string }> = {
  trello: {
    nome: "Trello",
    descricao: "Cria o cartão da viagem vendida com as tarefas da venda e, quando o roteiro é aprovado, as do roteiro.",
  },
  drive: {
    nome: "Google Drive",
    descricao: "Cria a pasta da viagem vendida com as subpastas Público e Uso interno.",
  },
  ia: {
    nome: "IA",
    descricao: "Reescreve textos do roteiro e responde no chat, respeitando o nível de acesso de quem pergunta.",
  },
  hotelaria: {
    nome: "Expedia TAAP e Infotera (New Age)",
    descricao: "Busca de hotelaria direto nas plataformas.",
  },
  agendador: {
    nome: "Agendador",
    descricao: "Chama o sistema em horários fixos para mandar o que ficou na fila e gerar os dailies.",
  },
};

export type UltimoTeste = { ok: boolean; em: Date; classe: ClasseErro | null };

export type CartaoIntegracao = {
  integracao: Integracao;
  nome: string;
  descricao: string;
  estado: { configurada: boolean; faltam: string[] };
  /** Tem botão "Testar conexão" (quando ligada). */
  testavel: boolean;
  ultimoTeste: UltimoTeste | null;
};

export type EnvioLista = {
  id: string;
  integracao: IntegracaoFila;
  tipo: string;
  viagem: { id: string; codigo: string; cliente: string } | null;
  situacao: SituacaoEnvio;
  tentativas: number;
  /** Rótulo do último erro (ou da espera); null sem erro. */
  erro: string | null;
  status: number | null;
  proximaEm: Date;
  criadoEm: Date;
  enviadoEm: Date | null;
  /** Cartão ou pasta criados (só https). */
  link: string | null;
};

export type Integracoes = {
  cartoes: CartaoIntegracao[];
  fila: { pendentes: EnvioLista[]; falhas: EnvioLista[]; enviadosRecentes: EnvioLista[] };
};

const LIMITE_LISTA = 50;
const LIMITE_ENVIADOS = 10;

function ultimoTesteDe(depois: unknown, em: Date): UltimoTeste | null {
  const d = depois as { ok?: unknown; classe?: unknown } | null;
  if (typeof d?.ok !== "boolean") return null;
  return { ok: d.ok, em, classe: d.ok ? null : ((typeof d.classe === "string" ? d.classe : "servidor") as ClasseErro) };
}

async function ultimosTestes(): Promise<Map<string, UltimoTeste>> {
  const linhas = await db
    .selectDistinctOn([auditoria.registroId], { registroId: auditoria.registroId, depois: auditoria.depois, em: auditoria.em })
    .from(auditoria)
    .where(and(eq(auditoria.tabela, "integracoes"), inArray(auditoria.registroId, [...INTEGRACOES])))
    .orderBy(auditoria.registroId, desc(auditoria.em), desc(auditoria.id));
  const m = new Map<string, UltimoTeste>();
  for (const l of linhas) {
    const t = ultimoTesteDe(l.depois, l.em);
    if (t) m.set(l.registroId, t);
  }
  return m;
}

const t = integracaoEnvios;

async function envios(situacoes: SituacaoEnvio[], ordem: "proxima" | "criado" | "enviado", limite: number): Promise<EnvioLista[]> {
  const ordenar = { proxima: [asc(t.proximaEm)], criado: [desc(t.criadoEm)], enviado: [desc(t.enviadoEm)] }[ordem];
  const linhas = await db
    .select({
      id: t.id,
      integracao: t.integracao,
      tipo: t.tipo,
      situacao: t.situacao,
      tentativas: t.tentativas,
      ultimoErro: t.ultimoErro,
      resultado: t.resultado,
      proximaEm: t.proximaEm,
      criadoEm: t.criadoEm,
      enviadoEm: t.enviadoEm,
      viagemId: viagens.id,
      seq: viagens.seq,
      clienteCodigo: clientes.codigo,
      grupo: clientes.grupo,
    })
    .from(t)
    .leftJoin(viagens, eq(viagens.id, t.viagemId))
    .leftJoin(clientes, eq(clientes.id, viagens.clienteId))
    .where(inArray(t.situacao, situacoes))
    .orderBy(...ordenar, asc(t.id))
    .limit(limite);
  return linhas.map((l) => {
    const r = l.resultado as { url?: unknown; link?: unknown } | null;
    return {
      id: l.id,
      integracao: l.integracao,
      tipo: l.tipo,
      viagem:
        l.viagemId && l.seq !== null && l.clienteCodigo !== null
          ? { id: l.viagemId, codigo: formatarCodigoViagem(l.clienteCodigo, l.seq), cliente: l.grupo ?? "" }
          : null,
      situacao: l.situacao,
      tentativas: l.tentativas,
      erro: rotuloDoErro(l.ultimoErro),
      status: l.ultimoErro?.status ?? null,
      proximaEm: l.proximaEm,
      criadoEm: l.criadoEm,
      enviadoEm: l.enviadoEm,
      link: l.situacao === "enviado" ? linkHttps(l.integracao === "trello" ? r?.url : r?.link) : null,
    };
  });
}

/** Só o Diretor; lança "Sem permissão" nos demais. */
export async function obterIntegracoes(): Promise<Integracoes> {
  await exigirPerfil("diretor");
  const [testes, pendentes, falhas, enviadosRecentes] = await Promise.all([
    ultimosTestes(),
    envios(["pendente", "enviando"], "proxima", LIMITE_LISTA),
    envios(["falhou"], "criado", LIMITE_LISTA),
    envios(["enviado"], "enviado", LIMITE_ENVIADOS),
  ]);
  const cartoes = INTEGRACOES.map((i) => ({
    integracao: i,
    ...NOMES[i],
    estado: estadoIntegracao(i),
    testavel: temTesteDeConexao(i),
    ultimoTeste: testes.get(i) ?? null,
  }));
  return { cartoes, fila: { pendentes, falhas, enviadosRecentes } };
}
