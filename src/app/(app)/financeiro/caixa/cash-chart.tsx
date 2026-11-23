import type { PeriodoCaixa } from "@/domain/caixa";
import { formatarReais } from "@/domain/dinheiro";

// Cores da marca (sem vermelho): entradas no azul, saídas em cinza azulado, saldo em laranja (o destaque),
// saldo negativo em ouro.
const AZUL = "#2E5C71";
const SAIDA = "#A9B8C0";
const LARANJA = "#F26531";
const OURO = "#D9A441";
const GRADE = "#E1E3E5";
const CINZA = "#6B7A86";

/** Valor do eixo em "12k" / "-3k" (só a escala do gráfico usa número; os rótulos exatos vêm em reais). */
const k = (centavos: number) => `${Math.round(centavos / 100_000)}k`;

/** Barras de entradas e saídas por período e a linha do saldo no fim de cada um. SVG puro, sem biblioteca. */
export function CashChart({ periodos, altura = 280 }: { periodos: PeriodoCaixa[]; altura?: number }) {
  const largura = 1000;
  const m = { topo: 16, dir: 16, base: 28, esq: 56 };
  const w = largura - m.esq - m.dir;
  const h = altura - m.topo - m.base;
  const valores = periodos.flatMap((p) => [Number(p.entradas), Number(p.saidas), Number(p.saldoFinal)]);
  // Escala com passo "redondo" (1, 2, 2,5 ou 5 × 10ⁿ reais), para o eixo mostrar 10k, 20k... e não 27k.
  const bruto = Math.max(Math.max(0, ...valores) - Math.min(0, ...valores), 100_000) / 4;
  const mag = 10 ** Math.floor(Math.log10(bruto));
  const passoY = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((p) => p >= bruto)!;
  const min = Math.floor(Math.min(0, ...valores) / passoY) * passoY;
  const max = Math.max(min + passoY, Math.ceil(Math.max(0, ...valores) / passoY) * passoY);
  const y = (v: number) => m.topo + ((max - v) / (max - min)) * h;
  const passo = w / Math.max(1, periodos.length);
  const barra = Math.min(28, passo / 3.2);
  const cx = (i: number) => m.esq + passo * i + passo / 2;
  const marcas = Array.from({ length: Math.round((max - min) / passoY) + 1 }, (_, i) => min + passoY * i);
  const linha = periodos.map((p, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${y(Number(p.saldoFinal)).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${largura} ${altura}`} className="h-auto w-full" role="img" aria-label="Entradas, saídas e saldo por período">
      {marcas.map((v) => (
        <g key={v}>
          <line x1={m.esq} x2={largura - m.dir} y1={y(v)} y2={y(v)} stroke={GRADE} />
          <text x={m.esq - 8} y={y(v) + 4} textAnchor="end" fontSize={12} fill={CINZA}>
            {k(v)}
          </text>
        </g>
      ))}
      <line x1={m.esq} x2={largura - m.dir} y1={y(0)} y2={y(0)} stroke={AZUL} strokeOpacity={0.4} />
      {periodos.map((p, i) => {
        const e = Number(p.entradas);
        const s = Number(p.saidas);
        return (
          <g key={p.inicio}>
            <rect x={cx(i) - barra - 2} y={y(e)} width={barra} height={Math.max(0, y(0) - y(e))} rx={3} fill={AZUL}>
              <title>{`${p.rotulo}: entradas ${formatarReais(p.entradas)}`}</title>
            </rect>
            <rect x={cx(i) + 2} y={y(s)} width={barra} height={Math.max(0, y(0) - y(s))} rx={3} fill={SAIDA}>
              <title>{`${p.rotulo}: saídas ${formatarReais(p.saidas)}`}</title>
            </rect>
            <text x={cx(i)} y={altura - 8} textAnchor="middle" fontSize={12} fill={CINZA}>
              {p.rotulo}
            </text>
          </g>
        );
      })}
      <path d={linha} fill="none" stroke={LARANJA} strokeWidth={2.5} />
      {periodos.map((p, i) => {
        const neg = p.saldoFinal < 0n;
        return (
          <circle key={p.inicio} cx={cx(i)} cy={y(Number(p.saldoFinal))} r={neg ? 6 : 4} fill={neg ? OURO : LARANJA} stroke="#fff" strokeWidth={2}>
            <title>{`${p.rotulo}: saldo ${formatarReais(p.saldoFinal)}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

export function LegendaCaixa() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-cinza">
      <span className="flex items-center gap-1.5">
        <i className="h-2.5 w-2.5 rounded-sm" style={{ background: AZUL }} /> Entradas
      </span>
      <span className="flex items-center gap-1.5">
        <i className="h-2.5 w-2.5 rounded-sm" style={{ background: SAIDA }} /> Saídas
      </span>
      <span className="flex items-center gap-1.5">
        <i className="h-0.5 w-4 rounded" style={{ background: LARANJA }} /> Saldo no fim
      </span>
      <span className="flex items-center gap-1.5">
        <i className="h-2.5 w-2.5 rounded-full" style={{ background: OURO }} /> Saldo negativo
      </span>
    </div>
  );
}
