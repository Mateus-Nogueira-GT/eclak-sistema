import { z } from "zod";
import { lerPercentual, lerReais } from "./dinheiro";

export const TIPOS_SERVICO = [
  "Hotelaria",
  "Transfer",
  "Trem",
  "Carro",
  "Ingresso",
  "Passeio guiado",
  "Seguro",
  "Restaurante",
  "Operadora",
  "Aéreo",
  "Taxa",
  "Outro",
] as const;
export type TipoServico = (typeof TIPOS_SERVICO)[number];

export const MODALIDADES = ["net", "comissionado"] as const;
export type Modalidade = (typeof MODALIDADES)[number];
export const ROTULO_MODALIDADE: Record<Modalidade, string> = { net: "Net", comissionado: "Comissionado" };

const TARIFA_MAX = 999_999_999_999n;

const texto = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "Texto muito longo")
    .optional()
    .transform((v) => (v ? v : null));

/** Texto digitado em formato brasileiro -> valor canônico; "Valor inválido" se não der. */
const lido = <T>(ler: (t: string) => T, vazio: T, valida: (v: T) => boolean) =>
  z
    .string()
    .trim()
    .optional()
    .transform((t, ctx) => {
      if (!t) return vazio;
      try {
        const v = ler(t);
        if (!valida(v)) throw new Error();
        return v;
      } catch {
        ctx.addIssue({ code: "custom", message: "Valor inválido" });
        return z.NEVER;
      }
    });

/** Entrada do formulário (textos). Whitelist: id, criado_em, excluido_em nunca entram. */
export const FornecedorSchema = z.strictObject({
  nome: z.string().trim().min(1, "Informe o nome do fornecedor").max(200, "Texto muito longo"),
  tipos: z.array(z.enum(TIPOS_SERVICO)).min(1, "Escolha ao menos um tipo de serviço"),
  cidade: texto(120),
  modalidade: z.enum(MODALIDADES),
  comissaoPct: lido(lerPercentual, "0.000", (v) => Number(v) >= 0 && Number(v) <= 100),
  tarifaFixa: lido(lerReais, 0n, (v) => v >= 0n && v <= TARIFA_MAX),
  descontoAVista: texto(200),
  operacaoFinanceiraOperadora: texto(200),
  contatoNome: texto(200),
  contatoTelefone: texto(60),
  contatoEmail: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || z.email().safeParse(v).success, "E-mail inválido"),
  plantao: texto(500),
  observacoes: texto(2000),
});

export type FornecedorEntrada = z.input<typeof FornecedorSchema>;
export type FornecedorValidado = z.output<typeof FornecedorSchema>;
