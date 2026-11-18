"use server";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { formatarCodigoCliente, hojeEmCuiaba, nomeDoGrupo, type TipoCliente } from "@/domain/clientes";
import { clienteSchema, MSG_PESSOA_ALHEIA } from "@/domain/clientes-entrada";
import type { Filial } from "@/domain/perfis";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { clientes, pessoas } from "@/server/db/schema";

export type PessoaEntrada = {
  /** Id de uma pessoa já gravada deste cliente; sem id, é pessoa nova. */
  id?: string;
  nome: string;
  parentesco?: string;
  nascimento?: string;
  cpf?: string;
  passaporte?: string;
  validadePassaporte?: string;
};

export type ClienteEntrada = {
  tipo: TipoCliente;
  grupo?: string;
  filial: Filial;
  telefone: string;
  email?: string;
  prefQuarto?: string;
  prefAlimentacao?: string;
  prefAssento?: string;
  observacoes?: string;
  titular: PessoaEntrada;
  acompanhantes: PessoaEntrada[];
};

type Falha = { ok: false; erro: string; campos?: Record<string, string>; conflito?: true };
const NAO_ENCONTRADO: Falha = { ok: false, erro: "Cliente não encontrado" };
const PESSOA_ALHEIA: Falha = { ok: false, erro: MSG_PESSOA_ALHEIA };
const CONCORRENCIA: Falha = {
  ok: false,
  erro: "Este cliente foi alterado por outra pessoa. Recarregue a página.",
  conflito: true,
};

/** Chave fixa do advisory lock que serializa a checagem de CPF entre transações. */
const LOCK_CPF = 727_001;

type ClienteLinha = typeof clientes.$inferSelect;
type PessoaLinha = typeof pessoas.$inferSelect;

/** Agregado auditado: cliente (sem id/datas de controle) + pessoas ativas (com id). */
function agregado(c: ClienteLinha, ps: PessoaLinha[]) {
  const omitidos = new Set(["id", "criadoEm", "atualizadoEm"]);
  return {
    ...Object.fromEntries(Object.entries(c).filter(([k]) => !omitidos.has(k))),
    pessoas: ps.map((p) => ({
      id: p.id,
      ordem: p.ordem,
      titular: p.titular,
      nome: p.nome,
      parentesco: p.parentesco,
      nascimento: p.nascimento,
      cpf: p.cpf,
      passaporte: p.passaporte,
      validadePassaporte: p.validadePassaporte,
    })),
  };
}

/** Pessoas ativas (não removidas) do cliente, na ordem. */
const ativasDe = (clienteId: string) => and(eq(pessoas.clienteId, clienteId), isNull(pessoas.removidoEm));

/** Erro de banco inesperado: loga só o código (sem parâmetros, que têm dados pessoais) e relança genérico. */
function erroDeBanco(mensagem: string, e: unknown): Error {
  const x = e as { code?: string; cause?: { code?: string } } | null;
  console.error(mensagem, { code: x?.cause?.code ?? x?.code });
  return new Error(mensagem);
}

/** Como um acompanhante é citado nas mensagens: pelo nome ou, sem nome, pela linha. */
function quemE(acompanhante: unknown, i: number): string {
  const nome = (acompanhante as { nome?: unknown } | null)?.nome;
  const t = typeof nome === "string" ? nome.trim() : "";
  return t && t.length <= 200 ? t : `linha ${i + 1}`;
}

/** Cria (sem `id`) ou edita (com `id` e `atualizadoEmEsperado`). Qualquer usuário ativo. */
export async function salvarCliente(
  dados: ClienteEntrada,
  id?: string,
  atualizadoEmEsperado?: string,
): Promise<{ ok: true; id: string; codigo: string } | Falha> {
  return comPerfil([], (usuario) => salvar(usuario.id, dados, id, atualizadoEmEsperado));
}

async function salvar(
  usuarioId: string,
  dados: ClienteEntrada,
  id?: string,
  atualizadoEmEsperado?: string,
): Promise<{ ok: true; id: string; codigo: string } | Falha> {
  const p = clienteSchema().safeParse(dados);
  if (!p.success) {
    const issue = p.error.issues[0];
    if (issue.message === MSG_PESSOA_ALHEIA && issue.path.at(-1) === "id") return PESSOA_ALHEIA;
    const campos = errosDeCampo(p.error);
    let erro = issue.message;
    // Acompanhantes: a mensagem geral diz de quem é; o campo da linha leva a mensagem simples.
    for (const i of p.error.issues) {
      const [raiz, n, campo] = i.path;
      if (raiz !== "acompanhantes" || typeof n !== "number" || typeof campo !== "string") continue;
      const comNome = `${i.message} (${quemE(dados.acompanhantes?.[n], n)})`;
      if (i === issue) erro = comNome;
      if (campos.acompanhantes === i.message) campos.acompanhantes = comNome;
      const chave = `acompanhantes.${n}.${campo}`;
      if (!(chave in campos)) campos[chave] = i.message;
    }
    return { ok: false, erro, campos };
  }
  if (id !== undefined && !ehUuid(id)) return NAO_ENCONTRADO;

  const { titular, acompanhantes, grupo: grupoInformado, ...resto } = p.data;
  const grupo = nomeDoGrupo(resto.tipo, titular.nome, grupoInformado ?? undefined);
  const todas = [titular, ...acompanhantes];
  const falhaCpf = (i: number, erro: string): Falha => {
    if (i === 0) return { ok: false, erro, campos: { "titular.cpf": erro } };
    const comNome = `${erro} (${quemE(todas[i], i - 1)})`;
    return { ok: false, erro: comNome, campos: { acompanhantes: comNome, [`acompanhantes.${i - 1}.cpf`]: erro } };
  };

  // Ids de pessoa: só de pessoas deste cliente (checado no banco), e cada um uma vez só.
  const idsInformados = todas.flatMap((x) => (x.id ? [x.id] : []));
  if (new Set(idsInformados).size !== idsInformados.length) return PESSOA_ALHEIA;
  if (id === undefined && idsInformados.length > 0) return PESSOA_ALHEIA;

  // CPF repetido dentro do próprio cadastro.
  const vistos = new Set<string>();
  for (let i = 0; i < todas.length; i++) {
    const c = todas[i].cpf;
    if (!c) continue;
    if (vistos.has(c)) return falhaCpf(i, "CPF repetido neste cliente");
    vistos.add(c);
  }

  let r: { id: string; codigo: number } | Falha;
  try {
    r = await db.transaction(async (tx): Promise<{ id: string; codigo: number } | Falha> => {
      // Serializa criações/edições concorrentes para a checagem de CPF não correr em paralelo.
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CPF})`);

      let antes: ReturnType<typeof agregado> | null = null;
      let psAntes: PessoaLinha[] = [];
      if (id !== undefined) {
        const [atual] = await tx
          .select()
          .from(clientes)
          .where(and(eq(clientes.id, id), isNull(clientes.excluidoEm)))
          .for("update");
        if (!atual) return NAO_ENCONTRADO;
        if (!atualizadoEmEsperado || new Date(atualizadoEmEsperado).getTime() !== atual.atualizadoEm.getTime()) {
          return CONCORRENCIA;
        }
        psAntes = await tx.select().from(pessoas).where(ativasDe(id)).orderBy(pessoas.ordem).for("update");
        const doCliente = new Set(psAntes.map((x) => x.id));
        if (idsInformados.some((x) => !doCliente.has(x))) return PESSOA_ALHEIA;
        antes = agregado(atual, psAntes);
      }

      // CPF já usado por outra pessoa ativa de outro cliente não excluído.
      if (vistos.size > 0) {
        const outros = await tx
          .select({ cpf: pessoas.cpf, grupo: clientes.grupo })
          .from(pessoas)
          .innerJoin(clientes, eq(clientes.id, pessoas.clienteId))
          .where(
            and(
              inArray(pessoas.cpf, [...vistos]),
              isNull(pessoas.removidoEm),
              isNull(clientes.excluidoEm),
              id === undefined ? undefined : ne(clientes.id, id),
            ),
          );
        for (let i = 0; i < todas.length; i++) {
          const dono = outros.find((o) => o.cpf === todas[i].cpf && todas[i].cpf);
          if (dono) return falhaCpf(i, `CPF já cadastrado em ${dono.grupo}`);
        }
      }

      const agora = new Date(); // milissegundos: o valor gravado é o que a ficha devolve
      const campos = { ...resto, grupo };
      let clienteId: string;
      let linha: ClienteLinha;
      if (id === undefined) {
        [linha] = await tx
          .insert(clientes)
          .values({ ...campos, clienteDesde: hojeEmCuiaba(), criadoEm: agora, atualizadoEm: agora })
          .returning();
        clienteId = linha.id;
      } else {
        [linha] = await tx
          .update(clientes)
          .set({ ...campos, atualizadoEm: agora })
          .where(eq(clientes.id, id))
          .returning();
        clienteId = id;
        // Tira o titular de todas antes, para a troca de titular não bater no índice de um titular por cliente.
        await tx.update(pessoas).set({ titular: false }).where(and(ativasDe(id), eq(pessoas.titular, true)));
        const mantidas = new Set(idsInformados);
        const sairam = psAntes.filter((x) => !mantidas.has(x.id)).map((x) => x.id);
        if (sairam.length > 0) {
          await tx.update(pessoas).set({ removidoEm: agora, atualizadoEm: agora }).where(inArray(pessoas.id, sairam));
        }
      }

      const depois: PessoaLinha[] = [];
      for (const [ordem, { id: pessoaId, ...x }] of todas.entries()) {
        const valores = { ...x, titular: ordem === 0, ordem, atualizadoEm: agora };
        const [gravada] = pessoaId
          ? await tx.update(pessoas).set(valores).where(eq(pessoas.id, pessoaId)).returning()
          : await tx.insert(pessoas).values({ ...valores, clienteId }).returning();
        depois.push(gravada);
      }

      await registrarAuditoria(tx, {
        usuarioId,
        tabela: "clientes",
        registroId: clienteId,
        acao: antes ? "alterar" : "criar",
        ...(antes ? { antes } : {}),
        depois: agregado(linha, depois),
      });
      return { id: clienteId, codigo: linha.codigo };
    });
  } catch (e) {
    throw erroDeBanco("Erro ao salvar cliente", e);
  }
  if ("ok" in r) return r;

  revalidatePath("/clientes");
  revalidatePath(`/clientes/${r.id}`);
  return { ok: true, id: r.id, codigo: formatarCodigoCliente(r.codigo) };
}

/** Exclusão lógica. Só o Diretor. */
export async function excluirCliente(id: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], (usuario) => excluir(usuario.id, id));
}

async function excluir(usuarioId: string, id: string): Promise<{ ok: true } | Falha> {
  if (!ehUuid(id)) return NAO_ENCONTRADO;

  let ok: boolean;
  try {
    ok = await db.transaction(async (tx) => {
      const [antes] = await tx
        .select()
        .from(clientes)
        .where(and(eq(clientes.id, id), isNull(clientes.excluidoEm)))
        .for("update");
      if (!antes) return false;
      const ps = await tx.select().from(pessoas).where(ativasDe(id)).orderBy(pessoas.ordem);
      const agora = new Date();
      await tx.update(clientes).set({ excluidoEm: agora, atualizadoEm: agora }).where(eq(clientes.id, id));
      await registrarAuditoria(tx, {
        usuarioId,
        tabela: "clientes",
        registroId: id,
        acao: "excluir",
        antes: agregado(antes, ps),
        depois: { excluidoEm: agora },
      });
      return true;
    });
  } catch (e) {
    throw erroDeBanco("Erro ao excluir cliente", e);
  }
  if (!ok) return NAO_ENCONTRADO;
  revalidatePath("/clientes");
  revalidatePath(`/clientes/${id}`);
  return { ok: true };
}
