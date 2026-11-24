"use client";

import Link from "next/link";
import { Badge, Botao } from "@/components/ui";
import { criarPastasNoDrive, enviarViagemAoTrello } from "@/server/actions/integracoes";
import type { SituacaoNaViagem } from "@/server/queries/operacao";
import { useAcao } from "./acao";

/**
 * Só o Diretor: "Enviar para o Trello" e "Criar pastas no Drive" quando a integração está ligada e a viagem ainda não
 * foi enviada; na fila ou com falha, a situação (a falha se reenvia em Admin › Integrações). O link do cartão e da
 * pasta já enviados fica no cabeçalho, para todos.
 */
export function IntegracoesViagem({
  viagemId,
  trello,
  drive,
}: {
  viagemId: string;
  trello: SituacaoNaViagem;
  drive: SituacaoNaViagem;
}) {
  const acao = useAcao();
  const itens = [
    { nome: "Trello", situacao: trello, botao: "Enviar para o Trello", fazer: () => enviarViagemAoTrello(viagemId) },
    { nome: "Drive", situacao: drive, botao: "Criar pastas no Drive", fazer: () => criarPastasNoDrive(viagemId) },
  ].filter((i) => i.situacao === "enviar" || i.situacao === "pendente" || i.situacao === "falhou");
  if (itens.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-linha pt-3">
      {itens.map((i) =>
        i.situacao === "enviar" ? (
          <Botao key={i.nome} variante="secundario" className="!py-1.5 !text-[13.5px]" disabled={acao.pendente} onClick={() => acao.executar(i.fazer)}>
            {i.botao}
          </Botao>
        ) : i.situacao === "pendente" ? (
          <Badge key={i.nome} tom="cinza">
            {i.nome}: na fila para envio
          </Badge>
        ) : (
          <span key={i.nome} className="inline-flex items-center gap-2">
            <Badge tom="ouro">{i.nome}: o envio falhou</Badge>
            <Link href="/admin/integracoes" className="text-[13px] font-semibold text-verde hover:underline">
              Ver em Integrações
            </Link>
          </span>
        ),
      )}
      {acao.erro && (
        <span role="alert" className="text-[13px] text-texto">
          {acao.erro}
        </span>
      )}
    </div>
  );
}
