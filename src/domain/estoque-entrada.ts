import { z } from "zod";
import { CENTROS, FORMAS_FINANCEIRO } from "./financeiro";
import { ehCompraNoCartao, uuid, uuidOpcional } from "./financeiro-entrada";
import { USOS_ESTOQUE } from "./estoque";
import { data, MSG_CARTAO_CORPORATIVO, obrigatorio, reais, texto } from "./venda-entrada";

// Entradas das actions do estoque (Zod). Datas "AAAA-MM-DD"; valor em reais vira centavos.

const MSG_QUANTIDADE = "Informe uma quantidade inteira de 1 em diante";
const MSG_MOTIVO = "Escreva o motivo (5 a 200 caracteres)";
const MSG_MINIMO = "O mínimo precisa ser um número inteiro, 0 ou mais";

const quantidade = z.number({ error: MSG_QUANTIDADE }).int(MSG_QUANTIDADE).min(1, MSG_QUANTIDADE);
const minimo = z.number({ error: MSG_MINIMO }).int(MSG_MINIMO).min(0, MSG_MINIMO);
const filial = z.enum(CENTROS, { error: "Filial inválida" });
const motivo = z.string({ error: MSG_MOTIVO }).trim().min(5, MSG_MOTIVO).max(200, MSG_MOTIVO);

export const produtoSchema = z.strictObject({
  nome: obrigatorio("Informe o nome do produto", 120),
  uso: z.enum(USOS_ESTOQUE, { error: "Uso inválido" }),
  minimoMt: minimo,
  minimoRs: minimo,
});

/** Compra de estoque; forma e cartão seguem as regras do lançamento manual a pagar. */
export const entradaSchema = z
  .strictObject({
    produtoId: uuid,
    filial,
    quantidade,
    valorUnitario: reais(false),
    fornecedorId: uuidOpcional,
    fornecedorTexto: texto(200),
    vencimento: data("Informe o vencimento"),
    forma: z.enum(FORMAS_FINANCEIRO, { error: "Forma de pagamento inválida" }),
    cartaoId: uuidOpcional,
  })
  .superRefine((v, ctx) => {
    if (v.fornecedorId !== null && v.fornecedorTexto !== null) {
      ctx.addIssue({ code: "custom", message: "Escolha só um: fornecedor do cadastro ou nome", path: ["fornecedor"] });
    }
    if (ehCompraNoCartao({ lado: "pagar", forma: v.forma }) && !v.cartaoId) {
      ctx.addIssue({ code: "custom", message: MSG_CARTAO_CORPORATIVO, path: ["cartaoId"] });
    }
  })
  .transform((v) => (ehCompraNoCartao({ lado: "pagar", forma: v.forma }) ? v : { ...v, cartaoId: null }));
export type EntradaValidada = z.output<typeof entradaSchema>;

export const saidaSchema = z.strictObject({ produtoId: uuid, filial, quantidade, motivo });

/** Contagem: a quantidade nova da filial (0 vale). */
export const ajusteSchema = z.strictObject({
  produtoId: uuid,
  filial,
  quantidadeNova: z.number({ error: MSG_MINIMO }).int(MSG_QUANTIDADE).min(0, "A quantidade não pode ser negativa"),
  motivo,
});

export const caixaItensSchema = z
  .array(z.strictObject({ produtoId: uuid, quantidade }), { error: "Itens inválidos" })
  .refine((is) => new Set(is.map((i) => i.produtoId)).size === is.length, "Produto repetido na caixa");
