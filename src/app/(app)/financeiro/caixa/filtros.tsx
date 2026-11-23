"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Select } from "@/components/ui";
import { ROTULO_TIPO_CAIXA, TIPOS_CAIXA, type TipoCaixa } from "@/domain/caixa";
import type { Centro } from "@/domain/financeiro";

export type FiltroTela = { centro?: Centro; viagemId?: string; tipo?: TipoCaixa };

export function urlDoCaixa(f: FiltroTela): string {
  const q = new URLSearchParams();
  if (f.tipo) q.set("tipo", f.tipo);
  if (f.centro) q.set("centro", f.centro);
  if (f.viagemId) q.set("viagem", f.viagemId);
  const s = q.toString();
  return s ? `/financeiro/caixa?${s}` : "/financeiro/caixa";
}

/** Filtros na URL (como a lista de lançamentos): mexem só nos movimentos, não no saldo de hoje. */
export function FiltrosCaixa({ filtro, viagens }: { filtro: FiltroTela; viagens: { id: string; codigo: string; cliente: string }[] }) {
  const router = useRouter();
  const ir = (mudar: Partial<FiltroTela>) => router.push(urlDoCaixa({ ...filtro, ...mudar }));
  const filtrado = Boolean(filtro.tipo || filtro.centro || filtro.viagemId);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={filtro.tipo ?? ""} onChange={(t) => ir({ tipo: (t || undefined) as TipoCaixa | undefined })}>
        <option value="">Todos os tipos</option>
        {TIPOS_CAIXA.map((t) => (
          <option key={t} value={t}>
            {ROTULO_TIPO_CAIXA[t]}
          </option>
        ))}
      </Select>
      <Select value={filtro.centro ?? ""} onChange={(c) => ir({ centro: (c || undefined) as Centro | undefined })}>
        <option value="">MT e RS</option>
        <option value="MT">Só MT</option>
        <option value="RS">Só RS</option>
      </Select>
      <Select value={filtro.viagemId ?? ""} onChange={(v) => ir({ viagemId: v || undefined })} className="w-full sm:w-[300px]">
        <option value="">Todas as viagens e a empresa</option>
        {viagens.map((v) => (
          <option key={v.id} value={v.id}>
            {v.codigo}
            {v.cliente ? ` · ${v.cliente}` : ""}
          </option>
        ))}
      </Select>
      {filtrado && (
        <Link href={urlDoCaixa({})} className="py-2 text-[13px] font-semibold text-verde hover:underline">
          Limpar filtros
        </Link>
      )}
    </div>
  );
}
