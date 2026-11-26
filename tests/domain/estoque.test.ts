import { describe, expect, it } from "vitest";
import {
  abaixoDoMinimo,
  aposEntrada,
  aposSaida,
  CATEGORIA_DO_USO,
  desfazerEntrada,
  ROTULO_USO,
  SITUACOES_CAIXA,
  TIPOS_MOVIMENTO,
  USOS_ESTOQUE,
  valorEmEstoque,
  type Saldo,
} from "@/domain/estoque";
import { ajusteSchema, caixaItensSchema, entradaSchema, produtoSchema, saidaSchema } from "@/domain/estoque-entrada";

const U1 = "6f1b1d1e-1b1a-4c1d-8e1f-1a1b1c1d1e1f";
const U2 = "7f1b1d1e-1b1a-4c1d-8e1f-1a1b1c1d1e1f";

describe("listas", () => {
  it("valores e rótulos", () => {
    expect(USOS_ESTOQUE).toEqual(["caixa_experiencia", "papelaria"]);
    expect(TIPOS_MOVIMENTO).toEqual(["entrada", "saida", "ajuste", "caixa", "devolucao_caixa"]);
    expect(SITUACOES_CAIXA).toEqual(["rascunho", "confirmada", "cancelada"]);
    expect(ROTULO_USO).toEqual({ caixa_experiencia: "Caixa de experiência", papelaria: "Papelaria" });
    expect(CATEGORIA_DO_USO).toEqual({ caixa_experiencia: "caixa_experiencia", papelaria: "papelaria" });
  });
});

describe("custo médio", () => {
  it("média ponderada", () => {
    expect(aposEntrada({ quantidade: 10, custoMedio: 3800n }, 5, 4400n)).toEqual({ quantidade: 15, custoMedio: 4000n });
    expect(aposEntrada({ quantidade: 0, custoMedio: 0n }, 3, 1000n)).toEqual({ quantidade: 3, custoMedio: 1000n });
  });
  it("arredonda meio para cima", () => {
    expect(aposEntrada({ quantidade: 1, custoMedio: 100n }, 2, 101n).custoMedio).toBe(101n);
    // 2*100 + 1*101 = 301 / 3 = 100,33 -> 100
    expect(aposEntrada({ quantidade: 2, custoMedio: 100n }, 1, 101n).custoMedio).toBe(100n);
    // 1*100 + 1*101 = 201 / 2 = 100,5 -> 101
    expect(aposEntrada({ quantidade: 1, custoMedio: 100n }, 1, 101n).custoMedio).toBe(101n);
  });
  it("saída", () => {
    expect(aposSaida({ quantidade: 3, custoMedio: 1000n }, 4)).toBeNull();
    expect(aposSaida({ quantidade: 3, custoMedio: 1000n }, 3)).toEqual({ quantidade: 0, custoMedio: 0n });
    expect(aposSaida({ quantidade: 3, custoMedio: 1000n }, 1)).toEqual({ quantidade: 2, custoMedio: 1000n });
  });
  it("desfazer entrada volta ao saldo de antes", () => {
    const casos: [Saldo, number, bigint][] = [
      [{ quantidade: 10, custoMedio: 3800n }, 5, 4400n],
      [{ quantidade: 0, custoMedio: 0n }, 3, 1000n],
      [{ quantidade: 1, custoMedio: 100n }, 2, 101n],
    ];
    for (const [s, q, u] of casos) {
      expect(desfazerEntrada(aposEntrada(s, q, u), q, s.custoMedio)).toEqual(s);
    }
  });
  it("desfazer entrada recusa passar do saldo", () => {
    expect(desfazerEntrada({ quantidade: 3, custoMedio: 1000n }, 4, 900n)).toBeNull();
  });
  it("desfazer entrada com saldo zero zera o custo", () => {
    expect(desfazerEntrada({ quantidade: 3, custoMedio: 1000n }, 3, 900n)).toEqual({ quantidade: 0, custoMedio: 0n });
  });
});

describe("mínimo e valor", () => {
  it("abaixo do mínimo", () => {
    expect(abaixoDoMinimo(4, 5)).toBe(true);
    expect(abaixoDoMinimo(5, 5)).toBe(false);
    expect(abaixoDoMinimo(0, 0)).toBe(false);
  });
  it("valor em estoque", () => {
    expect(valorEmEstoque([])).toBe(0n);
    expect(
      valorEmEstoque([
        { quantidade: 2, custoMedio: 1000n },
        { quantidade: 3, custoMedio: 500n },
      ]),
    ).toBe(3500n);
  });
});

const entrada = {
  produtoId: U1,
  filial: "MT",
  quantidade: 5,
  valorUnitario: "12,50",
  fornecedorId: U2,
  vencimento: "2026-12-10",
  forma: "PIX",
};

describe("entradaSchema", () => {
  it("aceita e converte para centavos", () => {
    const r = entradaSchema.safeParse(entrada);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.valorUnitario).toBe(1250n);
      expect(r.data.fornecedorTexto).toBeNull();
      expect(r.data.cartaoId).toBeNull();
    }
  });
  it("aceita valor zero e fornecedor em texto", () => {
    const r = entradaSchema.safeParse({ ...entrada, valorUnitario: "0,00", fornecedorId: "", fornecedorTexto: "Papelaria do Zé" });
    expect(r.success).toBe(true);
  });
  it("recusa quantidade 0, fracionada e valor negativo", () => {
    expect(entradaSchema.safeParse({ ...entrada, quantidade: 0 }).success).toBe(false);
    expect(entradaSchema.safeParse({ ...entrada, quantidade: 1.5 }).success).toBe(false);
    expect(entradaSchema.safeParse({ ...entrada, valorUnitario: "-1,00" }).success).toBe(false);
  });
  it("recusa os dois fornecedores juntos", () => {
    const r = entradaSchema.safeParse({ ...entrada, fornecedorTexto: "Loja" });
    expect(r.success).toBe(false);
  });
  it("cartão de crédito exige o cartão; nas outras formas vira null", () => {
    expect(entradaSchema.safeParse({ ...entrada, forma: "Cartão de crédito" }).success).toBe(false);
    const ok = entradaSchema.safeParse({ ...entrada, forma: "Cartão de crédito", cartaoId: U2 });
    expect(ok.success && ok.data.cartaoId).toBe(U2);
    const outra = entradaSchema.safeParse({ ...entrada, cartaoId: U2 });
    expect(outra.success && outra.data.cartaoId).toBeNull();
  });
  it("recusa filial e forma inválidas", () => {
    expect(entradaSchema.safeParse({ ...entrada, filial: "SP" }).success).toBe(false);
    expect(entradaSchema.safeParse({ ...entrada, forma: "Cheque" }).success).toBe(false);
  });
});

describe("saída, ajuste, produto e caixa", () => {
  const saida = { produtoId: U1, filial: "RS", quantidade: 2, motivo: "Brinde avulso" };
  it("motivo de 5 a 200 caracteres", () => {
    expect(saidaSchema.safeParse(saida).success).toBe(true);
    expect(saidaSchema.safeParse({ ...saida, motivo: "abc" }).success).toBe(false);
    expect(saidaSchema.safeParse({ ...saida, motivo: "a".repeat(201) }).success).toBe(false);
    expect(saidaSchema.safeParse({ ...saida, quantidade: 0 }).success).toBe(false);
    const aj = { produtoId: U1, filial: "RS", quantidadeNova: 0, motivo: "Contagem" };
    expect(ajusteSchema.safeParse(aj).success).toBe(true);
    expect(ajusteSchema.safeParse({ ...aj, motivo: "ok" }).success).toBe(false);
    expect(ajusteSchema.safeParse({ ...aj, quantidadeNova: -1 }).success).toBe(false);
  });
  it("produto", () => {
    const p = { nome: "Caderno", uso: "papelaria", minimoMt: 5, minimoRs: 0 };
    expect(produtoSchema.safeParse(p).success).toBe(true);
    expect(produtoSchema.safeParse({ ...p, nome: " " }).success).toBe(false);
    expect(produtoSchema.safeParse({ ...p, uso: "outro" }).success).toBe(false);
    expect(produtoSchema.safeParse({ ...p, minimoMt: -1 }).success).toBe(false);
  });
  it("caixa: sem produto repetido e quantidade >= 1", () => {
    expect(caixaItensSchema.safeParse([{ produtoId: U1, quantidade: 2 }, { produtoId: U2, quantidade: 1 }]).success).toBe(true);
    expect(caixaItensSchema.safeParse([{ produtoId: U1, quantidade: 2 }, { produtoId: U1, quantidade: 1 }]).success).toBe(false);
    expect(caixaItensSchema.safeParse([{ produtoId: U1, quantidade: 0 }]).success).toBe(false);
  });
});
