import Link from "next/link";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cx } from "./ui";

export type EtapaViagem = "precificacao" | "aprovacao";

const ETAPAS: { id: string; nome: string }[] = [
  { id: "cotacao", nome: "Cotação" },
  { id: "precificacao", nome: "Precificação" },
  { id: "aprovacao", nome: "Aprovação" },
  { id: "compras", nome: "Compras" },
  { id: "roteiro", nome: "Roteiro" },
  { id: "tarefas", nome: "Tarefas" },
  { id: "dailies", nome: "Dailies" },
];

export type PassageiroBilhete = { nome: string; removido?: boolean };

/**
 * Cabeçalho de viagem, no formato de um bilhete: o código no canhoto azul, os dados da viagem ao lado e, embaixo,
 * em que etapa a viagem está. Só Precificação e Aprovação existem nesta fatia; as demais aparecem desabilitadas.
 */
export function Bilhete({
  codigo,
  cliente,
  destino,
  periodo,
  noites,
  passageiros,
  consultor,
  etapa,
  href,
  right,
}: {
  codigo: string;
  cliente: string;
  destino: string;
  periodo: string;
  noites: number;
  passageiros: PassageiroBilhete[];
  consultor: string;
  etapa: EtapaViagem;
  /** Rota da precificação (a etapa vira link). */
  href?: string;
  right?: ReactNode;
}) {
  const iAtual = ETAPAS.findIndex((e) => e.id === etapa);
  const n = passageiros.length;
  return (
    <div className="mb-6">
      <div className="flex flex-col overflow-hidden rounded-[6px] border border-linha sm:flex-row">
        <div className="flex shrink-0 items-center justify-between gap-3 border-dashed border-white/60 bg-verde px-5 py-3 text-white sm:w-[176px] sm:flex-col sm:items-start sm:border-r sm:py-4">
          <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-white/75">Código</span>
          <span className="titulo num whitespace-nowrap text-[24px] leading-none">{codigo}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-8 gap-y-4 bg-white px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h1 className="titulo text-[25px] leading-[1.1] text-texto sm:text-[30px]">{cliente}</h1>
            <dl className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2 text-[14px] sm:flex sm:flex-wrap sm:gap-x-8">
              {[
                ["Destino", destino],
                ["Período", periodo],
                ["Noites", String(noites)],
                ["Passageiros", `${String(n).padStart(2, "0")} ${n === 1 ? "pessoa" : "pessoas"}`],
                ["Consultor", consultor],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">{k}</dt>
                  <dd className="num font-semibold text-texto">{v}</dd>
                </div>
              ))}
            </dl>
            {n > 0 && (
              <p className="mt-2 text-[13px] text-cinza">
                {passageiros.map((p, i) => (
                  <span key={i}>
                    {i > 0 && ", "}
                    {p.nome}
                    {p.removido && <span className="ml-1 rounded-[3px] bg-ouro/25 px-1.5 py-0.5 text-[11.5px] font-semibold text-texto">Removido do cadastro</span>}
                  </span>
                ))}
              </p>
            )}
          </div>
          {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
        </div>
      </div>

      <nav aria-label="Etapas da viagem" className="mt-3 flex items-center gap-1 overflow-x-auto text-[13.5px]">
        {ETAPAS.map((e, i) => {
          const on = e.id === etapa;
          const feita = i < iAtual && (e.id === "precificacao" || e.id === "aprovacao");
          const ativa = e.id === "precificacao" || e.id === "aprovacao";
          const cls = cx(
            "flex items-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 py-1.5",
            on ? "bg-verde font-bold text-white" : feita ? "font-semibold text-verde" : "font-medium text-cinza",
            !ativa && "cursor-not-allowed opacity-60",
          );
          const dentro = (
            <>
              {feita && <Check size={14} strokeWidth={2.6} />}
              {e.nome}
            </>
          );
          const linkavel = e.id === "precificacao" && href;
          return (
            <span key={e.id} className="flex items-center gap-1">
              {linkavel ? (
                <Link href={href} className={cx(cls, !on && "hover:bg-fundo")}>{dentro}</Link>
              ) : (
                <span className={cls} aria-disabled={!ativa || undefined}>{dentro}</span>
              )}
              {i < ETAPAS.length - 1 && <span className="h-px w-5 bg-[#C9CDD1]" />}
            </span>
          );
        })}
      </nav>
    </div>
  );
}
