"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Botao } from "@/components/ui";
import { excluirCliente } from "@/server/actions/clientes";

/** Exclusão em dois passos: "Excluir" e depois "Confirmar exclusão". Só é renderizado para o diretor. */
export function ExcluirCliente({ id }: { id: string }) {
  const router = useRouter();
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();

  function excluir() {
    setErro(null);
    iniciar(async () => {
      const r = await excluirCliente(id);
      if (r.ok) {
        router.push("/clientes");
        router.refresh();
      } else {
        setErro(r.erro);
        setConfirmando(false);
      }
    });
  }

  if (!confirmando) {
    return (
      <>
        <Botao variante="secundario" onClick={() => setConfirmando(true)}>Excluir</Botao>
        {erro && <span role="alert" className="self-center text-[13px] text-texto">{erro}</span>}
      </>
    );
  }
  return (
    <>
      <Botao onClick={excluir} disabled={pendente}>Confirmar exclusão</Botao>
      <Botao variante="fantasma" onClick={() => setConfirmando(false)} disabled={pendente}>Cancelar</Botao>
    </>
  );
}
