"use client";

import { Printer } from "lucide-react";

export function BotaoImprimir() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="inline-flex cursor-pointer items-center gap-2 rounded-[5px] bg-verde px-3.5 py-2 text-[14px] font-semibold text-white hover:bg-[#254B5C] print:hidden"
    >
      <Printer size={15} /> Imprimir / salvar em PDF
    </button>
  );
}
