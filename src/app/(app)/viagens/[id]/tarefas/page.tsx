import Link from "next/link";
import { notFound } from "next/navigation";
import { datasDaViagem } from "@/domain/roteiro";
import { tarefasDaViagem } from "@/server/queries/operacao";
import { Trilha } from "../trilha";
import { TarefasDaViagem } from "./tarefas";

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await tarefasDaViagem(id);
  if (!r) notFound();
  if (!r.cabecalho.vendida) {
    return (
      <div className="mx-auto max-w-[640px] py-16 text-center">
        <p className="text-[16px] font-semibold text-texto">Disponível depois da venda</p>
        <Link href={`/viagens/${id}`} className="mt-4 inline-block text-[14px] font-semibold text-verde hover:underline">
          Voltar à viagem
        </Link>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[1640px]">
      <Trilha viagem={r.cabecalho} ativa="tarefas" />
      <TarefasDaViagem
        viagemId={id}
        tarefas={r.tarefas}
        temDaVenda={r.temDaVenda}
        usuarios={r.usuarios}
        datas={datasDaViagem(r.cabecalho.inicio, r.cabecalho.fim)}
      />
    </div>
  );
}
