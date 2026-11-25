"use client";

import Link from "next/link";
import { Botao, Card } from "@/components/ui";

export default function Erro({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-[560px] py-12">
      <Card className="p-7">
        <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Algo deu errado</p>
        <h1 className="mt-1.5 text-[20px] font-bold text-verde">Não foi possível concluir a ação</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-texto">
          Verifique sua conexão e tente novamente. Se o problema continuar, recarregue a página.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Botao onClick={reset}>Tentar novamente</Botao>
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-[5px] border border-[#C9CDD1] bg-white px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde"
          >
            Voltar ao início
          </Link>
        </div>
      </Card>
    </div>
  );
}
