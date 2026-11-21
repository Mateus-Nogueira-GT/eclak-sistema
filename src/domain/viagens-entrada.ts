import { z } from "zod";
import { MOEDAS } from "./cambio";
import { dataReal } from "./clientes-entrada";
import { lerPercentual, lerReais } from "./dinheiro";
import type { TipoItem } from "./precificacao";

export const MSG_PASSAGEIRO_ALHEIO = "Passageiro não pertence a este cliente";
export const MSG_TAXA_AUTOMATICA = "A taxa de roteiro é automática";
const MSG_VOLTA = "A volta não pode ser antes da ida";

const MAX_CENTAVOS = 999_999_999_999n;
const MAX_PASSAGEIROS = 61;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const texto = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "Texto muito longo")
    .nullish()
    .transform((v) => (v ? v : null));

const obrigatorio = (msg: string, max: number) => z.string({ error: msg }).trim().min(1, msg).max(max, "Texto muito longo");

const dataObrigatoria = z
  .string({ error: "Data inválida" })
  .trim()
  .refine(dataReal, "Data inválida");

const dataOpcional = z
  .string()
  .trim()
  .nullish()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!dataReal(v)) {
      ctx.addIssue({ code: "custom", message: "Data inválida" });
      return z.NEVER;
    }
    return v;
  });

const camposOrcamento = {
  destino: obrigatorio("Informe o destino", 200),
  inicio: dataObrigatoria,
  fim: dataObrigatoria,
  passageiros: z
    .array(z.string({ error: MSG_PASSAGEIRO_ALHEIO }).regex(UUID, MSG_PASSAGEIRO_ALHEIO), {
      error: "Escolha ao menos um passageiro",
    })
    .min(1, "Escolha ao menos um passageiro")
    .max(MAX_PASSAGEIROS, "Passageiros demais")
    .transform((ids) => [...new Set(ids.map((x) => x.toLowerCase()))]),
  observacoes: texto(4000),
};

const voltaDepoisDaIda = (v: { inicio: string; fim: string }, ctx: z.RefinementCtx) => {
  if (v.fim < v.inicio) ctx.addIssue({ code: "custom", message: MSG_VOLTA, path: ["fim"] });
};

/** Edição do cabeçalho do orçamento (o cliente não muda). */
export const orcamentoSchema = z.strictObject(camposOrcamento).superRefine(voltaDepoisDaIda);

/** Novo orçamento. */
export const novoOrcamentoSchema = z
  .strictObject({
    clienteId: z.string({ error: "Cliente não encontrado" }).regex(UUID, "Cliente não encontrado"),
    ...camposOrcamento,
  })
  .superRefine(voltaDepoisDaIda);

/** Tipos que o usuário lança; `Taxa` é só a taxa de roteiro, mantida pelo servidor. */
export const TIPOS_ITEM_ENTRADA = [
  "Hotelaria",
  "Trem",
  "Transfer",
  "Carro",
  "Passeio",
  "Ingresso",
  "Seguro",
  "Outro",
  "Aéreo",
] as const satisfies readonly Exclude<TipoItem, "Taxa">[];

export const itemSchema = z
  .strictObject({
    tipo: z.enum(TIPOS_ITEM_ENTRADA, { error: "Tipo inválido" }),
    cidade: texto(120),
    servico: obrigatorio("Informe o serviço", 200),
    checkin: dataOpcional,
    checkout: dataOpcional,
    diarias: z
      .number({ error: "Diárias inválidas" })
      .int("Diárias inválidas")
      .min(0, "Diárias inválidas")
      .max(1000, "Diárias inválidas")
      .nullish()
      .transform((v) => v ?? null),
  })
  .superRefine((v, ctx) => {
    if (v.checkin && v.checkout && v.checkout < v.checkin) {
      ctx.addIssue({ code: "custom", message: "O check-out não pode ser antes do check-in", path: ["checkout"] });
    }
  });

/** Dinheiro em formato brasileiro ("1.000,00", "R$ 50"); centavos da moeda informada. */
const dinheiro = (opcional: boolean) =>
  z
    .string({ error: "Valor inválido" })
    .nullish()
    .transform((v, ctx) => {
      if (!v || !v.trim()) {
        if (opcional) return 0n;
        ctx.addIssue({ code: "custom", message: "Valor inválido" });
        return z.NEVER;
      }
      let c: bigint;
      try {
        c = lerReais(v);
      } catch {
        ctx.addIssue({ code: "custom", message: "Valor inválido" });
        return z.NEVER;
      }
      if (c > MAX_CENTAVOS) {
        ctx.addIssue({ code: "custom", message: "Valor muito alto" });
        return z.NEVER;
      }
      return c;
    });

/** Percentual de 0 a 100 ("4", "4,5", "4%") → "4.000". Vazio = `vazio`. */
const percentual = <T extends string | null>(vazio: T) =>
  z
    .string({ error: "Percentual inválido" })
    .nullish()
    .transform((v, ctx): string | T => {
      if (!v || !v.trim()) return vazio;
      let p: string;
      try {
        p = lerPercentual(v);
      } catch {
        ctx.addIssue({ code: "custom", message: "Percentual inválido" });
        return z.NEVER;
      }
      if (Number(p) > 100) {
        ctx.addIssue({ code: "custom", message: "Percentual inválido" });
        return z.NEVER;
      }
      return p;
    });

/** Cotação. Não há campo de câmbio: o servidor usa o dos Parâmetros vigentes. */
export const cotacaoSchema = z.strictObject({
  fornecedorId: z
    .string({ error: "Fornecedor não encontrado" })
    .regex(UUID, "Fornecedor não encontrado")
    .nullish()
    .transform((v) => v ?? null),
  moeda: z.enum(MOEDAS, { error: "Moeda inválida" }).default("BRL"),
  valor: dinheiro(false),
  comissao: percentual("0.000"),
  descontoAVista: percentual(null),
  tarifaFixa: dinheiro(true),
});
