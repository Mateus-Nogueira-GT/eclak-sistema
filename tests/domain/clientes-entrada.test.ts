import { describe, expect, it } from "vitest";
import { clienteSchema } from "@/domain/clientes-entrada";

const base = { tipo: "casal", filial: "RS", telefone: "66999990000", titular: { nome: "Ana" }, acompanhantes: [] };
const erros = (v: unknown) => {
  const r = clienteSchema("2026-11-18").safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("clienteSchema: campos ausentes", () => {
  it("aceita entrada mínima", () => {
    expect(erros(base)).toEqual([]);
  });
  it("acompanhantes ausente vira lista vazia", () => {
    const { acompanhantes: _a, ...sem } = base;
    void _a;
    const r = clienteSchema("2026-11-18").safeParse(sem);
    expect(r.success && r.data.acompanhantes).toEqual([]);
  });
  it("titular.nome ausente", () => {
    expect(erros({ ...base, titular: {} })).toEqual(["Informe o nome do titular"]);
  });
  it("titular ausente", () => {
    const { titular: _t, ...sem } = base;
    void _t;
    expect(erros(sem)).toEqual(["Informe o nome do titular"]);
  });
  it("telefone ausente", () => {
    const { telefone: _t, ...sem } = base;
    void _t;
    expect(erros(sem)).toEqual(["Informe o telefone"]);
  });
  it("nome de acompanhante ausente", () => {
    expect(erros({ ...base, acompanhantes: [{}] })).toEqual(["Informe o nome do acompanhante"]);
  });
});
