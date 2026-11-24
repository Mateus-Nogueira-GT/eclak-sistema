import Link from "next/link";
import { Badge, Card, PageHeader, Td, Th } from "@/components/ui";
import { dataBr } from "@/domain/tarefas";
import { listarRoteiros } from "@/server/queries/operacao";
import { ROTULO_STATUS_ROTEIRO, TOM_STATUS_ROTEIRO } from "../viagens/[id]/roteiro/previa";

export default async function Pagina() {
  const linhas = await listarRoteiros();
  return (
    <div className="mx-auto max-w-[1640px]">
      <PageHeader title="Roteiros" subtitle="Viagens vendidas ainda não terminadas, por data de início, com a situação do roteiro." />
      <Card className="overflow-hidden">
        {linhas.length === 0 ? (
          <p className="px-6 py-10 text-center text-[14px] text-cinza">Nenhuma viagem vendida em andamento.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Viagem</Th>
                <Th>Cliente</Th>
                <Th>Destino</Th>
                <Th>Período</Th>
                <Th>Roteiro</Th>
                <Th className="text-right">
                  <span className="sr-only">Abrir</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.viagemId} className="border-t border-linha">
                  <Td className="num font-semibold text-verde">{l.codigo}</Td>
                  <Td>{l.cliente}</Td>
                  <Td>{l.destino}</Td>
                  <Td className="num whitespace-nowrap">
                    {dataBr(l.inicio)} a {dataBr(l.fim)}
                  </Td>
                  <Td>
                    {l.situacao === "sem_roteiro" ? (
                      <Badge tom="cinza">Sem roteiro</Badge>
                    ) : (
                      <Badge tom={TOM_STATUS_ROTEIRO[l.situacao]}>{ROTULO_STATUS_ROTEIRO[l.situacao]}</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    <Link href={`/viagens/${l.viagemId}/roteiro`} className="text-[14px] font-semibold text-verde hover:underline">
                      {l.situacao === "sem_roteiro" ? "Criar roteiro" : "Abrir roteiro"}
                    </Link>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
