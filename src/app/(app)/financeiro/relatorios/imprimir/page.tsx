import { redirect } from "next/navigation";
import { hojeEmCuiaba } from "@/domain/clientes";
import { rotuloPeriodoMeses, RELATORIOS } from "@/domain/paineis";
import { ErroAcesso } from "@/server/auth";
import { carregarRelatorio, parametrosDoRelatorio, type RelatorioCarregado } from "@/server/relatorios";
import { BotaoImprimir } from "../../../viagens/[id]/proposta/imprimir";
import { dataBr } from "../../../viagens/formatos";
import { TabelaRelatorio } from "../tabelas";


// Impressão do relatório: só o título, o período e a tabela, sem links.
export default async function Pagina({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const hoje = hojeEmCuiaba();
  const { rel, periodo, consultorId } = parametrosDoRelatorio(await searchParams, hoje);
  let carregado: RelatorioCarregado;
  try {
    carregado = await carregarRelatorio(rel, periodo.intervalo, consultorId);
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
      </header>
      <TabelaRelatorio carregado={carregado} intervalo={periodo.intervalo} links={false} />
    </article>
  );
}
