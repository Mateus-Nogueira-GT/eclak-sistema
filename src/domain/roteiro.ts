import { z } from "zod";
import { aniversarioNoAno, ultimoSobrenome } from "./clientes";
import type { TipoItem } from "./precificacao";
import { dataBr } from "./tarefas";
import { somarDias } from "./venda";

// ---------- Idiomas e fusos ----------

export const IDIOMAS = ["italiano", "espanhol", "frances", "ingles", "alemao", "portugues"] as const;
export type Idioma = (typeof IDIOMAS)[number];

export const ROTULO_IDIOMA: Record<Idioma, string> = {
  italiano: "Italiano",
  espanhol: "Espanhol",
  frances: "Francês",
  ingles: "Inglês",
  alemao: "Alemão",
  portugues: "Português",
};

export const SAUDACAO: Record<Idioma, string> = {
  italiano: "Buongiorno",
  espanhol: "¡Buenos días",
  frances: "Bonjour",
  ingles: "Good morning",
  alemao: "Guten Morgen",
  portugues: "Bom dia",
};

export function fusoValido(f: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: f });
    return true;
  } catch {
    return false;
  }
}

export const FUSOS_SUGERIDOS: { id: string; rotulo: string }[] = [
  { id: "Europe/Rome", rotulo: "Roma" },
  { id: "Europe/Paris", rotulo: "Paris" },
  { id: "Europe/Madrid", rotulo: "Madri" },
  { id: "Europe/Lisbon", rotulo: "Lisboa" },
  { id: "Europe/Berlin", rotulo: "Berlim" },
  { id: "Europe/London", rotulo: "Londres" },
  { id: "America/New_York", rotulo: "Nova York" },
  { id: "America/Argentina/Buenos_Aires", rotulo: "Buenos Aires" },
  { id: "America/Santiago", rotulo: "Santiago" },
  { id: "America/Sao_Paulo", rotulo: "Brasília" },
];

const semAcento = (t: string) =>
  t
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const SUGESTOES: { termos: string[]; idioma: Idioma; fuso: string }[] = [
  { termos: ["italia"], idioma: "italiano", fuso: "Europe/Rome" },
  { termos: ["franca"], idioma: "frances", fuso: "Europe/Paris" },
  { termos: ["espanha"], idioma: "espanhol", fuso: "Europe/Madrid" },
  { termos: ["portugal"], idioma: "portugues", fuso: "Europe/Lisbon" },
  { termos: ["alemanha"], idioma: "alemao", fuso: "Europe/Berlin" },
  { termos: ["reino unido", "inglaterra", "escocia"], idioma: "ingles", fuso: "Europe/London" },
  { termos: ["estados unidos"], idioma: "ingles", fuso: "America/New_York" },
  { termos: ["argentina"], idioma: "espanhol", fuso: "America/Argentina/Buenos_Aires" },
  { termos: ["chile"], idioma: "espanhol", fuso: "America/Santiago" },
];

export function sugerirIdiomaEFuso(destino: string): { idioma: Idioma; fuso: string } | null {
  const d = semAcento(destino);
  const s = SUGESTOES.find((x) => x.termos.some((t) => d.includes(t)));
  return s ? { idioma: s.idioma, fuso: s.fuso } : null;
}

// ---------- Datas ----------

export function datasDaViagem(inicio: string, fim: string): string[] {
  const datas: string[] = [];
  for (let d = inicio; d <= fim; d = somarDias(d, 1)) datas.push(d);
  return datas;
}

const DIAS_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

export function rotuloDiaRoteiro(data: string): string {
  const [a, m, d] = data.split("-").map(Number);
  const dia = DIAS_SEMANA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  return `${dataBr(data).slice(0, 5)} (${dia})`;
}

// ---------- Conteúdo ----------

export type ItemRoteiro = { hora: string | null; titulo: string; texto: string; mapa: string | null };
export type DiaRoteiro = {
  data: string;
  titulo: string;
  itens: ItemRoteiro[];
  dica: { tema: string; texto: string } | null;
  porque: string | null;
  gastro: string[];
};
export type HotelRoteiro = {
  cidade: string;
  nome: string;
  entrada: string | null;
  saida: string | null;
  horaCheckin: string | null;
  horaCheckout: string | null;
  mapa: string | null;
};
export type VooRoteiro = { data: string | null; voo: string; trecho: string; saida: string | null; chegada: string | null };
export type ConteudoRoteiro = { dias: DiaRoteiro[]; hoteis: HotelRoteiro[]; voos: VooRoteiro[] };

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Hora inválida").nullable();
const mapa = z
  .string()
  .max(500, "Link inválido")
  .regex(/^https:\/\/\S+$/, "Link inválido")
  .nullable();
const data = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida")
  .refine((t) => {
    const d = new Date(`${t}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
  }, "Data inválida");

const itemSchema = z.object({
  hora,
  titulo: z.string().trim().min(1, "Informe o título").max(160, "Título muito longo"),
  texto: z.string().max(2000, "Texto muito longo"),
  mapa,
});

const diaSchema = z.object({
  data,
  titulo: z.string().max(120, "Título muito longo"),
  itens: z.array(itemSchema).max(40, "No máximo 40 itens por dia"),
  dica: z
    .object({ tema: z.string().max(40, "Tema muito longo"), texto: z.string().max(1000, "Texto muito longo") })
    .nullable(),
  porque: z.string().max(1000, "Texto muito longo").nullable(),
  gastro: z.array(z.string().max(200, "Linha muito longa")).max(10, "No máximo 10 linhas"),
});

const hotelSchema = z
  .object({
    cidade: z.string().max(120, "Texto muito longo"),
    nome: z.string().max(200, "Texto muito longo"),
    entrada: data.nullable(),
    saida: data.nullable(),
    horaCheckin: hora,
    horaCheckout: hora,
    mapa,
  })
  .refine((h) => !h.entrada || !h.saida || h.saida >= h.entrada, {
    message: "A saída não pode ser antes da entrada",
    path: ["saida"],
  });

const vooSchema = z.object({
  data: data.nullable(),
  voo: z.string().max(40, "Texto muito longo"),
  trecho: z.string().max(120, "Texto muito longo"),
  saida: hora,
  chegada: hora,
});

export function conteudoRoteiroSchema(inicio: string, fim: string) {
  const esperadas = datasDaViagem(inicio, fim);
  return z
    .object({
      dias: z.array(diaSchema),
      hoteis: z.array(hotelSchema).max(30, "No máximo 30 hotéis"),
      voos: z.array(vooSchema).max(20, "No máximo 20 voos"),
    })
    .refine(
      (c) => c.dias.length === esperadas.length && c.dias.every((d, i) => d.data === esperadas[i]),
      { message: "Os dias do roteiro não batem com as datas da viagem", path: ["dias"] },
    );
}

// ---------- Montagem inicial ----------

type ItemViagem = { tipo: TipoItem; cidade: string | null; servico: string; checkin: string | null; checkout: string | null };

export function hoteisEVoosDosItens(itens: ItemViagem[]): { hoteis: HotelRoteiro[]; voos: VooRoteiro[] } {
  return {
    hoteis: itens
      .filter((i) => i.tipo === "Hotelaria")
      .map((i) => ({
        cidade: i.cidade ?? "",
        nome: i.servico,
        entrada: i.checkin,
        saida: i.checkout,
        horaCheckin: null,
        horaCheckout: null,
        mapa: null,
      })),
    voos: itens
      .filter((i) => i.tipo === "Aéreo")
      .map((i) => ({ data: i.checkin, voo: "", trecho: i.servico, saida: null, chegada: null })),
  };
}

export function roteiroInicial(v: { inicio: string; fim: string; itens: ItemViagem[] }): ConteudoRoteiro {
  return {
    dias: datasDaViagem(v.inicio, v.fim).map((d) => ({ data: d, titulo: "", itens: [], dica: null, porque: null, gastro: [] })),
    ...hoteisEVoosDosItens(v.itens),
  };
}

export function noitesDoHotel(h: HotelRoteiro): string | null {
  if (!h.entrada || !h.saida) return null;
  const n = Math.round((Date.parse(`${h.saida}T12:00:00Z`) - Date.parse(`${h.entrada}T12:00:00Z`)) / 86_400_000);
  return `${n} ${n === 1 ? "noite" : "noites"} · ${dataBr(h.entrada).slice(0, 5)} a ${dataBr(h.saida).slice(0, 5)}`;
}

// ---------- Nome de arquivo ----------

const emMaiusculas = (t: string) => semAcento(t).toUpperCase().trim().split(/\s+/).join("-");

export function nomeArquivo(prefixo: "RT" | "TAREFAS", titular: string, destino: string, inicio: string, fim: string): string {
  return `${prefixo}_${emMaiusculas(ultimoSobrenome(titular))}_${emMaiusculas(destino)}_${inicio.replaceAll("-", "")}-${fim.replaceAll("-", "")}`;
}

// ---------- Aniversários ----------

export type Aniversario = { pessoaId: string; nome: string; data: string; idade: number; diaDaViagem: number; onde: string | null };

export function aniversariosNaViagem(
  pessoas: { id: string; nome: string; nascimento: string | null }[],
  inicio: string,
  fim: string,
  hoteis: HotelRoteiro[],
): Aniversario[] {
  const saida: Aniversario[] = [];
  const anoIni = Number(inicio.slice(0, 4));
  const anoFim = Number(fim.slice(0, 4));
  for (const p of pessoas) {
    if (!p.nascimento) continue;
    for (let ano = anoIni; ano <= anoFim; ano++) {
      const dia = aniversarioNoAno(p.nascimento, ano);
      if (dia < inicio || dia > fim) continue;
      const hotel = hoteis.find((h) => h.entrada && h.saida && h.entrada <= dia && dia < h.saida);
      saida.push({
        pessoaId: p.id,
        nome: p.nome,
        data: dia,
        idade: ano - Number(p.nascimento.slice(0, 4)),
        diaDaViagem: datasDaViagem(inicio, dia).length,
        onde: hotel ? `${hotel.cidade} (${hotel.nome})` : null,
      });
      break;
    }
  }
  return saida;
}

export function textoAniversario(a: Aniversario): string {
  return `${a.nome} faz ${a.idade} anos em ${dataBr(a.data)}, dia ${a.diaDaViagem} da viagem${a.onde ? `, em ${a.onde}` : ""}.`;
}
