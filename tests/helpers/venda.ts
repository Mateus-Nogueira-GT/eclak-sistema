// Fixture de viagem vendida (extraída de financeiro-viagem.test.ts). Quem importa precisa registrar, no próprio
// arquivo de teste, os mocks de `next/cache` e `@/server/supabase` (vi.mock só vale no arquivo de teste).
import { asc, eq } from "drizzle-orm";
import type { FormaPagamento } from "@/domain/precificacao";
import { db } from "@/server/db/client";
import { comissoes, contasPagar, pagamentosFornecedor, parcelasReceber } from "@/server/db/schema";
import { salvarCliente, type ClienteEntrada } from "@/server/actions/clientes";
import { salvarFornecedor } from "@/server/actions/fornecedores";
import { salvarRegras } from "@/server/actions/regras";
import { regrasVigentes } from "@/server/queries/regras";
import { aprovar, enviarParaAprovacao } from "@/server/actions/aprovacoes";
import { criarOrcamento, salvarCotacao, salvarItem, type ItemEntrada } from "@/server/actions/viagens";
import { fecharVenda } from "@/server/actions/vendas";
import { salvarContaBancaria } from "@/server/actions/financeiro";
import { obterCliente } from "@/server/queries/clientes";
import { comSessao, criarUsuarioTeste } from "./db";

export const souza: ClienteEntrada = {
  tipo: "familia",
  filial: "RS",
  telefone: "(66) 9 9123-4567",
  titular: { nome: "Marcos Souza" },
  acompanhantes: [{ nome: "Júlia Souza", parentesco: "Esposa" }],
};

const BOLETO2: FormaPagamento = { tipo: "boleto", parcelas: 2 };
const CARTAO_FORNECEDOR: FormaPagamento = { tipo: "cartao_fornecedor", parcelas: 1 };

/** Conta bancária ativa criada pelo financeiro `uid` (nome único entre as ativas); devolve o id. */
export async function contaBancaria(uid: string, nome = "Banco do Brasil"): Promise<string> {
  const r = await comSessao(uid, () => salvarContaBancaria({ nome, banco: "001", saldoInicial: "0,00", saldoInicialEm: "2026-01-01" }));
  if (!r.ok || !r.id) throw new Error(r.ok ? "Conta bancária sem id" : r.erro);
  return r.id;
}

export async function fornecedor(uid: string, nome: string, modalidade: "net" | "comissionado", tipos: string[]) {
  const r = await comSessao(uid, () => salvarFornecedor({ nome, tipos, modalidade } as Parameters<typeof salvarFornecedor>[0]));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

export async function item(uid: string, viagemId: string, dados: Partial<ItemEntrada>) {
  const r = await comSessao(uid, () => salvarItem(viagemId, { tipo: "Passeio", servico: "Passeio", ...dados }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

export async function cotacao(uid: string, itemId: string, dados: Record<string, unknown>) {
  const r = await comSessao(uid, () => salvarCotacao(itemId, { moeda: "BRL", valor: "1.000,00", ...dados }));
  if (!r.ok) throw new Error(r.erro);
  return r.id;
}

/**
 * Viagem vendida em boleto 2x: hotel em fornecedor comissionado (3.106,00, 4% a receber, 4% à vista), passeio net
 * (500,00), transfer em EUR net (1.000,00 EUR), aéreo (8.000,00) e a taxa de roteiro automática. Com `cartao`, a
 * venda é "Cartão direto no fornecedor" (1 parcela) recebida no cartão desse fornecedor (hotel = Palazzo Hotels,
 * passeio = Roma Tours, transfer = Euro Transfer). `forma` troca a forma de pagamento (ex.: crédito com antecipação).
 */
export async function vendida(o: { florenca?: boolean; cartao?: "hotel" | "passeio" | "transfer"; forma?: FormaPagamento } = {}) {
  const u = await criarUsuarioTeste("consultor");
  const d = await criarUsuarioTeste("diretor");
  const fin = await criarUsuarioTeste("fin_operacional");
  const vig = await comSessao(d.id, () => regrasVigentes());
  if (vig.valores.taxaRoteiro.minimoItens !== 2) {
    const g = await comSessao(d.id, () => salvarRegras({ ...vig.valores, taxaRoteiro: { ...vig.valores.taxaRoteiro, minimoItens: 2 } }));
    if (!g.ok) throw new Error(g.erro);
  }
  const c = await comSessao(u.id, () => salvarCliente(souza));
  if (!c.ok) throw new Error(c.erro);
  const pessoas = (await comSessao(u.id, () => obterCliente(c.id)))!.pessoas.map((p) => p.id);
  const r = await comSessao(u.id, () =>
    criarOrcamento({ clienteId: c.id, destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: pessoas }),
  );
  if (!r.ok) throw new Error(r.erro);
  const viagemId = r.id;
  const palazzo = await fornecedor(u.id, "Palazzo Hotels", "comissionado", ["Hotelaria"]);
  const roma = await fornecedor(u.id, "Roma Tours", "net", ["Passeio guiado"]);
  const euro = await fornecedor(u.id, "Euro Transfer", "net", ["Transfer"]);
  const hotel = await item(u.id, viagemId, { tipo: "Hotelaria", servico: "Palazzo Barocci", cidade: "Roma", diarias: 3 });
  await cotacao(u.id, hotel, { valor: "3.106,00", comissao: "4", descontoAVista: "4", fornecedorId: palazzo });
  const passeio = await item(u.id, viagemId, { servico: "Coliseu", cidade: "Roma" });
  await cotacao(u.id, passeio, { valor: "500,00", fornecedorId: roma });
  const transfer = await item(u.id, viagemId, { tipo: "Transfer", servico: "Transfer FCO", cidade: "Roma" });
  await cotacao(u.id, transfer, { moeda: "EUR", valor: "1.000,00", fornecedorId: euro });
  const aereo = await item(u.id, viagemId, { tipo: "Aéreo", servico: "GRU-FCO" });
  await cotacao(u.id, aereo, { valor: "8.000,00", comissao: "6" });
  // Opcional: o hotel de Florença do caso Ribeiro (4.100,00 net, sem desconto à vista).
  const florenca = o.florenca ? await item(u.id, viagemId, { tipo: "Hotelaria", servico: "Palazzo Lungarno Nove", cidade: "Florença", diarias: 3 }) : null;
  if (florenca) await cotacao(u.id, florenca, { valor: "4.100,00", fornecedorId: await fornecedor(u.id, "Lungarno Hotels", "net", ["Hotelaria"]) });
  const forma = o.forma ?? (o.cartao ? CARTAO_FORNECEDOR : BOLETO2);
  const fornecedorCartaoId = o.cartao ? { hotel: palazzo, passeio: roma, transfer: euro }[o.cartao] : undefined;
  const e = await comSessao(u.id, () => enviarParaAprovacao(viagemId, { forma, alteracao: "Primeira versão" }));
  if (!e.ok) throw new Error(e.erro);
  const a = await comSessao(d.id, () => aprovar(e.id));
  if (!a.ok) throw new Error(a.erro);
  const f = await comSessao(u.id, () =>
    fecharVenda(viagemId, {
      aceiteEm: "2026-11-20",
      forma,
      parcelas: forma.parcelas,
      primeiroVencimento: "2026-12-10",
      faturaNome: "Marcos Souza",
      faturaDocumento: "529.982.247-25",
      fornecedorCartaoId,
    }),
  );
  if (!f.ok) throw new Error(f.erro);

  const contas = await db.select().from(contasPagar).where(eq(contasPagar.viagemId, viagemId));
  const conta = (itemId: string) => contas.find((x) => x.itemId === itemId)!;
  const pagamentoDa = async (contaId: string) =>
    (await db.select().from(pagamentosFornecedor).where(eq(pagamentosFornecedor.contaId, contaId)).orderBy(asc(pagamentosFornecedor.numero)))[0];
  const parcelas = await db.select().from(parcelasReceber).where(eq(parcelasReceber.viagemId, viagemId)).orderBy(asc(parcelasReceber.numero));
  const [comissao] = await db.select().from(comissoes).where(eq(comissoes.viagemId, viagemId));
  return {
    u,
    d,
    fin,
    viagemId,
    fornecedores: { palazzo, roma, euro },
    hotel: conta(hotel),
    passeio: conta(passeio),
    transfer: conta(transfer),
    aereo: conta(aereo),
    florenca: florenca ? conta(florenca) : null,
    pagHotel: await pagamentoDa(conta(hotel).id),
    pagPasseio: await pagamentoDa(conta(passeio).id),
    pagTransfer: await pagamentoDa(conta(transfer).id),
    pagAereo: await pagamentoDa(conta(aereo).id),
    parcelas,
    comissao,
  };
}

export type Fixture = Awaited<ReturnType<typeof vendida>>;
