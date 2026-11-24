"use client";

import { useState } from "react";
import { Botao } from "@/components/ui";
import { ROTULO_CLASSE_ERRO, type ClasseErro } from "@/domain/integracoes";
import { reenviarEnvio, testarConexao } from "@/server/actions/integracoes";
import { useAcao } from "../../viagens/[id]/acao";

/** "Testar conexão": o resultado fica logo abaixo e, depois do refresh, em "Último teste". */
export function TestarConexao({ integracao }: { integracao: string }) {
  const acao = useAcao();
  const [resultado, setResultado] = useState<{ ok: boolean; classe: ClasseErro | null } | null>(null);

  function testar() {
    setResultado(null);
    acao.executar(async () => {
      const r = await testarConexao(integracao);
      if (r.ok) setResultado(r.conexao);
      return r;
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Botao variante="secundario" onClick={testar} disabled={acao.pendente}>
        {acao.pendente ? "Testando…" : "Testar conexão"}
      </Botao>
      {resultado && (
        <span role="status" className="text-[13px] text-texto">
          {resultado.ok ? "Conexão funcionando." : `A conexão falhou: ${ROTULO_CLASSE_ERRO[resultado.classe ?? "servidor"]}.`}
        </span>
      )}
      {acao.erro && (
        <span role="alert" className="text-[13px] text-texto">
          {acao.erro}
        </span>
      )}
    </div>
  );
}

/** Reenviar um envio que falhou (ou tentar agora um pendente). */
export function Reenviar({ envioId, rotulo }: { envioId: string; rotulo: string }) {
  const acao = useAcao();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Botao variante="fantasma" className="!px-2 !py-1 !text-[13px]" onClick={() => acao.executar(() => reenviarEnvio(envioId))} disabled={acao.pendente}>
        {rotulo}
      </Botao>
      {acao.erro && (
        <span role="alert" className="text-[12.5px] text-texto">
          {acao.erro}
        </span>
      )}
    </span>
  );
}
