"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";
import { Botao, Select } from "@/components/ui";
import { ROTULOS_STATUS_ORCAMENTO, STATUS_ORCAMENTO } from "@/domain/viagens";

export function Filtros({ busca, status }: { busca: string; status: string }) {
  const router = useRouter();
  const [b, setB] = useState(busca);
  const [s, setS] = useState(status);

  function aplicar(nb = b, ns = s) {
    const q = new URLSearchParams();
    if (nb.trim()) q.set("busca", nb.trim());
    if (ns) q.set("status", ns);
    const t = q.toString();
    router.push(t ? `/viagens?${t}` : "/viagens");
  }

  return (
    <form
      className="flex flex-wrap items-center gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        aplicar();
      }}
    >
      <label className="flex items-center gap-2 rounded-[5px] border border-[#C9CDD1] bg-white px-3 py-2 focus-within:border-verde">
        <Search size={16} className="text-cinza" />
        <input
          aria-label="Buscar orçamento"
          placeholder="Código, cliente, destino ou passageiro"
          className="w-[280px] text-[14px] outline-none"
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
      </label>
      <Select
        value={s}
        onChange={(v) => {
          setS(v);
          aplicar(b, v);
        }}
      >
        <option value="">Todos os status</option>
        {STATUS_ORCAMENTO.map((x) => <option key={x} value={x}>{ROTULOS_STATUS_ORCAMENTO[x]}</option>)}
      </Select>
      <Botao type="submit" variante="secundario">Buscar</Botao>
    </form>
  );
}
