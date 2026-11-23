"use client";

import { Badge, Card, CardHeader, Td, Th } from "@/components/ui";
import { formatarReais } from "@/domain/dinheiro";
import type { StatusVersao } from "@/domain/viagens";
import type { VersaoFicha } from "@/server/queries/viagens";
import { dataHora } from "../formatos";

const ROTULO: Record<StatusVersao, string> = {
  aguardando: "Aguardando aprovação",
  aprovada: "Aprovada",
  aprovada_com_ajuste: "Aprovada com ajuste",
  devolvida: "Devolvida",
};
const TOM: Record<StatusVersao, "ouro" | "agua" | "cinza"> = { aguardando: "ouro", aprovada: "agua", aprovada_com_ajuste: "agua", devolvida: "cinza" };

export function Versoes({ versoes }: { versoes: VersaoFicha[] }) {
  const preco = versoes.some((v) => v.preco !== undefined);
  return (
    <Card className="mb-5">
      <CardHeader eyebrow="Cada envio para aprovação gera uma versão" title="Versões" />
      {versoes.length === 0 ? (
        <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhuma versão enviada ainda.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full">
            <thead className="border-y border-linha">
              <tr>
                <Th className="pl-6">Versão</Th>
                <Th>Status</Th>
                {preco && <Th className="text-right">Preço</Th>}
                <Th>Enviada</Th>
                <Th>Decisão</Th>
                <Th>Comentário</Th>
              </tr>
            </thead>
            <tbody>
              {versoes.map((v) => (
                <tr key={v.id} className="border-b border-linha/70 align-top last:border-0">
                  <Td className="num pl-6 font-semibold">Versão {v.numero}</Td>
                  <Td><Badge tom={TOM[v.status]}>{ROTULO[v.status]}</Badge></Td>
                  {preco && <Td className="num text-right">{v.preco !== undefined ? formatarReais(v.preco) : ""}</Td>}
                  <Td className="text-[13px]">
                    <span className="num block">{dataHora(v.enviadoEm)}</span>
                    <span className="block text-cinza">{v.enviadoPor}</span>
                    {v.alteracao && <span className="mt-1 block text-texto">{v.alteracao}</span>}
                  </Td>
                  <Td className="text-[13px]">
                    {v.decididoEm ? (
                      <>
                        <span className="num block">{dataHora(v.decididoEm)}</span>
                        <span className="block text-cinza">{v.decididoPor}</span>
                      </>
                    ) : (
                      <span className="text-cinza">Pendente</span>
                    )}
                  </Td>
                  <Td className="whitespace-pre-line text-[13px]">{v.comentario ?? ""}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
