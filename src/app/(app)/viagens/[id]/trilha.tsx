import Link from "next/link";
import { FolderOpen, SquareKanban } from "lucide-react";
import { dataBr } from "@/domain/tarefas";
import type { CabecalhoViagem } from "@/server/queries/operacao";
import { IntegracoesViagem } from "./integracoes-viagem";

export type AbaTrilha = "viagem" | "roteiro" | "tarefas" | "dailies";

const ABAS: { id: AbaTrilha; rotulo: string; caminho: string }[] = [
  { id: "viagem", rotulo: "Viagem", caminho: "" },
  { id: "roteiro", rotulo: "Roteiro", caminho: "/roteiro" },
  { id: "tarefas", rotulo: "Tarefas", caminho: "/tarefas" },
  { id: "dailies", rotulo: "Dailies", caminho: "/dailies" },
];

const LINK = "inline-flex items-center gap-1.5 text-[13.5px] font-semibold text-verde hover:underline";

/** Cabeçalho da viagem vendida e abas da operação (Viagem, Roteiro, Tarefas, Dailies). */
export function Trilha({ viagem, ativa }: { viagem: CabecalhoViagem; ativa: AbaTrilha }) {
  return (
    <div className="mb-6 print:hidden">
      <div className="rounded-[6px] border border-linha bg-fundo px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-[13px] font-bold text-verde">{viagem.codigo}</span>
          <h2 className="text-[18px] font-bold text-texto">{viagem.cliente}</h2>
          <span className="text-[14px] text-texto">{viagem.destino}</span>
          {(viagem.cartaoTrello || viagem.pastaDrive) && (
            <span className="ml-auto flex items-center gap-4 self-center">
              {viagem.cartaoTrello && (
                <a href={viagem.cartaoTrello} target="_blank" rel="noopener noreferrer" className={LINK}>
                  <SquareKanban size={15} aria-hidden /> Cartão no Trello
                </a>
              )}
              {viagem.pastaDrive && (
                <a href={viagem.pastaDrive} target="_blank" rel="noopener noreferrer" className={LINK}>
                  <FolderOpen size={15} aria-hidden /> Pasta no Drive
                </a>
              )}
            </span>
          )}
        </div>
        <p className="mt-1 text-[13.5px] text-cinza">
          {dataBr(viagem.inicio)} a {dataBr(viagem.fim)} · {viagem.noites} {viagem.noites === 1 ? "noite" : "noites"}
        </p>
        <p className="mt-1 text-[13.5px] text-cinza">
          Passageiros: {viagem.passageiros.map((p) => p.nome).join(", ") || "nenhum"} · Consultor: {viagem.consultor.nome}
        </p>
        {viagem.integracoesNaViagem && (
          <IntegracoesViagem viagemId={viagem.id} trello={viagem.integracoesNaViagem.trello} drive={viagem.integracoesNaViagem.drive} />
        )}
      </div>
      <nav className="mt-3 flex gap-6 border-b border-linha" aria-label="Operação da viagem">
        {ABAS.map((a) => (
          <Link
            key={a.id}
            href={`/viagens/${viagem.id}${a.caminho}`}
            aria-current={a.id === ativa ? "page" : undefined}
            className={`-mb-px border-b-2 pb-2 text-[14px] transition-colors ${a.id === ativa ? "border-verde font-bold text-verde" : "border-transparent font-medium text-cinza hover:text-texto"}`}
          >
            {a.rotulo}
          </Link>
        ))}
      </nav>
    </div>
  );
}
