import { SAUDACAO, type DiaRoteiro, type HotelRoteiro, type Idioma } from "./roteiro";
import { dataBr } from "./tarefas";
import { somarDias } from "./venda";

// ---------- Texto ----------

export function formatarHora(hhmm: string): string {
  const [h, m] = hhmm.split(":");
  return m === "00" ? `${h}h` : `${h}h${m}`;
}

export function nomesDaSaudacao(nomes: string[], grupo: string): string {
  const primeiros = nomes.map((n) => n.trim().split(/\s+/)[0]).filter(Boolean);
  if (primeiros.length === 0 || primeiros.length > 3) return grupo;
  if (primeiros.length === 1) return primeiros[0];
  return `${primeiros.slice(0, -1).join(", ")} e ${primeiros[primeiros.length - 1]}`;
}

const DIAS_SEMANA = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];

export function diaDaSemana(data: string): string {
  const [a, m, d] = data.split("-").map(Number);
  return DIAS_SEMANA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
}

export function trocaDeHotel(
  hoteis: HotelRoteiro[],
  data: string,
): { sai: HotelRoteiro | null; entra: HotelRoteiro | null; troca: boolean } {
  const sai = hoteis.find((h) => h.saida === data) ?? null;
  const entra = hoteis.find((h) => h.entrada === data) ?? null;
  return { sai, entra, troca: sai !== null && entra !== null };
}

export function linkMapaHotel(h: HotelRoteiro): string {
  return h.mapa ?? `https://maps.google.com/?q=${encodeURIComponent(`${h.nome} ${h.cidade}`)}`;
}

const comPonto = (t: string) => (/[.!?…]$/.test(t) ? t : `${t}.`);

function frase(titulo: string, texto: string): string {
  const partes = [titulo, ...texto.split(" | ")].map((p) => p.trim()).filter(Boolean);
  return partes.map(comPonto).join(" ");
}

export function textoDoDaily(e: {
  data: string;
  idioma: Idioma;
  nomes: string;
  dia: DiaRoteiro;
  hoteis: HotelRoteiro[];
  encerramento: string;
}): string {
  const { sai, entra } = trocaDeHotel(e.hoteis, e.data);
  const blocos: string[] = [
    `${SAUDACAO[e.idioma]}, ${e.nomes}!`,
    `Programação de amanhã, ${diaDaSemana(e.data)}, ${dataBr(e.data).slice(0, 5)}.`,
  ];

  const hotel: string[] = [];
  if (sai) hotel.push(`Check-out: ${sai.nome}${sai.horaCheckout ? `, até as ${formatarHora(sai.horaCheckout)}` : ""}`);
  if (entra) {
    hotel.push(`Check-in: ${entra.nome}${entra.horaCheckin ? `, a partir das ${formatarHora(entra.horaCheckin)}` : ""}`);
    hotel.push(linkMapaHotel(entra));
  }
  if (hotel.length) blocos.push(hotel.join("\n"));

  const comHora = e.dia.itens.filter((i) => i.hora).sort((a, b) => (a.hora as string).localeCompare(b.hora as string));
  const semHora = e.dia.itens.filter((i) => !i.hora);
  for (const i of [...comHora, ...semHora]) {
    const linha = frase(i.titulo, i.texto);
    const corpo = i.hora ? `*${formatarHora(i.hora)}*: ${linha}` : linha;
    blocos.push(i.mapa ? `${corpo}\n${i.mapa}` : corpo);
  }

  blocos.push(e.encerramento);
  return blocos.join("\n\n");
}

// ---------- Padrão do daily ECLAK ----------

export type Indicador = { nome: string; ok: boolean; dica: string };

const GERUNDISMO = /\b(vamos|vai|vou|estaremos|estarei|estar)\s+(estar\s+)?\w+ndo\b/i;
const TROCA_NO_TOPO =
  /Check-out:[^\n]*\n\s*Check-in:[^\n]*\n\s*https?:\/\/\S*(maps\.google|goo\.gl\/maps|maps\.app\.goo\.gl)/i;
const CONTATOS = /\(\d{2}\)\s?\d|\+\d{2}\s?\d|guia:|motorista:|apoio local/i;
const ITEM_COM_HORA = /^\*\d{1,2}h\d{0,2}\*:/;
const PARECE_HORA = /^\*?\d{1,2}h\d{0,2}\*?/;
const COMECA_ASTERISCO_NUMERO = /^\*\d/;

export function conferirDaily(
  texto: string,
  o: { troca: boolean; idioma: Idioma; encerramento: string },
): Indicador[] {
  const t = texto.trim();
  const saudacao = SAUDACAO[o.idioma];
  const gerundio = GERUNDISMO.exec(texto);

  const topo = t.split(/\n(?=\*\d)/)[0];
  const trocaOk = TROCA_NO_TOPO.test(topo);

  const linhas = t.split("\n").map((l) => l.trim());
  const candidatas = linhas.filter((l) => PARECE_HORA.test(l) || COMECA_ASTERISCO_NUMERO.test(l));
  const horarioOk = candidatas.length > 0 && candidatas.every((l) => ITEM_COM_HORA.test(l));

  return [
    {
      nome: "Saudação no idioma do destino",
      ok: t.toLowerCase().startsWith(saudacao.toLowerCase()),
      dica: 'Comece com a saudação do país, como "Buongiorno" na Itália.',
    },
    {
      nome: "Sem gerundismo",
      ok: !gerundio,
      dica: `Troque "${gerundio ? gerundio[0] : "Vamos estar enviando"}" pelo verbo direto, como "enviaremos" ou "aguardamos".`,
    },
    o.troca
      ? {
          nome: "Troca de hotel: check-out e check-in no topo, com o mapa",
          ok: trocaOk,
          dica: 'Abra com "Check-out: [hotel]" e "Check-in: [hotel]", com o link do Google Maps do hotel novo logo abaixo.',
        }
      : { nome: "Sem troca de hotel neste dia", ok: true, dica: "Nada a conferir: não há troca de hotel." },
    {
      nome: "Cada item da programação começa pelo horário",
      ok: horarioOk,
      dica: "Use o formato *06h20*: partida do trem...",
    },
    {
      nome: "Sem contatos de fornecedores",
      ok: !CONTATOS.test(texto),
      dica: "Contatos de guia, apoio local e operadora ficam só na versão interna.",
    },
    {
      nome: "Encerramento padrão da ECLAK",
      ok: t.endsWith(o.encerramento.trim()),
      dica: "Termine com o texto padrão, definido em Parâmetros.",
    },
  ];
}

// ---------- Prazos e estado ----------

export const dataDeGeracao = (data: string) => somarDias(data, -2);
export const dataDeEnvio = (data: string) => somarDias(data, -1);

export const ESTADOS_DAILY = ["pendente", "gerado", "revisado", "enviado"] as const;
export type EstadoDaily = (typeof ESTADOS_DAILY)[number];

export function estadoDoDaily(
  data: string,
  estado: EstadoDaily | null,
  hoje: string,
): { rotulo: string; tom: "cinza" | "ouro" | "agua" | "verde"; noPrazoDeGerar: boolean } {
  const geracao = dataDeGeracao(data);
  const noPrazoDeGerar = hoje >= geracao;
  if (estado === "gerado") return { rotulo: "Gerado, a revisar", tom: "ouro", noPrazoDeGerar };
  if (estado === "revisado") return { rotulo: "Pronto para enviar", tom: "agua", noPrazoDeGerar };
  if (estado === "enviado") return { rotulo: "Enviado", tom: "verde", noPrazoDeGerar };
  if (!noPrazoDeGerar) return { rotulo: `Gera em ${dataBr(geracao).slice(0, 5)}`, tom: "cinza", noPrazoDeGerar };
  return { rotulo: "A gerar", tom: "ouro", noPrazoDeGerar };
}

// ---------- Fusos ----------

function partes(instante: number, fuso: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(instante))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return p;
}

function deslocamento(instante: number, fuso: string): number {
  const p = partes(instante, fuso);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instante / 1000) * 1000;
}

export function converterHorario(data: string, hora: string, de: string, para: string): string {
  const [a, m, d] = data.split("-").map(Number);
  const [h, min] = hora.split(":").map(Number);
  const parede = Date.UTC(a, m - 1, d, h, min);
  let instante = parede;
  for (let i = 0; i < 2; i++) instante = parede - deslocamento(instante, de);
  const p = partes(instante, para);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
