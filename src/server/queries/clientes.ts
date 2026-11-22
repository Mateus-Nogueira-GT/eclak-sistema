import "server-only";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
  alertasDoCliente,
  type ViagemAlerta,
  formatarCodigoCliente,
  formatarCpf,
  formatarTelefone,
  hojeEmCuiaba,
  type AlertaCliente,
  type TipoCliente,
} from "@/domain/clientes";
import type { Filial } from "@/domain/perfis";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, pessoas, viagemPassageiros, viagens } from "@/server/db/schema";

export type PessoaFicha = {
  id: string;
  nome: string;
  titular: boolean;
  parentesco: string | null;
  nascimento: string | null;
  cpf: string | null;
  passaporte: string | null;
  validadePassaporte: string | null;
};

export type ClienteFicha = {
  id: string;
  codigo: string;
  grupo: string;
  tipo: TipoCliente;
  filial: Filial;
  telefone: string;
  email: string | null;
  prefQuarto: string | null;
  prefAlimentacao: string | null;
  prefAssento: string | null;
  observacoes: string | null;
  clienteDesde: string;
  /** ISO em milissegundos; devolvido em `salvarCliente` para controle de concorrência. */
  atualizadoEm: string;
  pessoas: PessoaFicha[];
  alertas: AlertaCliente[];
  excluidoEm: string | null;
};

export type ClienteLista = {
  id: string;
  codigo: string;
  grupo: string;
  tipo: TipoCliente;
  filial: Filial;
  titular: string;
  acompanhantes: number;
  telefone: string;
  email: string | null;
  alertas: AlertaCliente[];
};

/** Escapa curingas do LIKE para a busca ser literal. */
const literal = (t: string) => t.replace(/[\\%_]/g, "\\$&");

const AVISOS_DOCUMENTOS: AlertaCliente["tipo"][] = ["sem_passaporte", "passaporte_vencido", "passaporte_volta"];

/** Viagens `aprovado`/`vendida` que ainda não terminaram, por cliente, para o aviso de passaporte × volta. */
async function viagensParaAlerta(ids: string[], hoje: string): Promise<Map<string, ViagemAlerta[]>> {
  const mapa = new Map<string, ViagemAlerta[]>();
  if (ids.length === 0) return mapa;
  const vs = await db
    .select({ id: viagens.id, clienteId: viagens.clienteId, destino: viagens.destino, fim: viagens.fim, internacional: viagens.internacional })
    .from(viagens)
    .where(and(inArray(viagens.clienteId, ids), inArray(viagens.status, ["aprovado", "vendida"]), gte(viagens.fim, hoje), isNull(viagens.excluidoEm)));
  if (vs.length === 0) return mapa;
  const pax = await db
    .select({ viagemId: viagemPassageiros.viagemId, pessoaId: viagemPassageiros.pessoaId })
    .from(viagemPassageiros)
    .where(inArray(viagemPassageiros.viagemId, vs.map((v) => v.id)));
  for (const v of vs) {
    const lista = mapa.get(v.clienteId) ?? [];
    lista.push({
      destino: v.destino,
      fim: v.fim,
      internacional: v.internacional,
      passageiros: pax.filter((p) => p.viagemId === v.id).map((p) => p.pessoaId),
    });
    mapa.set(v.clienteId, lista);
  }
  return mapa;
}

async function pessoasDe(ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(pessoas)
    .where(and(inArray(pessoas.clienteId, ids), isNull(pessoas.removidoEm)))
    .orderBy(asc(pessoas.clienteId), asc(pessoas.ordem));
}

/** `ECL-0002`, `ecl2`, `ECL 2`: busca pelo código do cliente. */
const CODIGO = /^\s*ECL-?\s*(\d{1,6})\s*$/i;

/**
 * Clientes não excluídos, por grupo. Busca pelo código (`ECL-0002`); ou sem acento e sem caixa em grupo,
 * nome das pessoas e e-mail, e por dígitos em CPF e telefone (com 3 dígitos ou mais). Pessoas removidas
 * não contam. Exige login.
 */
export async function listarClientes(
  filtro: { busca?: string; tipo?: TipoCliente; aviso?: "documentos" | "aniversario" } = {},
): Promise<ClienteLista[]> {
  await exigirPerfil();
  const condicoes = [isNull(clientes.excluidoEm)];
  const busca = filtro.busca?.trim();
  const codigo = busca ? CODIGO.exec(busca) : null;
  if (codigo) {
    condicoes.push(eq(clientes.codigo, Number(codigo[1])));
  } else if (busca) {
    const padrao = `%${literal(busca)}%`;
    const digitos = busca.replace(/\D/g, "");
    const partes = [
      sql`extensions.unaccent(${clientes.grupo}) ilike extensions.unaccent(${padrao})`,
      sql`extensions.unaccent(coalesce(${clientes.email}, '')) ilike extensions.unaccent(${padrao})`,
      sql`exists (select 1 from ${pessoas} p where p.cliente_id = ${clientes.id} and p.removido_em is null and extensions.unaccent(p.nome) ilike extensions.unaccent(${padrao}))`,
    ];
    if (digitos.length >= 3) {
      const d = `%${digitos}%`;
      partes.push(sql`${clientes.telefone} like ${d}`);
      partes.push(sql`exists (select 1 from ${pessoas} p where p.cliente_id = ${clientes.id} and p.removido_em is null and p.cpf like ${d})`);
    }
    condicoes.push(sql`(${sql.join(partes, sql` or `)})`);
  }
  if (filtro.tipo) condicoes.push(eq(clientes.tipo, filtro.tipo));

  const linhas = await db
    .select()
    .from(clientes)
    .where(and(...condicoes))
    .orderBy(asc(clientes.grupo), asc(clientes.codigo));
  const todas = await pessoasDe(linhas.map((c) => c.id));
  const hoje = hojeEmCuiaba();
  const futuras = await viagensParaAlerta(linhas.map((c) => c.id), hoje);

  const lista: ClienteLista[] = [];
  for (const c of linhas) {
    const doCliente = todas.filter((p) => p.clienteId === c.id);
    const alertas = alertasDoCliente({ tipo: c.tipo, pessoas: doCliente }, hoje, futuras.get(c.id));
    if (filtro.aviso === "documentos" && !alertas.some((a) => AVISOS_DOCUMENTOS.includes(a.tipo))) continue;
    if (filtro.aviso === "aniversario" && !alertas.some((a) => a.tipo === "aniversario")) continue;
    lista.push({
      id: c.id,
      codigo: formatarCodigoCliente(c.codigo),
      grupo: c.grupo,
      tipo: c.tipo,
      filial: c.filial,
      titular: doCliente.find((p) => p.titular)?.nome ?? "",
      acompanhantes: doCliente.filter((p) => !p.titular).length,
      telefone: formatarTelefone(c.telefone),
      email: c.email,
      alertas,
    });
  }
  return lista;
}

/** Inclui excluídos (com `excluidoEm` preenchido). Exige login. */
export async function obterCliente(id: string): Promise<ClienteFicha | null> {
  await exigirPerfil();
  if (!ehUuid(id)) return null;
  const [c] = await db.select().from(clientes).where(eq(clientes.id, id)).limit(1);
  if (!c) return null;
  const ps = await pessoasDe([c.id]);
  const hoje = hojeEmCuiaba();
  return {
    id: c.id,
    codigo: formatarCodigoCliente(c.codigo),
    grupo: c.grupo,
    tipo: c.tipo,
    filial: c.filial,
    telefone: formatarTelefone(c.telefone),
    email: c.email,
    prefQuarto: c.prefQuarto,
    prefAlimentacao: c.prefAlimentacao,
    prefAssento: c.prefAssento,
    observacoes: c.observacoes,
    clienteDesde: c.clienteDesde,
    atualizadoEm: c.atualizadoEm.toISOString(),
    pessoas: ps.map((p) => ({
      id: p.id,
      nome: p.nome,
      titular: p.titular,
      parentesco: p.parentesco,
      nascimento: p.nascimento,
      cpf: p.cpf ? formatarCpf(p.cpf) : null,
      passaporte: p.passaporte,
      validadePassaporte: p.validadePassaporte,
    })),
    alertas: alertasDoCliente({ tipo: c.tipo, pessoas: ps }, hoje, (await viagensParaAlerta([c.id], hoje)).get(c.id)),
    excluidoEm: c.excluidoEm ? c.excluidoEm.toISOString() : null,
  };
}
