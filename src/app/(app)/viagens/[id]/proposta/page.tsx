import Link from "next/link";
import { notFound } from "next/navigation";
import { formatarReais } from "@/domain/dinheiro";
import { obterProposta } from "@/server/queries/viagens";
import { dataCurta } from "../../formatos";
import { BotaoImprimir } from "./imprimir";

const data = (d: string) => d.split("-").reverse().join("/");

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await obterProposta(id);
  if (!r.ok) {
    if (r.erro === "Orçamento não encontrado") notFound();
    return (
      <div className="mx-auto max-w-[640px] py-16 text-center">
        <p className="text-[16px] font-semibold text-texto">{r.erro}</p>
        <Link href={`/viagens/${id}`} className="mt-4 inline-block text-[14px] font-semibold text-verde hover:underline">
          Voltar ao orçamento
        </Link>
      </div>
    );
  }
  const p = r.proposta;
  const pacote = p.total - p.taxaServico;

  return (
    <article className="mx-auto max-w-[820px] text-texto print:max-w-none">
      <style>{`@page { size: A4; margin: 16mm 14mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/viagens/${id}`} className="text-[14px] font-semibold text-verde hover:underline">
          Voltar ao orçamento
        </Link>
        <BotaoImprimir />
      </div>

      {p.desatualizada && (
        // Visível também na impressão: uma proposta desatualizada nunca sai sem aviso.
        <p role="status" className="mb-6 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto print:bg-transparent">
          Há alterações no orçamento ainda não aprovadas. Esta proposta mostra a versão {p.numeroVersao} aprovada em {p.aprovadaEm ? dataCurta(p.aprovadaEm) : ""}.
        </p>
      )}

      <header className="flex items-start justify-between gap-6 border-b-2 border-verde pb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-eclak.png" alt="ECLAK Viagens" className="h-[44px] w-auto" />
        <div className="text-right">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Proposta de viagem</p>
          <p className="num text-[18px] font-bold text-verde">{p.codigo}</p>
          <p className="text-[12.5px] text-cinza">Versão {p.numeroVersao}</p>
        </div>
      </header>

      <section className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Cliente</p>
          <p className="text-[16px] font-semibold">{p.cliente}</p>
          <p className="mt-1 text-[14px] text-cinza">{p.passageiros.join(", ")}</p>
        </div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Destino e período</p>
          <p className="text-[16px] font-semibold">{p.destino}</p>
          <p className="num mt-1 text-[14px] text-cinza">
            {data(p.inicio)} a {data(p.fim)} ({p.dias} dias, {p.noites} noites)
          </p>
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">O que está incluído</h2>
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-linha text-left text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">
              <th className="py-2 pr-3">Serviço</th>
              <th className="py-2 pr-3">Tipo</th>
              <th className="py-2 pr-3">Cidade</th>
              <th className="py-2">Datas</th>
            </tr>
          </thead>
          <tbody>
            {p.itens.map((i, k) => (
              <tr key={k} className="break-inside-avoid border-b border-linha align-top">
                <td className="py-2 pr-3 font-medium">{i.servico}</td>
                <td className="py-2 pr-3">{i.tipo}</td>
                <td className="py-2 pr-3">{i.cidade ?? ""}</td>
                <td className="num py-2">
                  {i.checkin && i.checkout ? `${data(i.checkin)} a ${data(i.checkout)}` : ""}
                  {i.diarias ? ` (${i.diarias} ${i.diarias === 1 ? "diária" : "diárias"})` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-8 break-inside-avoid rounded-[6px] border border-linha p-5">
        <dl className="space-y-2 text-[14.5px]">
          <div className="flex justify-between gap-4">
            <dt>Valor do pacote</dt>
            <dd className="num font-semibold">{formatarReais(pacote)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Taxa de serviço ({p.dias} dias)</dt>
            <dd className="num font-semibold">{formatarReais(p.taxaServico)}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-linha pt-2 text-[16px]">
            <dt className="font-bold">Valor total</dt>
            <dd className="num font-bold">{formatarReais(p.total)}</dd>
          </div>
          <div className="flex justify-between gap-4 text-[16px]">
            <dt className="font-bold text-verde">
              Por pessoa ({p.passageiros.length} {p.passageiros.length === 1 ? "passageiro" : "passageiros"})
            </dt>
            <dd className="num font-bold text-verde">{formatarReais(p.porPessoa)}</dd>
          </div>
        </dl>
        <p className="mt-4 text-[13.5px]">
          <span className="font-semibold">Forma de pagamento:</span> {p.forma}
        </p>
      </section>

      <p className="mt-6 text-[12.5px] leading-relaxed text-cinza">{p.validade}</p>
    </article>
  );
}
