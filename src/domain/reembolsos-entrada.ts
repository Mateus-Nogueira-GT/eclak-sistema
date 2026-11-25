import { z } from "zod";
import { FORMAS_DEVOLUCAO } from "./reembolsos";
import { uuid } from "./financeiro-entrada";
import { data, obrigatorio, reais } from "./venda-entrada";

// Entrada do registro de um caso de reembolso (Zod). Valores em reais viram centavos; datas "AAAA-MM-DD".

export const MSG_SEM_VALOR = "Informe um valor a cobrar ou a devolver";
export const MSG_PREVISTO = "Informe quando o fornecedor deve pagar";
const MSG_OCORRIDO = "Conte o que aconteceu (10 a 1.000 caracteres)";

/** Campo opcional de formulário: vazio chega como "" e vale null. */
const uuidOpcional = z.preprocess((v) => (v === "" ? null : v), uuid.nullish().transform((v) => v ?? null));
const dataOpcional = z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), data("Data inválida").nullish().transform((v) => v ?? null));
/** Valor em reais; vazio = 0 (nunca negativo: o parser recusa "-"). */
const zeroSeVazio = reais(true).transform((v) => v ?? 0n);

export const reembolsoSchema = z
  .strictObject({
    viagemId: uuid,
    contaPagarId: uuidOpcional,
    servico: obrigatorio("Informe o serviço", 200),
    ocorridoEm: data("Informe quando aconteceu"),
    ocorrido: z.string({ error: MSG_OCORRIDO }).trim().min(10, MSG_OCORRIDO).max(1000, MSG_OCORRIDO),
    valorCobrar: zeroSeVazio,
    valorDevolver: zeroSeVazio,
    formaDevolucao: z.enum(FORMAS_DEVOLUCAO, { error: "Forma de devolução inválida" }),
    prazoCliente: data("Informe o prazo do cliente"),
    previstoFornecedor: dataOpcional,
  })
  .superRefine((v, ctx) => {
    if (v.valorCobrar === 0n && v.valorDevolver === 0n) {
      ctx.addIssue({ code: "custom", path: ["valorCobrar"], message: MSG_SEM_VALOR });
    }
    if (v.valorCobrar > 0n && !v.previstoFornecedor) {
      ctx.addIssue({ code: "custom", path: ["previstoFornecedor"], message: MSG_PREVISTO });
    }
  });

export type ReembolsoEntrada = z.output<typeof reembolsoSchema>;
