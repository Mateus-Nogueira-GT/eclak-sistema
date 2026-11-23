"use client";

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { cx } from "./ui";

export function SoGestao({ children }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-semibold text-cinza">
      <Lock size={12} /> {children ?? "Somente gestão"}
    </span>
  );
}

/** Tabela simples: cabeçalho em caixa alta azul, números à direita, linha de total em azul e negrito. */
export function Grade({
  head,
  rows,
  right = [],
  foot,
  destaque,
  estrategicoDe,
  className,
  compacta,
}: {
  head: ReactNode[];
  rows: ReactNode[][];
  right?: number[];
  foot?: ReactNode[];
  destaque?: (i: number) => boolean;
  /** índice da primeira coluna de visão estratégica (fundo azul claro) */
  estrategicoDe?: number;
  className?: string;
  compacta?: boolean;
}) {
  const pad = compacta ? "px-2.5 py-2" : "px-4 py-3";
  const tam = compacta ? "whitespace-nowrap text-[12.5px]" : "text-[14px]";
  const estr = (i: number) => estrategicoDe !== undefined && i >= estrategicoDe;
  return (
    <div className={cx("overflow-x-auto", className)}>
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} className={cx(pad, "whitespace-nowrap border-y border-linha text-[11px] font-bold uppercase tracking-[0.05em] text-verde", right.includes(i) ? "text-right" : "text-left", estr(i) ? "bg-verde/[0.09]" : "bg-fundo")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className={cx("border-b border-linha last:border-0 hover:bg-fundo/70", destaque?.(ri) && "bg-ouro/15 hover:bg-ouro/15")}>
              {r.map((c, i) => (
                <td key={i} className={cx(pad, tam, right.includes(i) ? "num text-right" : "text-left", estr(i) && !destaque?.(ri) && "bg-verde/[0.04]")}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot>
            <tr className="border-t-2 border-verde">
              {foot.map((c, i) => (
                <td key={i} className={cx(pad, tam, "font-bold text-verde", right.includes(i) ? "num text-right" : "text-left")}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function Linha({ rotulo, children }: { rotulo: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-linha/80 py-2.5 last:border-0">
      <span className="text-[13.5px] text-cinza">{rotulo}</span>
      <span className="num text-right text-[14px] font-semibold text-texto">{children}</span>
    </div>
  );
}

/** "19.0", "-3.25" → milésimos inteiros (sem ponto flutuante). */
function milesimos(p: string): bigint {
  const neg = p.trim().startsWith("-");
  const [i, d = ""] = p.trim().replace("-", "").split(".");
  const v = BigInt(i || "0") * 1000n + BigInt(d.padEnd(3, "0").slice(0, 3));
  return neg ? -v : v;
}

/**
 * Margem frente à alvo e à referência dos Parâmetros (`margemAlvoPct`, `margemReferenciaPct`). Sem vermelho:
 * abaixo do alvo é ouro. Percentuais em texto ("19.0", "19.000").
 */
export function Semaforo({ margemPct, alvoPct, referenciaPct }: { margemPct: string; alvoPct: string; referenciaPct: string }) {
  const m = milesimos(margemPct);
  const [cor, texto] =
    m >= milesimos(alvoPct) ? ["bg-agua", "No alvo"] : m >= milesimos(referenciaPct) ? ["bg-ouro", "Abaixo do alvo"] : ["bg-ouro", "Abaixo da referência"];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-semibold text-texto">
      <span className={cx("h-2.5 w-2.5 rounded-full", cor)} /> {texto}
    </span>
  );
}
