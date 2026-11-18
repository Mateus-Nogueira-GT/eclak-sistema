"use server";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { formatarCodigoCliente, nomeDoGrupo, type TipoCliente } from "@/domain/clientes";
import { clienteSchema } from "@/domain/clientes-entrada";
import type { Filial } from "@/domain/perfis";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db } from "@/server/db/client";
import { clientes, pessoas } from "@/server/db/schema";

export type PessoaEntrada = {
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

type Falha = { ok: false; erro: string; campos?: Record<string, string> };
const NAO_ENCONTRADO: Falha = { ok: false, erro: "Cliente não encontrado" };
const CONCORRENCIA: Falha = { ok: false, erro: "Este cliente foi alterado por outra pessoa. Recarregue a página." };

/** Chave fixa do advisory lock que serializa a checagem de CPF entre transações. */
const LOCK_CPF = 727_001;

type ClienteLinha = typeof clientes.$inferSelect;
type PessoaLinha = typeof pessoas.$inferSelect;

/** Agregado auditado: cliente (sem id/datas de controle) + pessoas (sem ids). */
function agregado(c: ClienteLinha, ps: PessoaLinha[]) {
  const omitidos = new Set(["id", "criadoEm", "atualizadoEm"]);
  return {
    ...Object.fromEntries(Object.entries(c).filter(([k]) => !omitidos.has(k))),
    pessoas: ps.map((p) => ({
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
    return { ok: false, erro: p.error.issues[0].message, campos: errosDeCampo(p.error) };
  }
  if (id !== undefined && !ehUuid(id)) return NAO_ENCONTRADO;

  const { titular, acompanhantes, grupo: grupoInformado, ...resto } = p.data;
  const grupo = nomeDoGrupo(resto.tipo, titular.nome, grupoInformado ?? undefined);
  const todas = [titular, ...acompanhantes];
  const falhaCpf = (i: number, erro: string): Falha => ({
    ok: false,
    erro,
    campos: { [i === 0 ? "titular.cpf" : "acompanhantes"]: erro },
  });

  // CPF repetido dentro do próprio cadastro.
  const vistos = new Set<string>();
  for (let i = 0; i < todas.length; i++) {
    const c = todas[i].cpf;
    if (!c) continue;
    if (vistos.has(c)) return falhaCpf(i, "CPF repetido neste cliente");
    vistos.add(c);
  }

  const r = await db.transaction(async (tx): Promise<{ id: string; codigo: number } | Falha> => {
    // Serializa criações/edições concorrentes para a checagem de CPF não correr em paralelo.
    await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_CPF})`);

    let antes: ReturnType<typeof agregado> | null = null;
    if (id !== undefined) {
      const [atual] = await tx
        .select()
        .from(clientes)
        .where(and(eq(clientes.id, id), isNull(clientes.excluidoEm)))
        .for("update");
      if (!atual) return NAO_ENCONTRADO;
      if (!atualizadoEmEsperado || atual.atualizadoEm.toISOString() !== atualizadoEmEsperado) return CONCORRENCIA;
      const psAntes = await tx.select().from(pessoas).where(eq(pessoas.clienteId, id)).orderBy(pessoas.ordem);
      antes = agregado(atual, psAntes);
    }

    // CPF já usado por outro cliente não excluído.
    if (vistos.size > 0) {
      const outros = await tx
        .select({ cpf: pessoas.cpf, grupo: clientes.grupo })
        .from(pessoas)
        .innerJoin(clientes, eq(clientes.id, pessoas.clienteId))
        .where(
          and(
            inArray(pessoas.cpf, [...vistos]),
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
        .values({ ...campos, criadoEm: agora, atualizadoEm: agora })
        .returning();
      clienteId = linha.id;
    } else {
      [linha] = await tx
        .update(clientes)
        .set({ ...campos, atualizadoEm: agora })
        .where(eq(clientes.id, id))
        .returning();
      clienteId = id;
      await tx.delete(pessoas).where(eq(pessoas.clienteId, id));
    }
    const novas = await tx
      .insert(pessoas)
      .values(todas.map((x, i) => ({ ...x, clienteId, titular: i === 0, ordem: i })))
      .returning();
    novas.sort((a, b) => a.ordem - b.ordem);

    await registrarAuditoria(tx, {
      usuarioId,
      tabela: "clientes",
      registroId: clienteId,
      acao: antes ? "alterar" : "criar",
      ...(antes ? { antes } : {}),
      depois: agregado(linha, novas),
    });
    return { id: clienteId, codigo: linha.codigo };
  });
  if ("ok" in r) return r;

  revalidatePath("/clientes");
  return { ok: true, id: r.id, codigo: formatarCodigoCliente(r.codigo) };
}

/** Exclusão lógica. Só o Diretor. */
export async function excluirCliente(id: string): Promise<{ ok: true } | Falha> {
  return comPerfil(["diretor"], (usuario) => excluir(usuario.id, id));
}

async function excluir(usuarioId: string, id: string): Promise<{ ok: true } | Falha> {
  if (!ehUuid(id)) return NAO_ENCONTRADO;

  const ok = await db.transaction(async (tx) => {
    const [antes] = await tx
      .select()
      .from(clientes)
      .where(and(eq(clientes.id, id), isNull(clientes.excluidoEm)))
      .for("update");
    if (!antes) return false;
    const ps = await tx.select().from(pessoas).where(eq(pessoas.clienteId, id)).orderBy(pessoas.ordem);
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
  if (!ok) return NAO_ENCONTRADO;
  revalidatePath("/clientes");
  return { ok: true };
}
