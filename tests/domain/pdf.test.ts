import { describe, expect, it } from "vitest";
import { textoDoPdf } from "@/server/integracoes/pdf";

/** Gera um PDF 1.4 mínimo de uma página contendo o texto ASCII informado. */
function pdfMinimo(texto: string): Uint8Array {
  const escapado = texto.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escapado}) Tj ET`;
  const objetos = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n",
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objetos) {
    offsets.push(out.length);
    out += obj;
  }
  const xrefPos = out.length;
  out += `xref\n0 ${objetos.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (let i = 1; i <= objetos.length; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("textoDoPdf", () => {
  it("extrai o texto de um PDF válido", async () => {
    const texto = await textoDoPdf(pdfMinimo("Voucher Roma 123"));
    expect(texto).toContain("Voucher Roma 123");
  });

  it("bytes aleatórios (PDF inválido) devolvem string vazia", async () => {
    expect(await textoDoPdf(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBe("");
  });
});
