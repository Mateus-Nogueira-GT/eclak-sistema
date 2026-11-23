/**
 * Seed local (npm run seed:local): um usuário por perfil (senha eclak-local) e os fornecedores fictícios do protótipo.
 * Recusa rodar se DATABASE_URL ou NEXT_PUBLIC_SUPABASE_URL não forem locais. Idempotente: o que já existe é pulado.
 */
import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { garantirBancoLocal } from "./local-guard";

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
  { nome: "TransEuropa Transfers", tipos: ["Transfer"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Mare Blu Barche", tipos: ["Passeio guiado"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "5% no Pix" },
  { nome: "Guias Privados Roma", tipos: ["Passeio guiado"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Sintra Privé Tours", tipos: ["Passeio guiado"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Proteção Viagem Corretora", tipos: ["Seguro"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não oferece" },
  { nome: "Taxas locais", tipos: ["Taxa"], modalidade: "net", comissaoPct: "0", tarifaFixa: 0n, descontoAVista: "Não se aplica" },
];

async function main() {
  const { DATABASE_URL, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
  garantirBancoLocal(DATABASE_URL ?? "", NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Falta SUPABASE_SERVICE_ROLE_KEY");

  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const admin = createClient(NEXT_PUBLIC_SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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
    console.log(`Seed local: ${usuariosNovos} usuário(s) e ${fornecedoresNovos} fornecedor(es) criados.`);
    console.log(`Logins: ${USUARIOS.map((u) => u.email).join(", ")} (senha ${SENHA})`);
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
