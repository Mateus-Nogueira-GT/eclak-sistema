import { Badge, Card, CardHeader, Eyebrow, PageHeader } from "@/components/ui";
import { Grade } from "@/components/kit";
import { TIPOS_CAIXA, type PeriodoCaixa, type TipoCaixa } from "@/domain/caixa";
import { formatarReais } from "@/domain/dinheiro";
import { CENTROS, type Centro } from "@/domain/financeiro";
import { ehUuid } from "@/server/acesso";
import { obterFluxoDeCaixa, viagensDoCaixa, type FluxoDeCaixa } from "@/server/queries/caixa";
import { CashChart, LegendaCaixa } from "./cash-chart";
import { FiltrosCaixa, type FiltroTela } from "./filtros";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
// `cx` de ui.tsx é de cliente: não pode ser chamado neste Server Component.
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
const dataBr = (iso: string) => iso.split("-").reverse().join("/");

/** Filtros da URL; valor inválido é ignorado (vira "todos"). */
function filtroDaUrl(sp: Params): FiltroTela {
  const tipo = primeiro(sp.tipo);
  const centro = primeiro(sp.centro);
  const viagem = primeiro(sp.viagem);
  return {
    tipo: TIPOS_CAIXA.includes(tipo as TipoCaixa) ? (tipo as TipoCaixa) : undefined,
    centro: CENTROS.includes(centro as Centro) ? (centro as Centro) : undefined,
    viagemId: viagem && ehUuid(viagem) ? viagem : undefined,
  };
}

/** Percentual inteiro de `parte` sobre `todo`, entre 0 e 100 (bigint; nada de ponto flutuante no dinheiro). */
function pctDe(parte: bigint, todo: bigint): number {
  if (todo <= 0n) return 100;
  if (parte <= 0n) return 0;
  const p = (parte * 100n) / todo;
  return Number(p > 100n ? 100n : p);
}

const Saldo = ({ v, className }: { v: bigint; className?: string }) => (
  <b className={cx("num font-bold", v < 0n ? "text-ouro" : "text-verde", className)}>{formatarReais(v)}</b>
);

export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const filtro = filtroDaUrl(await searchParams);
  const [fluxo, viagens] = await Promise.all([obterFluxoDeCaixa(filtro), viagensDoCaixa()]);
  const filtrado = Boolean(filtro.tipo || filtro.centro || filtro.viagemId);
  return (
    <div className="mx-auto max-w-[1440px]">
      <PageHeader
        title="Fluxo de caixa"
        subtitle="O que está nas contas hoje e o que vai entrar e sair: parcelas dos clientes pelo líquido da taxa, fornecedores, comissões e as contas da empresa. O que venceu e não foi baixado entra na semana atual."
      />
      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <SaldoAtual fluxo={fluxo} />
        <Reserva fluxo={fluxo} />
      </div>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <h2 className="text-[16px] font-bold text-texto">Próximas 8 semanas</h2>
        <FiltrosCaixa filtro={filtro} viagens={viagens} />
      </div>
      {filtrado && (
        <p className="mb-4 text-[13.5px] text-cinza">
          Filtro aplicado só aos movimentos: o saldo de partida é o de todas as contas ({formatarReais(fluxo.saldoAtual)}).
          {filtro.viagemId && " As compras desta viagem no cartão corporativo estão dentro das faturas do cartão (fora deste filtro)."}
        </p>
      )}

      <Card>
        <CardHeader eyebrow="Semana a semana, de segunda a domingo" title="Entradas, saídas e saldo projetado" right={<LegendaCaixa />} />
        <div className="px-4 pb-2 pt-4">
          <CashChart periodos={fluxo.semanas} />
        </div>
        <TabelaPeriodos periodos={fluxo.semanas} coluna="Semana" />
      </Card>

      <Card className="mt-5">
        <CardHeader eyebrow="Mês a mês, a partir do mês atual" title="Projeção de 12 meses" />
        {/* A meta de reserva compara com o saldo de todas as contas: com filtro, a coluna esconde (o card usa a projeção sem filtro). */}
        <TabelaPeriodos periodos={fluxo.meses} coluna="Mês" meta={filtrado ? undefined : fluxo.reserva.meta} />
      </Card>
    </div>
  );
}

function SaldoAtual({ fluxo }: { fluxo: FluxoDeCaixa }) {
  return (
    <Card className="p-6">
      <Eyebrow>Saldo atual</Eyebrow>
      <p className="mt-2">
        <Saldo v={fluxo.saldoAtual} className="text-[30px] tracking-tight" />
      </p>
      <p className="mt-1 text-[13.5px] text-cinza">
        Soma das {fluxo.contas.length === 1 ? "conta ativa" : `${fluxo.contas.length} contas ativas`} em {dataBr(fluxo.hoje)}: saldo inicial mais o que foi baixado nelas desde a data dele.
      </p>
      {fluxo.contas.length > 0 && (
        <details className="group mt-4 border-t border-linha pt-3">
          <summary className="cursor-pointer text-[13.5px] font-semibold text-verde hover:underline">Ver por conta</summary>
          <dl className="mt-2">
            {fluxo.contas.map((c) => (
              <div key={c.contaId} className="flex items-baseline justify-between gap-4 border-b border-linha py-2 last:border-b-0">
                <dt className="text-[14px] text-texto">{c.nome}</dt>
                <dd>
                  <Saldo v={c.saldoAtual} className="text-[15px]" />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </Card>
  );
}

function Reserva({ fluxo }: { fluxo: FluxoDeCaixa }) {
  const r = fluxo.reserva;
  const pct = pctDe(r.temos, r.meta);
  return (
    <Card className="p-6">
      <h2 className="text-[16px] font-bold text-texto">Reserva de caixa</h2>
      <p className="mt-0.5 text-[13.5px] text-cinza">Meta de 6 meses de custo fixo, pelo custo fixo mensal dos Parâmetros.</p>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-fundo" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Reserva atingida">
        <div className="h-full rounded-full bg-verde" style={{ width: `${pct}%` }} />
      </div>
      <p className="num mt-2 text-[13.5px] text-cinza">{pct}% da meta</p>
      <dl className="mt-3 border-t border-linha">
        {(
          [
            ["Meta (6 × custo fixo mensal)", r.meta],
            ["Quanto já temos", r.temos],
            ["Quanto falta", r.falta],
          ] as const
        ).map(([rotulo, v], i) => (
          <div key={rotulo} className="flex items-baseline justify-between gap-4 border-b border-linha py-2.5">
            <dt className="text-[14px] text-cinza">{rotulo}</dt>
            <dd className={cx("num font-bold", i === 2 ? "text-[19px] text-terracota" : "text-[15px]", i === 1 && v < 0n ? "text-ouro" : i !== 2 && "text-verde")}>{formatarReais(v)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[13.5px] text-texto">
        {r.falta === 0n ? (
          <>A reserva já está na meta.</>
        ) : r.atingidaEm ? (
          <>
            No ritmo projetado, a meta é atingida em <b>{r.atingidaEm}</b>.
          </>
        ) : (
          <>No ritmo projetado, a meta não é atingida nos próximos 12 meses.</>
        )}
      </p>
    </Card>
  );
}

function TabelaPeriodos({ periodos, coluna, meta }: { periodos: PeriodoCaixa[]; coluna: string; meta?: bigint }) {
  const head = [coluna, "Entradas", "Saídas", "Saldo no fim", ...(meta !== undefined ? ["Meta de reserva"] : [])];
  return (
    <Grade
      className="mt-3"
      right={[1, 2, 3, 4]}
      head={head}
      rows={periodos.map((p, i) => [
        <span key="p" className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <b className="font-semibold">{p.rotulo}</b>
          {i === 0 && p.vencidas > 0n && (
            <Badge tom="ouro" className="!text-[12.5px]">
              Inclui {formatarReais(p.vencidas)} vencidos em aberto
            </Badge>
          )}
        </span>,
        <span key="e" className="num">{formatarReais(p.entradas)}</span>,
        <span key="s" className="num">{formatarReais(p.saidas)}</span>,
        <Saldo key="f" v={p.saldoFinal} />,
        ...(meta !== undefined
          ? [
              <span key="r" className="flex items-center justify-end gap-2">
                <span className="h-1.5 w-[80px] overflow-hidden rounded-full bg-fundo">
                  <span className="block h-full bg-verde" style={{ width: `${pctDe(p.saldoFinal, meta)}%` }} />
                </span>
                <span className="num w-[38px] text-right text-[12px] text-cinza">{pctDe(p.saldoFinal, meta)}%</span>
              </span>,
            ]
          : []),
      ])}
    />
  );
}
