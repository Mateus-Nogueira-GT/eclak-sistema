"use client";

import { useState, useTransition, type ReactNode } from "react";
import { PenLine } from "lucide-react";
import { Botao, cx } from "@/components/ui";
import { MARCADORES } from "@/domain/ia-privacidade";
import type { Idioma } from "@/domain/roteiro";
import { reescreverTexto } from "@/server/actions/ia";

type Finalidade = "abertura" | "dica" | "porque" | "daily";

const TEM_MARCADOR = new RegExp(Object.values(MARCADORES).map((m) => m.replace(/[[\]]/g, "\\$&")).join("|"));

/**
 * Campo com "Reescrever com IA" logo abaixo (só quando a IA está ligada). A sugestão aparece ao lado do campo (ou
 * logo abaixo, com `abaixo`, para campo estreito como a DICA ECLAK), com "Usar este texto" (só preenche o campo: a
 * pessoa ainda salva) e "Descartar". Nada é gravado aqui.
 */
export function ComReescrita({
  ligada,
  texto,
  finalidade,
  idioma,
  roteiroId,
  onUsar,
  abaixo = false,
  children,
}: {
  ligada: boolean;
  texto: string;
  finalidade: Finalidade;
  idioma: Idioma;
  roteiroId: string;
  onUsar: (texto: string) => void;
  abaixo?: boolean;
  children: ReactNode;
}) {
  const [pendente, iniciar] = useTransition();
  const [sugestao, setSugestao] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  if (!ligada) return <>{children}</>;

  function pedir() {
    setErro(null);
    iniciar(async () => {
      const r = await reescreverTexto({ texto, finalidade, idioma, roteiroId });
      if (r.ok) setSugestao(r.texto);
      else setErro(r.erro);
    });
  }

  return (
    <div className={cx("min-w-0", sugestao !== null && "grid items-start gap-3", sugestao !== null && !abaixo && "lg:grid-cols-2")}>
      <div className="min-w-0">
        {children}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={pedir}
            disabled={pendente || texto.trim() === ""}
            title={texto.trim() === "" ? "Escreva o texto antes de reescrever" : undefined}
            className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] font-semibold text-verde hover:underline disabled:cursor-not-allowed disabled:text-cinza disabled:no-underline"
          >
            <PenLine size={14} aria-hidden /> {pendente ? "Reescrevendo…" : "Reescrever com IA"}
          </button>
          {erro && (
            <span role="alert" className="text-[12.5px] text-texto">
              {erro}
            </span>
          )}
        </div>
      </div>
      {sugestao !== null && (
        <section aria-label="Sugestão da IA" className="min-w-0 rounded-[5px] border border-verde/40 bg-verde/[0.04] px-3.5 py-3">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Sugestão da IA</p>
          <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-[1.55] text-texto">{sugestao}</p>
          {TEM_MARCADOR.test(sugestao) && (
            <p className="mt-2 text-[12.5px] text-cinza">
              Dados pessoais não vão para a IA: troque os marcadores entre colchetes antes de salvar.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <Botao
              type="button"
              className="!px-3 !py-1.5 !text-[13px]"
              onClick={() => {
                onUsar(sugestao);
                setSugestao(null);
              }}
            >
              Usar este texto
            </Botao>
            <Botao type="button" variante="secundario" className="!px-3 !py-1.5 !text-[13px]" onClick={() => setSugestao(null)}>
              Descartar
            </Botao>
          </div>
        </section>
      )}
    </div>
  );
}
