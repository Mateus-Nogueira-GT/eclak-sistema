import "server-only";
import { extractText } from "unpdf";

// Extração de texto de PDF no servidor (usada só por `drive_ler_arquivo`). PDF escaneado ou inválido devolve "".
export async function textoDoPdf(bytes: Uint8Array): Promise<string> {
  try {
    const copia = new Uint8Array(bytes.byteLength);
    copia.set(bytes);
    const { text } = await extractText(copia, { mergePages: false });
    return text
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .join("\n\n");
  } catch {
    return "";
  }
}
