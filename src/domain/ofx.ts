// Leitor de extrato OFX (puro, sem I/O). Aceita OFX 1.x (SGML, tags sem fechamento) e 2.x (XML).
// Leitura tolerante por regex de tags: `<TAG>valor` vai até o próximo `<` ou o fim da linha.

export const TAMANHO_MAXIMO_OFX = 5 * 1024 * 1024;

export const MAX_DESCRICAO_OFX = 255;

export const MSG_OFX_INVALIDO = "O arquivo não parece um extrato OFX";
export const MSG_OFX_VARIAS_CONTAS = "O arquivo tem mais de uma conta. Baixe o extrato de uma conta por vez";
export const MSG_OFX_CARTAO = "Extrato de cartão de crédito não é aceito aqui";
export const MSG_OFX_SEM_FITID = "Transação sem identificador (FITID) no extrato";

export type TransacaoOfx = {
  fitid: string;
  /** AAAA-MM-DD, como escrita no arquivo (sem converter fuso). */
  data: string;
  /** Centavos; entrada +, saída −. */
  valor: bigint;
  tipo: string;
  descricao: string;
};

export type ExtratoOfx = {
  banco: string | null;
  /** Só os 4 últimos caracteres alfanuméricos da conta. */
  conta: string | null;
  inicio: string | null;
  fim: string | null;
  transacoes: TransacaoOfx[];
};

export type ResultadoOfx = { ok: true; extrato: ExtratoOfx } | { ok: false; erro: string };

/**
 * Texto do arquivo pelos bytes, não pelo cabeçalho (bancos declaram `CHARSET:1252` e mandam UTF-8, ou `CHARSET:NONE`
 * e mandam 1252): UTF-8 estrito primeiro; se os bytes não são UTF-8 válido, windows-1252 (superconjunto do
 * ISO-8859-1). Texto só ASCII sai igual nos dois, então o cabeçalho não tem o que desempatar. Tira o BOM.
 */
export function decodificarOfx(bytes: Uint8Array): string {
  let texto: string;
  try {
    texto = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    texto = new TextDecoder("windows-1252").decode(bytes);
  }
  return texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
}

/** `-2862.49`, `-2862,49`, `+10` → centavos. Um só separador decimal, no máximo 2 casas; milhar não existe em OFX → `null`. */
export function valorOfxEmCentavos(s: string): bigint | null {
  const m = /^([+-]?)(\d+)(?:[.,](\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const centavos = BigInt(m[2]) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] === "-" ? -centavos : centavos;
}

/** `AAAAMMDD[HHMM[SS[.XXX]]][[-3:BRT]]` → `AAAA-MM-DD` como escrita; `null` se não for data válida. */
export function dataOfx(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:\d{4}(?:\d{2}(?:\.\d+)?)?)?(?:\[[^\]]*\])?$/.exec(s.trim());
  if (!m) return null;
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mes < 1 || mes > 12 || dia < 1) return null;
  if (dia > new Date(Date.UTC(ano, mes, 0)).getUTCDate()) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const ENTIDADES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Código de `&#193;` / `&#xC1;` como caractere; inválido (fora do Unicode ou metade de surrogate) fica como está. */
function caractere(original: string, codigo: number): string {
  return codigo > 0x10ffff || (codigo >= 0xd800 && codigo <= 0xdfff) ? original : String.fromCodePoint(codigo);
}

/** Entidades nomeadas e numéricas numa passada só (`&amp;#193;` vira o texto `&#193;`, não `Á`). */
function limpar(v: string): string {
  return v
    .replace(/&(?:(amp|lt|gt|quot|apos)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g, (e: string, nome?: string, dec?: string, hex?: string) =>
      nome ? ENTIDADES[nome] : caractere(e, dec !== undefined ? Number(dec) : parseInt(hex!, 16)),
    )
    .replace(/\s+/g, " ")
    .trim();
}

/** Valor da primeira ocorrência de `<TAG>` no trecho (até `<` ou fim da linha); `null` se não há ou vazio. */
function tag(trecho: string, nome: string): string | null {
  const m = new RegExp(`<${nome}>\\s*([^<\\r\\n]*)`, "i").exec(trecho);
  const v = m ? limpar(m[1]) : "";
  return v === "" ? null : v;
}

function descricaoDe(trecho: string): string {
  const nome = tag(trecho, "NAME");
  const memo = tag(trecho, "MEMO");
  const junta = nome && memo && nome !== memo ? `${nome} · ${memo}` : (nome ?? memo ?? "");
  return junta.slice(0, MAX_DESCRICAO_OFX).trim();
}

export function lerOfx(texto: string): ResultadoOfx {
  const invalido = { ok: false, erro: MSG_OFX_INVALIDO } as const;
  if (!/<OFX[\s>]/i.test(texto)) return invalido;

  if (/<CCSTMTRS[\s>]/i.test(texto)) return { ok: false, erro: MSG_OFX_CARTAO };
  const contas = texto.match(/<STMTRS[\s>]/gi)?.length ?? 0;
  if (contas > 1) return { ok: false, erro: MSG_OFX_VARIAS_CONTAS };
  if (contas === 0) return invalido;

  const blocos = texto.match(/<STMTTRN>[\s\S]*?(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi) ?? [];
  const transacoes: TransacaoOfx[] = [];
  for (const bloco of blocos) {
    const fitid = tag(bloco, "FITID");
    if (!fitid) return { ok: false, erro: MSG_OFX_SEM_FITID };
    const data = dataOfx(tag(bloco, "DTPOSTED") ?? "");
    if (!data) return { ok: false, erro: `Transação com data inválida no extrato (FITID ${fitid})` };
    const valor = valorOfxEmCentavos(tag(bloco, "TRNAMT") ?? "");
    if (valor === null) return { ok: false, erro: `Transação com valor inválido no extrato (FITID ${fitid})` };
    transacoes.push({ fitid, data, valor, tipo: tag(bloco, "TRNTYPE") ?? "OTHER", descricao: descricaoDe(bloco) });
  }

  const acct = tag(texto, "ACCTID");
  const conta = acct ? acct.replace(/[^0-9A-Za-z]/g, "").slice(-4) || null : null;
  const antesDasTransacoes = texto.split(/<STMTTRN>/i)[0];
  return {
    ok: true,
    extrato: {
      banco: tag(texto, "BANKID") ?? tag(antesDasTransacoes, "ORG"),
      conta,
      inicio: dataOfx(tag(texto, "DTSTART") ?? ""),
      fim: dataOfx(tag(texto, "DTEND") ?? ""),
      transacoes,
    },
  };
}
