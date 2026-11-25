/**
 * Seed local (npm run seed:local): um usuário por perfil (senha eclak-local), os fornecedores, os clientes fictícios do protótipo, três orçamentos (aguardando, aprovado e devolvido) e três viagens vendidas (Ribeiro, em viagem; uma conciliada; e Teixeira, da filial RS, embarcando em 20 dias), duas contas bancárias, lançamentos manuais do protótipo, a fatura da Ribeiro, um cartão corporativo com três compras, uma nota fiscal, as tarefas da venda, um roteiro aprovado, dois dailies, um extrato sintético (confere, diferença e tarifa pendente) e a fatia 5b (seed-5b.ts: estoque, caixas de experiência, reembolsos e comunicados).
 * Recusa rodar se DATABASE_URL ou NEXT_PUBLIC_SUPABASE_URL não forem locais. Idempotente: o que já existe é pulado; nada é apagado
 * (os testes de integração truncam o banco; o que um teste deixou fica: `supabase db reset` e o seed para começar limpo).
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { garantirBancoLocal } from "./local-guard";
import { semearOrcamentos } from "./seed-orcamentos";
import { semearFinanceiro } from "./seed-financeiro";
import { semearConciliacao } from "./seed-conciliacao";
import { semearVendas } from "./seed-vendas";
import { semearOperacao } from "./seed-operacao";
import { semear5b } from "./seed-5b";

config({ path: ".env.local", quiet: true });

const SENHA = "eclak-local";

const USUARIOS = [
  { nome: "Diretor Local", email: "diretor@eclak.local", perfil: "diretor", filial: "Rondonópolis" },
  { nome: "Consultor Local", email: "consultor@eclak.local", perfil: "consultor", filial: "Rondonópolis" },
  { nome: "Operacional Local", email: "operacional@eclak.local", perfil: "operacional", filial: "Rondonópolis" },
  { nome: "Financeiro Operacional Local", email: "fin.operacional@eclak.local", perfil: "fin_operacional", filial: "Rondonópolis" },
  { nome: "Financeiro Estratégico Local", email: "fin.estrategico@eclak.local", perfil: "fin_estrategico", filial: "Rondonópolis" },
] as const;

type SeedFornecedor = {
  nome: string;
  cidade?: string;
  tipos: string[];
  modalidade: "net" | "comissionado";
  comissaoPct: string;
  tarifaFixa: bigint; // centavos
  descontoAVista: string;
};

// Dados do protótipo (fornecedoresIniciais), com tipos mapeados para os rótulos do sistema e tarifa em centavos.
const FORNECEDORES: SeedFornecedor[] = [
  { nome: "Operadora Mediterrânea", tipos: ["Passeio guiado", "Hotelaria"], modalidade: "comissionado", comissaoPct: "10", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Atlântica Operadora", tipos: ["Passeio guiado", "Hotelaria"], modalidade: "comissionado", comissaoPct: "12", tarifaFixa: 0n, descontoAVista: "3% no Pix" },
  { nome: "Rota Andina Operadora", tipos: ["Passeio guiado", "Hotelaria"], modalidade: "comissionado", comissaoPct: "11", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Austral Consolidadora", tipos: ["Aéreo"], modalidade: "comissionado", comissaoPct: "7", tarifaFixa: 4000n, descontoAVista: "Não oferece" },
  { nome: "Céu Aberto Consolidadora", tipos: ["Aéreo"], modalidade: "net", comissaoPct: "0", tarifaFixa: 6000n, descontoAVista: "2% no Pix" },
  { nome: "Hotel Via Appia Suites", cidade: "Roma", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "5% à vista" },
  { nome: "Villa Limoni Positano", cidade: "Positano", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "6% à vista" },
  { nome: "Grand Hotel Scogliera", cidade: "Amalfi", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Albergo Costa Viva", cidade: "Positano", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "4% à vista" },
  { nome: "Hotel Miradouro Sete", cidade: "Lisboa", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Quinta Ribeira Alta", cidade: "Porto", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Residencia Alcalá Norte", cidade: "Madri", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "5% à vista" },
  { nome: "Casa del Azahar", cidade: "Sevilha", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Hotel Passeig Modernista", cidade: "Barcelona", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Parcela em 2x" },
  { nome: "Hôtel Promenade Azur", cidade: "Nice", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Palazzo Lungarno Nove", cidade: "Florença", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Hotel Travertino Roma", cidade: "Roma", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "3% à vista" },
  { nome: "Ca' Laguna Antica", cidade: "Veneza", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Maison Rivoli Seize", cidade: "Paris", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "7% à vista ou 3x sem desconto" },
  { nome: "The Mayfair Row", cidade: "Londres", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Resort Ilha Serena", cidade: "Orlando", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "5% à vista ou 4x sem desconto" },
  { nome: "Palazzo Barocci", cidade: "Veneza", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "4% à vista" },
  { nome: "Orto de' Medici", cidade: "Florença", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "4% à vista" },
  { nome: "Il Borro", cidade: "Toscana", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "4% à vista" },
  { nome: "Hotel Belair", cidade: "Sorrento", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "4% à vista" },
  { nome: "Hotel Syrene", cidade: "Capri", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Leonardo Boutique", cidade: "Roma", tipos: ["Hotelaria"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Trenitalia Parceiros", tipos: ["Trem"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Locadora Toscana Auto", tipos: ["Carro"], modalidade: "comissionado", comissaoPct: "10", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Ferry Golfo di Napoli", tipos: ["Outro"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "TransEuropa Transfers", tipos: ["Transfer"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Mare Blu Barche", tipos: ["Passeio guiado"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "5% no Pix" },
  { nome: "Guias Privados Roma", tipos: ["Passeio guiado"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Sintra Privé Tours", tipos: ["Passeio guiado"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Proteção Viagem Corretora", tipos: ["Seguro"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Taxas locais", tipos: ["Taxa"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não se aplica" },
];

type SeedLinha = [
  grupo: string,
  titular: string,
  nascimento: string,
  validade: string | null,
  quarto: string,
  alimentacao: string,
  assento: string,
  obs: string,
  familia: [string, string, string, string | null][],
];

// Dados do protótipo (clientesIniciais): [nome, parentesco, nascimento, validade do passaporte] por acompanhante.
const CLIENTES: SeedLinha[] = [
  ["Família Ribeiro", "Ricardo Ribeiro", "1979-03-14", "2031-08-02", "Dois quartos conjugados, andar alto", "Sem restrições", "Corredor", "Gosta de hotéis boutique no centro histórico.", [["Ana Paula Ribeiro", "Esposa", "1982-11-21", "2030-04-18"], ["Lucas Ribeiro", "Filho", "2012-06-03", "2028-09-10"], ["Marina Ribeiro", "Filha", "2015-01-27", "2027-05-20"]]],
  ["Casal Andrade", "Rodrigo Andrade", "1988-07-09", "2032-02-11", "King, vista mar", "Sem glúten (Camila)", "Janela", "Lua de mel. Pediu decoração no quarto.", [["Camila Andrade", "Esposa", "1991-11-30", "2033-05-05"]]],
  ["Formatura Medicina 2026", "Júlia Mendes", "2001-04-02", "2034-01-15", "Quartos quádruplos", "Sem restrições", "Indiferente", "Contato da comissão de formatura. 24 formandos.", []],
  ["Família Teixeira", "Marcelo Teixeira", "1981-02-18", "2029-10-30", "Suíte família ou dois quartos", "Sem lactose (Pedro)", "Corredor", "Parques: comprar ingressos antecipados.", [["Daniela Teixeira", "Esposa", "1983-08-12", "2030-07-01"], ["Pedro Teixeira", "Filho", "2014-03-22", "2029-01-14"], ["Sofia Teixeira", "Filha", "2017-09-09", "2029-01-14"], ["Helena Teixeira", "Mãe", "1955-12-03", "2028-06-19"]]],
  ["Sr. Paulo Vieira", "Paulo Vieira", "1958-05-25", "2030-03-12", "Twin", "Sem frutos do mar", "Corredor", "Prefere voos diurnos.", [["Lúcia Vieira", "Esposa", "1960-10-17", "2030-03-12"]]],
  ["Casal Brandão", "Fábio Brandão", "1984-12-01", "2031-11-23", "King, quarto silencioso", "Vegetariana (Renata)", "Janela", "Executiva no aéreo. Ryokan com onsen privativo.", [["Renata Brandão", "Esposa", "1986-04-15", "2031-11-23"]]],
  ["Dr. Henrique Moraes", "Henrique Moraes", "1970-09-08", "2029-07-07", "King", "Sem restrições", "Corredor", "Paga em boletos. Atenção à cobrança.", [["Cláudia Moraes", "Esposa", "1972-01-19", "2029-07-07"], ["Beatriz Moraes", "Filha", "2003-06-28", "2032-02-02"]]],
  ["Família Lacerda", "Gustavo Lacerda", "1985-10-10", null, "Dois quartos", "Sem restrições", "Indiferente", "", [["Patrícia Lacerda", "Esposa", "1987-02-02", null], ["Theo Lacerda", "Filho", "2016-08-15", null], ["Laura Lacerda", "Filha", "2019-12-01", null]]],
  ["Grupo Amigas do Vinho", "Cristina Albuquerque", "1966-03-30", "2030-09-14", "Twin", "Sem restrições", "Indiferente", "Contato do grupo. 8 pessoas.", []],
  ["Casal Fontana", "Leonardo Fontana", "1990-06-06", "2031-03-03", "King, vista mar", "Sem restrições", "Janela", "", [["Isabela Fontana", "Esposa", "1992-09-25", "2031-03-03"]]],
  ["Família Queiroz", "Eduardo Queiroz", "1978-11-11", null, "Chalé família", "Sem restrições", "Indiferente", "Natal em Gramado todo ano.", [["Mariana Queiroz", "Esposa", "1980-05-05", null], ["Bruno Queiroz", "Filho", "2008-07-07", null], ["Clara Queiroz", "Filha", "2011-02-14", null], ["Antônio Queiroz", "Pai", "1950-03-03", null], ["Rosa Queiroz", "Mãe", "1953-06-12", null]]],
  ["Sra. Helena Duarte", "Helena Duarte", "1962-08-19", "2027-02-28", "King", "Sem restrições", "Corredor", "Viaja com a irmã.", [["Márcia Duarte", "Irmã", "1965-04-04", "2032-10-10"]]],
  ["Família Moretti", "Alessandro Moretti", "1983-01-23", "2030-12-12", "Suíte família", "Sem restrições", "Corredor", "", [["Fernanda Moretti", "Esposa", "1985-07-17", "2030-12-12"], ["Enzo Moretti", "Filho", "2015-11-11", "2028-03-01"], ["Valentina Moretti", "Filha", "2018-04-30", "2028-03-01"]]],
  ["Casal Siqueira", "André Siqueira", "1993-03-03", null, "Casal", "Sem restrições", "Indiferente", "", [["Juliana Siqueira", "Esposa", "1994-12-24", null]]],
  ["Família Barros", "Roberto Barros", "1976-04-11", "2029-04-11", "Dois quartos", "Sem restrições", "Corredor", "Ainda pagando boletos de Nova York.", [["Simone Barros", "Esposa", "1978-09-09", "2029-04-11"], ["Gabriel Barros", "Filho", "2007-10-20", "2027-10-20"], ["Lívia Barros", "Filha", "2010-01-05", "2027-10-20"]]],
  ["Sr. Rogério Pinheiro", "Rogério Pinheiro", "1964-07-04", "2028-11-30", "Tenda luxo, king", "Sem restrições", "Corredor", "Fotógrafo amador. Safáris longos.", [["Vera Pinheiro", "Esposa", "1967-02-21", "2028-11-30"]]],
  ["Casal Nogueira", "Thiago Nogueira", "1995-05-15", null, "Casal", "Vegano (Thiago)", "Indiferente", "", [["Larissa Nogueira", "Esposa", "1996-08-08", null]]],
  ["Grupo Melhor Idade", "Dona Irene Carvalho", "1949-12-08", "2029-05-05", "Twin", "Sem açúcar (vários)", "Corredor", "16 pessoas. Precisa de assistência em aeroportos.", []],
  ["Família Campos", "Felipe Campos", "1982-09-29", "2030-01-01", "Dois quartos", "Sem restrições", "Janela", "", [["Aline Campos", "Esposa", "1984-03-17", "2030-01-01"], ["Davi Campos", "Filho", "2013-05-05", "2028-08-08"], ["Alice Campos", "Filha", "2016-10-10", "2028-08-08"]]],
  ["Casal Vasconcelos", "Ricardo Vasconcelos", "1987-02-27", "2032-06-06", "King", "Sem restrições", "Janela", "", [["Paula Vasconcelos", "Esposa", "1989-09-01", "2032-06-06"]]],
  ["Família Guimarães", "Sérgio Guimarães", "1975-06-30", null, "Casa com piscina", "Sem restrições", "Indiferente", "", [["Renata Guimarães", "Esposa", "1977-12-12", null], ["Arthur Guimarães", "Filho", "2009-04-04", null], ["Manuela Guimarães", "Filha", "2012-07-19", null], ["Lara Guimarães", "Filha", "2015-03-08", null]]],
  ["Dra. Marina Costa Lima", "Marina Costa Lima", "1983-10-05", "2033-04-01", "King", "Pescetariana", "Janela", "Quer ver aurora boreal.", [["Paulo Costa Lima", "Marido", "1981-07-14", "2033-04-01"]]],
  ["Família Rezende", "Otávio Rezende", "1980-01-31", "2031-01-31", "Dois quartos", "Sem restrições", "Corredor", "", [["Luciana Rezende", "Esposa", "1982-06-16", "2031-01-31"], ["Mateus Rezende", "Filho", "2011-11-11", "2029-02-02"], ["Isadora Rezende", "Filha", "2014-02-14", "2029-02-02"]]],
  ["Casal Peixoto", "Diego Peixoto", "1989-08-28", "2031-09-09", "King, vista mar", "Sem restrições", "Janela", "", [["Bianca Peixoto", "Esposa", "1990-03-13", "2031-09-09"]]],
  ["Família Moura", "Cristiano Moura", "1979-12-20", null, "Dois quartos", "Sem restrições", "Indiferente", "", [["Tatiane Moura", "Esposa", "1981-04-09", null], ["Rafael Moura", "Filho", "2010-09-09", null], ["Yasmin Moura", "Filha", "2012-12-12", null], ["José Moura", "Avô", "1948-05-01", null], ["Ivone Moura", "Avó", "1951-08-21", null]]],
  ["Sr. Eduardo Prates", "Eduardo Prates", "1968-02-09", "2030-08-08", "Suíte", "Halal (preferência)", "Corredor", "Executiva sempre.", [["Mônica Prates", "Esposa", "1970-11-03", "2030-08-08"]]],
  ["Grupo Pescaria Pantanal", "Valdir Souza", "1961-06-14", null, "Twin", "Sem restrições", "Indiferente", "Contato do grupo. 10 pescadores.", []],
  ["Família Carvalho", "Henrique Carvalho", "1977-09-17", "2029-09-17", "Dois quartos", "Sem restrições", "Corredor", "", [["Adriana Carvalho", "Esposa", "1979-01-01", "2029-09-17"], ["Pietro Carvalho", "Filho", "2011-03-03", "2027-12-01"], ["Giovana Carvalho", "Filha", "2014-06-06", "2027-12-01"]]],
  ["Casal Albuquerque", "Marcos Albuquerque", "1986-04-24", "2027-06-30", "King, bangalô", "Sem pimenta (Marcos)", "Janela", "Tailândia exige 6 meses de validade do passaporte.", [["Carolina Albuquerque", "Esposa", "1988-10-10", "2031-01-20"]]],
  ["Família Pacheco", "Rodrigo Pacheco", "1980-07-07", "2030-02-02", "Cabine com varanda", "Sem restrições", "Indiferente", "", [["Elaine Pacheco", "Esposa", "1982-03-25", "2030-02-02"], ["Igor Pacheco", "Filho", "2009-08-18", "2028-04-04"], ["Nina Pacheco", "Filha", "2013-01-13", "2028-04-04"], ["Sandra Pacheco", "Tia", "1960-10-10", "2030-02-02"]]],
  ["Casal Souza", "Marina Souza", "1985-03-12", "2032-05-20", "King, vista mar", "Sem restrições", "Janela", "Roteiro de 19 dias pela Itália.", [["Rafael Souza", "Marido", "1983-09-02", "2032-05-20"]]],
];

// Filial de cada cliente, como na viagem do protótipo; os demais são de Rondonópolis.
const GRUPOS_RS = [
  "Família Teixeira", "Sr. Paulo Vieira", "Grupo Amigas do Vinho", "Família Queiroz", "Família Moretti",
  "Família Campos", "Dra. Marina Costa Lima", "Família Rezende", "Família Carvalho", "Casal Albuquerque",
];

/** Dígitos pseudoaleatórios determinísticos (mesmo gerador do protótipo). */
function dig(seed: number, n: number): string {
  let s = "";
  let x = seed * 9301 + 49297;
  for (let i = 0; i < n; i++) {
    x = (x * 9301 + 49297) % 233280;
    s += Math.floor((x / 233280) * 10);
  }
  return s;
}

/** CPF válido (dígitos verificadores calculados) a partir de uma semente; nunca todos os dígitos iguais. */
function cpfDe(semente: number): string {
  let base = dig(semente, 9);
  if (/^(\d)\1{8}$/.test(base)) base = `${base.slice(0, 8)}${(Number(base[8]) + 1) % 10}`;
  const calc = (d: string) => {
    const resto = (d.split("").reduce((soma, c, i) => soma + Number(c) * (d.length + 1 - i), 0) * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = calc(base);
  const d2 = calc(base + d1);
  return `${base}${d1}${d2}`;
}

const semAcento = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

type SeedPessoa = {
  nome: string;
  parentesco: string | null;
  nascimento: string | null;
  cpf: string;
  passaporte: string | null;
  validade: string | null;
};

function montarClientes() {
  const cpfsUsados = new Set<string>();
  const cpfUnico = (semente: number) => {
    let s = semente;
    while (cpfsUsados.has(cpfDe(s))) s += 1000;
    const c = cpfDe(s);
    cpfsUsados.add(c);
    return c;
  };
  return CLIENTES.map(([grupo, titular, nasc, validade, quarto, alimentacao, assento, obs, familia], i) => {
    const filial = GRUPOS_RS.includes(grupo) ? "RS" : "Rondonópolis";
    const [primeiro, ...resto] = titular.replace(/^(Dona|Dra?\.|Sr\.|Sra\.) /, "").split(" ");
    const tipo = /^(Grupo|Formatura)/.test(grupo) ? "grupo" : grupo.startsWith("Casal") ? "casal" : grupo.startsWith("Família") ? "familia" : "individual";
    const pessoas: SeedPessoa[] = [
      { nome: titular, parentesco: null, nascimento: nasc, cpf: cpfUnico(i + 7), passaporte: validade ? `F${dig(i + 11, 6)}` : null, validade },
      ...familia.map(([nome, parentesco, nascimento, val], k) => ({
        nome,
        parentesco,
        nascimento,
        cpf: cpfUnico(i * 10 + k + 301),
        passaporte: val ? `F${dig(i * 10 + k + 31, 6)}` : null,
        validade: val,
      })),
    ];
    return {
      grupo,
      tipo,
      filial,
      telefone: `${filial === "RS" ? "51" : "66"}9${dig(i + 3, 8)}`,
      email: `${semAcento(primeiro)}.${semAcento(resto[resto.length - 1] ?? "")}@email.com`,
      quarto,
      alimentacao,
      assento,
      obs,
      clienteDesde: `20${String(18 + (i % 8)).padStart(2, "0")}-${String((i % 12) + 1).padStart(2, "0")}-10`,
      pessoas,
    };
  });
}

async function main() {
  const { DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  garantirBancoLocal(DATABASE_URL ?? "", NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");

  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const admin = createClient(NEXT_PUBLIC_SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let erroOriginal: unknown;
  try {
    let usuariosNovos = 0;
    for (const u of USUARIOS) {
      const [existe] = await sql`select 1 from usuarios where email = ${u.email}`;
      if (existe) continue;
      const { data, error } = await admin.auth.admin.createUser({
        email: u.email,
        password: SENHA,
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`Falha ao criar ${u.email}: ${error?.message}`);
      await sql`
        insert into usuarios (id, nome, email, perfil, filial, ativo)
        values (${data.user.id}, ${u.nome}, ${u.email}, ${u.perfil}, ${u.filial}, true)`;
      usuariosNovos++;
    }

    let fornecedoresNovos = 0;
    for (const f of FORNECEDORES) {
      const [existe] = await sql`select 1 from fornecedores where nome = ${f.nome} and excluido_em is null`;
      if (existe) continue;
      await sql`
        insert into fornecedores (nome, cidade, tipos, modalidade, comissao_pct, tarifa_fixa, desconto_a_vista)
        values (${f.nome}, ${f.cidade ?? null}, ${f.tipos as unknown as string}::tipo_servico[], ${f.modalidade},
                ${f.comissaoPct}, ${f.tarifaFixa.toString()}, ${f.descontoAVista})`;
      fornecedoresNovos++;
    }
    let clientesNovos = 0;
    for (const c of montarClientes()) {
      const [existe] = await sql`select 1 from clientes where grupo = ${c.grupo} and excluido_em is null`;
      if (existe) continue;
      await sql.begin(async (tx) => {
        const [novo] = await tx`
          insert into clientes (grupo, tipo, filial, telefone, email, pref_quarto, pref_alimentacao, pref_assento, observacoes, cliente_desde)
          values (${c.grupo}, ${c.tipo}, ${c.filial}, ${c.telefone}, ${c.email}, ${c.quarto}, ${c.alimentacao}, ${c.assento},
                  ${c.obs || null}, ${c.clienteDesde})
          returning id`;
        for (const [ordem, p] of c.pessoas.entries()) {
          await tx`
            insert into pessoas (cliente_id, titular, ordem, nome, parentesco, nascimento, cpf, passaporte, validade_passaporte)
            values (${novo.id}, ${ordem === 0}, ${ordem}, ${p.nome}, ${p.parentesco}, ${p.nascimento}, ${p.cpf}, ${p.passaporte}, ${p.validade})`;
        }
      });
      clientesNovos++;
    }
    const orcamentosNovos = await semearOrcamentos(sql);
    const vendasNovas = await semearVendas(sql);
    const fin = await semearFinanceiro(sql);
    const op = await semearOperacao(sql);
    const conciliadas = await semearConciliacao(sql);
    const b = await semear5b(sql);
    console.log(`Seed local: ${usuariosNovos} usuário(s), ${fornecedoresNovos} fornecedor(es), ${clientesNovos} cliente(s), ${orcamentosNovos} orçamento(s), ${vendasNovas} viagem(ns) vendida(s), ${fin.lancamentos} lançamento(s), ${fin.faturas} fatura(s), ${fin.cartoes} cartão(ões) com ${fin.compras} compra(s), ${fin.notas} nota(s) fiscal(is), ${op.tarefas} tarefa(s), ${op.roteiros} roteiro(s) e ${op.dailies} daily(ies), ${conciliadas} transação(ões) de extrato, ${b.produtos} produto(s) de estoque, ${b.entradas} entrada(s) de estoque, ${b.caixas} caixa(s) de experiência, ${b.reembolsos} reembolso(s) e ${b.comunicados} comunicado(s) criados.`);
    console.log(`Logins: ${USUARIOS.map((u) => u.email).join(", ")} (senha ${SENHA})`);
  } catch (e) {
    erroOriginal = e;
    throw e;
  } finally {
    // Fecha as duas conexões sem esconder o erro original: com ele, a falha ao fechar só é registrada; sem ele, a
    // primeira falha ao fechar é o erro do seed. O cliente do app (núcleo usado pela fatura e pela 5b) é carregado só
    // aqui no fim se ainda não foi.
    const falhas: unknown[] = [];
    for (const fechar of [() => sql.end(), async () => (await import("../src/server/db/client")).sql.end()]) {
      try {
        await fechar();
      } catch (e) {
        falhas.push(e);
      }
    }
    if (falhas.length > 0) {
      if (erroOriginal === undefined) throw falhas[0];
      for (const f of falhas) console.error("Falha ao fechar a conexão (o erro do seed segue abaixo):", f instanceof Error ? f.message : f);
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
