import "server-only";
import { PASSO_AVISO_CENTRAL, perfisDoSetor, SETOR_DO_TIPO, type AvisoCentral } from "@/domain/avisos";
import { CENTROS } from "@/domain/financeiro";
import { exigirPerfil } from "@/server/auth";
import { listarEstoque } from "@/server/queries/estoque";

/**
 * Aviso do setor Financeiro (spec 5b §8.3): produto ativo abaixo do mínimo numa filial (sem saldo conta como 0), um
 * por produto e filial, pela ordem da tela do Estoque. Chave `estoque_minimo:<produto>:<filial>`.
 */
export async function avisosDeEstoque(): Promise<AvisoCentral[]> {
  await exigirPerfil(...perfisDoSetor("Financeiro"));
  const { produtos } = await listarEstoque({});
  const avisos: AvisoCentral[] = [];
  for (const p of produtos) {
    for (const filial of CENTROS) {
      const s = filial === "MT" ? p.mt : p.rs;
      if (!s.abaixo) continue;
      avisos.push({
        chave: `estoque_minimo:${p.id}:${filial}`,
        tipo: "estoque_minimo",
        titulo: `${p.nome} abaixo do mínimo em ${filial}`,
        detalhe: `${s.quantidade} em estoque, mínimo de ${s.minimo}`,
        passo: PASSO_AVISO_CENTRAL.estoque_minimo,
        setor: SETOR_DO_TIPO.estoque_minimo,
        href: `/financeiro/estoque?${new URLSearchParams({ filial, abaixo: "1" }).toString()}`,
        dispensavel: true,
      });
    }
  }
  return avisos;
}
