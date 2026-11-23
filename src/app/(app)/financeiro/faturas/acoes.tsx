"use client";

import { FileText, RefreshCw } from "lucide-react";
import { Botao } from "@/components/ui";
import { emitirFatura, reemitirFatura } from "@/server/actions/faturas";
import { useAcao } from "../../viagens/[id]/acao";

function Erro({ erro }: { erro: string | null }) {
  if (!erro) return null;
  return (
    <span role="alert" className="mt-1 block text-[12.5px] text-texto">
      {erro}
    </span>
  );
}

export function BotaoEmitir({ vendaId, proximo }: { vendaId: string; proximo: number }) {
  const acao = useAcao();
  return (
    <span className="inline-flex flex-col items-end">
      <Botao className="!px-3 !py-1.5 !text-[13px]" disabled={acao.pendente} onClick={() => acao.executar(() => emitirFatura(vendaId))}>
        <FileText size={14} /> Emitir fatura {proximo}
      </Botao>
      <Erro erro={acao.erro} />
    </span>
  );
}

export function BotaoReemitir({ faturaId }: { faturaId: string }) {
  const acao = useAcao();
  return (
    <span className="inline-flex flex-col items-end">
      <Botao variante="secundario" disabled={acao.pendente} onClick={() => acao.executar(() => reemitirFatura(faturaId))}>
        <RefreshCw size={15} /> Reemitir
      </Botao>
      <Erro erro={acao.erro} />
    </span>
  );
}
