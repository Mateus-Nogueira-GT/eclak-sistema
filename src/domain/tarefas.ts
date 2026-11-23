import { z } from "zod";
import { dataReal } from "./clientes-entrada";
import { somarDias } from "./venda";

export const CATEGORIAS_TAREFA = [
  "ingressos",
  "transfers_passeios",
  "restaurantes",
  "hoteis_carro_voos",
  "conferir",
  "envio",
] as const;
export type CategoriaTarefa = (typeof CATEGORIAS_TAREFA)[number];

export const ROTULO_CATEGORIA: Record<CategoriaTarefa, string> = {
  ingressos: "Emitir ingressos e bilhetes com horário",
  transfers_passeios: "Transfers e passeios",
  restaurantes: "Reservar restaurantes (cortesia do concierge)",
  hoteis_carro_voos: "Hotéis, carro e voos",
  conferir: "Conferir",
  envio: "Envio e acompanhamento",
};

// ---------- Prazo ----------

export type Prazo = { tipo: "data"; data: string } | { tipo: "dias_antes"; dias: number };

/** Data efetiva do prazo (calculada, nunca gravada); null = sem prazo. */
export function prazoEfetivo(prazo: Prazo | null, inicio: string): string | null {
  if (!prazo) return null;
  return prazo.tipo === "data" ? prazo.data : somarDias(inicio, -prazo.dias);
}

const dataBr = (iso: string) => iso.split("-").reverse().join("/");

export function rotuloPrazo(prazo: Prazo | null, inicio: string): string {
  const efetivo = prazoEfetivo(prazo, inicio);
  if (!prazo || !efetivo) return "Sem prazo";
  if (prazo.tipo === "data") return `Até ${dataBr(efetivo)}`;
  return `${prazo.dias} ${prazo.dias === 1 ? "dia" : "dias"} antes (${dataBr(efetivo)})`;
}

// ---------- Situação ----------

export const SITUACOES_TAREFA = ["concluida", "vencida", "vence_hoje", "no_prazo", "sem_prazo"] as const;
export type SituacaoTarefa = (typeof SITUACOES_TAREFA)[number];

export const ROTULO_SITUACAO_TAREFA: Record<SituacaoTarefa, string> = {
  concluida: "Concluída",
  vencida: "Vencida",
  vence_hoje: "Vence hoje",
  no_prazo: "No prazo",
  sem_prazo: "Sem prazo",
};

export function situacaoTarefa(t: { prazoEfetivo: string | null; concluida: boolean }, hoje: string): SituacaoTarefa {
  if (t.concluida) return "concluida";
  if (t.prazoEfetivo === null) return "sem_prazo";
  if (t.prazoEfetivo < hoje) return "vencida";
  if (t.prazoEfetivo === hoje) return "vence_hoje";
  return "no_prazo";
}

// ---------- Tarefas automáticas ----------

export type TarefaAutomatica = {
  chave: string;
  categoria: CategoriaTarefa;
  item: string;
  fazer: string;
  prazo: Prazo | null;
};

const DA_VENDA: { chave: string; categoria: CategoriaTarefa; item: string; dias: number }[] = [
  { chave: "venda.whatsapp", categoria: "envio", item: "Criar grupo no WhatsApp", dias: 1 },
  { chave: "venda.fatura", categoria: "conferir", item: "Encaminhar informações para emissão da fatura", dias: 2 },
  { chave: "venda.comparativo", categoria: "conferir", item: "Fazer comparativo de valores de fornecedores", dias: 7 },
  { chave: "venda.reservas", categoria: "hoteis_carro_voos", item: "Realizar reserva da hotelaria e do transfer", dias: 7 },
  { chave: "venda.drive", categoria: "envio", item: "Abrir pasta no Google Drive", dias: 1 },
];

/** As 5 tarefas da venda: prazo fixo `venda + N dias`, nunca depois do início da viagem. */
export function tarefasDaVenda(diaDaVenda: string, inicio: string): TarefaAutomatica[] {
  return DA_VENDA.map((t) => {
    const alvo = somarDias(diaDaVenda, t.dias);
    return {
      chave: t.chave,
      categoria: t.categoria,
      item: t.item,
      fazer: "",
      prazo: { tipo: "data", data: alvo > inicio ? inicio : alvo },
    };
  });
}

/** As 3 tarefas nascidas da aprovação do roteiro (prazo relativo ao embarque). */
export function tarefasDoRoteiro(): TarefaAutomatica[] {
  return [
    { chave: "roteiro.passeios", categoria: "transfers_passeios", item: "Reserva de passeios", fazer: "", prazo: { tipo: "dias_antes", dias: 60 } },
    { chave: "roteiro.ingressos", categoria: "ingressos", item: "Compra de ingressos", fazer: "", prazo: { tipo: "dias_antes", dias: 60 } },
    { chave: "roteiro.trem", categoria: "ingressos", item: "Compra de trem", fazer: "", prazo: { tipo: "dias_antes", dias: 90 } },
  ];
}

// ---------- Ordenação ----------

/** Categoria; depois "Geral" (dia null) primeiro; depois dia; depois ordem. */
export function ordenarTarefas<T extends { categoria: CategoriaTarefa; dia: string | null; ordem: number }>(ts: T[]): T[] {
  return [...ts].sort((a, b) => {
    const c = CATEGORIAS_TAREFA.indexOf(a.categoria) - CATEGORIAS_TAREFA.indexOf(b.categoria);
    if (c !== 0) return c;
    if (a.dia !== b.dia) {
      if (a.dia === null) return -1;
      if (b.dia === null) return 1;
      return a.dia < b.dia ? -1 : 1;
    }
    return a.ordem - b.ordem;
  });
}

// ---------- Entrada ----------

const MSG_DIAS = "Informe de 0 a 365 dias";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const data = z.string({ error: "Data inválida" }).trim().refine(dataReal, "Data inválida");

const opcional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "Texto muito longo")
    .nullish()
    .transform((v) => (v ? v : null));

export const tarefaSchema = z.object({
  categoria: z.enum(CATEGORIAS_TAREFA, { error: "Escolha a categoria" }),
  dia: data.nullish().transform((v) => v ?? null),
  item: z.string({ error: "Informe o item" }).trim().min(1, "Informe o item").max(200, "Texto muito longo"),
  fazer: z
    .string()
    .trim()
    .max(2000, "Texto muito longo")
    .nullish()
    .transform((v) => v ?? ""),
  prazo: z
    .discriminatedUnion("tipo", [
      z.object({ tipo: z.literal("data"), data }),
      z.object({
        tipo: z.literal("dias_antes"),
        dias: z.number({ error: MSG_DIAS }).int(MSG_DIAS).min(0, MSG_DIAS).max(365, MSG_DIAS),
      }),
    ])
    .nullish()
    .transform((v) => v ?? null),
  responsavel: z
    .discriminatedUnion("tipo", [
      z.object({ tipo: z.literal("usuario"), id: z.string({ error: "Responsável inválido" }).regex(UUID, "Responsável inválido") }),
      z.object({ tipo: z.literal("customer_care") }),
    ])
    .nullish()
    .transform((v) => v ?? null),
  observacao: opcional(2000),
});

export type TarefaEntrada = z.input<typeof tarefaSchema>;
