/**
 * Operação do seed local: as 5 tarefas da venda em toda viagem vendida (mesma lista de `tarefasDaVenda`, com a mesma
 * `chave` e o mesmo ON CONFLICT do app); na Família Ribeiro, tarefas manuais do protótipo (algumas concluídas, uma
 * vencida, uma de Customer care), o roteiro aprovado (Florença e Veneza preenchidos, 2 hotéis com troca, voo), as 3
 * tarefas do roteiro, dois dailies (um "Pronto para enviar" e um "Gerado, a revisar") e um aniversário dentro da viagem.
 * Idempotente: tarefas automáticas por (viagem, chave), manuais por viagem + item, roteiro por viagem, daily por roteiro + data.
 * Sem imports de servidor: usa só o domínio e SQL.
 */
import { hojeEmCuiaba } from "../src/domain/clientes";
import { ENCERRAMENTO_INICIAL } from "../src/domain/regras";
import { nomesDaSaudacao, textoDoDaily } from "../src/domain/daily";
import {
  aniversariosNaViagem,
  datasDaViagem,
  type ConteudoRoteiro,
  type DiaRoteiro,
  type HotelRoteiro,
} from "../src/domain/roteiro";
import { tarefasDaVenda, tarefasDoRoteiro, type CategoriaTarefa, type TarefaAutomatica } from "../src/domain/tarefas";
import { somarDias } from "../src/domain/venda";
import type { Sql } from "./seed-orcamentos";

type Viagem = { id: string; inicio: string; fim: string; consultorId: string; grupo: string; titular: string; aceite: string };

async function inserirAutomaticas(sql: Sql, viagem: Viagem, lista: TarefaAutomatica[], origem: "venda" | "roteiro", autor: string) {
  let n = 0;
  for (const t of lista) {
    const [max] = await sql`select coalesce(max(ordem), 0)::int as n from tarefas where viagem_id = ${viagem.id}`;
    const r = await sql`
      insert into tarefas (viagem_id, categoria, item, fazer, prazo_tipo, prazo_data, prazo_dias, responsavel_id, ordem, origem, chave, criado_por)
      values (${viagem.id}, ${t.categoria}, ${t.item}, ${t.fazer}, ${t.prazo?.tipo ?? null},
              ${t.prazo?.tipo === "data" ? t.prazo.data : null}, ${t.prazo?.tipo === "dias_antes" ? t.prazo.dias : null},
              ${viagem.consultorId}, ${max.n + 1}, ${origem}, ${t.chave}, ${autor})
      on conflict (viagem_id, chave) where chave is not null do nothing
      returning id`;
    n += r.length;
  }
  return n;
}

type Manual = {
  categoria: CategoriaTarefa;
  item: string;
  fazer: string;
  dia: number | null; // dia da viagem (0 = início), ou nulo para "Geral"
  prazo: { dias: number } | { dataRel: number } | null; // dias antes do início, ou relativo a hoje
  quem: "consultor" | "operacional";
  care?: boolean;
  concluida?: boolean;
};

const MANUAIS: Manual[] = [
  { categoria: "ingressos", item: "Trem Veneza > Florença", fazer: "Italo, 2ª classe, assentos juntos", dia: 11, prazo: { dias: 60 }, quem: "operacional", concluida: true },
  { categoria: "ingressos", item: "Galleria degli Uffizi", fazer: "Entrada com horário às 9h30", dia: 9, prazo: { dias: 45 }, quem: "operacional", concluida: true },
  { categoria: "ingressos", item: "Coliseu e Fórum Romano", fazer: "Arena incluída, guia em português", dia: 13, prazo: { dias: 60 }, quem: "operacional" },
  { categoria: "transfers_passeios", item: "Barco privativo VCE > hotel", fazer: "Confirmar horário do voo com o motorista", dia: 11, prazo: { dias: 30 }, quem: "operacional" },
  { categoria: "restaurantes", item: "Jantar em Florença", fazer: "Mesa para 4 às 20h, pedir mesa perto da janela", dia: 9, prazo: { dias: 20 }, quem: "consultor" },
  { categoria: "restaurantes", item: "Almoço em Veneza", fazer: "Cicchetti em Cannaregio", dia: 11, prazo: { dias: 20 }, quem: "consultor", concluida: true },
  { categoria: "hoteis_carro_voos", item: "Confirmar AZ 1465", fazer: "Conferir assentos e bagagem com a companhia", dia: 0, prazo: { dias: 3 }, quem: "consultor", care: true },
  { categoria: "conferir", item: "Passaportes e seguro-viagem", fazer: "Validade mínima de 6 meses e apólice no WhatsApp", dia: null, prazo: { dataRel: -3 }, quem: "consultor" },
  { categoria: "envio", item: "Nomes, bilhetes e fatura", fazer: "Enviar ao cliente em uma única mensagem", dia: null, prazo: { dias: 7 }, quem: "consultor" },
  { categoria: "envio", item: "Roteiro final em PDF", fazer: "Gerar a impressão do RT e anexar no grupo", dia: null, prazo: { dias: 10 }, quem: "consultor" },
];

async function semearManuais(sql: Sql, v: Viagem, usuarios: Record<string, string>, hoje: string) {
  let n = 0;
  for (const m of MANUAIS) {
    const [existe] = await sql`select 1 from tarefas where viagem_id = ${v.id} and item = ${m.item} and origem = 'manual' and excluido_em is null`;
    if (existe) continue;
    const [max] = await sql`select coalesce(max(ordem), 0)::int as n from tarefas where viagem_id = ${v.id}`;
    const dia = m.dia === null ? null : somarDias(v.inicio, m.dia);
    const prazo = m.prazo;
    const prazoTipo = prazo === null ? null : "dias" in prazo ? "dias_antes" : "data";
    const prazoDias = prazo && "dias" in prazo ? prazo.dias : null;
    const prazoData = prazo && "dataRel" in prazo ? somarDias(hoje, prazo.dataRel) : null;
    const resp = usuarios[m.quem === "operacional" ? "operacional@eclak.local" : "consultor@eclak.local"];
    await sql`
      insert into tarefas (viagem_id, categoria, dia, item, fazer, prazo_tipo, prazo_data, prazo_dias, responsavel_id, customer_care, ordem,
                           origem, concluida_em, concluida_por, criado_por)
      values (${v.id}, ${m.categoria}, ${dia}, ${m.item}, ${m.fazer}, ${prazoTipo}, ${prazoData}, ${prazoDias}, ${m.care ? null : resp}, ${m.care ?? false}, ${max.n + 1},
              'manual', ${m.concluida ? new Date() : null}, ${m.concluida ? resp : null}, ${usuarios["diretor@eclak.local"]})`;
    n++;
  }
  return n;
}

function conteudoDoRoteiro(v: Viagem): ConteudoRoteiro {
  const d = (n: number) => somarDias(v.inicio, n);
  const hoteis: HotelRoteiro[] = [
    { cidade: "Florença", nome: "Palazzo Lungarno Nove", entrada: d(9), saida: d(11), horaCheckin: "14:00", horaCheckout: "11:00", mapa: null },
    { cidade: "Veneza", nome: "Ca' Laguna Antica", entrada: d(11), saida: d(12), horaCheckin: "15:00", horaCheckout: "10:00", mapa: "https://maps.app.goo.gl/lagunaantica" },
    { cidade: "Roma", nome: "Hotel Travertino Roma", entrada: d(12), saida: d(14), horaCheckin: "14:00", horaCheckout: "11:00", mapa: null },
  ];
  const preenchidos: Record<string, Partial<DiaRoteiro>> = {
    [d(9)]: {
      titulo: "Florença: Duomo e Uffizi",
      itens: [
        { hora: "09:30", titulo: "Galleria degli Uffizi", texto: "Entrada com horário marcado | Guia privativo em português", mapa: "https://maps.app.goo.gl/uffizi" },
        { hora: "13:00", titulo: "Almoço na Via dei Neri", texto: "Panini e vinho da casa", mapa: null },
        { hora: "16:00", titulo: "Passeio pela Piazza del Duomo", texto: "Cúpula de Brunelleschi e Batistério", mapa: null },
      ],
      dica: { tema: "TREM", texto: "Valide o bilhete na plataforma antes de embarcar; sem validação a multa é de 50 euros." },
      porque: "Escolhemos o Uffizi no primeiro dia para a visita acontecer com a cabeça descansada e a luz do início da manhã.",
      gastro: ["Trattoria Mario (bistecca)", "Gelateria dei Neri"],
    },
    [d(10)]: {
      titulo: "Toscana: Chianti e Siena",
      itens: [
        { hora: "08:30", titulo: "Saída para o Chianti", texto: "Motorista privativo | Duas vinícolas com almoço", mapa: null },
        { hora: "17:30", titulo: "Siena ao fim da tarde", texto: "Piazza del Campo e Duomo", mapa: null },
      ],
      dica: null,
      porque: "O Chianti entra no meio da estadia para quebrar o ritmo de museus.",
      gastro: ["Osteria Le Logge (Siena)"],
    },
    [d(11)]: {
      titulo: "Florença > Veneza",
      itens: [
        { hora: "10:30", titulo: "Trem Florença > Veneza", texto: "Italo, 2ª classe | Cerca de 2h", mapa: null },
        { hora: "13:30", titulo: "Barco privativo até o hotel", texto: "Motorista aguarda na estação de Santa Lucia", mapa: null },
        { hora: "19:30", titulo: "Jantar em Cannaregio", texto: "Mesa reservada para 4", mapa: null },
      ],
      dica: { tema: "VAPORETTO", texto: "O bilhete de 24 horas compensa a partir da terceira viagem; valide na entrada do píer." },
      porque: "Veneza em uma noite só: chegar de barco é a melhor primeira impressão da cidade.",
      gastro: ["Osteria alle Testiere", "Cantina Do Spade"],
    },
  };
  return {
    dias: datasDaViagem(v.inicio, v.fim).map((data) => ({
      data,
      titulo: "",
      itens: [],
      dica: null,
      porque: null,
      gastro: [],
      ...(preenchidos[data] ?? {}),
    })),
    hoteis,
    voos: [{ data: v.inicio, voo: "AZ 1465", trecho: "GRU > LIS", saida: "22:30", chegada: "11:20" }],
  };
}

async function semearRoteiro(sql: Sql, v: Viagem, usuarios: Record<string, string>) {
  const [existe] = await sql`select id from roteiros where viagem_id = ${v.id}`;
  if (existe) return { roteiroId: existe.id as string, novo: false };
  const diretor = usuarios["diretor@eclak.local"];
  const conteudo = conteudoDoRoteiro(v);
  const [r] = await sql`
    insert into roteiros (viagem_id, status, idioma, fuso, abertura, conteudo, enviado_cliente_em, enviado_cliente_por, aprovado_em, aprovado_por, criado_por)
    values (${v.id}, 'aprovado', 'italiano', 'Europe/Rome',
            'Preparamos este roteiro pensando no ritmo da família: manhãs com cultura e tardes mais leves.',
            ${sql.json(conteudo as never)}, now(), ${v.consultorId}, now(), ${diretor}, ${v.consultorId})
    returning id`;
  return { roteiroId: r.id as string, novo: true };
}

async function semearDailies(sql: Sql, v: Viagem, roteiroId: string, usuarios: Record<string, string>) {
  const [r] = await sql`select idioma, conteudo from roteiros where id = ${roteiroId}`;
  const conteudo = r.conteudo as ConteudoRoteiro;
  const ps = await sql`
    select p.nome from viagem_passageiros vp join pessoas p on p.id = vp.pessoa_id
    where vp.viagem_id = ${v.id} and p.removido_em is null order by p.ordem, p.nome`;
  const nomes = nomesDaSaudacao(ps.map((p) => p.nome as string), v.grupo);
  const plantao = usuarios["operacional@eclak.local"];
  const consultor = v.consultorId;
  let n = 0;
  // Dia 9 (Florença): pronto para enviar. Dia 11 (troca Florença > Veneza): gerado, a revisar.
  for (const [dia, estado] of [[9, "revisado"], [11, "gerado"]] as const) {
    const data = somarDias(v.inicio, dia);
    const [existe] = await sql`select 1 from dailies where roteiro_id = ${roteiroId} and data = ${data}`;
    if (existe) continue;
    const texto = textoDoDaily({
      data,
      idioma: r.idioma,
      nomes,
      dia: conteudo.dias.find((x) => x.data === data)!,
      hoteis: conteudo.hoteis,
      encerramento: ENCERRAMENTO_INICIAL,
    });
    await sql`
      insert into dailies (roteiro_id, data, estado, texto, gerado_em, gerado_por, revisado_em, revisado_por, plantao_id, interno)
      values (${roteiroId}, ${data}, ${estado}, ${texto}, now(), ${consultor},
              ${estado === "revisado" ? new Date() : null}, ${estado === "revisado" ? consultor : null},
              ${plantao}, ${estado === "revisado" ? "Cliente prefere receber depois das 20h." : null})`;
    n++;
  }
  return n;
}

/** Aniversário de um passageiro dentro da viagem: ajusta o nascimento do Lucas (mesmo ano, dia da viagem em Florença). */
async function semearAniversario(sql: Sql, v: Viagem, roteiroId: string) {
  const [r] = await sql`select conteudo from roteiros where id = ${roteiroId}`;
  const ps = await sql`
    select p.id, p.nome, p.nascimento::text as nascimento from viagem_passageiros vp join pessoas p on p.id = vp.pessoa_id
    where vp.viagem_id = ${v.id} and p.removido_em is null`;
  const lista = ps.map((p) => ({ id: p.id as string, nome: p.nome as string, nascimento: p.nascimento as string | null }));
  if (aniversariosNaViagem(lista, v.inicio, v.fim, (r.conteudo as ConteudoRoteiro).hoteis).length > 0) return 0;
  const lucas = lista.find((p) => p.nome === "Lucas Ribeiro");
  if (!lucas) return 0;
  const alvo = somarDias(v.inicio, 10);
  await sql`update pessoas set nascimento = ${`2012${alvo.slice(4)}`} where id = ${lucas.id}`;
  return 1;
}

export async function semearOperacao(sql: Sql): Promise<{ tarefas: number; roteiros: number; dailies: number }> {
  const hoje = hojeEmCuiaba();
  const us = await sql`select id, email from usuarios where email like '%@eclak.local'`;
  const usuarios = Object.fromEntries(us.map((u) => [u.email as string, u.id as string]));
  if (!usuarios["diretor@eclak.local"] || !usuarios["operacional@eclak.local"]) return { tarefas: 0, roteiros: 0, dailies: 0 };

  const rows = await sql`
    select v.id, v.inicio::text as inicio, v.fim::text as fim, v.consultor_id, c.grupo, ve.aceite_em::text as aceite,
           (select p.nome from pessoas p where p.cliente_id = c.id and p.titular and p.removido_em is null limit 1) as titular
    from viagens v join clientes c on c.id = v.cliente_id join vendas ve on ve.viagem_id = v.id
    where v.status = 'vendida' and v.excluido_em is null order by v.criado_em`;
  const viagens: Viagem[] = rows.map((r) => ({
    id: r.id, inicio: r.inicio, fim: r.fim, consultorId: r.consultor_id, grupo: r.grupo, titular: r.titular ?? r.grupo, aceite: r.aceite,
  }));

  let tarefas = 0;
  let roteiros = 0;
  let dailies = 0;
  for (const v of viagens) {
    tarefas += await inserirAutomaticas(sql, v, tarefasDaVenda(v.aceite, v.inicio), "venda", usuarios["diretor@eclak.local"]);
    if (v.grupo !== "Família Ribeiro") continue;
    tarefas += await semearManuais(sql, v, usuarios, hoje);
    const { roteiroId, novo } = await semearRoteiro(sql, v, usuarios);
    if (novo) roteiros++;
    tarefas += await inserirAutomaticas(sql, v, tarefasDoRoteiro(), "roteiro", usuarios["diretor@eclak.local"]);
    await semearAniversario(sql, v, roteiroId);
    dailies += await semearDailies(sql, v, roteiroId, usuarios);
  }
  return { tarefas, roteiros, dailies };
}
