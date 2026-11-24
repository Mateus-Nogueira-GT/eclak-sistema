import { describe, expect, it } from "vitest";
import {
  CATEGORIAS_TAREFA,
  ordenarTarefas,
  prazoEfetivo,
  ROTULO_CATEGORIA,
  rotuloPrazo,
  situacaoTarefa,
  tarefaSchema,
  tarefasDaVenda,
  tarefasDoRoteiro,
} from "@/domain/tarefas";

const INI = "2027-08-14";

describe("categorias", () => {
  it("textos exatos do spec, na ordem", () => {
    expect(CATEGORIAS_TAREFA.map((c) => ROTULO_CATEGORIA[c])).toEqual([
      "Emitir ingressos e bilhetes com horário",
      "Transfers e passeios",
      "Reservar restaurantes (cortesia do concierge)",
      "Hotéis, carro e voos",
      "Conferir",
      "Envio e acompanhamento",
    ]);
  });
});

describe("prazoEfetivo / rotuloPrazo", () => {
  it("calcula a data efetiva", () => {
    expect(prazoEfetivo({ tipo: "dias_antes", dias: 15 }, INI)).toBe("2027-07-30");
    expect(prazoEfetivo({ tipo: "dias_antes", dias: 60 }, INI)).toBe("2027-06-15");
    expect(prazoEfetivo({ tipo: "dias_antes", dias: 0 }, INI)).toBe("2027-08-14");
    expect(prazoEfetivo({ tipo: "data", data: "2027-04-15" }, INI)).toBe("2027-04-15");
    expect(prazoEfetivo(null, INI)).toBeNull();
  });
  it("rótulos", () => {
    expect(rotuloPrazo({ tipo: "data", data: "2027-04-15" }, INI)).toBe("Até 15/04/2027");
    expect(rotuloPrazo({ tipo: "dias_antes", dias: 15 }, INI)).toBe("15 dias antes (30/07/2027)");
    expect(rotuloPrazo({ tipo: "dias_antes", dias: 1 }, INI)).toBe("1 dia antes (13/08/2027)");
    expect(rotuloPrazo(null, INI)).toBe("Sem prazo");
  });
});

describe("situacaoTarefa", () => {
  const hoje = "2026-11-23";
  it("classifica", () => {
    expect(situacaoTarefa({ prazoEfetivo: "2026-11-22", concluida: false }, hoje)).toBe("vencida");
    expect(situacaoTarefa({ prazoEfetivo: "2026-11-23", concluida: false }, hoje)).toBe("vence_hoje");
    expect(situacaoTarefa({ prazoEfetivo: "2026-11-24", concluida: false }, hoje)).toBe("no_prazo");
    expect(situacaoTarefa({ prazoEfetivo: null, concluida: false }, hoje)).toBe("sem_prazo");
    expect(situacaoTarefa({ prazoEfetivo: "2026-11-22", concluida: true }, hoje)).toBe("concluida");
  });
});

describe("tarefas automáticas", () => {
  it("da venda", () => {
    const ts = tarefasDaVenda("2026-11-23", INI);
    expect(ts.map((t) => t.chave)).toEqual(["venda.whatsapp", "venda.fatura", "venda.comparativo", "venda.reservas", "venda.drive"]);
    expect(ts.map((t) => t.item)).toEqual([
      "Criar grupo no WhatsApp",
      "Encaminhar informações para emissão da fatura",
      "Fazer comparativo de valores de fornecedores",
      "Realizar reserva da hotelaria e do transfer",
      "Abrir pasta no Google Drive",
    ]);
    expect(ts.map((t) => t.categoria)).toEqual(["envio", "conferir", "conferir", "hoteis_carro_voos", "envio"]);
    expect(ts.map((t) => (t.prazo?.tipo === "data" ? t.prazo.data : null))).toEqual([
      "2026-11-24", "2026-11-25", "2026-11-30", "2026-11-30", "2026-11-24",
    ]);
    expect(ts.every((t) => t.fazer === "")).toBe(true);
  });
  it("limita ao início da viagem", () => {
    const ts = tarefasDaVenda("2027-08-10", INI);
    expect(ts.find((t) => t.chave === "venda.reservas")?.prazo).toEqual({ tipo: "data", data: "2027-08-14" });
    expect(ts.find((t) => t.chave === "venda.whatsapp")?.prazo).toEqual({ tipo: "data", data: "2027-08-11" });
  });
  it("do roteiro", () => {
    const ts = tarefasDoRoteiro();
    expect(ts.map((t) => t.chave)).toEqual(["roteiro.passeios", "roteiro.ingressos", "roteiro.trem"]);
    expect(ts.map((t) => t.item)).toEqual(["Reserva de passeios", "Compra de ingressos", "Compra de trem"]);
    expect(ts.map((t) => t.categoria)).toEqual(["transfers_passeios", "ingressos", "ingressos"]);
    expect(ts.map((t) => t.prazo)).toEqual([
      { tipo: "dias_antes", dias: 60 },
      { tipo: "dias_antes", dias: 60 },
      { tipo: "dias_antes", dias: 90 },
    ]);
  });
});

describe("ordenarTarefas", () => {
  it("categoria, Geral primeiro, dia, ordem", () => {
    const r = ordenarTarefas([
      { categoria: "conferir" as const, dia: null, ordem: 1 },
      { categoria: "ingressos" as const, dia: "2027-08-16", ordem: 2 },
      { categoria: "ingressos" as const, dia: null, ordem: 3 },
    ]);
    expect(r.map((t) => [t.categoria, t.dia])).toEqual([
      ["ingressos", null],
      ["ingressos", "2027-08-16"],
      ["conferir", null],
    ]);
  });
});

describe("tarefaSchema", () => {
  const base = { categoria: "conferir", dia: null, item: "Item", fazer: "", prazo: null, responsavel: null, observacao: null };
  const msgs = (e: unknown) => {
    const r = tarefaSchema.safeParse(e);
    return r.success ? [] : r.error.issues.map((i) => [i.path.join("."), i.message]);
  };
  it("aceita válido", () => {
    expect(tarefaSchema.safeParse(base).success).toBe(true);
    expect(
      tarefaSchema.safeParse({
        ...base,
        dia: "2027-08-15",
        prazo: { tipo: "dias_antes", dias: 10 },
        responsavel: { tipo: "usuario", id: "123e4567-e89b-42d3-a456-426614174000" },
      }).success,
    ).toBe(true);
    expect(tarefaSchema.safeParse({ ...base, responsavel: { tipo: "customer_care" } }).success).toBe(true);
  });
  it("mensagens", () => {
    expect(msgs({ ...base, item: "  " })).toContainEqual(["item", "Informe o item"]);
    expect(msgs({ ...base, prazo: { tipo: "dias_antes", dias: 366 } })).toContainEqual(["prazo.dias", "Informe de 0 a 365 dias"]);
    expect(msgs({ ...base, prazo: { tipo: "dias_antes", dias: 1.5 } })).toContainEqual(["prazo.dias", "Informe de 0 a 365 dias"]);
    expect(msgs({ ...base, responsavel: { tipo: "usuario", id: "x" } }).some(([p]) => p.startsWith("responsavel"))).toBe(true);
    expect(msgs({ ...base, dia: "2027-02-30" }).some(([p]) => p === "dia")).toBe(true);
  });
});
