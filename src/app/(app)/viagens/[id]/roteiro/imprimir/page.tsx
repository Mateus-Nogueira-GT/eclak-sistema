import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { nomeArquivo } from "@/domain/roteiro";
import { roteiroDaViagem } from "@/server/queries/operacao";
import { BotaoImprimir } from "../../proposta/imprimir";
import { DocumentoRoteiro, RodapeRoteiro } from "../previa";

// Impressão do roteiro (RT) ao cliente (padrão da proposta). O <title> é o nome do arquivo, que o navegador sugere
// ao salvar em PDF. O rodapé é fixo: na impressão ele se repete em toda página, sobre o espaço reservado pelo <tfoot>.

const carregar = cache((id: string) => roteiroDaViagem(id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const r = await carregar((await params).id);
  if (!r) return {};
  const c = r.cabecalho;
  return { title: nomeArquivo("RT", c.titular, c.destino, c.inicio, c.fim) };
}

function Indisponivel({ id, texto, voltar }: { id: string; texto: string; voltar: "viagem" | "roteiro" }) {
  return (
    <div className="mx-auto max-w-[640px] py-16 text-center">
      <p className="text-[16px] font-semibold text-texto">{texto}</p>
      <Link href={voltar === "viagem" ? `/viagens/${id}` : `/viagens/${id}/roteiro`} className="mt-4 inline-block text-[14px] font-semibold text-verde hover:underline">
        {voltar === "viagem" ? "Voltar à viagem" : "Voltar ao roteiro"}
      </Link>
    </div>
  );
}

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await carregar(id);
  if (!r) notFound();
  if (!r.cabecalho.vendida) return <Indisponivel id={id} texto="Disponível depois da venda" voltar="viagem" />;
  if (!r.roteiro) return <Indisponivel id={id} texto="Esta viagem ainda não tem roteiro" voltar="roteiro" />;

  return (
    <article className="mx-auto max-w-[820px] text-texto print:max-w-none">
      <style>{`@page { size: A4; margin: 14mm 14mm 10mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/viagens/${id}/roteiro`} className="text-[14px] font-semibold text-verde hover:underline">
          Voltar ao roteiro
        </Link>
        <BotaoImprimir />
      </div>

      <table className="w-full border-collapse">
        <tbody>
          <tr>
            <td className="p-0 align-top">
              <DocumentoRoteiro destino={r.cabecalho.destino} abertura={r.roteiro.abertura} conteudo={r.roteiro.conteudo} />
            </td>
          </tr>
        </tbody>
        <tfoot className="hidden print:table-footer-group">
          <tr>
            <td className="p-0">
              <div className="h-[16mm]" />
            </td>
          </tr>
        </tfoot>
      </table>

      <footer className="mt-10 border-t border-linha pt-3 print:fixed print:inset-x-0 print:bottom-0 print:mt-0 print:bg-white print:pb-1">
        <RodapeRoteiro />
      </footer>
    </article>
  );
}
