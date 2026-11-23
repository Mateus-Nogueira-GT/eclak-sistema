import "server-only";
import { and, asc, eq, isNull } from "drizzle-orm";
import { formatarCodigoViagem, noites } from "@/domain/viagens";
import { ehUuid } from "@/server/acesso";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { clientes, pessoas, usuarios, viagemPassageiros, viagens } from "@/server/db/schema";

export type CabecalhoViagem = {
  id: string;
  codigo: string;
  cliente: string;
  grupo: string;
  titular: string;
  destino: string;
  inicio: string;
  fim: string;
  noites: number;
  passageiros: { id: string; nome: string; nascimento: string | null }[];
  consultor: { id: string; nome: string };
  vendida: boolean;
};

/** Cabeçalho da trilha da operação (só dados cadastrais; nada de preço, custo, margem ou comissão). */
export async function cabecalhoDaViagem(viagemId: string): Promise<CabecalhoViagem | null> {
  await exigirPerfil();
  if (!ehUuid(viagemId)) return null;
  const [v] = await db
    .select({
      id: viagens.id,
      seq: viagens.seq,
      destino: viagens.destino,
      inicio: viagens.inicio,
      fim: viagens.fim,
      status: viagens.status,
      consultorId: viagens.consultorId,
      clienteId: viagens.clienteId,
      clienteCodigo: clientes.codigo,
      grupo: clientes.grupo,
      consultor: usuarios.nome,
    })
    .from(viagens)
    .innerJoin(clientes, eq(clientes.id, viagens.clienteId))
    .innerJoin(usuarios, eq(usuarios.id, viagens.consultorId))
    .where(and(eq(viagens.id, viagemId), isNull(viagens.excluidoEm)))
    .limit(1);
  if (!v) return null;
  const [titular] = await db
    .select({ nome: pessoas.nome })
    .from(pessoas)
    .where(and(eq(pessoas.clienteId, v.clienteId), eq(pessoas.titular, true), isNull(pessoas.removidoEm)))
    .limit(1);
  const passageiros = await db
    .select({ id: pessoas.id, nome: pessoas.nome, nascimento: pessoas.nascimento })
    .from(viagemPassageiros)
    .innerJoin(pessoas, eq(pessoas.id, viagemPassageiros.pessoaId))
    .where(eq(viagemPassageiros.viagemId, v.id))
    .orderBy(asc(pessoas.ordem), asc(pessoas.nome));
  return {
    id: v.id,
    codigo: formatarCodigoViagem(v.clienteCodigo, v.seq),
    cliente: v.grupo,
    grupo: v.grupo,
    titular: titular?.nome ?? v.grupo,
    destino: v.destino,
    inicio: v.inicio,
    fim: v.fim,
    noites: noites(v.inicio, v.fim),
    passageiros,
    consultor: { id: v.consultorId, nome: v.consultor },
    vendida: v.status === "vendida",
  };
}
