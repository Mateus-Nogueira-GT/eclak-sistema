import { describe, expect, it } from "vitest";
import {
  alertasDoCliente,
  cpfValido,
  formatarCodigoCliente,
  formatarCpf,
  formatarTelefone,
  hojeEmCuiaba,
  idade,
  nomeDoGrupo,
  normalizarCpf,
  normalizarTelefone,
  telefoneValido,
  NOMES_TIPO_CLIENTE,
  TIPOS_CLIENTE,
} from "@/domain/clientes";

const pessoa = (o: Partial<{ nome: string; titular: boolean; nascimento: string | null; validadePassaporte: string | null }> = {}) => ({
  nome: "Ana Lima",
  titular: true,
  nascimento: null,
  validadePassaporte: "2030-01-01",
  ...o,
});

describe("tipos", () => {
  it("lista e nomes", () => {
    expect(TIPOS_CLIENTE).toEqual(["familia", "casal", "individual", "grupo"]);
    expect(NOMES_TIPO_CLIENTE.familia).toBe("Família");
    expect(NOMES_TIPO_CLIENTE.grupo).toBe("Grupo");
  });
});

describe("cpf", () => {
  it("valida", () => {
    expect(cpfValido("52998224725")).toBe(true);
    expect(cpfValido("52998224724")).toBe(false);
    expect(cpfValido("11111111111")).toBe(false);
    expect(cpfValido("123")).toBe(false);
  });
  it("formata e normaliza", () => {
    expect(formatarCpf("52998224725")).toBe("529.982.247-25");
    expect(normalizarCpf("529.982.247-25")).toBe("52998224725");
  });
});

describe("telefone", () => {
  it("formata", () => {
    expect(formatarTelefone("66991234567")).toBe("(66) 9 9123-4567");
    expect(formatarTelefone("6634211234")).toBe("(66) 3421-1234");
    expect(normalizarTelefone("(66) 9 9123-4567")).toBe("66991234567");
  });
  it("valida", () => {
    expect(telefoneValido("669912")).toBe(false);
    expect(telefoneValido("6634211234")).toBe(true);
    expect(telefoneValido("66991234567")).toBe(true);
  });
});

describe("código", () => {
  it("formata", () => {
    expect(formatarCodigoCliente(1)).toBe("ECL-0001");
    expect(formatarCodigoCliente(153)).toBe("ECL-0153");
    expect(formatarCodigoCliente(10000)).toBe("ECL-10000");
  });
});

describe("nomeDoGrupo", () => {
  it("segue a regra do protótipo", () => {
    expect(nomeDoGrupo("familia", "Carlos Ribeiro")).toBe("Família Ribeiro");
    expect(nomeDoGrupo("casal", "Marina Souza")).toBe("Casal Souza");
    expect(nomeDoGrupo("individual", "Ana Lima")).toBe("Ana Lima");
    expect(nomeDoGrupo("grupo", "Ana Lima")).toBe("Ana Lima");
    expect(nomeDoGrupo("familia", "Carlos Ribeiro", " Ribeiro e amigos ")).toBe("Ribeiro e amigos");
    expect(nomeDoGrupo("familia", "Carlos Ribeiro", "   ")).toBe("Família Ribeiro");
  });
});

describe("idade", () => {
  it("anos completos", () => {
    expect(idade("1986-03-09", "2026-11-18")).toBe(40);
    expect(idade("1986-11-19", "2026-11-18")).toBe(39);
    expect(idade("1986-11-18", "2026-11-18")).toBe(40);
  });
});

describe("alertasDoCliente", () => {
  it("aniversário de 29/02 em ano não bissexto conta como 28/02", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ nascimento: "2000-02-29" })] }, "2027-02-20");
    expect(a).toHaveLength(1);
    expect(a[0].tipo).toBe("aniversario");
    expect(a[0].texto).toBe("Ana Lima faz aniversário em 28/02.");
  });
  it("aniversário atravessa o ano", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ nascimento: "1990-01-05" })] }, "2026-12-20");
    expect(a[0].texto).toContain("05/01");
  });
  it("hoje", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ nascimento: "1980-11-18" })] }, "2026-11-18");
    expect(a[0].texto).toBe("Ana Lima faz aniversário em 18/11 (hoje).");
  });
  it("31 dias fica de fora, 30 entra", () => {
    expect(alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ nascimento: "1980-12-19" })] }, "2026-11-18")).toEqual([]);
    expect(alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ nascimento: "1980-12-18" })] }, "2026-11-18")).toHaveLength(1);
  });
  it("grupo: documento só do titular", () => {
    const a = alertasDoCliente(
      {
        tipo: "grupo",
        pessoas: [pessoa({ validadePassaporte: null }), pessoa({ nome: "Bia Souza", titular: false, validadePassaporte: null })],
      },
      "2026-11-18",
    );
    expect(a.filter((x) => x.tipo === "sem_passaporte")).toHaveLength(1);
    expect(a[0].texto).toBe("Ana Lima não tem passaporte cadastrado.");
  });
  it("família: um por pessoa", () => {
    const a = alertasDoCliente(
      {
        tipo: "familia",
        pessoas: [pessoa({ validadePassaporte: null }), pessoa({ nome: "Bia Souza", titular: false, validadePassaporte: null })],
      },
      "2026-11-18",
    );
    expect(a.filter((x) => x.tipo === "sem_passaporte")).toHaveLength(2);
  });
  it("passaporte vencido", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ validadePassaporte: "2026-11-17" })] }, "2026-11-18");
    expect(a).toHaveLength(1);
    expect(a[0].tipo).toBe("passaporte_vencido");
    expect(a[0].texto).toBe("Passaporte de Ana Lima venceu em 17/11/2026.");
    expect(alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ validadePassaporte: "2026-11-18" })] }, "2026-11-18")).toEqual([]);
  });
});

describe("hojeEmCuiaba", () => {
  it("usa UTC-4", () => {
    expect(hojeEmCuiaba(new Date("2026-11-19T03:30:00Z"))).toBe("2026-11-18");
    expect(hojeEmCuiaba(new Date("2026-11-19T04:30:00Z"))).toBe("2026-11-19");
  });
});
