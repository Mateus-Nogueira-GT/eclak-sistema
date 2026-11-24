"use client";

import { useState } from "react";
import { Botao } from "@/components/ui";
import { desfazerImportacao } from "@/server/actions/conciliacao";
import { useAcao } from "../../viagens/[id]/acao";
import { Dialogo } from "../lancamentos/baixa";

/**
 * "Desfazer importação" de uma linha do histórico (arquivo da conta errada, por exemplo), com confirmação. Com
 * transação já conciliada ou ignorada, não oferece: é preciso desfazer essas antes (o servidor também confere).
 */
export function DesfazerImportacao({ id, arquivoNome, transacoes, tratadas }: { id: string; arquivoNome: string; transacoes: number; tratadas: number }) {
  const [aberto, setAberto] = useState(false);
  const acao = useAcao();
  if (tratadas > 0) {
    return <span className="text-[12.5px] text-cinza">Desfaça as conciliações antes</span>;
  }
  return (
    <>
      <Botao variante="secundario" onClick={() => setAberto(true)} className="!px-2.5 !py-1 !text-[13px]">
        Desfazer importação
      </Botao>
      {aberto && (
        <Dialogo
          eyebrow="Desfazer importação"
          titulo={arquivoNome}
          onFechar={() => setAberto(false)}
          rodape={
            <>
              <Botao variante="secundario" onClick={() => setAberto(false)}>
                Cancelar
              </Botao>
              <Botao disabled={acao.pendente} onClick={() => acao.executar(() => desfazerImportacao(id), () => setAberto(false))}>
                Desfazer importação
              </Botao>
            </>
          }
        >
          <div className="px-6 py-5 text-left">
            <p className="text-[14px] text-texto">
              {transacoes === 0
                ? "Este extrato não trouxe transação nova; sai só o registro da importação"
                : transacoes === 1
                  ? "A transação deste extrato sai da conciliação"
                  : `As ${transacoes} transações deste extrato saem da conciliação`}{" "}
              e o arquivo pode ser importado de novo (nesta ou em outra conta). Fica registrado no histórico de alterações.
            </p>
            {acao.erro && (
              <p role="alert" className="mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
                {acao.erro}
              </p>
            )}
          </div>
        </Dialogo>
      )}
    </>
  );
}
