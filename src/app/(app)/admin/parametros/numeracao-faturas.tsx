"use client";

import { useState } from "react";
import { Botao, Card, CardHeader, inputCls } from "@/components/ui";
import { MSG_NUMERO_FATURA } from "@/domain/faturas";
import { definirProximoNumeroFatura } from "@/server/actions/faturas";
import { useAcao } from "../../viagens/[id]/acao";

/** Próximo número de fatura: editável só enquanto nenhuma fatura foi emitida (depois, só avança). */
export function NumeracaoFaturas({ proximo, haFaturas }: { proximo: number; haFaturas: boolean }) {
  const acao = useAcao();
  const [texto, setTexto] = useState(String(proximo));
  const [ok, setOk] = useState(false);
  const [erroLocal, setErroLocal] = useState<string | null>(null);

  function salvar() {
    setOk(false);
    setErroLocal(null);
    const t = texto.trim();
    if (!/^\d{1,6}$/.test(t)) return setErroLocal(MSG_NUMERO_FATURA);
    acao.executar(() => definirProximoNumeroFatura(Number(t)), () => setOk(true));
  }

  const erro = erroLocal ?? acao.erro;
  return (
    <Card className="mb-5 pb-6">
      <CardHeader
        title="Numeração de faturas"
        eyebrow={
          haFaturas
            ? "Já há faturas emitidas: a numeração só avança."
            : "Número da primeira fatura a ser emitida. Pode ser ajustado enquanto nenhuma fatura tiver sido emitida."
        }
      />
      <div className="mt-4 flex flex-wrap items-end gap-3 px-6">
        <label className="block">
          <span className="mb-1 block text-[12.5px] font-semibold text-cinza">Próxima fatura</span>
          {haFaturas ? (
            <span className="num block py-2 text-[18px] font-bold text-verde">{proximo}</span>
          ) : (
            <input
              inputMode="numeric"
              className={`${inputCls} num w-[140px] ${erro ? "!border-ouro bg-ouro/15" : ""}`}
              aria-invalid={erro ? true : undefined}
              value={texto}
              onChange={(e) => {
                setTexto(e.target.value);
                setOk(false);
                setErroLocal(null);
              }}
            />
          )}
        </label>
        {!haFaturas && (
          <Botao onClick={salvar} disabled={acao.pendente || texto.trim() === String(proximo)}>
            Salvar número
          </Botao>
        )}
      </div>
      {erro && (
        <p role="alert" className="mx-6 mt-3 text-[13px] text-texto">
          {erro}
        </p>
      )}
      {ok && !erro && (
        <p role="status" className="mx-6 mt-3 text-[13px] text-cinza">
          Número salvo.
        </p>
      )}
    </Card>
  );
}
