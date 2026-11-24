import { ultimoSobrenome } from "./clientes";

// Google Drive (puro): nome da pasta da viagem, subpastas e chave da fila. Nada de valor, custo, margem, comissão nem
// documento: só o código do cliente, o sobrenome do titular, o destino e as datas.

export const SUBPASTA_PUBLICA = "Público";
export const SUBPASTA_INTERNA = "Uso interno";

export const chavePasta = (viagemId: string) => `pasta:${viagemId}`;

/** Maiúsculas, sem acento, sem espaço e sem pontuação: só letras A–Z e dígitos; nada sobrando vira "X". */
function parte(t: string): string {
  const p = t
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return p || "X";
}

const data = (iso: string) => iso.slice(0, 10).replace(/-/g, "");

/** `ECL-0147_SOUZA_ITALIA_20270814-20270901` (código do cliente, não da viagem). Datas "AAAA-MM-DD". */
export function nomeDaPasta(v: { codigoCliente: string; titular: string; destino: string; inicio: string; fim: string }): string {
  return [v.codigoCliente.trim(), parte(ultimoSobrenome(v.titular)), parte(v.destino), `${data(v.inicio)}-${data(v.fim)}`].join("_");
}
