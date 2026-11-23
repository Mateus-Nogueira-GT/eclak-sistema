import { z } from "zod";
import { hojeEmCuiaba } from "./clientes";
import { CENTROS, FORMAS_FINANCEIRO, FREQUENCIAS, LADOS, ORIGENS, SITUACOES } from "./financeiro";
import { contaBancariaId, data, MSG_CARTAO_CORPORATIVO, obrigatorio, reais, texto } from "./venda-entrada";

// Entradas das actions do financeiro (Zod). Datas "AAAA-MM-DD", competência "AAAA-MM".

export const MSG_PESSOA = "Escolha só um: fornecedor, cliente ou nome";
export const MSG_VALOR_ZERO = "Informe um valor maior que zero";
export const MSG_FORMA = "Forma de pagamento inválida";
export const MSG_DATA_FUTURA = "A data não pode ser futura";
export const MSG_LINHA_REPETIDA = "Linha repetida no lote";
/** Até a baixa da fatura do cartão existir (Task 7), a linha da fatura não tem baixa pela lista. */
export const MSG_BAIXA_FATURA_CARTAO = "Dê baixa na fatura do cartão pela tela de cartões";
export const MSG_LOTE_RECUSADO = "Tire do lote as linhas indicadas: elas pedem baixa individual";
export const MSG_LOTE_LADOS = "Escolha linhas de um lado só (a pagar ou a receber)";
const MSG_DATA = "Informe a data";
const MSG_COMPETENCIA = "Competência inválida";
const MSG_ID = "Identificador inválido";
const MSG_FINAL = "Informe os 4 últimos dígitos do cartão";

const uuid = z.string({ error: MSG_ID }).uuid(MSG_ID);
/** Select vazio de formulário chega como "" e vale null. */
const uuidOpcional = z.preprocess(
  (v) => (v === "" ? null : v),
  z
    .string({ error: MSG_ID })
    .uuid(MSG_ID)
    .nullish()
    .transform((v) => v ?? null),
);

/** Valor em reais maior que zero. */
const positivo = reais(false).refine((v) => v > 0n, MSG_VALOR_ZERO);
/** Valor em reais opcional, vazio = 0 (nunca negativo: o parser recusa "-"). */
const zeroSeVazio = reais(true).transform((v) => v ?? 0n);

const dataAteHoje = (hoje: string) => data(MSG_DATA).refine((v) => v <= hoje, MSG_DATA_FUTURA);

const competencia = z
  .string({ error: MSG_COMPETENCIA })
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, MSG_COMPETENCIA);

const lado = z.enum(LADOS, { error: "Lado inválido" });
const centro = z.enum(CENTROS, { error: "Centro de custo inválido" });
const origem = z.enum(ORIGENS, { error: "Origem inválida" });

const repeticao = z.discriminatedUnion(
  "tipo",
  [
    z.strictObject({ tipo: z.literal("unica") }),
    z.strictObject({
      tipo: z.literal("parcelado"),
      parcelas: z.number({ error: "Parcelas inválidas" }).int("Parcelas inválidas").min(2, "Mínimo de 2 parcelas").max(60, "Máximo de 60 parcelas"),
    }),
    z.strictObject({
      tipo: z.literal("recorrente"),
      frequencia: z.enum(FREQUENCIAS, { error: "Frequência inválida" }),
      quantidade: z.number({ error: "Quantidade inválida" }).int("Quantidade inválida").min(2, "Mínimo de 2 repetições").max(60, "Máximo de 60 repetições"),
    }),
  ],
  { error: "Repetição inválida" },
);

/** Lançamento a pagar no cartão de crédito: compra no cartão corporativo (vai para a fatura do ciclo). */
const ehCompraNoCartao = (v: { lado: string; forma: string }) => v.lado === "pagar" && v.forma === "Cartão de crédito";

export const lancamentoSchema = z
  .strictObject({
    lado,
    descricao: obrigatorio("Informe a descrição", 200),
    fornecedorId: uuidOpcional,
    clienteId: uuidOpcional,
    pessoaTexto: texto(200),
    categoriaId: uuid,
    centro,
    competencia,
    emissao: data(MSG_DATA),
    vencimento: data(MSG_DATA),
    valor: positivo,
    forma: z.enum(FORMAS_FINANCEIRO, { error: MSG_FORMA }),
    contaBancariaId: uuidOpcional,
    observacao: texto(2000),
    repeticao,
    /** Cartão corporativo da compra: só a pagar no cartão de crédito (obrigatório aí); nas outras, vale null. */
    cartaoId: uuidOpcional,
  })
  .superRefine((v, ctx) => {
    const preenchidos = [v.fornecedorId, v.clienteId, v.pessoaTexto].filter((x) => x !== null).length;
    if (preenchidos > 1) ctx.addIssue({ code: "custom", message: MSG_PESSOA, path: ["pessoa"] });
    if (ehCompraNoCartao(v) && !v.cartaoId) ctx.addIssue({ code: "custom", message: MSG_CARTAO_CORPORATIVO, path: ["cartaoId"] });
  })
  .transform((v) => (ehCompraNoCartao(v) ? v : { ...v, cartaoId: null }));
export type LancamentoEntrada = z.infer<typeof lancamentoSchema>;

/** Baixa individual: a diferença entre `valorPago` e `valor + juros − desconto` é conferida na action. */
export function baixaLancamentoSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({
    data: dataAteHoje(hoje),
    valorPago: positivo,
    juros: zeroSeVazio,
    desconto: zeroSeVazio,
    contaBancariaId: uuid,
    observacao: texto(2000),
  });
}

/** Lote: 1 a 200 linhas (origem + id), sem repetidas; recusado inteiro na action se qualquer uma falhar. */
export function loteSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({
    itens: z
      .array(z.strictObject({ origem, id: uuid }), { error: "Escolha as linhas do lote" })
      .min(1, "Escolha ao menos uma linha")
      .max(200, "No máximo 200 linhas por lote")
      .refine((is) => new Set(is.map((i) => `${i.origem}:${i.id}`)).size === is.length, MSG_LINHA_REPETIDA),
    data: dataAteHoje(hoje),
    contaBancariaId: uuid,
  });
}

/** A linha da view, no que o lote confere. */
export type LinhaDoLote = {
  origem: (typeof ORIGENS)[number];
  statusBase: "em_aberto" | "baixado" | "cancelado";
  exigeIndividual: boolean;
  repasse: boolean;
  transitaCaixa: boolean;
};

/**
 * Por que a linha não entra no lote (baixa pelo valor previsto, com data e conta do lote), ou `null` se entra.
 * Ordem: estado da linha, depois o dado individual que ela exige.
 */
export function motivoForaDoLote(l: LinhaDoLote): string | null {
  if (l.statusBase === "baixado") return "Já baixada";
  if (l.statusBase === "cancelado") return "Cancelada";
  if (l.origem === "fatura_cartao") return MSG_BAIXA_FATURA_CARTAO;
  if (l.repasse) return l.exigeIndividual ? "Repasse sem fornecedor do cartão: escolha o fornecedor na viagem" : "Repasse do cartão direto no fornecedor: dê baixa individual";
  if (!l.transitaCaixa) return "Não passa pelo caixa: pago pelo cliente no cartão do fornecedor";
  if (l.exigeIndividual) return "Pagamento em moeda estrangeira: dê baixa individual com o câmbio efetivo";
  return null;
}

/** Repasse do cartão direto no fornecedor: o repasse pode ser zero (o fornecedor reteve tudo). */
export function repasseSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({
    data: dataAteHoje(hoje),
    valorRepassado: reais(false),
    contaBancariaId,
  });
}

export type RepasseValidado = z.output<ReturnType<typeof repasseSchema>>;

export const categoriaSchema = z.strictObject({
  lado,
  grupo: obrigatorio("Informe o grupo", 80),
  nome: obrigatorio("Informe o nome", 80),
});

/** Saldo inicial em reais, aceita sinal ("-1.234,56"). */
const reaisComSinal = z
  .string({ error: "Valor inválido" })
  .transform((v, ctx) => {
    const t = v.trim();
    const negativo = t.startsWith("-");
    const r = reais(false).safeParse(negativo ? t.slice(1).trim() : t);
    if (!r.success) {
      ctx.addIssue({ code: "custom", message: r.error.issues[0]?.message ?? "Valor inválido" });
      return z.NEVER;
    }
    return negativo ? -r.data : r.data;
  });

export const contaBancariaSchema = z.strictObject({
  nome: obrigatorio("Informe o nome", 80),
  banco: texto(80),
  saldoInicial: reaisComSinal,
  saldoInicialEm: data(MSG_DATA),
});

const opcional = <T extends z.ZodType>(s: T) => s.optional();

export const filtroLancamentosSchema = z.strictObject({
  lado: z.enum(["pagar", "receber", "todos"], { error: "Lado inválido" }),
  de: data(MSG_DATA),
  ate: data(MSG_DATA),
  base: z.enum(["vencimento", "competencia", "baixa"], { error: "Base inválida" }),
  /** As situações derivadas e "em_aberto" (vencidas, de hoje e a vencer). */
  situacao: opcional(z.enum([...SITUACOES, "em_aberto"], { error: "Situação inválida" })),
  categoriaId: opcional(uuid),
  grupo: opcional(z.string().trim().min(1).max(80)),
  centro: opcional(centro),
  contaBancariaId: opcional(uuid),
  origem: opcional(z.enum(["viagem", "manual"], { error: "Origem inválida" })),
  busca: opcional(z.string().trim().max(100, "Busca muito longa")),
  pagina: z.number({ error: "Página inválida" }).int("Página inválida").min(1, "Página inválida"),
});
export type FiltroLancamentos = z.infer<typeof filtroLancamentosSchema>;

/** Último dia do mês de "AAAA-MM-DD". */
function fimDoMes(data: string): string {
  const [a, m] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

/**
 * Filtro da lista a partir dos parâmetros da URL: vazios, desconhecidos e inválidos são descartados (cada um vale
 * o padrão); padrão = A pagar, por vencimento, no mês de `hoje`, página 1. Repetido na URL vale o primeiro.
 */
export function filtroDaUrl(params: Record<string, string | string[] | undefined>, hoje: string): FiltroLancamentos {
  const forma = filtroLancamentosSchema.shape;
  const filtro: Record<string, unknown> = { lado: "pagar", base: "vencimento", de: `${hoje.slice(0, 8)}01`, ate: fimDoMes(hoje), pagina: 1 };
  for (const [k, bruto] of Object.entries(params)) {
    if (!Object.hasOwn(forma, k)) continue;
    const texto = (Array.isArray(bruto) ? bruto[0] : bruto)?.trim();
    if (!texto) continue;
    const valor = k === "pagina" ? Number(texto) : texto;
    const r = forma[k as keyof typeof forma].safeParse(valor);
    if (r.success && r.data !== undefined) filtro[k] = r.data;
  }
  return filtroLancamentosSchema.parse(filtro);
}

const MSG_DIA = "Escolha um dia de 1 a 28";
const dia = z.preprocess(
  (v) => (typeof v === "string" ? (/^\s*\d+\s*$/.test(v) ? Number(v) : NaN) : v),
  z.number({ error: MSG_DIA }).int(MSG_DIA).min(1, MSG_DIA).max(28, MSG_DIA),
);

/** Cadastro do cartão corporativo: dias de fechamento e de vencimento de 1 a 28 (todo mês tem). */
export const cartaoSchema = z.strictObject({
  nome: obrigatorio("Informe o nome do cartão", 100),
  final: z.string({ error: MSG_FINAL }).trim().regex(/^\d{4}$/, MSG_FINAL),
  diaFechamento: dia,
  diaVencimento: dia,
  contaBancariaId,
  centro,
});
export type CartaoValidado = z.output<typeof cartaoSchema>;
