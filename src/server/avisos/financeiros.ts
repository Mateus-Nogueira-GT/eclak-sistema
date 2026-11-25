import "server-only";
import { and, count, eq, inArray, lt, lte, min, sql, type SQL } from "drizzle-orm";
import { PASSO_AVISO, type AvisoCentral } from "@/domain/avisos";
import { hojeEmCuiaba } from "@/domain/clientes";
import { DIAS_AVISO } from "@/domain/conciliacao";
import { formatarReais } from "@/domain/dinheiro";
import { RESPONSAVEL_AVISO, type Aviso } from "@/domain/paineis";
import { PERFIS_FINANCEIRO } from "@/domain/perfis";
import { somarDias } from "@/domain/venda";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { categoriasFinanceiras, lancamentosFinanceiros as lf } from "@/server/db/schema";
import { pendentesParaAviso } from "@/server/queries/conciliacao";

const DIAS_A_PAGAR = 7;

type Agregado = { quantidade: number; total: bigint; desde: string | null };

/** Linhas em aberto da view que atendem `filtro`: quantidade, total previsto e o vencimento mais antigo. */
async function emAberto(filtro: SQL | undefined): Promise<Agregado> {
  const [t] = await db
    .select({
      quantidade: count(),
      total: sql<string>`coalesce(sum(${lf.valorPrevisto}), 0)::bigint`.mapWith((v: string) => BigInt(v)),
      desde: min(lf.vencimento),
    })
    .from(lf)
    .where(and(eq(lf.statusBase, "em_aberto"), filtro));
  return t ?? { quantidade: 0, total: 0n, desde: null };
}

export const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;
const lista = (params: Record<string, string>) => `/financeiro/lancamentos?${new URLSearchParams(params).toString()}`;

/** Aviso que resume várias linhas: a chave é só o tipo. */
export function avisoAgregado(tipo: Aviso["tipo"], titulo: string, detalhe: string, href: string): AvisoCentral {
  return { chave: tipo, tipo, titulo, detalhe, passo: PASSO_AVISO[tipo], setor: RESPONSAVEL_AVISO[tipo], href, dispensavel: true };
}

/**
 * Avisos do setor Financeiro (spec 5b §8.3): parcelas de cliente e comissões de fornecedor vencidas, contas a pagar
 * vencidas ou vencendo em 7 dias e transações do extrato sem par há mais de `DIAS_AVISO` dias. Os mesmos textos e
 * links da Visão geral, nesta ordem.
 */
export async function avisosFinanceiros(): Promise<AvisoCentral[]> {
  await exigirPerfil(...PERFIS_FINANCEIRO);
  const hoje = hojeEmCuiaba();
  const ontem = somarDias(hoje, -1);
  const limitePagar = somarDias(hoje, DIAS_A_PAGAR);

  const [parcelas, comissoesVencidas, aPagar, categoriaVendas, semPar] = await Promise.all([
    emAberto(and(eq(lf.origem, "parcela"), lt(lf.vencimento, hoje))),
    emAberto(and(eq(lf.origem, "comissao"), lt(lf.vencimento, hoje))),
    emAberto(and(eq(lf.lado, "pagar"), eq(lf.transitaCaixa, true), inArray(lf.origem, ["pagamento", "manual", "fatura_cartao"]), lte(lf.vencimento, limitePagar))),
    db.select({ id: categoriasFinanceiras.id }).from(categoriasFinanceiras).where(eq(categoriasFinanceiras.sistema, "vendas_viagem")),
    pendentesParaAviso(hoje),
  ]);

  const avisos: AvisoCentral[] = [];
  if (parcelas.quantidade > 0 && parcelas.desde) {
    const filtro: Record<string, string> = { lado: "receber", base: "vencimento", situacao: "vencida", origem: "viagem" };
    if (categoriaVendas[0]) filtro.categoriaId = categoriaVendas[0].id;
    avisos.push(
      avisoAgregado(
        "parcela",
        plural(parcelas.quantidade, "parcela de cliente vencida", "parcelas de cliente vencidas"),
        `${formatarReais(parcelas.total)} em aberto`,
        lista({ ...filtro, de: parcelas.desde, ate: ontem }),
      ),
    );
  }
  if (comissoesVencidas.quantidade > 0 && comissoesVencidas.desde) {
    avisos.push(
      avisoAgregado(
        "comissao",
        plural(comissoesVencidas.quantidade, "comissão de fornecedor vencida", "comissões de fornecedor vencidas"),
        `${formatarReais(comissoesVencidas.total)} a receber`,
        lista({ lado: "receber", base: "vencimento", situacao: "vencida", origem: "viagem", de: comissoesVencidas.desde, ate: ontem }),
      ),
    );
  }
  if (aPagar.quantidade > 0 && aPagar.desde) {
    avisos.push(
      avisoAgregado(
        "pagar",
        plural(aPagar.quantidade, "conta a pagar vencida ou vencendo em 7 dias", "contas a pagar vencidas ou vencendo em 7 dias"),
        `${formatarReais(aPagar.total)} em aberto`,
        lista({ lado: "pagar", base: "vencimento", situacao: "em_aberto", de: aPagar.desde, ate: limitePagar }),
      ),
    );
  }
  if (semPar.qtd > 0) {
    // Abre a conta com a pendência mais antiga, do dia dela até hoje: a lista não cai vazia.
    const primeira = semPar.contas[0];
    const href = `/financeiro/conciliacao?${new URLSearchParams({ conta: primeira.contaId, de: primeira.maisAntiga, ate: hoje, situacao: "nao_conciliado" }).toString()}`;
    avisos.push(
      avisoAgregado(
        "conciliacao",
        `${plural(semPar.qtd, "transação", "transações")} do extrato sem par no sistema`,
        `${formatarReais(semPar.valor)} em transações sem par com mais de ${DIAS_AVISO} dias${semPar.contas.length > 1 ? `, em ${semPar.contas.length} contas` : ""}`,
        href,
      ),
    );
  }
  return avisos;
}
