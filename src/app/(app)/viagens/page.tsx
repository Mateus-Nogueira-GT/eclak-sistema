import Link from "next/link";
import { Plus } from "lucide-react";
import { Card, PageHeader, Td, Th } from "@/components/ui";
import { StatusOrcamentoBadge } from "@/components/status-orcamento";
import { formatarReais } from "@/domain/dinheiro";
import { STATUS_ORCAMENTO, type StatusOrcamento } from "@/domain/viagens";
import { listarOrcamentos } from "@/server/queries/viagens";
import { dataBr, pct1 } from "./formatos";
import { Filtros } from "./filtros";

type Busca = { busca?: string | string[]; status?: string | string[] };
const um = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Pagina({ searchParams }: { searchParams: Promise<Busca> }) {
  const sp = await searchParams;
  const busca = um(sp.busca);
  const status = (STATUS_ORCAMENTO as readonly string[]).includes(um(sp.status)) ? (um(sp.status) as StatusOrcamento) : undefined;
  const lista = await listarOrcamentos({ busca, status });
  // A coluna de preço e margem só existe quando o servidor devolveu a camada estratégica.
  const estrategico = lista.some((l) => l.estrategico !== undefined);
  const colunas = estrategico ? 9 : 7;

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title={`${lista.length} ${lista.length === 1 ? "orçamento" : "orçamentos"}`}
        subtitle="Cotação, precificação e aprovação de cada viagem."
        right={
          <Link href="/viagens/novo" className="inline-flex items-center gap-2 whitespace-nowrap rounded-[5px] bg-verde px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#254B5C]">
            <Plus size={16} /> Novo orçamento
          </Link>
        }
      />
      <div className="mb-4">
        <Filtros key={`${busca}|${status ?? ""}`} busca={busca} status={status ?? ""} />
      </div>
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-linha">
              <tr>
                <Th className="pl-6">Código</Th>
                <Th>Cliente</Th>
                <Th>Destino</Th>
                <Th>Período</Th>
                <Th>Consultor</Th>
                <Th>Status</Th>
                <Th>Versão aprovada</Th>
                {estrategico && <Th className="text-right">Preço</Th>}
                {estrategico && <Th className="text-right">Margem líquida</Th>}
              </tr>
            </thead>
            <tbody>
              {lista.map((o) => (
                <tr key={o.id} className="border-b border-linha/70 last:border-0 hover:bg-fundo">
                  <Td className="num pl-6 font-semibold">
                    <Link href={`/viagens/${o.id}`} className="text-texto hover:text-verde">{o.codigo}</Link>
                  </Td>
                  <Td>
                    <Link href={`/clientes/${o.clienteId}`} className="hover:text-verde">{o.cliente}</Link>
                  </Td>
                  <Td>{o.destino}</Td>
                  <Td className="num whitespace-nowrap text-[13px]">{dataBr(o.inicio)} a {dataBr(o.fim)}</Td>
                  <Td>{o.consultor}</Td>
                  <Td><StatusOrcamentoBadge status={o.status} /></Td>
                  <Td className="num text-cinza">{o.versaoAprovada ? `Versão ${o.versaoAprovada}` : "-"}</Td>
                  {estrategico && (
                    <Td className="num text-right">
                      {o.estrategico === undefined ? "" : "erro" in o.estrategico ? <span className="text-[12.5px] text-cinza">{o.estrategico.erro}</span> : o.estrategico.preco === null ? <span className="text-cinza">-</span> : formatarReais(o.estrategico.preco)}
                    </Td>
                  )}
                  {estrategico && (
                    <Td className="num text-right">
                      {o.estrategico === undefined || "erro" in o.estrategico || o.estrategico.margemPct === null ? <span className="text-cinza">-</span> : pct1(o.estrategico.margemPct)}
                    </Td>
                  )}
                </tr>
              ))}
              {lista.length === 0 && (
                <tr>
                  <td colSpan={colunas} className="py-12 text-center text-[14px] text-cinza">
                    Nenhum orçamento encontrado.{" "}
                    <Link href="/viagens/novo" className="font-semibold text-verde hover:underline">Criar novo orçamento</Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
