"use client";

import { useActionState, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Campo, inputCls } from "@/components/ui";
import { entrar, type EstadoLogin } from "./actions";

const campo = inputCls + " !py-3 !text-[15px]";
const inicial: EstadoLogin = { erro: null };

export default function Login() {
  const [verSenha, setVerSenha] = useState(false);
  const [estado, acao, enviando] = useActionState(entrar, inicial);

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-linha">
        <div className="mx-auto flex h-[64px] max-w-[1120px] items-center justify-between px-4 md:px-8">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-eclak.png" alt="ECLAK Viagens" className="h-[34px] w-auto" />
          <span className="text-[13px] text-cinza">Acesso restrito à equipe</span>
        </div>
      </header>

      <main className="mx-auto grid w-full max-w-[1120px] flex-1 grid-cols-1 items-center gap-x-24 gap-y-10 px-4 py-10 md:px-8 lg:grid-cols-[1.15fr_400px] lg:py-16">
        <div>
          <h1 className="titulo text-[36px] leading-[1.05] text-texto sm:text-[56px]">Viva um mundo só seu, no mundo todo</h1>
          <p className="mt-6 max-w-[46ch] text-[17px] leading-relaxed text-cinza">
            O sistema interno da ECLAK reúne precificação, viagens, compras e financeiro. Cada pessoa vê o que o seu nível de acesso permite.
          </p>
        </div>

        <div className="border-t-2 border-verde pt-8">
          <form action={acao}>
            <h2 className="text-[20px] font-bold text-texto">Entrar</h2>
            <p className="mt-1 text-[14.5px] text-cinza">Use o e-mail e a senha cadastrados pela gestão.</p>
            <div className="mt-6 space-y-4">
              <Campo label="E-mail">
                <input name="email" type="email" required autoComplete="username" className={campo} />
              </Campo>
              <Campo label="Senha">
                <div className="relative">
                  <input name="senha" type={verSenha ? "text" : "password"} required autoComplete="current-password" className={campo + " !pr-11"} />
                  <button type="button" onClick={() => setVerSenha(!verSenha)} aria-label={verSenha ? "Ocultar senha" : "Mostrar senha"} className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer text-cinza hover:text-verde">
                    {verSenha ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </Campo>
            </div>
            {estado.erro && (
              <p role="alert" className="mt-4 text-[14px] font-bold text-texto">{estado.erro}</p>
            )}
            <button type="submit" disabled={enviando} className="mt-7 w-full cursor-pointer rounded-[5px] bg-terracota py-3.5 text-[15px] font-bold text-white hover:brightness-95 disabled:opacity-60">
              {enviando ? "Entrando..." : "Entrar"}
            </button>
            <p className="mt-5 text-[13.5px] text-cinza">Sem acesso? Peça à gestão para criar o seu usuário.</p>
          </form>
        </div>
      </main>

      <footer className="border-t border-linha">
        <p className="mx-auto max-w-[1120px] px-4 py-5 md:px-8 text-[13px] text-cinza">Rua Artur de Almeida, 343, Rondonópolis – MT. eclak.com.br</p>
      </footer>
    </div>
  );
}
