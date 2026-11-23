import { PageHeader } from "@/components/ui";
import { listarCategorias } from "@/server/queries/financeiro";
import { Categorias } from "./categorias";

export default async function Pagina() {
  const grupos = await listarCategorias();
  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title="Categorias" subtitle="Organizam os lançamentos do financeiro em contas a pagar e a receber." />
      <Categorias grupos={grupos} />
    </div>
  );
}
