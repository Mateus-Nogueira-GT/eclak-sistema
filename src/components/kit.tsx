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

export function Semaforo({ margem }: { margem: number }) {
  const [cor, texto] = margem >= 25 ? ["bg-agua", "Na meta"] : margem >= 19 ? ["bg-ouro", "No alvo"] : ["bg-alerta", "Abaixo do alvo"];
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-semibold text-texto">
      <span className={cx("h-2.5 w-2.5 rounded-full", cor)} /> {texto}
    </span>
  );
}
