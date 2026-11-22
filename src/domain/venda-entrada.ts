import { z } from "zod";
import { formaSchema } from "./aprovacoes";
import { hojeEmCuiaba } from "./clientes";
import { dataReal } from "./clientes-entrada";
import { documentoValido } from "./venda";

// Entradas das actions da venda (Zod). Datas ISO "AAAA-MM-DD".

export const MSG_JA_VENDIDA = "Esta viagem já foi vendida";
export const MSG_VIAGEM_VENDIDA =
  "Viagem vendida: ajustes de valor vão em Contas a pagar";
export const MSG_MUDOU_DEPOIS_DA_APROVACAO =
  "O orçamento mudou depois da aprovação. Envie a nova versão para o Diretor.";
export const MSG_FORMA_DIFERENTE =
  "A forma acordada é diferente da aprovada. Envie a nova forma para o Diretor.";
export const MSG_FORMA_IGUAL = "A nova forma é igual à aprovada";
export const MSG_NAO_APROVADO = "Orçamento ainda não aprovado pelo Diretor";
export const MSG_AGUARDANDO_DIRETOR =
  "Orçamento aguardando aprovação do Diretor";
export const MSG_PARCELAS = "Número de parcelas inválido";
export const MSG_ACEITE = "Informe a data do aceite";
export const MSG_PRIMEIRO_VENCIMENTO = "Informe o primeiro vencimento";
export const MSG_FATURA_NOME = "Informe o nome da fatura";
export const MSG_DOCUMENTO = "CPF ou CNPJ inválido";
export const MSG_PEDIDO_CLIENTE = "Escreva o pedido do cliente";
export const MSG_VENCIMENTO_ANTES_DO_ACEITE =
  "O primeiro vencimento não pode ser antes do aceite";
export const MSG_ACEITE_FUTURO = "Data do aceite no futuro";
export const ALTERACAO_NOVA_FORMA =
  "Nova forma de pagamento acordada com o cliente";

const texto = (max: number) =>
  z
    .string({ error: "Texto inválido" })
    .trim()
    .max(max, "Texto muito longo")
    .nullish()
    .transform((v) => (v ? v : null));

const obrigatorio = (msg: string, max: number) =>
  z.string({ error: msg }).trim().min(1, msg).max(max, "Texto muito longo");

const data = (msg: string) =>
  z.string({ error: msg }).trim().min(1, msg).refine(dataReal, "Data inválida");

/**
 * Fechamento da venda. A forma é conferida com a aprovada na action (tipo, antecipação e parcelas); aqui só a
 * estrutura (até 10x). `parcelas` = número de parcelas a receber, igual às da forma. O aceite não pode ser
 * depois de `hoje` (Cuiabá) e o primeiro vencimento não pode ser antes do aceite.
 */
export function fechamentoSchema(hoje: string = hojeEmCuiaba()) {
  return z
    .strictObject({
      aceiteEm: data(MSG_ACEITE).refine((v) => v <= hoje, MSG_ACEITE_FUTURO),
      forma: formaSchema(10),
      parcelas: z
        .number({ error: MSG_PARCELAS })
        .int(MSG_PARCELAS)
        .min(1, MSG_PARCELAS)
        .max(10, MSG_PARCELAS),
      primeiroVencimento: data(MSG_PRIMEIRO_VENCIMENTO),
      faturaNome: obrigatorio(MSG_FATURA_NOME, 200),
      /** Aceita a pontuação de CPF/CNPJ (".", "-", "/") e espaços; grava só os dígitos. Outro caractere invalida. */
      faturaDocumento: z
        .string({ error: MSG_DOCUMENTO })
        .refine((v) => /^[\d.\-/\s]*$/.test(v), MSG_DOCUMENTO)
        .transform((v) => v.replace(/[.\-/\s]/g, ""))
        .refine(documentoValido, MSG_DOCUMENTO),
      comprovante: texto(4000),
      observacao: texto(4000),
    })
    .superRefine((v, ctx) => {
      if (v.primeiroVencimento < v.aceiteEm)
        ctx.addIssue({
          code: "custom",
          message: MSG_VENCIMENTO_ANTES_DO_ACEITE,
          path: ["primeiroVencimento"],
        });
    });
}

export type FechamentoValidado = z.output<ReturnType<typeof fechamentoSchema>>;

/** Nova forma acordada com o cliente: forma pelos Parâmetros da versão aprovada e nota opcional. */
export function novaFormaSchema(parcelamentoMaximo: number) {
  return z.strictObject({
    forma: formaSchema(parcelamentoMaximo),
    nota: texto(2000),
  });
}

/** Pedido de ajustes do cliente (obrigatório). */
export const pedidoClienteSchema = obrigatorio(MSG_PEDIDO_CLIENTE, 4000);

/** "Nova forma de pagamento acordada com o cliente: <nota>" (sem nota, só a frase). */
export function alteracaoNovaForma(nota: string | null): string {
  return nota ? `${ALTERACAO_NOVA_FORMA}: ${nota}` : ALTERACAO_NOVA_FORMA;
}
