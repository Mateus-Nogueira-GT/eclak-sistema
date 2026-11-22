import { z } from "zod";
import { hojeEmCuiaba } from "./clientes";
import { CENTROS, FORMAS_FINANCEIRO, FREQUENCIAS, LADOS, ORIGENS, SITUACOES } from "./financeiro";
import { data, obrigatorio, reais, texto } from "./venda-entrada";

// Entradas das actions do financeiro (Zod). Datas "AAAA-MM-DD", competência "AAAA-MM".

export const MSG_PESSOA = "Escolha só um: fornecedor, cliente ou nome";
export const MSG_VALOR_ZERO = "Informe um valor maior que zero";
export const MSG_FORMA = "Forma de pagamento inválida";
export const MSG_DATA_FUTURA = "A data não pode ser futura";
export const MSG_LINHA_REPETIDA = "Linha repetida no lote";
const MSG_DATA = "Informe a data";
const MSG_COMPETENCIA = "Competência inválida";
const MSG_ID = "Identificador inválido";

const uuid = z.string({ error: MSG_ID }).uuid(MSG_ID);
const uuidOpcional = z
  .string({ error: MSG_ID })
  .uuid(MSG_ID)
  .nullish()
  .transform((v) => v ?? null);

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
  })
  .superRefine((v, ctx) => {
    const preenchidos = [v.fornecedorId, v.clienteId, v.pessoaTexto].filter((x) => x !== null).length;
    if (preenchidos > 1) ctx.addIssue({ code: "custom", message: MSG_PESSOA, path: ["pessoa"] });
  });
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

/** Repasse do cartão direto no fornecedor: o repasse pode ser zero (o fornecedor reteve tudo). */
export function repasseSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({
    data: dataAteHoje(hoje),
    valorRepassado: reais(false),
    contaBancariaId: uuid,
  });
}

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
  situacao: opcional(z.enum(SITUACOES, { error: "Situação inválida" })),
  categoriaId: opcional(uuid),
  grupo: opcional(z.string().trim().min(1).max(80)),
  centro: opcional(centro),
  contaBancariaId: opcional(uuid),
  origem: opcional(z.enum(["viagem", "manual"], { error: "Origem inválida" })),
  busca: opcional(z.string().trim().max(100, "Busca muito longa")),
  pagina: z.number({ error: "Página inválida" }).int("Página inválida").min(1, "Página inválida"),
});
export type FiltroLancamentos = z.infer<typeof filtroLancamentosSchema>;
