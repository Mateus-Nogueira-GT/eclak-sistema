import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const obterProposta = vi.fn();
vi.mock("@/server/queries/viagens", () => ({ obterProposta: (id: string) => obterProposta(id) }));

import Pagina from "@/app/(app)/viagens/[id]/proposta/page";

const render = async () => renderToStaticMarkup(await Pagina({ params: Promise.resolve({ id: "x" }) }));

describe("página da proposta", () => {
  it("sem aprovação mostra a mensagem e nenhum valor", async () => {
    obterProposta.mockResolvedValue({ ok: false, erro: "Proposta disponível só depois da aprovação do Diretor" });
    const html = await render();
    expect(html).toContain("Proposta disponível só depois da aprovação do Diretor");
    expect(html).not.toContain("R$");
  });

  it("aprovada mostra pacote, taxa, total e por pessoa em formato brasileiro, sem dados internos", async () => {
    obterProposta.mockResolvedValue({
      ok: true,
      proposta: {
        codigo: "ECL-0031-01",
        cliente: "Casal Souza",
        numeroVersao: 1,
        destino: "Itália",
        inicio: "2027-08-14",
        fim: "2027-09-01",
        dias: 19,
        noites: 18,
        passageiros: ["Marina Souza", "Rafael Souza"],
        itens: [{ tipo: "Hotelaria", cidade: "Veneza", servico: "Palazzo Barocci", checkin: "2027-08-14", checkout: "2027-08-16", diarias: 2 }],
        total: 6981518n,
        taxaServico: 285000n,
        porPessoa: 3490759n,
        forma: "Cartão em 6x",
        validade: "Não inclui aéreo.",
        aprovadaEm: new Date("2026-11-21T15:00:00Z"),
        desatualizada: false,
      },
    });
    const html = await render();
    expect(html).not.toContain("Há alterações no orçamento");
    expect(html).toContain("R$ 66.965,18");
    expect(html).toContain("R$ 2.850,00");
    expect(html).toContain("R$ 69.815,18");
    expect(html).toContain("R$ 34.907,59");
    expect(html).toContain("14/08/2027 a 01/09/2027");
    expect(html).toContain("Cartão em 6x");
    expect(html).toContain("Não inclui aéreo");
    expect(html).not.toMatch(/comiss|custo|margem|fornecedor/i);
  });

  it("orçamento alterado depois da aprovação: aviso visível (também na impressão) com versão e data", async () => {
    obterProposta.mockResolvedValue({
      ok: true,
      proposta: {
        codigo: "ECL-0031-01",
        cliente: "Casal Souza",
        numeroVersao: 2,
        destino: "Itália",
        inicio: "2027-08-14",
        fim: "2027-09-01",
        dias: 19,
        noites: 18,
        passageiros: ["Marina Souza"],
        itens: [],
        total: 100n,
        taxaServico: 0n,
        porPessoa: 100n,
        forma: "Pix",
        validade: "Não inclui aéreo.",
        aprovadaEm: new Date("2026-11-21T15:00:00Z"),
        desatualizada: true,
      },
    });
    const html = await render();
    expect(html).toContain("Há alterações no orçamento ainda não aprovadas. Esta proposta mostra a versão 2 aprovada em 21/11/2026.");
    const aviso = html.slice(html.lastIndexOf("<p", html.indexOf("Há alterações")), html.indexOf("Há alterações"));
    expect(aviso).not.toContain("print:hidden");
  });
});
