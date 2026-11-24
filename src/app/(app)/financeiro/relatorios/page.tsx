import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { AVISO_PERIODO_INVALIDO, rotuloMes, rotuloPeriodoMeses, RELATORIOS, RELATORIOS_TIPOS } from "@/domain/paineis";
import { somarMeses } from "@/domain/venda";
import { ErroAcesso } from "@/server/auth";
import { carregarRelatorio, nomeDoConsultor, parametrosDoRelatorio, type RelatorioCarregado } from "@/server/relatorios";
import { hojeEmCuiaba } from "@/domain/clientes";
import { TabelaRelatorio } from "./tabelas";

// Não importar `inputCls` de "@/components/ui": o módulo é "use client" e, numa página de servidor, a constante vira referência de cliente.
const campoCls = "rounded-[5px] border border-[#C9CDD1] bg-white px-3 py-2 text-[14px] text-texto outline-none focus:border-verde";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** Meses de dois anos atrás a um ano à frente, mais os escolhidos (a URL pode trazer um de fora). */
function opcoesDeMes(hoje: string, escolhidos: string[]): string[] {
  const base = `${hoje.slice(0, 7)}-01`;
  const lista = new Set<string>(escolhidos);
  for (let n = -24; n <= 12; n++) lista.add(somarMeses(base, n).slice(0, 7));
  return [...lista].sort();
}

// Defesa em profundidade: o proxy já barra, mas a tela não depende só dele.
export default async function Pagina({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const hoje = hojeEmCuiaba();
  const { rel, periodo, consultorId } = parametrosDoRelatorio(await searchParams, hoje);
  const { intervalo } = periodo;
  let carregado: RelatorioCarregado;
  let nomeConsultor: string | undefined;
  try {
    carregado = await carregarRelatorio(rel, intervalo, consultorId);
    if (consultorId) nomeConsultor = await nomeDoConsultor(intervalo, consultorId);
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }

  const periodoUrl = `de=${periodo.de}&ate=${periodo.ate}`;
  const query = `rel=${rel}&${periodoUrl}${consultorId ? `&consultor=${consultorId}` : ""}`;
  const rotuloPeriodo = rotuloPeriodoMeses(periodo.de, periodo.ate);
  const meses = opcoesDeMes(hoje, [periodo.de, periodo.ate]);
  const botao = "inline-flex items-center rounded-[5px] border border-[#C9CDD1] bg-white px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde";

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader title="Relatórios" subtitle="Os relatórios seguem o nível de acesso de quem abre." />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[280px_1fr]">
        <nav aria-label="Relatórios" className="self-start rounded-[6px] border border-linha bg-white p-2">
          {RELATORIOS_TIPOS.map((r) => (
            <Link
              key={r}
              href={`/financeiro/relatorios?rel=${r}&${periodoUrl}`}
              aria-current={r === rel ? "page" : undefined}
              className={cx("block rounded-[5px] px-4 py-3", r === rel ? "bg-verde/[0.08]" : "hover:bg-fundo")}
            >
              <span className="block text-[14.5px] font-semibold text-texto">{RELATORIOS[r].nome}</span>
              <span className="block text-[12.5px] text-cinza">{RELATORIOS[r].descricao}</span>
            </Link>
          ))}
        </nav>

        <div>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="rel" value={rel} />
            {consultorId && <input type="hidden" name="consultor" value={consultorId} />}
            <label className="text-[13px] text-cinza">
              De
              <select name="de" defaultValue={periodo.de} className={cx(campoCls, "mt-1")}>
                {meses.map((m) => <option key={m} value={m}>{rotuloMes(m)}</option>)}
              </select>
            </label>
            <label className="text-[13px] text-cinza">
              Até
              <select name="ate" defaultValue={periodo.ate} className={cx(campoCls, "mt-1")}>
                {meses.map((m) => <option key={m} value={m}>{rotuloMes(m)}</option>)}
              </select>
            </label>
            <button type="submit" className="cursor-pointer rounded-[5px] bg-verde px-3.5 py-2 text-[14px] font-semibold text-white hover:bg-[#254B5C]">Aplicar</button>
            <span className="ml-auto flex gap-2">
              {/* Download de arquivo: link comum (não `next/link`, que tentaria navegar pelo roteador). */}
              <a href={`/financeiro/relatorios/planilha?${query}`} download className={botao}>Planilha</a>
              <Link href={`/financeiro/relatorios/imprimir?${query}`} target="_blank" className={botao}>PDF</Link>
            </span>
          </form>
          {periodo.invalido && (
            <p role="status" className="mb-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
              {AVISO_PERIODO_INVALIDO}
            </p>
          )}
          {consultorId && (
            <p className="mb-4 text-[14px] text-cinza">
              Só as viagens de <b className="font-semibold text-texto">{nomeConsultor ?? "um consultor"}</b>.{" "}
              <Link href={`/financeiro/relatorios?rel=margens&${periodoUrl}`} className="font-semibold text-verde underline underline-offset-[3px]">Ver todas</Link>
            </p>
          )}
          <Card>
            <CardHeader eyebrow={rotuloPeriodo} title={RELATORIOS[rel].nome} />
            <TabelaRelatorio carregado={carregado} intervalo={intervalo} links />
            <p className="px-6 pb-5 pt-3 text-[13px] text-cinza">Cada linha com link abre os lançamentos ou a viagem que formam o valor.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}
