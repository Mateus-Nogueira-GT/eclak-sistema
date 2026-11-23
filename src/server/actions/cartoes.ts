"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { cartaoSchema, type CartaoValidado } from "@/domain/financeiro-entrada";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { comPerfil, ehUuid, errosDeCampo } from "@/server/acesso";
import { registrarAuditoria } from "@/server/auditoria";
import { db, type Transacao } from "@/server/db/client";
import { cartoesCorporativos } from "@/server/db/schema";
import { auditarAlteracao, contaBancariaAtiva, Desfazer, falha, type Falha } from "@/server/financeiro/baixas-viagem";

// Só as Server Actions são exportadas (todo export de um arquivo "use server" vira endpoint).
//
// Cadastro dos cartões corporativos: criar, editar e desativar (nunca apagar). Só Diretor e financeiros. Mudar os
// dias de fechamento/vencimento vale para as faturas que ainda vão nascer; as que já existem guardam as suas datas.

type Ok = { ok: true; id: string };

const FINANCEIRO = [...PERFIS_FINANCEIRO];
const CARTAO_NAO_ENCONTRADO = falha("Cartão não encontrado");
const CARTAO_REPETIDO = falha("Já existe um cartão ativo com este nome", "nome");
const CONTA_INVALIDA = falha("Conta bancária não encontrada ou desativada", "contaBancariaId");

function falhaDeValidacao(erro: ZodError): Falha {
  return { ok: false, erro: erro.issues[0].message, campos: errosDeCampo(erro) };
}

/** Transação com `Desfazer`; nome repetido entre os ativos (23505) vira a falha do campo; outro erro loga só o código. */
async function transacao(mensagemErro: string, fn: (tx: Transacao) => Promise<Ok | Falha>): Promise<Ok | Falha> {
  try {
    const r = await db.transaction(fn);
    if (r.ok) revalidatePath("/financeiro", "layout");
    return r;
  } catch (x) {
    if (x instanceof Desfazer) return x.falha;
    const e = x as { code?: string; cause?: { code?: string } } | null;
    const codigo = e?.cause?.code ?? e?.code;
    if (codigo === "23505") return CARTAO_REPETIDO;
    console.error(mensagemErro, { code: codigo });
    throw new Error(mensagemErro);
  }
}

const linha = (v: CartaoValidado) => ({
  nome: v.nome,
  final: v.final,
  diaFechamento: v.diaFechamento,
  diaVencimento: v.diaVencimento,
  contaBancariaId: v.contaBancariaId,
  centro: v.centro,
});

export async function criarCartao(dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = cartaoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    const v = linha(p.data);
    return transacao("Falha ao criar o cartão", async (tx) => {
      if (!(await contaBancariaAtiva(tx, v.contaBancariaId))) return CONTA_INVALIDA;
      const [novo] = await tx.insert(cartoesCorporativos).values(v).returning();
      await registrarAuditoria(tx, { usuarioId: u.id, tabela: "cartoes_corporativos", registroId: novo.id, acao: "criar", depois: novo });
      return { ok: true, id: novo.id };
    });
  });
}

export async function editarCartao(id: string, dados: unknown) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    const p = cartaoSchema.safeParse(dados);
    if (!p.success) return falhaDeValidacao(p.error);
    if (!ehUuid(id)) return CARTAO_NAO_ENCONTRADO;
    const v = linha(p.data);
    return transacao("Falha ao editar o cartão", async (tx) => {
      const [k] = await tx.select().from(cartoesCorporativos).where(eq(cartoesCorporativos.id, id)).for("update");
      if (!k) return CARTAO_NAO_ENCONTRADO;
      if (!k.ativo) return falha("Cartão desativado não pode ser editado");
      const mudou = (Object.keys(v) as (keyof typeof v)[]).filter((c) => k[c] !== v[c]);
      if (mudou.includes("contaBancariaId") && !(await contaBancariaAtiva(tx, v.contaBancariaId))) return CONTA_INVALIDA;
      if (mudou.length > 0) {
        const parcial = Object.fromEntries(mudou.map((c) => [c, v[c]])) as Partial<typeof k>;
        await tx.update(cartoesCorporativos).set(parcial).where(eq(cartoesCorporativos.id, id));
        await auditarAlteracao(tx, u.id, "cartoes_corporativos", k, parcial);
      }
      return { ok: true, id };
    });
  });
}

/** Desativa: o cartão sai das compras novas; as faturas e compras dele ficam (e podem ser pagas). */
export async function desativarCartao(id: string) {
  return comPerfil(FINANCEIRO, async (u): Promise<Ok | Falha> => {
    if (!ehUuid(id)) return CARTAO_NAO_ENCONTRADO;
    return transacao("Falha ao desativar o cartão", async (tx) => {
      const [k] = await tx.select().from(cartoesCorporativos).where(eq(cartoesCorporativos.id, id)).for("update");
      if (!k) return CARTAO_NAO_ENCONTRADO;
      if (k.ativo) {
        await tx.update(cartoesCorporativos).set({ ativo: false }).where(eq(cartoesCorporativos.id, id));
        await registrarAuditoria(tx, { usuarioId: u.id, tabela: "cartoes_corporativos", registroId: id, acao: "desativar", antes: { ativo: true }, depois: { ativo: false } });
      }
      return { ok: true, id };
    });
  });
}
