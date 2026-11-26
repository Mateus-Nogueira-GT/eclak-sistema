import { describe, expect, it } from "vitest";
import {
  comunicadoSchema,
  dispensaVale,
  justificativaSchema,
  PASSO_AVISO,
  PASSO_AVISO_CENTRAL,
  perfisDoSetor,
  recebe,
  SETOR_DO_TIPO,
  SETORES,
  SETORES_DO_PERFIL,
  setoresDaVisao,
  tiposDosSetores,
} from "@/domain/avisos";

describe("setores dos avisos (spec §8.2)", () => {
  it("cinco setores, na ordem do spec", () => {
    expect(SETORES).toEqual(["Gestão", "Financeiro", "Comercial", "Operacional", "Geral"]);
  });

  it("cada perfil recebe os setores da tabela", () => {
    expect(SETORES_DO_PERFIL).toEqual({
      diretor: ["Gestão", "Financeiro", "Comercial", "Operacional", "Geral"],
      fin_estrategico: ["Gestão", "Financeiro", "Geral"],
      fin_operacional: ["Financeiro", "Geral"],
      consultor: ["Comercial", "Operacional", "Geral"],
      operacional: ["Operacional", "Geral"],
    });
  });

  it("recebe", () => {
    expect(recebe("diretor", "Comercial")).toBe(true);
    expect(recebe("fin_estrategico", "Gestão")).toBe(true);
    expect(recebe("fin_operacional", "Gestão")).toBe(false);
    expect(recebe("fin_operacional", "Financeiro")).toBe(true);
    expect(recebe("consultor", "Financeiro")).toBe(false);
    expect(recebe("consultor", "Gestão")).toBe(false);
    expect(recebe("operacional", "Comercial")).toBe(false);
    for (const p of ["diretor", "fin_estrategico", "fin_operacional", "consultor", "operacional"] as const) expect(recebe(p, "Geral")).toBe(true);
  });

  it("próximo passo dos sete avisos da Visão geral (decisão do coordenador)", () => {
    expect(PASSO_AVISO).toEqual({
      caixa: "Rever o fluxo de caixa",
      margem: "Rever os custos lançados na viagem",
      parcela: "Cobrar o cliente",
      comissao: "Cobrar a comissão do fornecedor",
      pagar: "Pagar ou reprogramar as contas",
      conciliacao: "Conciliar o extrato",
      aprovacao: "Aprovar ou devolver os pedidos",
    });
  });
});

describe("avisos novos da central (spec §8.3)", () => {
  it("setor de cada tipo: valor estratégico só em Gestão e Financeiro", () => {
    expect(SETOR_DO_TIPO).toEqual({
      caixa: "Gestão",
      margem: "Gestão",
      aprovacao: "Gestão",
      parcela: "Financeiro",
      comissao: "Financeiro",
      pagar: "Financeiro",
      conciliacao: "Financeiro",
      estoque_minimo: "Financeiro",
      reembolso_pedir: "Financeiro",
      reembolso_fornecedor: "Financeiro",
      reembolso_cliente: "Financeiro",
      aniversario: "Comercial",
      tarefa_vencida: "Operacional",
      daily_a_gerar: "Operacional",
      caixa_a_montar: "Operacional",
    });
    expect(tiposDosSetores(SETORES_DO_PERFIL.operacional)).toEqual(["tarefa_vencida", "daily_a_gerar", "caixa_a_montar"]);
    expect(tiposDosSetores(SETORES_DO_PERFIL.consultor)).toEqual(["aniversario", "tarefa_vencida", "daily_a_gerar", "caixa_a_montar"]);
  });

  it("filtro: só o Diretor escolhe o setor; para os outros vale sempre 'para mim'", () => {
    expect(setoresDaVisao("diretor", {})).toEqual(SETORES_DO_PERFIL.diretor);
    expect(setoresDaVisao("diretor", { setor: "todos" })).toEqual(SETORES_DO_PERFIL.diretor);
    expect(setoresDaVisao("diretor", { setor: "Comercial" })).toEqual(["Comercial"]);
    expect(setoresDaVisao("diretor", { setor: "Vendas" as never })).toEqual(SETORES_DO_PERFIL.diretor);
    expect(setoresDaVisao("operacional", { setor: "Financeiro" })).toEqual(["Operacional", "Geral"]);
    expect(setoresDaVisao("fin_operacional", { setor: "todos" })).toEqual(["Financeiro", "Geral"]);
  });

  it("quem recebe cada setor", () => {
    expect(perfisDoSetor("Operacional")).toEqual(["diretor", "consultor", "operacional"]);
    expect(perfisDoSetor("Comercial")).toEqual(["diretor", "consultor"]);
    expect(perfisDoSetor("Financeiro")).toEqual(["diretor", "fin_estrategico", "fin_operacional"]);
    expect(perfisDoSetor("Gestão")).toEqual(["diretor", "fin_estrategico"]);
  });

  it("próximo passo dos oito tipos novos", () => {
    expect(PASSO_AVISO_CENTRAL).toEqual({
      tarefa_vencida: "Abrir as tarefas da viagem",
      daily_a_gerar: "Gerar o daily",
      aniversario: "Combinar a surpresa e incluir no roteiro",
      estoque_minimo: "Repor o estoque",
      caixa_a_montar: "Montar a caixa na viagem",
      reembolso_pedir: "Pedir o reembolso ao fornecedor",
      reembolso_fornecedor: "Cobrar o fornecedor",
      reembolso_cliente: "Reembolsar o cliente",
    });
  });
});

describe("validade da dispensa (Review Focus 5)", () => {
  const agora = new Date("2026-11-25T12:00:00Z");
  const dias = (n: number) => new Date(agora.getTime() - n * 24 * 60 * 60 * 1000);
  const gravado = (n: number) => ({ titulo: "3 parcelas de cliente vencidas", detalhe: "R$ 300,00 em aberto", criadoEm: dias(n) });
  const atual = { titulo: "3 parcelas de cliente vencidas", detalhe: "R$ 300,00 em aberto" };

  it("mesmo título e detalhe, até 30 dias: vale", () => {
    expect(dispensaVale(gravado(0), atual, agora)).toBe(true);
    expect(dispensaVale(gravado(30), atual, agora)).toBe(true);
  });

  it("detalhe mudou: não vale", () => {
    expect(dispensaVale(gravado(1), { ...atual, detalhe: "R$ 400,00 em aberto" }, agora)).toBe(false);
  });

  it("título mudou (3 → 4 parcelas vencidas): não vale", () => {
    expect(dispensaVale(gravado(1), { ...atual, titulo: "4 parcelas de cliente vencidas" }, agora)).toBe(false);
  });

  it("31 dias: não vale", () => {
    expect(dispensaVale(gravado(31), atual, agora)).toBe(false);
  });
});

describe("entradas da dispensa e do comunicado", () => {
  it("justificativa de 10 a 500 caracteres", () => {
    expect(justificativaSchema.safeParse("curta").success).toBe(false);
    expect(justificativaSchema.safeParse("         x         ").success).toBe(false);
    expect(justificativaSchema.safeParse("a".repeat(10)).success).toBe(true);
    expect(justificativaSchema.safeParse("a".repeat(500)).success).toBe(true);
    expect(justificativaSchema.safeParse("a".repeat(501)).success).toBe(false);
  });

  it("comunicado: setor da lista, texto de 5 a 500, passo até 200", () => {
    expect(comunicadoSchema.safeParse({ setor: "Operacional", texto: "Conferir os vouchers" }).data).toEqual({ setor: "Operacional", texto: "Conferir os vouchers", passo: null });
    expect(comunicadoSchema.safeParse({ setor: "Geral", texto: "Reunião", passo: " Confirmar presença " }).data?.passo).toBe("Confirmar presença");
    expect(comunicadoSchema.safeParse({ setor: "Vendas", texto: "Conferir os vouchers" }).success).toBe(false);
    expect(comunicadoSchema.safeParse({ setor: "Geral", texto: "Oi" }).success).toBe(false);
    expect(comunicadoSchema.safeParse({ setor: "Geral", texto: "a".repeat(501) }).success).toBe(false);
    expect(comunicadoSchema.safeParse({ setor: "Geral", texto: "Reunião", passo: "a".repeat(201) }).success).toBe(false);
  });
});
