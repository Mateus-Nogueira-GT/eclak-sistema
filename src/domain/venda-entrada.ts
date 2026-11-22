import { z } from "zod";
import { formaSchema } from "./aprovacoes";
import { hojeEmCuiaba } from "./clientes";
import { lerCambio } from "./cambio";
import { dataReal } from "./clientes-entrada";
import { lerReais } from "./dinheiro";
import { COMISSAO_TIPOS, documentoValido } from "./venda";

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

export const texto = (max: number) =>
  z
    .string({ error: "Texto inválido" })
    .trim()
    .max(max, "Texto muito longo")
    .nullish()
    .transform((v) => (v ? v : null));

export const obrigatorio = (msg: string, max: number) =>
  z.string({ error: msg }).trim().min(1, msg).max(max, "Texto muito longo");

export const data = (msg: string) =>
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

// ---------------------------------------------------------------------------
// Financeiro da viagem vendida (baixas, contas a pagar, comissões, conciliação)
// ---------------------------------------------------------------------------

export const MSG_NAO_VENDIDA = "A viagem ainda não foi vendida";
export const MSG_CONCILIADA = "Viagem conciliada: desfaça a conciliação para alterar";
export const MSG_NAO_CONCILIADA = "A viagem não está conciliada";
export const MSG_JA_BAIXADO_NA_CONTA = "Já há pagamento baixado nesta conta";
export const MSG_CAMBIO_EFETIVO = "Informe o câmbio efetivo";
export const MSG_EM_ABERTO = "Ainda há valores em aberto";
export const MSG_DATA = "Informe a data";
export const MSG_DATA_FUTURA = "Data no futuro";
export const MSG_MOTIVO_PREVISTO = "Escreva o motivo da alteração";
export const MSG_CONTESTACAO = "Escreva a contestação";
export const MSG_MOTIVO = "Escreva o motivo";
export const MSG_PARCELA_RECEBIDA = "Parcela já recebida";
export const MSG_PARCELA_CANCELADA = "Parcela cancelada";
export const MSG_DIFERENCA_RECEBIDA = "Explique a diferença do valor recebido";
export const MSG_PARCELA_EM_ABERTO = "Esta parcela não foi baixada";
export const MSG_PAGAMENTO_PAGO = "Pagamento já baixado";
export const MSG_PAGAMENTO_EM_ABERTO = "Este pagamento não foi baixado";
export const MSG_COMISSAO_REGISTRADA = "Comissão já registrada";
export const MSG_COMISSAO_CANCELADA = "Comissão cancelada";
export const MSG_COMISSAO_EM_ABERTO = "Esta comissão não foi registrada";
export const MSG_SEM_FORNECEDOR = "Conta sem fornecedor: a comissão só pode ser descontada";

const MAX_CENTAVOS = 999_999_999_999n;

/** Dinheiro em formato brasileiro ("1.000,00") → centavos; `null` se vazio, ou a mensagem do erro. */
function lerValor(v: string | null | undefined): bigint | null | string {
  if (!v || !v.trim()) return null;
  let c: bigint;
  try {
    c = lerReais(v);
  } catch {
    return "Valor inválido";
  }
  return c > MAX_CENTAVOS ? "Valor muito alto" : c;
}

export function reais(opcional: true): z.ZodType<bigint | null, string | null | undefined>;
export function reais(opcional: false): z.ZodType<bigint, string | null | undefined>;
export function reais(opcional: boolean): z.ZodType<bigint | null, string | null | undefined> {
  return z
    .string({ error: "Valor inválido" })
    .nullish()
    .transform((v, ctx) => {
      const c = lerValor(v);
      if (typeof c === "string" || (c === null && !opcional)) {
        ctx.addIssue({ code: "custom", message: typeof c === "string" ? c : "Valor inválido" });
        return z.NEVER;
      }
      return c;
    });
}

/** Valor em reais obrigatório ("1.000,00" → centavos). */
export const valorReaisSchema = reais(false);

/** Data de baixa: obrigatória, real e não depois de `hoje` (Cuiabá). */
const dataBaixa = (hoje: string) => data(MSG_DATA).refine((v) => v <= hoje, MSG_DATA_FUTURA);

export function baixaParcelaSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({
    recebidaEm: dataBaixa(hoje),
    valorRecebido: reais(false),
    /** Taxa cobrada de fato (maquininha, boleto); vazia = a prevista. */
    taxaEfetiva: reais(true),
    /** Obrigatória (na action) quando o valor recebido é diferente do valor da parcela. */
    observacao: texto(2000),
  });
}

export function baixaPagamentoSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({
    pagoEm: dataBaixa(hoje),
    /** Na moeda da conta. */
    valorOriginalPago: reais(false),
    /** Obrigatório (na action) se a moeda não é BRL; "6,2000" → "6.2000". */
    cambioEfetivo: z
      .string({ error: "Câmbio inválido" })
      .nullish()
      .transform((v, ctx) => {
        if (!v || !v.trim()) return null;
        try {
          return lerCambio(v);
        } catch {
          ctx.addIssue({ code: "custom", message: "Câmbio inválido" });
          return z.NEVER;
        }
      }),
  });
}

export function comissaoRecebidaSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({ recebidaEm: dataBaixa(hoje), valorRecebido: reais(false) });
}

/** Forma de pagamento ao fornecedor. Parcelas na moeda da conta, somando o previsto (conferido na action). */
export const formaFornecedorSchema = z.discriminatedUnion(
  "tipo",
  [
    z.strictObject({ tipo: z.literal("a_vista"), vencimento: data(MSG_DATA).optional() }),
    z.strictObject({
      tipo: z.literal("parcelado"),
      parcelas: z
        .array(z.strictObject({ vencimento: data(MSG_DATA), valor: reais(false) }), { error: "Informe as parcelas" })
        .min(1, "Informe as parcelas")
        .max(24, "Parcelas demais")
        .transform((ps) => ps.map((p) => ({ vencimento: p.vencimento, valorOriginal: p.valor }))),
    }),
    z.strictObject({ tipo: z.literal("cartao_corporativo"), vencimento: data(MSG_DATA) }),
  ],
  { error: "Forma inválida" },
);

export const comissaoTipoSchema = z.strictObject({
  tipo: z.enum(COMISSAO_TIPOS, { error: "Tipo de comissão inválido" }),
  previstaPara: data(MSG_DATA).nullish().transform((v) => v ?? null),
});

export const motivoPrevistoSchema = obrigatorio(MSG_MOTIVO_PREVISTO, 2000);
export const contestacaoSchema = obrigatorio(MSG_CONTESTACAO, 4000);
export const motivoSchema = obrigatorio(MSG_MOTIVO, 2000);

/** "O valor previsto não pode ser menor que o já pago (R$ 7.520,00)". */
export const msgPrevistoAbaixoDoPago = (pago: string) => `O valor previsto não pode ser menor que o já pago (${pago})`;

/** "Ainda há valores em aberto: a, b, c e mais N" (até 3 nomes). */
export function msgEmAberto(itens: string[]): string {
  const nomes = itens.slice(0, 3).join(", ");
  const resto = itens.length - 3;
  return `${MSG_EM_ABERTO}: ${nomes}${resto > 0 ? ` e mais ${resto}` : ""}`;
}
