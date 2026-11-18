"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Botao, Select, inputCls } from "@/components/ui";
import { TIPOS_SERVICO } from "@/domain/fornecedores";

export function Filtros({ busca, tipo }: { busca: string; tipo: string }) {
  const router = useRouter();
  const [b, setB] = useState(busca);
  const [t, setT] = useState(tipo);

  function aplicar(nb = b, nt = t) {
    const q = new URLSearchParams();
    if (nb.trim()) q.set("busca", nb.trim());
    if (nt) q.set("tipo", nt);
    const s = q.toString();
    router.push(s ? `/fornecedores?${s}` : "/fornecedores");
  }

  return (
    <form
      className="flex flex-wrap items-center gap-3 px-6 py-4"
      onSubmit={(e) => {
        e.preventDefault();
        aplicar();
      }}
    >
      <input
        aria-label="Buscar por nome ou cidade"
        placeholder="Buscar por nome ou cidade"
        className={`${inputCls} !w-[320px]`}
        value={b}
        onChange={(e) => setB(e.target.value)}
      />
      <Select
        value={t}
        onChange={(v) => {
          setT(v);
          aplicar(b, v);
        }}
      >
        <option value="">Todos os tipos</option>
        {TIPOS_SERVICO.map((x) => <option key={x} value={x}>{x}</option>)}
      </Select>
      <Botao type="submit" variante="secundario">Buscar</Botao>
    </form>
  );
}
