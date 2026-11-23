"use client";

import { useActionState } from "react";
import { Botao, Campo, Card, inputCls } from "@/components/ui";
import { definirSenha, type EstadoSenha } from "@/server/actions/senha";

const inicial: EstadoSenha = { erro: null };

export function FormularioSenha() {
  const [estado, acao, enviando] = useActionState(definirSenha, inicial);
  return (
    <Card className="p-6">
      <form action={acao} className="space-y-4">
        <Campo label="NOVA SENHA">
          <input name="senha" type="password" required minLength={8} autoComplete="new-password" className={inputCls} />
        </Campo>
        <Campo label="CONFIRMAR NOVA SENHA">
          <input name="confirmacao" type="password" required minLength={8} autoComplete="new-password" className={inputCls} />
        </Campo>
        <p className="text-[13px] text-cinza">Use pelo menos 8 caracteres.</p>
        {estado.erro && (
          <p role="alert" className="rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
            {estado.erro}
          </p>
        )}
        <Botao type="submit" disabled={enviando}>{enviando ? "Salvando..." : "Salvar senha"}</Botao>
      </form>
    </Card>
  );
}
