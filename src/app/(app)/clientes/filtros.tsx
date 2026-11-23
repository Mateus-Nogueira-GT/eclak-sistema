"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Search } from "lucide-react";
import { Botao, Select } from "@/components/ui";
import { NOMES_TIPO_CLIENTE, TIPOS_CLIENTE } from "@/domain/clientes";

export function Filtros({ busca, tipo, aviso }: { busca: string; tipo: string; aviso: string }) {
  const router = useRouter();
  const [b, setB] = useState(busca);
  const [t, setT] = useState(tipo);

  function aplicar(nb = b, nt = t) {
    const q = new URLSearchParams();
    if (nb.trim()) q.set("busca", nb.trim());
    if (nt) q.set("tipo", nt);
    if (aviso) q.set("aviso", aviso);
    const s = q.toString();
    router.push(s ? `/clientes?${s}` : "/clientes");
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
          aria-label="Buscar cliente"
          placeholder="Nome, CPF, telefone ou e-mail"
          className="w-[260px] text-[14px] outline-none"
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
      </label>
      <Select
        value={t}
        onChange={(v) => {
          setT(v);
          aplicar(b, v);
        }}
      >
        <option value="">Todos os tipos</option>
        {TIPOS_CLIENTE.map((x) => <option key={x} value={x}>{NOMES_TIPO_CLIENTE[x]}</option>)}
      </Select>
      <Botao type="submit" variante="secundario">Buscar</Botao>
    </form>
  );
}
