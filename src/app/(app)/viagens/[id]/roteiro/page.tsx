import Link from "next/link";
import { notFound } from "next/navigation";
import { estadoIntegracao } from "@/server/integracoes/config";
import { roteiroDaViagem } from "@/server/queries/operacao";
import { Trilha } from "../trilha";
import { CriarRoteiro, EditorRoteiro } from "./editor";

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await roteiroDaViagem(id);
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
  return (
    <div className="mx-auto max-w-[1640px]">
      <Trilha viagem={c} ativa="roteiro" />
      {r.roteiro ? (
        <EditorRoteiro viagemId={id} destino={c.destino} inicio={c.inicio} fim={c.fim} roteiro={r.roteiro}
          aniversarios={r.aniversarios}
          iaLigada={estadoIntegracao("ia").configurada}
        />
      ) : (
        <CriarRoteiro viagemId={id} sugestao={r.sugestao} aniversarios={r.aniversarios} />
      )}
    </div>
  );
}
