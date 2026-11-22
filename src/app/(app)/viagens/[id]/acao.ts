"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export const MSG_FALHA = "Não foi possível concluir. Tente de novo.";

type Resultado = { ok: true } | { ok: false; erro: string; campos?: Record<string, string> };

/**
 * Executa uma Server Action de item/cotação/envio. No sucesso atualiza os dados da página (o `atualizadoEm` do
 * cabeçalho precisa ficar em dia); na falha guarda a mensagem e os erros por campo. Se a action lança (rede,
 * erro do servidor), mostra MSG_FALHA e mantém o que foi digitado.
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
      let r: Resultado;
      try {
        r = await fn();
      } catch {
        // Falha de rede ou erro do servidor: mensagem genérica; o formulário fica como estava.
        setErro(MSG_FALHA);
        return;
      }
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
