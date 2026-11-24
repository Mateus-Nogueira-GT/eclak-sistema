import "server-only";
import { hojeEmCuiaba } from "@/domain/clientes";
import {
  linhasCsv,
  nomeArquivoRelatorio,
  paraCsv,
  periodoDosRelatorios,
  RELATORIOS_TIPOS,
  type Intervalo,
  type PeriodoRelatorio,
  type Relatorio,
} from "@/domain/paineis";
import {
  relatorioBancos,
  relatorioConsultores,
  relatorioContas,
  relatorioDre,
  relatorioMargens,
  type LinhaMargem,
  type RelatorioBancos,
  type RelatorioConsultores,
  type RelatorioContas,
  type RelatorioDre,
} from "@/server/queries/paineis";

type Parametro = string | string[] | undefined;
const primeiro = (v: Parametro) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ParametrosRelatorio = { rel: Relatorio; periodo: PeriodoRelatorio; consultorId?: string };

/** Parâmetros da URL das telas e da planilha: relatório (padrão DRE), meses `de`/`ate` e, na margem, `consultor`. */
export function parametrosDoRelatorio(params: Record<string, Parametro>, hoje: string = hojeEmCuiaba()): ParametrosRelatorio {
  const rel = RELATORIOS_TIPOS.find((r) => r === primeiro(params.rel)) ?? "dre";
  const consultor = primeiro(params.consultor);
  return {
    rel,
    periodo: periodoDosRelatorios(primeiro(params.de), primeiro(params.ate), hoje),
    consultorId: rel === "margens" && consultor && UUID.test(consultor) ? consultor : undefined,
  };
}

type Lidos = {
  dre: RelatorioDre;
  pagar: RelatorioContas;
  receber: RelatorioContas;
  bancos: RelatorioBancos;
  margens: LinhaMargem[];
  consultores: RelatorioConsultores;
};
export type RelatorioCarregado = { [R in Relatorio]: { rel: R; dados: Lidos[R] } }[Relatorio];

function ler<R extends Relatorio>(rel: R, i: Intervalo, consultorId?: string): Promise<Lidos[R]> {
  const lido = (() => {
    switch (rel) {
      case "dre":
        return relatorioDre(i);
      case "pagar":
      case "receber":
        return relatorioContas(rel, i);
      case "bancos":
        return relatorioBancos(i);
      case "margens":
        return relatorioMargens(i, consultorId);
      case "consultores":
        return relatorioConsultores(i);
    }
  })();
  return lido as Promise<Lidos[R]>;
}

/** Lê o relatório (cada leitura exige o perfil financeiro; sem ele lança `ErroAcesso`). */
export async function carregarRelatorio(rel: Relatorio, i: Intervalo, consultorId?: string): Promise<RelatorioCarregado> {
  return { rel, dados: await ler(rel, i, consultorId) } as RelatorioCarregado;
}

/** O CSV e o nome do arquivo de um relatório, pelos mesmos parâmetros da tela. Lança `ErroAcesso` sem o perfil. */
export async function gerarCsv(params: ParametrosRelatorio): Promise<{ nome: string; corpo: string }> {
  const { rel, periodo, consultorId } = params;
  const dados = await ler(rel, periodo.intervalo, consultorId);
  const { cabecalho, linhas } = linhasCsv(rel, dados);
  return { nome: nomeArquivoRelatorio(rel, periodo.de, periodo.ate, consultorId !== undefined), corpo: paraCsv(cabecalho, linhas) };
}

/** Nome do consultor do filtro da margem por viagem (pelas vendas dele no intervalo); exige o perfil financeiro. */
export async function nomeDoConsultor(i: Intervalo, consultorId: string): Promise<string | undefined> {
  return (await relatorioConsultores(i)).linhas.find((l) => l.consultorId === consultorId)?.nome;
}
