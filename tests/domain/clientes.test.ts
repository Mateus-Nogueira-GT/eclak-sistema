import { describe, expect, it } from "vitest";
import {
  alertasDoCliente,
  dataEmCuiaba,
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

const pessoa = (
  o: Partial<{ id: string; nome: string; titular: boolean; nascimento: string | null; passaporte: string | null; validadePassaporte: string | null }> = {},
) => ({
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
  it("número sem validade: pede a validade", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ passaporte: "FX123", validadePassaporte: null })] }, "2026-11-18");
    expect(a).toEqual([
      { tipo: "sem_passaporte", pessoa: "Ana Lima", texto: "Ana Lima não tem a validade do passaporte cadastrada." },
    ]);
  });
  it("sem número e sem validade: texto de sem passaporte", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ passaporte: null, validadePassaporte: null })] }, "2026-11-18");
    expect(a.map((x) => x.texto)).toEqual(["Ana Lima não tem passaporte cadastrado."]);
  });
  it("alerta leva o id da pessoa quando houver", () => {
    const a = alertasDoCliente(
      { tipo: "familia", pessoas: [pessoa({ id: "p1", validadePassaporte: null }), pessoa({ id: "p2", nome: "Ana Lima", titular: false, nascimento: "1980-11-18" })] },
      "2026-11-18",
    );
    expect(a.map((x) => [x.tipo, x.pessoaId])).toEqual([
      ["sem_passaporte", "p1"],
      ["aniversario", "p2"],
    ]);
  });
  it("passaporte vencido", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ validadePassaporte: "2026-11-17" })] }, "2026-11-18");
    expect(a).toHaveLength(1);
    expect(a[0].tipo).toBe("passaporte_vencido");
    expect(a[0].texto).toBe("Passaporte de Ana Lima venceu em 17/11/2026.");
    expect(alertasDoCliente({ tipo: "individual", pessoas: [pessoa({ validadePassaporte: "2026-11-18" })] }, "2026-11-18")).toEqual([]);
  });
});

describe("alertasDoCliente: passaporte × volta da viagem", () => {
  const viagem = (o: Partial<{ destino: string; fim: string; internacional: boolean; passageiros: string[] }> = {}) => ({
    destino: "Itália",
    fim: "2027-01-29",
    internacional: true,
    passageiros: ["p1"],
    ...o,
  });
  const ana = (validadePassaporte: string | null, o: Partial<{ passaporte: string | null; titular: boolean; nome: string; id: string }> = {}) =>
    pessoa({ id: "p1", validadePassaporte, ...o });

  it("validade antes de volta + 182 dias: aviso", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [ana("2027-06-30")] }, "2026-11-22", [viagem()]);
    expect(a).toEqual([
      {
        tipo: "passaporte_volta",
        pessoa: "Ana Lima",
        pessoaId: "p1",
        texto: "Passaporte de Ana Lima vence em 30/06/2027, menos de 6 meses depois da volta de Itália.",
      },
    ]);
  });
  it("182 dias exatos não avisa; um dia a menos avisa", () => {
    // 2027-01-29 + 182 dias = 2027-07-30
    expect(alertasDoCliente({ tipo: "individual", pessoas: [ana("2027-07-30")] }, "2026-11-22", [viagem()])).toEqual([]);
    expect(alertasDoCliente({ tipo: "individual", pessoas: [ana("2027-07-29")] }, "2026-11-22", [viagem()])).toHaveLength(1);
  });
  it("volta em 2026-12-01: sem aviso", () => {
    expect(alertasDoCliente({ tipo: "individual", pessoas: [ana("2027-06-30")] }, "2026-11-22", [viagem({ fim: "2026-12-01" })])).toEqual([]);
  });
  it("viagem não internacional, já terminada ou sem a pessoa: sem aviso", () => {
    const c = { tipo: "individual" as const, pessoas: [ana("2027-06-30")] };
    expect(alertasDoCliente(c, "2026-11-22", [viagem({ internacional: false })])).toEqual([]);
    expect(alertasDoCliente(c, "2027-02-01", [viagem()])).toEqual([]);
    expect(alertasDoCliente(c, "2026-11-22", [viagem({ passageiros: ["outra"] })])).toEqual([]);
  });
  it("sem passaporte com viagem: aviso com destino e data da volta, no lugar do genérico", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [ana(null, { passaporte: null })] }, "2026-11-22", [
      viagem(),
      viagem({ destino: "Japão", fim: "2027-04-10" }),
    ]);
    expect(a.map((x) => [x.tipo, x.texto])).toEqual([
      ["sem_passaporte", "Ana Lima não tem passaporte cadastrado para Itália (29/01/2027)."],
      ["sem_passaporte", "Ana Lima não tem passaporte cadastrado para Japão (10/04/2027)."],
    ]);
  });
  it("passaporte vencido não repete o aviso da volta", () => {
    const a = alertasDoCliente({ tipo: "individual", pessoas: [ana("2026-11-01")] }, "2026-11-22", [viagem()]);
    expect(a.map((x) => x.tipo)).toEqual(["passaporte_vencido"]);
  });
  it("grupo: na viagem, todo passageiro é conferido (não só o titular)", () => {
    const a = alertasDoCliente(
      { tipo: "grupo", pessoas: [ana("2027-06-30"), pessoa({ id: "p2", nome: "Bia Souza", titular: false, validadePassaporte: "2027-06-30" })] },
      "2026-11-22",
      [viagem({ passageiros: ["p1", "p2"] })],
    );
    expect(a.map((x) => [x.tipo, x.pessoa])).toEqual([
      ["passaporte_volta", "Ana Lima"],
      ["passaporte_volta", "Bia Souza"],
    ]);
  });
  it("grupo: passageiro sem passaporte na viagem avisa; quem não viaja segue a regra antiga (só o titular)", () => {
    const a = alertasDoCliente(
      {
        tipo: "grupo",
        pessoas: [
          ana("2031-01-01"),
          pessoa({ id: "p2", nome: "Bia Souza", titular: false, passaporte: null, validadePassaporte: null }),
          pessoa({ id: "p3", nome: "Caio Souza", titular: false, passaporte: null, validadePassaporte: null }),
        ],
      },
      "2026-11-22",
      [viagem({ passageiros: ["p1", "p2"] })],
    );
    expect(a.map((x) => x.texto)).toEqual(["Bia Souza não tem passaporte cadastrado para Itália (29/01/2027)."]);
  });
});

describe("hojeEmCuiaba", () => {
  it("usa UTC-4", () => {
    expect(hojeEmCuiaba(new Date("2026-11-19T03:30:00Z"))).toBe("2026-11-18");
    expect(hojeEmCuiaba(new Date("2026-11-19T04:30:00Z"))).toBe("2026-11-19");
  });
  it("dataEmCuiaba: a data do instante em Cuiabá (não a de UTC)", () => {
    expect(dataEmCuiaba(new Date("2026-11-21T02:00:00Z"))).toBe("2026-11-20");
    expect(dataEmCuiaba(new Date("2026-11-21T04:00:00Z"))).toBe("2026-11-21");
  });
});
