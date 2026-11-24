import { describe, expect, it } from "vitest";
import {
  DIAS_AVISO,
  DIAS_ESCOLHA,
  DIAS_SUGESTAO,
  SITUACOES_EXTRATO,
  opcoesDeEscolha,
  situacaoExibida,
  sugerirPar,
  type Candidata,
} from "@/domain/conciliacao";

const cand = (id: string, data: string, valor: bigint): Candidata => ({
  origem: "parcela",
  id,
  data,
  valor,
  pessoa: "Pessoa Teste",
  descricao: "Teste",
});
const t = { data: "2027-03-10", valor: 100000n };

describe("constantes", () => {
  it("valores do spec", () => {
    expect([DIAS_SUGESTAO, DIAS_ESCOLHA, DIAS_AVISO]).toEqual([3, 10, 3]);
    expect(SITUACOES_EXTRATO).toEqual(["pendente", "conciliada", "ignorada"]);
  });
});

describe("sugerirPar", () => {
  it("uma candidata a 2 dias: sugere", () => {
    const c = cand("a", "2027-03-12", 100000n);
    expect(sugerirPar(t, [c])).toBe(c);
  });
  it("a 3 dias ainda sugere, a 4 não", () => {
    expect(sugerirPar(t, [cand("a", "2027-03-07", 100000n)])?.id).toBe("a");
    expect(sugerirPar(t, [cand("a", "2027-03-14", 100000n)])).toBeNull();
  });
  it("duas de mesmo valor a 1 e 2 dias: a de 1", () => {
    expect(sugerirPar(t, [cand("a", "2027-03-12", 100000n), cand("b", "2027-03-11", 100000n)])?.id).toBe("b");
  });
  it("duas a 1 dia (uma antes, outra depois): empate, nenhuma", () => {
    expect(sugerirPar(t, [cand("a", "2027-03-09", 100000n), cand("b", "2027-03-11", 100000n)])).toBeNull();
  });
  it("sinal ou valor diferente nunca", () => {
    expect(sugerirPar(t, [cand("a", "2027-03-10", -100000n)])).toBeNull();
    expect(sugerirPar(t, [cand("a", "2027-03-10", 100001n)])).toBeNull();
  });
  it("sem candidatas: null", () => {
    expect(sugerirPar(t, [])).toBeNull();
  });
});

describe("opcoesDeEscolha", () => {
  it("janela de 10 dias, mesmo sinal, ordenadas por valor e depois por dias", () => {
    const r = opcoesDeEscolha(t, [
      cand("longe", "2027-03-21", 100000n),
      cand("sinal", "2027-03-10", -100000n),
      cand("valor-longe", "2027-03-10", 150000n),
      cand("igual-3d", "2027-03-13", 100000n),
      cand("igual-1d", "2027-03-09", 100000n),
      cand("perto", "2027-03-10", 99000n),
      cand("limite", "2027-03-20", 100000n),
    ]);
    expect(r.map((c) => c.id)).toEqual(["igual-1d", "igual-3d", "limite", "perto", "valor-longe"]);
  });
});

describe("situacaoExibida", () => {
  it("conciliada com valor igual: confere", () => {
    expect(situacaoExibida({ situacao: "conciliada", valor: 5000n }, { valor: 5000n })).toEqual({
      tipo: "confere",
      rotulo: "Confere",
      diferenca: 0n,
    });
  });
  it("conciliada com valor diferente: diferenca", () => {
    expect(situacaoExibida({ situacao: "conciliada", valor: -286249n }, { valor: -298176n })).toEqual({
      tipo: "diferenca",
      rotulo: "Diferença de R$ 119,27",
      diferenca: 11927n,
    });
  });
  it("conciliada com linha null: baixa mudou", () => {
    expect(situacaoExibida({ situacao: "conciliada", valor: 5000n }, null).tipo).toBe("baixa_mudou");
    expect(situacaoExibida({ situacao: "conciliada", valor: 5000n }, null).rotulo).toBe("A baixa mudou: confira");
  });
  it("linha que mudou de sinal: baixa mudou", () => {
    expect(situacaoExibida({ situacao: "conciliada", valor: 5000n }, { valor: -5000n }).tipo).toBe("baixa_mudou");
  });
  it("pendente e ignorada", () => {
    expect(situacaoExibida({ situacao: "pendente", valor: 5000n }, null)).toMatchObject({ tipo: "nao_conciliado", rotulo: "Não conciliado" });
    expect(situacaoExibida({ situacao: "ignorada", valor: 5000n }, null)).toMatchObject({ tipo: "ignorado", rotulo: "Ignorado" });
  });
});
