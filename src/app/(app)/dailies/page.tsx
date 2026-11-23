import Link from "next/link";
import { Badge, Card, PageHeader, Td, Th } from "@/components/ui";
import { dataBr } from "@/domain/tarefas";
import { listarDailies } from "@/server/queries/operacao";

export default async function Pagina() {
  const linhas = await listarDailies();
  return (
    <div className="mx-auto max-w-[1640px]">
      <PageHeader
        title="Dailies"
        subtitle="Mensagens diárias de hoje até daqui a 3 dias, de todas as viagens com roteiro. O envio é no dia anterior."
      />
      <Card className="overflow-hidden">
        {linhas.length === 0 ? (
          <p className="px-6 py-10 text-center text-[14px] text-cinza">Nenhum daily de hoje até daqui a 3 dias.</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <Th>Dia</Th>
                <Th>Viagem</Th>
                <Th>Cliente</Th>
                <Th>Cidade</Th>
                <Th>Enviar em</Th>
                <Th>Estado</Th>
                <Th className="text-right">
                  <span className="sr-only">Abrir</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={`${l.viagem.id}-${l.data}`} className="border-t border-linha">
                  <Td className="num whitespace-nowrap font-semibold">{l.rotuloDia}</Td>
                  <Td className="num font-semibold text-verde">{l.viagem.codigo}</Td>
                  <Td>{l.viagem.cliente}</Td>
                  <Td>{l.cidade}</Td>
                  <Td className="num">{dataBr(l.dataEnvio).slice(0, 5)}</Td>
                  <Td>
                    <Badge tom={l.estado.tom}>{l.estado.rotulo}</Badge>
                  </Td>
                  <Td className="text-right">
                    <Link href={`/viagens/${l.viagem.id}/dailies?dia=${l.data}`} className="text-[14px] font-semibold text-verde hover:underline">
                      Abrir daily
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
