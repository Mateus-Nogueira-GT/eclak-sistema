import { describe, expect, it } from "vitest";
import {
  ROTULOS_STATUS_ORCAMENTO,
  STATUS_ORCAMENTO,
  diasDaViagem,
  formatarCodigoViagem,
  noites,
} from "@/domain/viagens";

describe("viagens", () => {
  it("formata o código da viagem", () => {
    expect(formatarCodigoViagem(147, 1)).toBe("ECL-0147-01");
    expect(formatarCodigoViagem(1, 12)).toBe("ECL-0001-12");
  });

  it("conta dias (inclusivo) e noites", () => {
    expect(diasDaViagem("2027-08-14", "2027-09-01")).toBe(19);
    expect(noites("2027-08-14", "2027-09-01")).toBe(18);
    expect(diasDaViagem("2027-08-14", "2027-08-14")).toBe(1);
    expect(noites("2027-08-14", "2027-08-14")).toBe(0);
  });

  it("expõe status e rótulos", () => {
    expect(STATUS_ORCAMENTO).toEqual(["em_edicao", "aguardando_aprovacao", "aprovado", "devolvido", "vendida"]);
    expect(ROTULOS_STATUS_ORCAMENTO.aguardando_aprovacao).toBe("Aguardando aprovação");
    expect(ROTULOS_STATUS_ORCAMENTO.em_edicao).toBe("Em edição");
  });
});
