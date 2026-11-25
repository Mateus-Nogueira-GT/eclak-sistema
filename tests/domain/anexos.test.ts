import { describe, expect, it } from "vitest";
import { DONOS_ANEXO, TAMANHO_MAXIMO_ANEXO, tamanhoLegivel, tipoPelosBytes } from "@/domain/anexos";

const bytes = (...b: number[]) => new Uint8Array(b);
const texto = (s: string) => new TextEncoder().encode(s);

describe("anexos: tipo pelos bytes iniciais", () => {
  it("reconhece PDF pelo %PDF-", () => {
    expect(tipoPelosBytes(texto("%PDF-1.7\n%âãÏÓ\n"))).toBe("application/pdf");
  });

  it("reconhece PNG pela assinatura de 8 bytes", () => {
    expect(tipoPelosBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d))).toBe("image/png");
  });

  it("reconhece JPEG pelo FF D8 FF", () => {
    expect(tipoPelosBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
  });

  it("texto renomeado (qualquer extensão) não passa", () => {
    expect(tipoPelosBytes(texto("isto é um texto qualquer renomeado para .pdf"))).toBeNull();
  });

  it("assinatura incompleta ou parecida não passa", () => {
    expect(tipoPelosBytes(texto("%PDF"))).toBeNull();
    expect(tipoPelosBytes(texto(" %PDF-1.4"))).toBeNull();
    expect(tipoPelosBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull();
    expect(tipoPelosBytes(bytes(0xff, 0xd8))).toBeNull();
    expect(tipoPelosBytes(bytes())).toBeNull();
  });

  it("limite de 10 MB e donos", () => {
    expect(TAMANHO_MAXIMO_ANEXO).toBe(10 * 1024 * 1024);
    expect(DONOS_ANEXO).toEqual(["manual", "parcela", "pagamento", "comissao", "fatura_cartao", "nota_fiscal", "reembolso"]);
  });

  it("tamanho legível em pt-BR", () => {
    expect(tamanhoLegivel(512)).toBe("512 bytes");
    expect(tamanhoLegivel(2048)).toBe("2 KB");
    expect(tamanhoLegivel(1536 * 1024)).toBe("1,5 MB");
  });
});
