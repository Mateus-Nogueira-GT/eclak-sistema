import { z } from "zod";
import { documentoValido } from "./venda";
import { data, obrigatorio, reais, texto } from "./venda-entrada";

// Notas fiscais emitidas (controle interno: número, emissão, competência, valor, destinatário, CPF/CNPJ, PDF).
// Datas "AAAA-MM-DD", competência "AAAA-MM". Cancelada nunca é apagada.

export const STATUS_NOTA = ["emitida", "cancelada"] as const;
export type StatusNota = (typeof STATUS_NOTA)[number];

export const MSG_NUMERO_REPETIDO = "Já existe uma nota com este número";
export const MSG_DOCUMENTO_NOTA = "CPF ou CNPJ inválido";
export const MSG_MOTIVO_NOTA = "Escreva o motivo do cancelamento";
export const MSG_FORNECEDOR_OU_CLIENTE = "Escolha só um: fornecedor ou cliente";
const MSG_ID = "Identificador inválido";
const MSG_COMPETENCIA = "Competência inválida";
const MSG_DATA = "Informe a data";
const MSG_VALOR_ZERO = "Informe um valor maior que zero";

export const NOTAS_POR_PAGINA = 50;

const uuidOpcional = z.preprocess(
  (v) => (v === "" ? null : v),
  z
    .string({ error: MSG_ID })
    .uuid(MSG_ID)
    .nullish()
    .transform((v) => v ?? null),
);

/** CPF ou CNPJ opcional: aceita máscara, guarda só os dígitos; vazio vale null. */
const documento = z
  .string({ error: MSG_DOCUMENTO_NOTA })
  .nullish()
  .transform((v, ctx) => {
    const digitos = (v ?? "").replace(/\D/g, "");
    if (digitos === "") return null;
    if (!documentoValido(digitos)) {
      ctx.addIssue({ code: "custom", message: MSG_DOCUMENTO_NOTA });
      return z.NEVER;
    }
    return digitos;
  });

export const notaFiscalSchema = z
  .strictObject({
    numero: obrigatorio("Informe o número da nota", 40),
    emitidaEm: data(MSG_DATA),
    competencia: z.string({ error: MSG_COMPETENCIA }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, MSG_COMPETENCIA),
    valor: reais(false).refine((v) => v > 0n, MSG_VALOR_ZERO),
    destinatario: obrigatorio("Informe o destinatário", 200),
    documento,
    fornecedorId: uuidOpcional,
    clienteId: uuidOpcional,
    viagemId: uuidOpcional,
    observacao: texto(2000),
  })
  .superRefine((v, ctx) => {
    if (v.fornecedorId !== null && v.clienteId !== null) ctx.addIssue({ code: "custom", message: MSG_FORNECEDOR_OU_CLIENTE, path: ["fornecedorId"] });
  });
export type NotaFiscalEntrada = z.infer<typeof notaFiscalSchema>;

export const motivoCancelamentoSchema = obrigatorio(MSG_MOTIVO_NOTA, 500);

export const filtroNotasSchema = z.strictObject({
  de: data(MSG_DATA),
  ate: data(MSG_DATA),
  destinatario: z.string().trim().max(100, "Busca muito longa").optional(),
  pagina: z.number({ error: "Página inválida" }).int("Página inválida").min(1, "Página inválida"),
});
export type FiltroNotas = z.infer<typeof filtroNotasSchema>;

/** Último dia do mês de "AAAA-MM-DD". */
function fimDoMes(d: string): string {
  const [a, m] = d.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

/** Filtro da lista a partir da URL: inválidos e vazios valem o padrão (mês de `hoje`, página 1). */
export function filtroNotasDaUrl(params: Record<string, string | string[] | undefined>, hoje: string): FiltroNotas {
  const forma = filtroNotasSchema.shape;
  const filtro: Record<string, unknown> = { de: `${hoje.slice(0, 8)}01`, ate: fimDoMes(hoje), pagina: 1 };
  for (const [k, bruto] of Object.entries(params)) {
    if (!Object.hasOwn(forma, k)) continue;
    const t = (Array.isArray(bruto) ? bruto[0] : bruto)?.trim();
    if (!t) continue;
    const r = forma[k as keyof typeof forma].safeParse(k === "pagina" ? Number(t) : t);
    if (r.success && r.data !== undefined) filtro[k] = r.data;
  }
  return filtroNotasSchema.parse(filtro);
}
