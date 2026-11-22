"use client";

import Link from "next/link";
import type { ReactNode, ButtonHTMLAttributes } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Card({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={cx("rounded-[6px] border border-linha bg-white", className)}>
      {children}
    </section>
  );
}

/** Rótulo de campo. Caixa alta por regra da marca (rótulos e cabeçalhos de tabela). */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("text-[11px] font-bold uppercase tracking-[0.06em] text-cinza", className)}>{children}</p>;
}

export function PageHeader({ title, subtitle, right }: { eyebrow?: string; title: string; subtitle?: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
      <div className="min-w-0">
        <h1 className="titulo text-[28px] leading-[1.1] text-texto sm:text-[34px]">{title}</h1>
        {subtitle && <p className="mt-2 max-w-[68ch] text-[15px] leading-relaxed text-cinza">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function CardHeader({ eyebrow, title, right }: { eyebrow?: string; title: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-5">
      <div>
        <h2 className="text-[16px] font-bold text-texto">{title}</h2>
        {eyebrow && <p className="mt-0.5 text-[13px] text-cinza">{eyebrow}</p>}
      </div>
      {right}
    </div>
  );
}

type Tom = "verde" | "agua" | "ouro" | "cinza" | "grafite";

const pontos: Record<Tom, string> = {
  verde: "bg-verde",
  agua: "bg-agua",
  ouro: "bg-ouro",
  cinza: "bg-[#A7A9AC]",
  grafite: "",
};

/** Situação: ponto de cor e texto, sem fundo. "grafite" é a marca sólida de decisão tomada. */
export function Badge({ tom = "cinza", children, className }: { tom?: Tom; children: ReactNode; className?: string }) {
  if (tom === "grafite") return <span className={cx("inline-flex items-center whitespace-nowrap rounded-[3px] bg-verde px-1.5 py-0.5 text-[11.5px] font-bold text-white", className)}>{children}</span>;
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold text-texto", className)}>
      <span className={cx("h-[7px] w-[7px] shrink-0 rounded-full", pontos[tom])} />
      {children}
    </span>
  );
}

type Variante = "primario" | "secundario" | "fantasma";

const variantes: Record<Variante, string> = {
  primario: "bg-verde text-white hover:bg-[#254B5C] disabled:bg-[#C9D2D7] disabled:text-white",
  secundario: "border border-[#C9CDD1] bg-white text-texto hover:border-verde hover:text-verde disabled:border-linha disabled:text-cinza",
  fantasma: "text-verde hover:bg-verde/8",
};

export function Botao({ variante = "primario", className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variante?: Variante }) {
  return (
    <button
      {...rest}
      className={cx("inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[5px] px-3.5 py-2 text-[14px] font-semibold transition-colors disabled:cursor-not-allowed", variantes[variante], className)}
    >
      {children}
    </button>
  );
}

export function BotaoLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link href={href} className={cx("inline-flex items-center gap-1 text-[13.5px] font-semibold text-verde underline decoration-verde/30 underline-offset-[3px] hover:decoration-verde", className)}>
      {children}
    </Link>
  );
}

export function Stat({ label, value, sub, grande }: { label: string; value: ReactNode; sub?: ReactNode; grande?: boolean }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div className={cx("num mt-1 font-bold tracking-tight", grande ? "text-[28px]" : "text-[21px]", "text-verde")}>{value}</div>
      {sub && <div className="mt-0.5 text-[13px] text-cinza">{sub}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return (
    <div className="flex max-w-full gap-6 overflow-x-auto border-b border-linha">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            "-mb-px cursor-pointer whitespace-nowrap border-b-2 pb-2.5 pt-1 text-[14px] transition-colors",
            value === o.value ? "border-verde font-bold text-verde" : "border-transparent font-medium text-cinza hover:text-texto",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select({ value, onChange, children, className }: { value: string; onChange: (v: string) => void; children: ReactNode; className?: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cx("cursor-pointer rounded-[5px] border border-[#C9CDD1] bg-white px-3 py-2 text-[14px] text-texto outline-none focus:border-verde", className)}
    >
      {children}
    </select>
  );
}

export function Campo({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">{label}</span>
      {children}
    </label>
  );
}

export const inputCls = "w-full rounded-[5px] border border-[#C9CDD1] bg-white px-3 py-2 text-[14px] text-texto outline-none focus:border-verde";

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx("bg-fundo px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-[0.06em] text-verde", className)}>{children}</th>;
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-4 py-3 text-[14px]", className)}>{children}</td>;
}
