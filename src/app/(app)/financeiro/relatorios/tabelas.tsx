import Link from "next/link";
import { Grade } from "@/components/kit";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { CABECALHOS, ppBr, ROTULO_RECEITA_VIAGENS, SEM_CALCULO, SEM_MARGEM, type Intervalo } from "@/domain/paineis";
import type { RelatorioCarregado } from "@/server/relatorios";
import { dataBr } from "../../viagens/formatos";

// `cx` de ui.tsx é de cliente: não pode ser chamado neste Server Component.
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Valor em reais; negativo em ouro (nunca vermelho). */
function Valor({ c, forte }: { c: bigint; forte?: boolean }) {
  return <span className={cx("num", forte && "font-bold", c < 0n ? "text-ouro" : forte && "text-verde")}>{formatarReais(c)}</span>;
}

const tipoLink = "font-semibold text-verde underline decoration-verde/30 underline-offset-[3px] hover:decoration-verde";
const mes = (data: string) => data.slice(0, 7);

/** Lançamentos de uma conta bancária pelas baixas do período. */
export function hrefConta(contaId: string, i: Intervalo) {
  return `/financeiro/lancamentos?lado=todos&base=baixa&de=${i.de}&ate=${i.ate}&contaBancariaId=${contaId}`;
}
/** Conciliação de uma conta no período (as datas da transação). */
export function hrefConciliacao(contaId: string, i: Intervalo) {
  return `/financeiro/conciliacao?conta=${contaId}&de=${i.de}&ate=${i.ate}`;
}
/** Margem por viagem do mesmo período (a origem da "Receita de viagens" da DRE). */
export function hrefMargens(i: Intervalo) {
  return `/financeiro/relatorios?rel=margens&de=${mes(i.de)}&ate=${mes(i.ate)}`;
}
/** Lançamentos manuais de uma categoria da DRE, pela competência do período, com as compras no cartão uma a uma. */
export function hrefCategoria(categoriaId: string, i: Intervalo) {
  return `/financeiro/lancamentos?lado=todos&base=competencia&origem=manual&de=${i.de}&ate=${i.ate}&categoriaId=${categoriaId}&compras=incluir`;
}

/**
 * As tabelas dos relatórios, as mesmas na tela (com links para os lançamentos e viagens) e na impressão (`links`
 * desligado: só a tabela).
 */
export function TabelaRelatorio({ carregado, intervalo, links }: { carregado: RelatorioCarregado; intervalo: Intervalo; links: boolean }) {
  const cab = CABECALHOS[carregado.rel];
  const Viagem = ({ id, codigo }: { id: string | null; codigo: string | null }) =>
    !codigo ? <span className="text-cinza">—</span> : links && id ? <Link href={`/viagens/${id}`} className={tipoLink}>{codigo}</Link> : <span className="num">{codigo}</span>;

  switch (carregado.rel) {
    case "dre": {
      const { linhas, semMargem } = carregado.dados;
      return (
        <>
          <p className="px-6 pt-1 text-[13px] text-cinza">Receita de viagens pela margem real (preço do pacote ± recebimentos); pode diferir do valor vendido.</p>
          <Grade
            className="mt-3"
            right={[1]}
            head={cab}
            rows={linhas.map((l) => [
              l.nivel === "categoria" && l.categoriaId && links ? (
                <Link key="l" href={hrefCategoria(l.categoriaId, intervalo)} className={cx(tipoLink, "pl-5")}>{l.rotulo}</Link>
              ) : l.rotulo === ROTULO_RECEITA_VIAGENS && links ? (
                <Link key="l" href={hrefMargens(intervalo)} className={tipoLink}>{l.rotulo}</Link>
              ) : (
                <span key="l" className={cx(l.nivel === "total" && "font-bold text-verde", l.nivel === "grupo" && "font-semibold", l.nivel === "categoria" && "pl-5 text-cinza")}>{l.rotulo}</span>
              ),
              <Valor key="v" c={l.valor} forte={l.nivel === "total"} />,
            ])}
          />
          {semMargem.length > 0 && (
            <p className="px-6 pb-2 pt-3 text-[13px] text-cinza">
              {semMargem.length === 1 ? "1 viagem do período está fora" : `${semMargem.length} viagens do período estão fora`} das linhas de viagem, por não ter a margem real calculada:{" "}
              {semMargem.map((v, i) => (
                <span key={v.viagemId}>
                  {i > 0 && ", "}
                  {links ? <Link href={`/viagens/${v.viagemId}`} className={tipoLink}>{v.codigo}</Link> : <span className="num">{v.codigo}</span>}
                </span>
              ))}
              .
            </p>
          )}
        </>
      );
    }
    case "pagar":
    case "receber": {
      const { linhas, totais } = carregado.dados;
      return (
        <>
          <Grade
            className="mt-3"
            right={[6]}
            head={cab}
            rows={linhas.map((l) => [
              <span key="v" className="num">{dataBr(l.vencimento)}</span>,
              <b key="p" className="font-semibold">{l.pessoa}</b>,
              l.descricao,
              <span key="c" className="text-cinza">{l.categoria}</span>,
              <Viagem key="vi" id={l.viagemId} codigo={l.viagemCodigo} />,
              <span key="s" className={cx(l.situacao === "Vencida" && "font-semibold text-ouro")}>{l.situacao}</span>,
              <Valor key="x" c={l.valor} />,
            ])}
          />
          {linhas.length === 0 && <p className="px-6 py-4 text-[14px] text-cinza">Nenhum lançamento com vencimento no período.</p>}
          {Object.keys(totais).length > 0 && (
            <dl className="mx-6 mt-3 max-w-[360px] border-t-2 border-verde">
              {Object.entries(totais).map(([situacao, v]) => (
                <div key={situacao} className="flex justify-between gap-4 border-b border-linha py-2 text-[14px]">
                  <dt className="font-semibold">Total {situacao.toLowerCase()}</dt>
                  <dd><Valor c={v} forte /></dd>
                </div>
              ))}
            </dl>
          )}
        </>
      );
    }
    case "bancos": {
      const { contas, total } = carregado.dados;
      return (
        <>
          <p className="px-6 pt-1 text-[13px] text-cinza">Inclui todas as baixas que passam pelo caixa (viagens e contas da empresa).</p>
          <Grade
            className="mt-3"
            right={[1, 2, 3, 4]}
            head={cab}
            rows={contas.map((c) => [
              links ? <Link key="n" href={hrefConta(c.contaId, intervalo)} className={tipoLink}>{c.nome}</Link> : <b key="n" className="font-semibold">{c.nome}</b>,
              <Valor key="e" c={c.entradas} />,
              <Valor key="s" c={c.saidas} />,
              <Valor key="p" c={c.saldoPeriodo} />,
              <Valor key="a" c={c.saldoAtual} />,
            ])}
            foot={["Total", <Valor key="e" c={total.entradas} forte />, <Valor key="s" c={total.saidas} forte />, <Valor key="p" c={total.saldoPeriodo} forte />, ""]}
          />
        </>
      );
    }
    case "margens": {
      const linhas = carregado.dados;
      return (
        <>
          <Grade
            className="mt-3"
            right={[3, 4, 5, 6]}
            head={cab}
            rows={linhas.map((l) => [
              <Viagem key="v" id={l.viagemId} codigo={l.codigo} />,
              <b key="c" className="font-semibold">{l.cliente}</b>,
              <span key="d" className="text-cinza">{l.destino}</span>,
              <Valor key="x" c={l.vendido} />,
              <span key="p" className="num">{formatarPercentual(l.planejadaPct)}</span>,
              l.realPct === null ? <span key="r" className="text-cinza" title={l.erro ?? undefined}>{SEM_CALCULO}</span> : <span key="r" className="num font-semibold">{formatarPercentual(l.realPct)}</span>,
              l.diferencaPp === null ? <span key="f" className="text-cinza">—</span> : <span key="f" className={cx("num font-semibold", l.diferencaPp.startsWith("-") ? "text-ouro" : "text-verde")}>{ppBr(l.diferencaPp)}</span>,
            ])}
          />
          {linhas.length === 0 && <p className="px-6 py-4 text-[14px] text-cinza">Nenhuma viagem com aceite no período.</p>}
        </>
      );
    }
    case "conciliacao": {
      const { linhas, totais } = carregado.dados;
      return (
        <>
          <p className="px-6 pt-1 text-[13px] text-cinza">Valores com sinal: entrada positiva, saída negativa. A diferença e a falta de par aparecem em ouro.</p>
          <Grade
            className="mt-3"
            right={[3, 4]}
            head={cab}
            rows={linhas.map((l) => [
              <span key="d" className="num">{dataBr(l.data)}</span>,
              links ? <Link key="c" href={hrefConciliacao(l.contaId, intervalo)} className={tipoLink}>{l.conta}</Link> : <b key="c" className="font-semibold">{l.conta}</b>,
              l.descricao,
              <Valor key="e" c={l.valorExtrato} />,
              l.valorSistema === null ? <span key="s" className="text-cinza">—</span> : <Valor key="s" c={l.valorSistema} />,
              <span key="t" className={cx(l.situacao !== "Confere" && l.situacao !== "Ignorado" && "font-semibold text-ouro")}>{l.situacao}</span>,
            ])}
          />
          {linhas.length === 0 && <p className="px-6 py-4 text-[14px] text-cinza">Nenhuma transação de extrato no período.</p>}
          {totais.length > 0 && (
            <dl className="mx-6 mt-3 max-w-[420px] border-t-2 border-verde">
              {totais.map((t) => (
                <div key={t.tipo} className="flex justify-between gap-4 border-b border-linha py-2 text-[14px]">
                  <dt className="font-semibold">{t.rotulo} <span className="num font-normal text-cinza">({t.qtd})</span></dt>
                  <dd><Valor c={t.valor} forte /></dd>
                </div>
              ))}
            </dl>
          )}
        </>
      );
    }
    case "consultores": {
      const { linhas, total } = carregado.dados;
      const margem = (p: string | null) => (p === null ? <span className="text-cinza">{SEM_MARGEM}</span> : <span className="num">{formatarPercentual(p)}</span>);
      return (
        <Grade
          className="mt-3"
          right={[1, 2, 3]}
          head={cab}
          rows={linhas.map((l) => [
            links ? (
              <Link key="n" href={`/financeiro/relatorios?rel=margens&consultor=${l.consultorId}&de=${mes(intervalo.de)}&ate=${mes(intervalo.ate)}`} className={tipoLink}>{l.nome}</Link>
            ) : (
              <b key="n" className="font-semibold">{l.nome}</b>
            ),
            <span key="v" className="num">{l.viagens}</span>,
            <Valor key="x" c={l.vendido} />,
            margem(l.margemPct),
          ])}
          foot={["Total", <span key="v" className="num font-bold text-verde">{total.viagens}</span>, <Valor key="x" c={total.vendido} forte />, margem(total.margemPct)]}
        />
      );
    }
  }
}
