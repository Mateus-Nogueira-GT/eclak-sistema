import Link from "next/link";
import { redirect } from "next/navigation";
import { Grade } from "@/components/kit";
import { BotaoLink, Card } from "@/components/ui";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { diferencaPp, pctAbaixoDe, ppBr as pp, PERIODOS_PAINEL, ROTULO_PERIODO, type PeriodoPainel } from "@/domain/paineis";
import { ErroAcesso } from "@/server/auth";
import { obterVisaoGeral, type VisaoGeral } from "@/server/queries/paineis";

type Busca = { periodo?: string | string[] };

// `cx` de ui.tsx é de cliente: não pode ser chamado neste Server Component.
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const dataBr = (iso: string) => iso.split("-").reverse().join("/");
const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`;

function periodoDaUrl(v: string | string[] | undefined): PeriodoPainel {
  const p = Array.isArray(v) ? v[0] : v;
  return PERIODOS_PAINEL.find((x) => x === p) ?? "30d";
}

// Defesa em profundidade: o proxy já barra, mas a tela não depende só dele.
export default async function Pagina({ searchParams }: { searchParams: Promise<Busca> }) {
  const periodo = periodoDaUrl((await searchParams).periodo);
  let v: VisaoGeral;
  try {
    v = await obterVisaoGeral(periodo);
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }
  const referencia = formatarPercentual(v.margemReferenciaPct);

  return (
    <div className="mx-auto max-w-[1440px]">
      <div className="grid grid-cols-1 gap-x-14 gap-y-10 lg:grid-cols-[1fr_380px]">
        <div>
          <h1 className="titulo max-w-[26ch] text-[30px] leading-[1.12] text-texto sm:text-[40px]">
            {v.primeiraNegativa ? <>O caixa fica negativo na semana de {v.primeiraNegativa.rotulo}.</> : <>O caixa fica positivo nas próximas 8 semanas.</>}
          </h1>
          <p className="mt-4 max-w-[62ch] text-[17px] leading-relaxed text-texto">
            {v.primeiraNegativa && (
              <>
                O saldo projetado chega a <b className="num">{formatarReais(v.primeiraNegativa.saldoFinal)}</b>.{" "}
              </>
            )}
            {v.viagensAbaixoReferencia > 0
              ? `${plural(v.viagensAbaixoReferencia, "viagem está", "viagens estão")} abaixo da margem de referência de ${referencia}.`
              : `Nenhuma viagem está abaixo da margem de referência de ${referencia}.`}{" "}
            Abaixo está o que pede decisão hoje.
          </p>

          <h2 className="mt-10 text-[16px] font-bold text-texto">Para decidir hoje</h2>
          <ul className="mt-3 border-t border-linha">
            {v.avisos.map((a, i) => (
              <li key={`${a.tipo}-${i}`} className="grid grid-cols-[1fr_auto] items-center gap-6 border-b border-linha py-4">
                <div>
                  <p className="text-[15.5px] font-bold text-texto">{a.titulo}</p>
                  <p className="mt-0.5 text-[14px] leading-relaxed text-cinza">
                    {a.detalhe}. Responsável: {a.responsavel}.
                  </p>
                </div>
                <Link href={a.href} className="whitespace-nowrap rounded-[5px] border border-[#C9CDD1] px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde">
                  {a.agregado ? "Abrir a lista" : "Abrir"}
                </Link>
              </li>
            ))}
            {v.avisos.length === 0 && <li className="border-b border-linha py-6 text-[15px] text-cinza">Nada pede decisão agora.</li>}
          </ul>
          {v.avisosOcultos.length > 0 && (
            <div className="mt-3 text-[13.5px] text-cinza">
              <p>e mais {plural(v.avisosOcultos.length, "aviso", "avisos")}:</p>
              <ul className="mt-1 space-y-1">
                {v.avisosOcultos.map((a, i) => (
                  <li key={`${a.tipo}-${i}`}>
                    <Link href={a.href} className="font-semibold text-verde underline decoration-verde/30 underline-offset-[3px] hover:decoration-verde">
                      {a.titulo}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <aside>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[16px] font-bold text-texto">No período</h2>
            <nav aria-label="Período" className="flex flex-wrap gap-1">
              {PERIODOS_PAINEL.map((p) => (
                <Link
                  key={p}
                  href={`/visao-geral?periodo=${p}`}
                  aria-current={p === periodo ? "page" : undefined}
                  className={cx("rounded-[5px] px-2.5 py-1 text-[13px]", p === periodo ? "bg-verde font-bold text-white" : "font-medium text-cinza hover:bg-fundo hover:text-texto")}
                >
                  {ROTULO_PERIODO[p]}
                </Link>
              ))}
            </nav>
          </div>
          <p className="mt-1 text-[13px] text-cinza">
            {ROTULO_PERIODO[periodo]}, de {dataBr(v.intervalo.de)} a {dataBr(v.intervalo.ate)}
          </p>
          <dl className="mt-4 border-t-2 border-verde">
            {resumo(v).map((x) => (
              <div key={x.k} className="flex items-baseline justify-between gap-4 border-b border-linha py-3.5">
                <dt>
                  <span className="block text-[14.5px] font-semibold text-texto">{x.k}</span>
                  <span className="block text-[12.5px] text-cinza">{x.sub}</span>
                </dt>
                <dd className={cx("num whitespace-nowrap font-bold", x.forte ? "text-[24px]" : "text-[19px]", x.ruim ? "text-ouro" : "text-verde")}>{x.v}</dd>
              </div>
            ))}
          </dl>
          <Reserva reserva={v.reserva} />
        </aside>
      </div>

      <section className="mt-14">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h2 className="text-[16px] font-bold text-texto">Saldo de caixa, semana a semana</h2>
            <p className="mt-0.5 text-[13.5px] text-cinza">Projeção das próximas 8 semanas, com viagens e custos da empresa.</p>
          </div>
          <BotaoLink href="/financeiro/caixa">Abrir o fluxo de caixa</BotaoLink>
        </div>
        <Semanas semanas={v.semanas} />
      </section>

      <section className="mt-14">
        <div className="flex items-end justify-between gap-6">
          <div>
            <h2 className="text-[16px] font-bold text-texto">Viagens que mais perderam margem</h2>
            <p className="mt-0.5 text-[13.5px] text-cinza">Diferença entre a margem planejada na venda e a margem real, com os custos já lançados. Só viagens ainda não conciliadas.</p>
          </div>
          <BotaoLink href="/viagens">Ver todas as viagens</BotaoLink>
        </div>
        {v.perdas.length === 0 ? (
          <p className="mt-4 border-y border-linha py-6 text-[14.5px] text-cinza">Nenhuma viagem está com a margem real abaixo da planejada.</p>
        ) : (
          <Card className="mt-4">
            <Grade
              right={[2, 3, 4, 5]}
              head={["Cliente", "Destino", "Valor vendido", "Planejada", "Real", "Diferença", ""]}
              rows={v.perdas.map((p) => [
                <b key="c" className="font-semibold">
                  {p.cliente} <span className="font-normal text-cinza">{p.codigo}</span>
                </b>,
                <span key="d" className="text-cinza">{p.destino}</span>,
                <span key="v" className="num">{formatarReais(p.vendido)}</span>,
                <span key="p" className="num">{formatarPercentual(p.planejadaPct)}</span>,
                <b key="r" className={cx("num", pctAbaixoDe(p.realPct, v.margemReferenciaPct) ? "text-ouro" : "text-verde")}>{formatarPercentual(p.realPct)}</b>,
                <span key="x" className="num font-semibold text-ouro">{pp(p.diferencaPp)}</span>,
                <BotaoLink key="l" href={`/viagens/${p.viagemId}`}>Abrir</BotaoLink>,
              ])}
            />
          </Card>
        )}
      </section>
    </div>
  );
}

function resumo(v: VisaoGeral) {
  const variacao =
    v.variacaoVendidoPct === null
      ? "sem base de comparação"
      : `${v.variacaoVendidoPct.startsWith("-") ? "" : "+"}${formatarPercentual(v.variacaoVendidoPct)} sobre o período anterior`;
  const margem =
    v.margemRealPct === null || v.margemPlanejadaPct === null
      ? { v: "sem dados", sub: "nenhuma viagem com margem real calculada no período", ruim: false }
      : (() => {
          const dif = diferencaPp(v.margemRealPct, v.margemPlanejadaPct);
          return {
            v: formatarPercentual(v.margemRealPct),
            sub: `planejada ${formatarPercentual(v.margemPlanejadaPct)}, diferença de ${pp(dif)}`,
            ruim: dif.startsWith("-"),
          };
        })();
  return [
    { k: "Vendido", v: formatarReais(v.vendido), sub: `${plural(v.viagensVendidas, "viagem", "viagens")} pelo aceite da venda, ${variacao}`, ruim: false, forte: false },
    { k: "Margem real", v: margem.v, sub: margem.sub, ruim: margem.ruim, forte: false },
    { k: "Recebido de clientes", v: formatarReais(v.recebido), sub: "pelas baixas no período, líquido da taxa", ruim: false, forte: false },
    { k: "Pago a fornecedores", v: formatarReais(v.pago), sub: "pelas baixas no período", ruim: false, forte: false },
    { k: "Resultado de caixa", v: formatarReais(v.resultadoCaixa), sub: "recebido menos pago", ruim: v.resultadoCaixa < 0n, forte: true },
  ];
}

function Reserva({ reserva: r }: { reserva: VisaoGeral["reserva"] }) {
  const pct = r.meta <= 0n ? 100 : r.temos <= 0n ? 0 : Number(r.temos >= r.meta ? 100n : (r.temos * 100n) / r.meta);
  return (
    <div className="mt-6 rounded-[6px] bg-fundo p-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[14.5px] font-semibold text-texto">Reserva de caixa</span>
        <span className="num text-[13px] text-cinza">{pct}% da meta</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-white" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Reserva atingida">
        <div className="h-full rounded-full bg-verde" style={{ width: `${pct}%` }} />
      </div>
      {/* `num` só nos valores: no parágrafo inteiro ele impede a quebra de linha e o texto sai do cartão. */}
      <p className="mt-2 text-[13px] leading-relaxed text-cinza">
        <span className="num">{formatarReais(r.temos)}</span> de <span className="num">{formatarReais(r.meta)}</span> (6 meses de custo fixo).{" "}
        {r.falta === 0n ? (
          "A reserva já está na meta."
        ) : (
          <>
            Faltam <span className="num">{formatarReais(r.falta)}</span>.
          </>
        )}
      </p>
    </div>
  );
}

function Semanas({ semanas }: { semanas: VisaoGeral["semanas"] }) {
  let teto = 1n;
  for (const w of semanas) {
    const a = w.saldoFinal < 0n ? -w.saldoFinal : w.saldoFinal;
    if (a > teto) teto = a;
  }
  return (
    <div className="mt-4 grid grid-cols-2 border-y border-linha sm:grid-cols-4 lg:grid-cols-8">
      {semanas.map((w, i) => {
        const neg = w.saldoFinal < 0n;
        const abs = neg ? -w.saldoFinal : w.saldoFinal;
        const razao = Number((abs * 1000n) / teto) / 1000;
        return (
          <div key={w.inicio} className={cx("px-3 py-4", i > 0 && "border-l border-linha", neg && "bg-ouro/[0.08]")}>
            <p className="text-[12.5px] text-cinza">Semana de</p>
            <p className="num text-[14px] font-semibold text-texto">{w.rotulo}</p>
            <div className="mt-3 flex h-[76px] items-end">
              <div className={cx("w-full rounded-t-[2px]", neg ? "bg-ouro" : "bg-verde")} style={{ height: Math.max(4, Math.round(razao * 72)), opacity: neg ? 1 : 0.35 + 0.65 * razao }} />
            </div>
            <p className={cx("num mt-2 text-[14.5px] font-bold", neg ? "text-ouro" : "text-verde")}>{formatarReais(w.saldoFinal)}</p>
            <p className="num text-[12px] text-cinza">entra {formatarReais(w.entradas)}</p>
            <p className="num text-[12px] text-cinza">sai {formatarReais(w.saidas)}</p>
          </div>
        );
      })}
    </div>
  );
}
