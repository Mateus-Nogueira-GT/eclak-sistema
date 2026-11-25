import Link from "next/link";
import { Badge, BotaoLink, Card, PageHeader } from "@/components/ui";
import { Grade } from "@/components/kit";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { ROTULO_MODALIDADE, TIPOS_SERVICO, type TipoServico } from "@/domain/fornecedores";
import { listarFornecedores } from "@/server/queries/fornecedores";
import { Filtros } from "./filtros";

type Busca = { busca?: string | string[]; tipo?: string | string[] };
const um = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Pagina({ searchParams }: { searchParams: Promise<Busca> }) {
  const sp = await searchParams;
  const busca = um(sp.busca);
  const tipo = (TIPOS_SERVICO as readonly string[]).includes(um(sp.tipo)) ? (um(sp.tipo) as TipoServico) : undefined;
  const lista = await listarFornecedores({ busca, tipo });

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title="Fornecedores"
        subtitle="Cadastro de fornecedores com as condições padrão de cada um."
        right={<BotaoLink href="/fornecedores/novo">Novo fornecedor</BotaoLink>}
      />
      <Card className="pb-2">
        <Filtros key={`${busca}|${tipo ?? ""}`} busca={busca} tipo={tipo ?? ""} />
        {lista.length === 0 ? (
          <p className="px-6 pb-5 pt-1 text-[14px] text-cinza">Nenhum fornecedor encontrado.</p>
        ) : (
          <Grade
            right={[4, 5]}
            head={["Nome", "Tipos", "Cidade", "Modalidade", "Comissão", "Tarifa fixa"]}
            rows={lista.map((f) => [
              <Link key="n" href={`/fornecedores/${f.id}`} className="font-semibold text-verde hover:underline">
                {f.nome}
              </Link>,
              <span key="t" className="flex flex-wrap gap-1">
                {f.tipos.map((t) => <Badge key={t}>{t}</Badge>)}
              </span>,
              f.cidade ?? "",
              ROTULO_MODALIDADE[f.modalidade],
              formatarPercentual(f.comissaoPct),
              formatarReais(f.tarifaFixa),
            ])}
          />
        )}
      </Card>
    </div>
  );
}
