import "server-only";
import { and, count, eq, isNull } from "drizzle-orm";
import { PASSO_AVISO, type AvisoCentral } from "@/domain/avisos";
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { pctAbaixoDe, RESPONSAVEL_AVISO } from "@/domain/paineis";
import { exigirPerfil } from "@/server/auth";
import { db } from "@/server/db/client";
import { versoesPrecificacao, viagens } from "@/server/db/schema";
import { obterFluxoDeCaixa, type FluxoDeCaixa } from "@/server/queries/caixa";
import { viagensNaoConciliadas, type ViagemVendidaDoPainel } from "@/server/queries/margens-vendidas";
import { regrasVigentes } from "@/server/queries/regras";
import { avisoAgregado, plural } from "./financeiros";

/** O que a Visão geral já leu e repassa, para não ler duas vezes o fluxo de caixa e as margens. */
export type DadosGestao = {
  fluxo: FluxoDeCaixa;
  /** Viagens vendidas e não conciliadas, com as margens. */
  naoConciliadas: ViagemVendidaDoPainel[];
  /** `margemReferenciaPct` vigente. */
  referencia: string;
};

async function pedidosAguardando(): Promise<number> {
  const [t] = await db
    .select({ quantidade: count() })
    .from(versoesPrecificacao)
    .innerJoin(viagens, eq(viagens.id, versoesPrecificacao.viagemId))
    .where(and(isNull(viagens.excluidoEm), eq(versoesPrecificacao.status, "aguardando")));
  return t?.quantidade ?? 0;
}

/**
 * Avisos do setor Gestão (spec 5b §8.3), com os textos da Visão geral: caixa negativo nas próximas semanas (uma linha,
 * não dispensável), margem real abaixo da referência (uma por viagem, a menor margem primeiro, sem corte) e, só para o
 * Diretor, pedidos aguardando aprovação. `dados` é o que a Visão geral já leu; sem ele, lê.
 */
export async function avisosDeGestao(dados?: DadosGestao): Promise<AvisoCentral[]> {
  const usuario = await exigirPerfil("diretor", "fin_estrategico");
  const [d, aguardando] = await Promise.all([
    dados ??
      Promise.all([obterFluxoDeCaixa({}), viagensNaoConciliadas(hojeEmCuiaba()), regrasVigentes()]).then(([fluxo, naoConciliadas, regras]) => ({
        fluxo,
        naoConciliadas,
        referencia: regras.valores.margemReferenciaPct,
      })),
    usuario.perfil === "diretor" ? pedidosAguardando() : Promise.resolve(0),
  ]);

  const avisos: AvisoCentral[] = [];
  // Caixa: uma linha só, com quantas semanas ficam negativas, a primeira e a de menor saldo.
  const negativas = d.fluxo.semanas.filter((s) => s.saldoFinal < 0n);
  if (negativas.length > 0) {
    const menor = negativas.reduce((m, s) => (s.saldoFinal < m.saldoFinal ? s : m));
    avisos.push({
      chave: "caixa",
      tipo: "caixa",
      titulo: `Caixa negativo em ${negativas.length} das próximas ${d.fluxo.semanas.length} semanas, a partir da semana de ${negativas[0].rotulo}`,
      detalhe: `Menor saldo projetado: ${formatarReais(menor.saldoFinal)}, na semana de ${menor.rotulo}`,
      passo: PASSO_AVISO.caixa,
      setor: RESPONSAVEL_AVISO.caixa,
      href: "/financeiro/caixa",
      dispensavel: false,
    });
  }

  // Margem: a maior distância da referência (a menor margem real) primeiro.
  const abaixo: { v: ViagemVendidaDoPainel; realPct: string }[] = [];
  for (const v of d.naoConciliadas) {
    const real = v.margens.real;
    if ("erro" in real) continue;
    if (pctAbaixoDe(real.finalPct, d.referencia)) abaixo.push({ v, realPct: real.finalPct });
  }
  abaixo.sort((a, b) => (pctAbaixoDe(a.realPct, b.realPct) ? -1 : pctAbaixoDe(b.realPct, a.realPct) ? 1 : a.v.codigo.localeCompare(b.v.codigo, "pt-BR")));
  for (const { v, realPct } of abaixo) {
    avisos.push({
      chave: `margem:${v.viagemId}`,
      tipo: "margem",
      titulo: `${v.codigo} abaixo da margem de referência`,
      detalhe: `${v.cliente}: margem real de ${formatarPercentual(realPct)}, referência de ${formatarPercentual(d.referencia)}`,
      passo: PASSO_AVISO.margem,
      setor: RESPONSAVEL_AVISO.margem,
      href: `/viagens/${v.viagemId}`,
      dispensavel: true,
    });
  }

  if (aguardando > 0) {
    avisos.push(avisoAgregado("aprovacao", plural(aguardando, "pedido aguardando aprovação", "pedidos aguardando aprovação"), "Decidir em Aprovações", "/aprovacoes"));
  }
  return avisos;
}
