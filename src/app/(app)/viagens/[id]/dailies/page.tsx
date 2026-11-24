import Link from "next/link";
import { notFound } from "next/navigation";
import { hojeEmCuiaba } from "@/domain/clientes";
import { dailiesDaViagem } from "@/server/queries/operacao";
import { Trilha } from "../trilha";
import { Dailies } from "./dailies";

type Params = Record<string, string | string[] | undefined>;

export default async function Pagina({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Params> }) {
  const { id } = await params;
  const sp = await searchParams;
  const r = await dailiesDaViagem(id);
  if (!r) notFound();
  const c = r.cabecalho;
  if (!c.vendida) {
    return (
      <div className="mx-auto max-w-[640px] py-16 text-center">
        <p className="text-[16px] font-semibold text-texto">Disponível depois da venda</p>
        <Link href={`/viagens/${id}`} className="mt-4 inline-block text-[14px] font-semibold text-verde hover:underline">
          Voltar à viagem
        </Link>
      </div>
    );
  }
  if (!r.roteiro) {
    return (
      <div className="mx-auto max-w-[1640px]">
        <Trilha viagem={c} ativa="dailies" />
        <div className="rounded-[6px] border border-linha bg-white px-6 py-12 text-center">
          <p className="text-[16px] font-semibold text-texto">Crie o roteiro antes dos dailies</p>
          <p className="mt-1 text-[14px] text-cinza">Os dailies saem dos dias, hotéis e horários do roteiro.</p>
          <Link href={`/viagens/${id}/roteiro`} className="mt-4 inline-block text-[14px] font-semibold text-verde hover:underline">
            Abrir o roteiro
          </Link>
        </div>
      </div>
    );
  }

  // Dia aberto: o da URL (?dia=AAAA-MM-DD, vindo da lista /dailies), senão o primeiro de hoje em diante, senão o primeiro.
  const pedido = Array.isArray(sp.dia) ? sp.dia[0] : sp.dia;
  const hoje = hojeEmCuiaba();
  const inicial =
    r.dias.find((d) => d.data === pedido)?.data ?? r.dias.find((d) => d.data >= hoje)?.data ?? r.dias[0]?.data ?? "";

  return (
    <div className="mx-auto max-w-[1640px]">
      <Trilha viagem={c} ativa="dailies" />
      <Dailies
        roteiro={r.roteiro}
        destino={c.destino}
        encerramento={r.encerramento}
        usuarios={r.usuarios}
        dias={r.dias}
        diaInicial={inicial}
      />
    </div>
  );
}
