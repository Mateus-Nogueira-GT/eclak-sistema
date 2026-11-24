import { redirect } from "next/navigation";
import { hojeEmCuiaba } from "@/domain/clientes";
import { AVISO_PERIODO_INVALIDO, rotuloPeriodoMeses, RELATORIOS } from "@/domain/paineis";
import { ErroAcesso } from "@/server/auth";
import { carregarRelatorio, parametrosDoRelatorio, type RelatorioCarregado } from "@/server/relatorios";
import { nomeDoConsultor } from "@/server/queries/paineis";
import { BotaoImprimir } from "../../../viagens/[id]/proposta/imprimir";
import { dataBr } from "../../../viagens/formatos";
import { TabelaRelatorio } from "../tabelas";

// Impressão do relatório: só o título, o período (e o consultor, se filtrado) e a tabela, sem links.
export default async function Pagina({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const hoje = hojeEmCuiaba();
  const { rel, periodo, consultorId } = parametrosDoRelatorio(await searchParams, hoje);
  let carregado: RelatorioCarregado;
  let nomeConsultor: string | undefined;
  try {
    carregado = await carregarRelatorio(rel, periodo.intervalo, consultorId);
    if (consultorId) nomeConsultor = await nomeDoConsultor(consultorId);
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }
  const rotulo = rotuloPeriodoMeses(periodo.de, periodo.ate);

  return (
    <article className="mx-auto max-w-[1000px] text-texto print:max-w-none">
      <style>{`@page { size: A4 landscape; margin: 14mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mb-6 flex justify-end print:hidden">
        <BotaoImprimir />
      </div>
      <header className="border-b-2 border-verde pb-3">
        <h1 className="titulo text-[24px] leading-tight">{RELATORIOS[rel].nome}</h1>
        <p className="text-[13px] text-cinza">
          {rotulo} (<span className="num">{dataBr(periodo.intervalo.de)}</span> a <span className="num">{dataBr(periodo.intervalo.ate)}</span>) · emitido em <span className="num">{dataBr(hoje)}</span>
        </p>
        {consultorId && nomeConsultor && <p className="text-[13px] text-texto">Consultor: {nomeConsultor}</p>}
        {periodo.invalido && <p className="mt-2 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{AVISO_PERIODO_INVALIDO}</p>}
      </header>
      <TabelaRelatorio carregado={carregado} intervalo={periodo.intervalo} links={false} />
    </article>
  );
}
