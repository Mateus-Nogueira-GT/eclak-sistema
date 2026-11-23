import { z } from "zod";
import { formatarCambio, lerCambio } from "./cambio";
import { formatarPercentual, formatarReais } from "./dinheiro";

// Formato canônico no JSON:
//  - dinheiro: string de centavos inteiros ("2072593" = R$ 20.725,93), até ~R$ 10 bilhões;
//  - percentual: string decimal com 3 casas, como `lerPercentual` devolve ("19.000"), de 0 a 999.999;
//  - contagens: inteiros.
const MAX_CENTAVOS = 999_999_999_999n;

const centavos = z
  .string({ error: "Valor inválido" })
  .regex(/^\d{1,13}$/, "Valor inválido")
  .refine((s) => BigInt(s) <= MAX_CENTAVOS, "Valor muito alto");

const pct = z.string({ error: "Valor inválido" }).regex(/^\d{1,3}\.\d{3}$/, "Valor inválido");

const contagem = z
  .number({ error: "Valor inválido" })
  .int("Informe um número inteiro")
  .min(1, "Informe um número inteiro maior que zero")
  .max(1000, "Valor muito alto");

export const METODOS_RATEIO = ["por_dia", "por_faturamento", "por_viagem"] as const;
export const ROTULO_METODO: Record<(typeof METODOS_RATEIO)[number], string> = {
  por_dia: "Por dias de viagem",
  por_faturamento: "Por faturamento",
  por_viagem: "Valor fixo por viagem",
};

const comercial = z.string({ error: "Câmbio inválido" }).refine((t) => {
  try {
    return lerCambio(t) === t;
  } catch {
    return false;
  }
}, "Câmbio inválido");

const dataCambio = z
  .string({ error: "Data inválida" })
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida")
  .refine((t) => {
    const d = new Date(`${t}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
  }, "Data inválida");

const cotacao = z.object({ comercial, data: dataCambio });

export const MOEDAS_ESTRANGEIRAS = ["USD", "EUR", "GBP", "CHF"] as const;

export const ENCERRAMENTO_INICIAL =
  "Qualquer dúvida, nosso customer care está à disposição no WhatsApp. Aproveitem o dia!\nEquipe ECLAK Viagens";

export const RegrasSchema = z.object({
  impostoSobreMargemPct: pct,
  margemAlvoPct: pct,
  margemReferenciaPct: pct,
  ganhoMinimoHotelPct: pct,
  limiteDiariaSemReajuste: centavos,
  markupTremPct: pct,
  markupServicos: z.object({ ate: centavos, pctAte: pct, pctAcima: pct }),
  taxaRoteiro: z.object({ valor: centavos, minimoItens: contagem }),
  taxaServicoPorDia: centavos,
  custoFixoMensal: centavos,
  rateio: z.object({
    metodo: z.enum(METODOS_RATEIO, { error: "Forma de rateio inválida" }),
    diasViagemMes: contagem,
    pctFaturamento: pct,
    viagensMes: contagem,
  }),
  travaCotacaoForaDaCurvaPct: pct,
  reservaCaixaMeses: contagem,
  horizonteProjecaoMeses: contagem,
  parcelamentoMaximo: z
    .number({ error: "Valor inválido" })
    .int("Informe um número inteiro")
    .min(1, "Informe de 1 a 10")
    .max(10, "Informe de 1 a 10"),
  cotacoesParaSugestao: contagem,
  acrescimoCambioPct: pct,
  cambio: z.object({ USD: cotacao, EUR: cotacao, GBP: cotacao, CHF: cotacao }),
  encerramentoDaily: z
    .string({ error: "Informe o texto de encerramento" })
    .trim()
    .min(1, "Informe o texto de encerramento")
    .max(1000, "Texto muito longo")
    .default(ENCERRAMENTO_INICIAL),
  taxas: z.object({
    pix: pct,
    cartaoDiretoFornecedor: pct,
    boletoPorBoleto: centavos,
    credito1x: pct,
    credito2a6x: pct,
    credito7a10x: pct,
    antecipacao1Parcela: pct,
    antecipacao10Parcelas: pct,
  }),
});

export type Regras = z.output<typeof RegrasSchema>;

export const REGRAS_INICIAIS: Regras = {
  impostoSobreMargemPct: "7.000",
  margemAlvoPct: "19.000",
  margemReferenciaPct: "19.000",
  ganhoMinimoHotelPct: "12.000",
  limiteDiariaSemReajuste: "350000",
  markupTremPct: "40.000",
  markupServicos: { ate: "500000", pctAte: "30.000", pctAcima: "20.000" },
  taxaRoteiro: { valor: "25000", minimoItens: 6 },
  taxaServicoPorDia: "15000",
  custoFixoMensal: "2072593",
  rateio: { metodo: "por_dia", diasViagemMes: 90, pctFaturamento: "7.400", viagensMes: 12 },
  travaCotacaoForaDaCurvaPct: "20.000",
  reservaCaixaMeses: 6,
  horizonteProjecaoMeses: 12,
  parcelamentoMaximo: 10,
  cotacoesParaSugestao: 3,
  acrescimoCambioPct: "4.500",
  cambio: {
    USD: { comercial: "5.4210", data: "2026-11-06" },
    EUR: { comercial: "5.8930", data: "2026-11-06" },
    GBP: { comercial: "6.9120", data: "2026-11-06" },
    CHF: { comercial: "6.1040", data: "2026-11-06" },
  },
  encerramentoDaily: ENCERRAMENTO_INICIAL,
  taxas: {
    pix: "0.000",
    cartaoDiretoFornecedor: "0.000",
    boletoPorBoleto: "250",
    credito1x: "2.190",
    credito2a6x: "3.470",
    credito7a10x: "2.890",
    antecipacao1Parcela: "2.450",
    antecipacao10Parcelas: "5.720",
  },
};

export type TipoCampo = "reais" | "pct" | "inteiro" | "metodo" | "cambio" | "data" | "texto";
export type GrupoCampo = "regras" | "taxas" | "cambio" | "moedas" | "operacao";

export type CampoRegra = {
  caminho: string;
  rotulo: string;
  tipo: TipoCampo;
  grupo: GrupoCampo;
  onde: string;
  obs: string;
};

const c = (
  caminho: string,
  rotulo: string,
  tipo: TipoCampo,
  grupo: GrupoCampo,
  onde: string,
  obs: string,
): CampoRegra => ({ caminho, rotulo, tipo, grupo, onde, obs });

/** Campos de Regras na ordem da tela; também dá os rótulos do histórico. */
export const CAMPOS: CampoRegra[] = [
  c("impostoSobreMargemPct", "Imposto sobre a margem", "pct", "regras", "Todas as margens", "Incide só sobre a margem (preço menos custo)."),
  c("margemAlvoPct", "Margem líquida alvo da viagem", "pct", "regras", "Simulador, compensação", "Ponto de equilíbrio do terrestre com o custo fixo atual."),
  c("margemReferenciaPct", "Margem de referência", "pct", "regras", "Aprovações", "Só indicador visual: mostra se a viagem está acima ou abaixo. Não bloqueia nada."),
  c("ganhoMinimoHotelPct", "Ganho mínimo por hotel", "pct", "regras", "Vendas", "Comissão mais over, medido sobre o preço do item."),
  c("limiteDiariaSemReajuste", "Limite de diária sem reajuste", "reais", "regras", "Vendas", "Acima disso, o hotel fica na tarifa do fornecedor."),
  c("markupTremPct", "Markup de trem", "pct", "regras", "Vendas", "Sobre o valor do fornecedor."),
  c("markupServicos.ate", "Markup de demais serviços: limite", "reais", "regras", "Vendas", "Valor do fornecedor até o qual vale o markup maior."),
  c("markupServicos.pctAte", "Markup de demais serviços: até o limite", "pct", "regras", "Vendas", "Sobre o valor do fornecedor."),
  c("markupServicos.pctAcima", "Markup de demais serviços: acima do limite", "pct", "regras", "Vendas", "Sobre o valor do fornecedor."),
  c("taxaRoteiro.valor", "Taxa de roteiro", "reais", "regras", "Vendas", "Sem margem."),
  c("taxaRoteiro.minimoItens", "Taxa de roteiro: mínimo de itens", "inteiro", "regras", "Vendas", "Cobrada quando a viagem tem pelo menos este número de itens (6 = mais de 5)."),
  c("taxaServicoPorDia", "Taxa de serviço", "reais", "regras", "Simulador", "Por dia de viagem. Fora do cálculo de margem."),
  c("custoFixoMensal", "Custo fixo mensal", "reais", "regras", "Aprovações, caixa", "Média do histórico (jan a nov/2026), sem faturas de cartão. Recalculada todo mês."),
  c("rateio.metodo", "Rateio do custo fixo na viagem", "metodo", "regras", "Aprovações", "Forma a definir com a gestão: por dias, por faturamento ou valor fixo por viagem."),
  c("rateio.diasViagemMes", "Rateio: dias de viagem por mês", "inteiro", "regras", "Aprovações", "Usado no rateio por dias de viagem."),
  c("rateio.pctFaturamento", "Rateio: percentual do faturamento", "pct", "regras", "Aprovações", "Usado no rateio por faturamento."),
  c("rateio.viagensMes", "Rateio: viagens por mês", "inteiro", "regras", "Aprovações", "Usado no rateio por valor fixo por viagem."),
  c("travaCotacaoForaDaCurvaPct", "Trava de cotação fora da curva", "pct", "regras", "Comparação", "Acima da média do grupo."),
  c("reservaCaixaMeses", "Meta de reserva de caixa (meses)", "inteiro", "regras", "Fluxo de caixa", "Meses de custo fixo médio mensal."),
  c("horizonteProjecaoMeses", "Horizonte da projeção de caixa (meses)", "inteiro", "regras", "Fluxo de caixa", "Mínimo definido pela gestão."),
  c("parcelamentoMaximo", "Parcelamento máximo", "inteiro", "regras", "Precificação, faturas", "Não há parcelamento acima de 10x."),
  c("cotacoesParaSugestao", "Sugestão de custo de serviço (cotações)", "inteiro", "regras", "Precificação", "A partir desta cotação do mesmo serviço, o sistema sugere a média."),
  c("taxas.pix", "Taxa de Pix", "pct", "taxas", "", "Sem taxa."),
  c("taxas.boletoPorBoleto", "Taxa de boleto (por boleto)", "reais", "taxas", "", "Por boleto baixado."),
  c("taxas.cartaoDiretoFornecedor", "Taxa de cartão: direto no fornecedor", "pct", "taxas", "", ""),
  c("taxas.credito1x", "Taxa de cartão: crédito 1x", "pct", "taxas", "", "Cielo, link de pagamento."),
  c("taxas.credito2a6x", "Taxa de cartão: crédito 2x a 6x", "pct", "taxas", "", "Taxa de referência do preço."),
  c("taxas.credito7a10x", "Taxa de cartão: crédito 7x a 10x", "pct", "taxas", "", "A confirmar com a Cielo."),
  c("taxas.antecipacao1Parcela", "Antecipação: 1 parcela", "pct", "taxas", "", "Somada à taxa de cartão."),
  c("taxas.antecipacao10Parcelas", "Antecipação: 10 parcelas", "pct", "taxas", "", "Intermediárias por interpolação."),
  c("acrescimoCambioPct", "Acréscimo sobre o câmbio comercial", "pct", "cambio", "", "Regra: câmbio comercial mais este acréscimo."),
  c("encerramentoDaily", "Encerramento do daily", "texto", "operacao", "Dailies", "Última parte de toda mensagem diária ao cliente."),
  ...MOEDAS_ESTRANGEIRAS.flatMap((m) => [
    c(`cambio.${m}.comercial`, `Câmbio ${m}`, "cambio", "moedas", "", "Câmbio comercial, 4 casas."),
    c(`cambio.${m}.data`, `Câmbio ${m} (data)`, "data", "moedas", "", "Data da cotação."),
  ]),
];

/** Lê valores gravados em qualquer versão: o que não existia (câmbio) recebe os valores iniciais. */
export function normalizarRegras(valores: unknown): Regras {
  const base = (valores && typeof valores === "object" ? valores : {}) as Record<string, unknown>;
  return RegrasSchema.parse(base.cambio === undefined ? { ...base, cambio: REGRAS_INICIAIS.cambio } : base);
}

export function valorNoCaminho(valores: Regras, caminho: string): unknown {
  let atual: unknown = valores;
  for (const parte of caminho.split(".")) {
    atual = (atual as Record<string, unknown> | undefined)?.[parte];
  }
  return atual;
}

/** Texto brasileiro para exibir um valor ("R$ 2,50", "19%", "2,19%", "6"). */
export function formatarValor(tipo: TipoCampo, valor: unknown): string {
  if (valor === undefined || valor === null) return "";
  switch (tipo) {
    case "reais":
      return formatarReais(BigInt(String(valor)));
    case "pct":
      return formatarPercentual(String(valor));
    case "cambio":
      return formatarCambio(String(valor));
    case "data":
      return String(valor).split("-").reverse().join("/");
    case "texto":
      return String(valor);
    case "metodo":
      return ROTULO_METODO[valor as keyof typeof ROTULO_METODO] ?? String(valor);
    default:
      return String(valor);
  }
}

export type DiferencaRegra = { campo: string; antes: string; depois: string };

/** Diferenças campo a campo, na ordem da tela, comparando o valor bruto. */
export function diferencasRegras(antes: Regras, depois: Regras): DiferencaRegra[] {
  const saida: DiferencaRegra[] = [];
  for (const campo of CAMPOS) {
    const a = valorNoCaminho(antes, campo.caminho);
    const d = valorNoCaminho(depois, campo.caminho);
    if (a === d) continue;
    saida.push({
      campo: campo.rotulo,
      antes: formatarValor(campo.tipo, a),
      depois: formatarValor(campo.tipo, d),
    });
  }
  return saida;
}
