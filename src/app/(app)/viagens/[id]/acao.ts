"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Resultado = { ok: true } | { ok: false; erro: string; campos?: Record<string, string> };

/**
 * Executa uma Server Action de item/cotação/envio. No sucesso atualiza os dados da página (o `atualizadoEm` do
 * cabeçalho precisa ficar em dia); na falha guarda a mensagem e os erros por campo.
 */
export function useAcao() {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [campos, setCampos] = useState<Record<string, string>>({});

  function executar(fn: () => Promise<Resultado>, aoSucesso?: () => void) {
    setErro(null);
    setCampos({});
    iniciar(async () => {
      const r = await fn();
      if (r.ok) {
        aoSucesso?.();
        router.refresh();
      } else {
        setErro(r.campos && Object.keys(r.campos).length > 0 ? "Corrija os campos indicados" : r.erro);
        setCampos(r.campos ?? {});
      }
    });
  }

  function limparCampo(k: string) {
    setCampos((c) => {
      if (!(k in c)) return c;
      const r = { ...c };
      delete r[k];
      return r;
    });
  }

  return { pendente, erro, campos, executar, limparCampo };
}
