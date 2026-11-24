import { describe, expect, it } from "vitest";
import {
  ajustarItem,
  ajustarSnapshot,
  ajusteSchema,
  custosDoSnapshot,
  envioSchema,
  formaSchema,
  MSG_SEM_ANTECIPACAO,
  resultadoDaVersao,
  rotuloForma,
  type CotacaoSnapshot,
  type ItemSnapshot,
  type Snapshot,
} from "@/domain/aprovacoes";
import { margemDaAprovacao } from "@/domain/precificacao";
import { REGRAS_INICIAIS as R } from "@/domain/regras";

describe("forma de pagamento da versão", () => {
  const s = formaSchema(10);

  it("normaliza: pix e cartão direto só em 1x; sem antecipação na proposta", () => {
    expect(s.parse({ tipo: "credito", parcelas: 6, antecipado: false })).toEqual({ tipo: "credito", parcelas: 6 });
    expect(s.parse({ tipo: "pix", parcelas: 1 })).toEqual({ tipo: "pix", parcelas: 1 });
    expect(s.safeParse({ tipo: "pix", parcelas: 2 }).success).toBe(false);
    expect(s.safeParse({ tipo: "cartao_fornecedor", parcelas: 3 }).success).toBe(false);
  });

  it("antecipação não é escolhida na proposta nem na venda (Augusto, 23/11/2026): recusa com mensagem", () => {
    for (const tipo of ["credito", "boleto"] as const) {
      const r = s.safeParse({ tipo, parcelas: 6, antecipado: true });
      expect(r.success).toBe(false);
      expect(r.error?.issues[0].message).toBe(MSG_SEM_ANTECIPACAO);
    }
  });

  it("parcelas de 1 ao parcelamento máximo dos Parâmetros", () => {
    expect(s.safeParse({ tipo: "credito", parcelas: 0 }).success).toBe(false);
    expect(s.safeParse({ tipo: "credito", parcelas: 11 }).success).toBe(false);
    expect(s.safeParse({ tipo: "credito", parcelas: 2.5 }).success).toBe(false);
    expect(formaSchema(6).safeParse({ tipo: "boleto", parcelas: 7 }).success).toBe(false);
    expect(formaSchema(6).safeParse({ tipo: "boleto", parcelas: 6 }).success).toBe(true);
    const r = s.safeParse({ tipo: "cheque", parcelas: 1 });
    expect(r.success ? null : r.error.issues[0].message).toBe("Forma de pagamento inválida");
    const p = s.safeParse({ tipo: "credito", parcelas: 11 });
    expect(p.success ? null : p.error.issues[0].message).toBe("Parcelas inválidas");
  });

  it("rótulos em pt-BR", () => {
    expect(rotuloForma({ tipo: "pix", parcelas: 1 })).toBe("Pix");
    expect(rotuloForma({ tipo: "cartao_fornecedor", parcelas: 1 })).toBe("Cartão direto no fornecedor");
    expect(rotuloForma({ tipo: "boleto", parcelas: 4 })).toBe("Boleto em 4x");
    expect(rotuloForma({ tipo: "credito", parcelas: 2 })).toBe("Cartão em 2x");
    expect(rotuloForma({ tipo: "credito", parcelas: 6, antecipado: true })).toBe("Cartão em 6x com antecipação");
  });

  it("envio: preço opcional em reais; alteração vazia vira nulo", () => {
    const e = envioSchema(10);
    expect(e.parse({ forma: { tipo: "pix", parcelas: 1 }, alteracao: "  " })).toEqual({
      preco: null,
      forma: { tipo: "pix", parcelas: 1 },
      alteracao: null,
    });
    expect(e.parse({ preco: "50.000,10", forma: { tipo: "pix", parcelas: 1 }, alteracao: "Primeira" }).preco).toBe(5000010n);
    const r = e.safeParse({ preco: "abc", forma: { tipo: "pix", parcelas: 1 }, alteracao: "" });
    expect(r.success ? null : r.error.issues[0].message).toBe("Valor inválido");
    expect(e.safeParse({ preco: "0,00", forma: { tipo: "pix", parcelas: 1 }, alteracao: "" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ajuste do Diretor por cotação (revisão final, achado 1) e paridade simulação × servidor (ledger T7)
// ---------------------------------------------------------------------------

const cot = (id: string, x: Partial<CotacaoSnapshot> = {}): CotacaoSnapshot => ({
  id,
  fornecedorId: null,
  fornecedor: `Fornecedor ${id.slice(0, 1)}`,
  moeda: "BRL",
  valorOriginal: "100000",
  cambioComercial: null,
  cambioAplicado: null,
  cambioData: null,
  valorBrl: "100000",
  comissaoPct: "0.000",
  descontoAVistaPct: null,
  tarifaFixa: "0",
  ...x,
});
const ID = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-000000000000`;

function itemSnap(id: string, cotacoes: CotacaoSnapshot[], escolhida: number, precificada: number, x: Partial<ItemSnapshot> = {}): ItemSnapshot {
  return {
    id,
    ordem: 1,
    tipo: "Passeio",
    cidade: null,
    servico: `Item ${id.slice(0, 1)}`,
    checkin: null,
    checkout: null,
    diarias: null,
    automatico: false,
    cotacoes,
    precificada: cotacoes[precificada],
    escolhida: cotacoes[escolhida],
    ...x,
  };
}

describe("ajuste do Diretor por cotação", () => {
  // a: 1.000,00 sem comissão (pior, custo 1.000,00); b: 1.100,00 com 20% (escolhida, custo 880,00)
  const a = cot(ID(1), { valorOriginal: "100000", valorBrl: "100000" });
  const b = cot(ID(2), { valorOriginal: "110000", valorBrl: "110000", comissaoPct: "20.000" });
  const passeio = itemSnap(ID(3), [a, b], 1, 0);
  const snap: Snapshot = { destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01", passageiros: [{ id: ID(9), nome: "A" }], itens: [passeio] };

  it("ajusta só a cotação precificada (padrão); a escolhida fica como estava e a margem extra segue", () => {
    const s = ajustarSnapshot(snap, [{ itemId: passeio.id, valorFornecedor: 95000n }]);
    if ("erro" in s) throw new Error(s.erro);
    const it2 = s.itens[0];
    expect(it2.cotacoes.find((c) => c.id === a.id)).toMatchObject({ valorBrl: "95000", valorOriginal: "95000", ajustadoPeloDiretor: true });
    expect(it2.cotacoes.find((c) => c.id === b.id)).toEqual(b);
    expect(it2.escolhida).toEqual(b);
    expect(it2.precificada.id).toBe(a.id);
    const { custo, custoEscolhidas } = custosDoSnapshot(s);
    expect(custo).toBe(95000n);
    expect(custoEscolhidas).toBe(88000n);
    expect(resultadoDaVersao(s, 200000n, { tipo: "pix", parcelas: 1 }, 19, "por_dia", R).margemExtra).toBe("7000");
    // o snapshot original não muda
    expect(snap.itens[0]).toEqual(passeio);
  });

  it("ajuste que deixa a cotação abaixo de outra reescolhe o pior custo; a escolhida ajustada acompanha", () => {
    const s = ajustarSnapshot(snap, [{ itemId: passeio.id, cotacaoId: b.id, comissaoPct: "0.000" }]);
    if ("erro" in s) throw new Error(s.erro);
    const it2 = s.itens[0];
    expect(it2.precificada).toMatchObject({ id: b.id, comissaoPct: "0.000", ajustadoPeloDiretor: true });
    expect(it2.escolhida).toEqual(it2.precificada);
    expect(it2.cotacoes.find((c) => c.id === a.id)).toEqual(a);
    expect(custosDoSnapshot(s)).toMatchObject({ custo: 110000n, custoEscolhidas: 110000n });
  });

  it("cotação em EUR ajustada para R$ X guarda valorBrl = X e valorOriginal = X ÷ câmbio aplicado", () => {
    const eur = cot(ID(4), { moeda: "EUR", valorOriginal: "50000", cambioComercial: "6.0000", cambioAplicado: "6.2700", valorBrl: "313500" });
    const hotel = itemSnap(ID(5), [eur], 0, 0, { tipo: "Hotelaria", diarias: 2 });
    const s = ajustarSnapshot({ ...snap, itens: [hotel] }, [{ itemId: hotel.id, valorFornecedor: 300000n }]);
    if ("erro" in s) throw new Error(s.erro);
    // 3.000,00 ÷ 6,2700 = 478,4688… → EUR 478,47
    expect(s.itens[0].precificada).toMatchObject({ moeda: "EUR", valorBrl: "300000", valorOriginal: "47847", cambioAplicado: "6.2700", ajustadoPeloDiretor: true });
    expect(s.itens[0].escolhida).toEqual(s.itens[0].precificada);
  });

  it("cotação que não é do item → Cotação não encontrada; item fora do snapshot → Item não encontrado", () => {
    expect(ajustarSnapshot(snap, [{ itemId: passeio.id, cotacaoId: ID(7), valorFornecedor: 1n }])).toEqual({ erro: "Cotação não encontrada" });
    expect(ajustarSnapshot(snap, [{ itemId: ID(8), valorFornecedor: 1n }])).toEqual({ erro: "Item não encontrado" });
  });

  it("schema do ajuste aceita cotacaoId (uuid)", () => {
    const sc = ajusteSchema(10);
    const ok = sc.parse({ preco: "1.000,00", forma: { tipo: "pix", parcelas: 1 }, itens: [{ itemId: passeio.id, cotacaoId: a.id, valorFornecedor: "900,00" }] });
    expect(ok.itens?.[0]).toEqual({ itemId: passeio.id, cotacaoId: a.id, valorFornecedor: 90000n });
    const r = sc.safeParse({ preco: "1.000,00", forma: { tipo: "pix", parcelas: 1 }, itens: [{ itemId: passeio.id, cotacaoId: "x" }] });
    expect(r.success ? null : r.error.issues[0].message).toBe("Cotação não encontrada");
  });

  it("paridade: ajustarItem por item → custosDoSnapshot → margemDaAprovacao = ajustarSnapshot → resultadoDaVersao", () => {
    const eur = cot(ID(4), { moeda: "EUR", valorOriginal: "50000", cambioAplicado: "6.2700", valorBrl: "313500", comissaoPct: "8.000" });
    const brl = cot(ID(6), { valorBrl: "320000", valorOriginal: "320000", comissaoPct: "4.000" });
    const hotel = itemSnap(ID(5), [eur, brl], 1, 1, { tipo: "Hotelaria", diarias: 2 });
    const taxa = itemSnap(ID(7), [cot(ID(8), { valorBrl: "35000", valorOriginal: "35000" })], 0, 0, { tipo: "Taxa", automatico: true });
    const s0: Snapshot = { ...snap, itens: [passeio, hotel, taxa] };
    const ajustes = [
      { itemId: hotel.id, cotacaoId: eur.id, valorFornecedor: 350000n, comissaoPct: "5.000" },
      { itemId: passeio.id, comissaoPct: "10.000" },
    ];
    const forma = { tipo: "credito", parcelas: 6 } as const;
    // caminho do navegador (painel de aprovações)
    const simulado: Snapshot = {
      ...s0,
      itens: s0.itens.map((i) => {
        const aj = ajustes.find((x) => x.itemId === i.id);
        if (!aj) return i;
        const r = ajustarItem(i, {
          cotacaoId: aj.cotacaoId ?? i.precificada.id,
          ...(aj.valorFornecedor !== undefined ? { valorFornecedor: aj.valorFornecedor.toString() } : {}),
          comissaoPct: aj.comissaoPct,
        });
        if ("erro" in r) throw new Error(r.erro);
        return r;
      }),
    };
    const { custo } = custosDoSnapshot(simulado);
    const cliente = margemDaAprovacao(900000n, custo, forma, 19, "por_dia", R);
    // caminho do servidor
    const s = ajustarSnapshot(s0, ajustes);
    if ("erro" in s) throw new Error(s.erro);
    const servidor = resultadoDaVersao(s, 900000n, forma, 19, "por_dia", R);
    expect(s).toEqual(simulado);
    expect(servidor).toMatchObject({ custo: cliente.custo.toString(), final: cliente.final.toString(), finalPct: cliente.finalPct, antes: cliente.antes.toString() });
    expect(s.itens[1].precificada.id).toBe(eur.id);
  });
});
