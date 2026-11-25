"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Grade } from "@/components/kit";
import { Badge, Card, CardHeader, Tabs } from "@/components/ui";
import type { CaixaProxima } from "@/server/queries/caixa-experiencia";
import { dataBr } from "../../viagens/formatos";

export type AbaEstoque = "produtos" | "caixas";

/** Abas do Estoque com o estado na URL: "Produtos" é a URL de sempre; "Caixas" é `?aba=caixas`. */
export function AbasEstoque({ aba }: { aba: AbaEstoque }) {
  const router = useRouter();
  return (
    <div className="mb-5">
      <Tabs<AbaEstoque>
        value={aba}
        onChange={(a) => router.push(a === "caixas" ? "/financeiro/estoque?aba=caixas" : "/financeiro/estoque")}
        options={[
          { value: "produtos", label: "Produtos" },
          { value: "caixas", label: "Caixas" },
        ]}
      />
    </div>
  );
}

const SITUACAO: Record<CaixaProxima["situacao"], { rotulo: string; tom: "agua" | "ouro" | "cinza" }> = {
  sem_caixa: { rotulo: "Sem caixa", tom: "ouro" },
  rascunho: { rotulo: "Rascunho", tom: "ouro" },
  confirmada: { rotulo: "Confirmada", tom: "agua" },
  cancelada: { rotulo: "Cancelada", tom: "cinza" },
};

/** Viagens vendidas e não conciliadas com embarque nos próximos 60 dias, com a situação da caixa e o link. */
export function Caixas({ caixas }: { caixas: CaixaProxima[] }) {
  return (
    <Card className="pb-2">
      <CardHeader title="Caixas das próximas viagens" eyebrow="Viagens vendidas com embarque nos próximos 60 dias. A caixa é montada e confirmada na página da viagem." />
      {caixas.length === 0 ? (
        <p className="px-6 pb-5 pt-4 text-[14px] text-cinza">Nenhuma viagem vendida com embarque nos próximos 60 dias.</p>
      ) : (
        <Grade
          className="mt-4"
          head={["Viagem", "Cliente", "Embarque", "Filial", "Caixa"]}
          rows={caixas.map((c) => [
            <Link key="v" href={`/viagens/${c.viagemId}`} className="num whitespace-nowrap font-semibold text-verde hover:underline">{c.codigo}</Link>,
            c.cliente,
            <span key="e" className="num whitespace-nowrap">{dataBr(c.embarque)}</span>,
            c.filial,
            <Badge key="s" tom={SITUACAO[c.situacao].tom}>{SITUACAO[c.situacao].rotulo}</Badge>,
          ])}
        />
      )}
    </Card>
  );
}
