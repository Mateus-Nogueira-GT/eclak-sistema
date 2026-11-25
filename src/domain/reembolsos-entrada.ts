import { z } from "zod";
import { FORMAS_DEVOLUCAO } from "./reembolsos";
import { uuid, uuidOpcional } from "./financeiro-entrada";
import { hojeEmCuiaba } from "./clientes";
import { data, obrigatorio, reais, texto } from "./venda-entrada";

// Entrada do registro de um caso de reembolso (Zod). Valores em reais viram centavos; datas "AAAA-MM-DD".

export const MSG_SEM_VALOR = "Informe um valor a cobrar ou a devolver";
export const MSG_PREVISTO = "Informe quando o fornecedor deve pagar";
const MSG_OCORRIDO = "Conte o que aconteceu (10 a 1.000 caracteres)";
export const MSG_MOTIVO_CANCELAMENTO = "Informe o motivo (5 a 200 caracteres)";
const MSG_DATA_FUTURA = "A data não pode ser futura";

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

const dataAteHoje = (msg: string, hoje: string) => data(msg).refine((v) => v <= hoje, MSG_DATA_FUTURA);

/** "Marcar como pedido": a data do pedido ao fornecedor (até hoje) e o protocolo (opcional). */
export function pedidoSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({ pedidoEm: dataAteHoje("Informe quando foi pedido", hoje), protocolo: texto(200) });
}

/** "Cliente reembolsado" nas formas sem conta (abatimento e crédito): só a data (até hoje). */
export function reembolsadoEmSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({ data: dataAteHoje("Informe a data", hoje) });
}

/** Motivo do cancelamento do caso: 5 a 200 caracteres, sem contar os espaços das pontas. */
export const motivoCancelamentoSchema = z.string({ error: MSG_MOTIVO_CANCELAMENTO }).trim().min(5, MSG_MOTIVO_CANCELAMENTO).max(200, MSG_MOTIVO_CANCELAMENTO);
