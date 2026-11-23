import { beforeEach, describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { db } from "@/server/db/client";
import {
  auditoria,
  clientes,
  cotacoes,
  itensViagem,
  pessoas,
  regrasVersoes,
  versoesPrecificacao,
  viagemPassageiros,
  viagens,
} from "@/server/db/schema";
import { criarUsuarioTeste, limparBanco } from "../helpers/db";

const anon = () =>
  createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );

describe("RLS: anon não lê nada", () => {
  beforeEach(async () => {
    await limparBanco();
    const u = await criarUsuarioTeste("diretor");
    await db.insert(auditoria).values({
      usuarioId: u.id,
      tabela: "usuarios",
      registroId: u.id,
      acao: "criar",
      depois: { ok: true },
    });
    const [c] = await db
      .insert(clientes)
      .values({ grupo: "Família Teste", tipo: "familia", filial: "Rondonópolis", telefone: "66999999999" })
      .returning();
    const [p] = await db
      .insert(pessoas)
      .values({ clienteId: c.id, titular: true, ordem: 1, nome: "Titular Teste" })
      .returning();
    const [v] = await db
      .insert(viagens)
      .values({
        clienteId: c.id,
        seq: 1,
        destino: "Itália",
        inicio: "2027-08-14",
        fim: "2027-09-01",
        filial: "Rondonópolis",
        consultorId: u.id,
      })
      .returning();
    await db.insert(viagemPassageiros).values({ viagemId: v.id, pessoaId: p.id });
    const [i] = await db
      .insert(itensViagem)
      .values({ viagemId: v.id, ordem: 1, tipo: "Hotelaria", servico: "Hotel Teste" })
      .returning();
    await db.insert(cotacoes).values({ itemId: i.id, valorOriginal: 100000n, valorBrl: 100000n });
    const [r] = await db.insert(regrasVersoes).values({ valores: {} as never }).returning();
    await db.insert(versoesPrecificacao).values({
      viagemId: v.id,
      numero: 1,
      snapshot: {},
      preco: 100000n,
      forma: {},
      dias: 19,
      regrasVersaoId: r.id,
      rateio: "pax",
      resultado: {},
      enviadoPor: u.id,
    });
  });

  for (const tabela of [
    "usuarios",
    "auditoria",
    "clientes",
    "pessoas",
    "viagens",
    "viagem_passageiros",
    "itens_viagem",
    "cotacoes",
    "versoes_precificacao",
  ]) {
    it(`anon não enxerga linhas de ${tabela}`, async () => {
      const { data, error } = await anon().from(tabela).select("*");
      expect(error ? [] : data).toEqual([]);
    });
  }
});
