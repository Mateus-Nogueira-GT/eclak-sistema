import Link from "next/link";
import { notFound } from "next/navigation";
import { formatarReais } from "@/domain/dinheiro";
import { formatarDocumento } from "@/domain/venda";
import { obterFatura } from "@/server/queries/faturas";
import { BotaoImprimir } from "../../../../viagens/[id]/proposta/imprimir";
import { dataBr, dataCurta } from "../../../../viagens/formatos";

// Página de impressão da fatura (mesmo padrão da proposta): mostra o retrato fixo da versão escolhida (padrão: a
// última). Layout provisório do protótipo até chegar o modelo FATURA_1405.

export default async function Pagina({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ versao?: string }> }) {
  const { id } = await params;
  const { versao } = await searchParams;
  if (versao !== undefined && !/^[1-9]\d{0,5}$/.test(versao)) notFound();
  const f = await obterFatura(id, versao === undefined ? undefined : Number(versao));
  if (!f) notFound();
  const d = f.dados;
  const t = f.totais;
  const ultima = f.versao === f.versoes.at(-1);

  return (
    <article className="mx-auto max-w-[820px] text-texto print:max-w-none">
      <style>{`@page { size: A4; margin: 16mm 14mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/financeiro/faturas?id=${f.id}`} className="text-[14px] font-semibold text-verde hover:underline">
          Voltar às faturas
        </Link>
        <BotaoImprimir />
      </div>

      {ultima && f.desatualizada && (
        // Visível também na impressão: uma fatura desatualizada nunca sai sem aviso.
        <p role="status" className="mb-6 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto print:bg-transparent">
          <b className="font-semibold">Fatura desatualizada.</b> As parcelas da venda mudaram depois desta emissão: reemita na tela Faturas antes de enviar ao cliente.
        </p>
      )}
      {!ultima && (
        <p role="status" className="mb-6 rounded-[5px] border border-linha bg-fundo px-4 py-3 text-[14px] text-texto print:hidden">
          Esta é a versão {f.versao}. A versão atual é a {f.versoes.at(-1)}.
        </p>
      )}

      <header className="flex items-start justify-between gap-6 border-b-2 border-verde pb-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-eclak.png" alt="ECLAK Viagens" className="h-[44px] w-auto" />
        <div className="text-right">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Fatura</p>
          <p className="num text-[24px] font-bold leading-tight text-verde">{f.numero}</p>
          <p className="text-[12.5px] text-cinza">
            Versão {f.versao} · emitida em <span className="num">{dataCurta(f.emitidaEm)}</span>
          </p>
        </div>
      </header>

      <section className="mt-6 grid gap-x-8 gap-y-4 sm:grid-cols-2">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Fatura em nome de</p>
          <p className="text-[16px] font-semibold">{d.nome}</p>
          <p className="num mt-1 text-[14px] text-cinza">
            {d.documento.length === 14 ? "CNPJ" : "CPF"} {formatarDocumento(d.documento)}
          </p>
        </div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Viagem</p>
          <p className="text-[16px] font-semibold">
            {d.destino} <span className="num text-[14px] font-normal text-cinza">· {d.codigoViagem}</span>
          </p>
          <p className="num mt-1 text-[14px] text-cinza">
            {dataBr(d.inicio)} a {dataBr(d.fim)}
          </p>
        </div>
      </section>

      <section className="mt-8 break-inside-avoid rounded-[6px] border border-linha p-5">
        <dl className="space-y-2 text-[14.5px]">
          <div className="flex justify-between gap-4">
            <dt>Forma de pagamento</dt>
            <dd className="font-semibold">{d.forma}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Valor da venda</dt>
            <dd className="num font-semibold">{formatarReais(t.venda)}</dd>
          </div>
          {t.canceladas > 0n && (
            <div className="flex justify-between gap-4">
              <dt>
                Parcelas canceladas <span className="num">({t.numerosCancelados})</span>
              </dt>
              <dd className="num font-semibold">− {formatarReais(t.canceladas)}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4 border-t border-linha pt-2 text-[16px]">
            <dt className="font-bold">Total a pagar</dt>
            <dd className="num border-b-2 border-terracota font-bold text-verde">{formatarReais(t.aPagar)}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-8">
        <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Parcelas</h2>
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-linha text-left text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">
              <th className="py-2 pr-3">Parcela</th>
              <th className="py-2 pr-3">Vencimento</th>
              <th className="py-2 text-right">Valor</th>
            </tr>
          </thead>
          <tbody>
            {d.parcelas.map((p) => (
              <tr key={p.numero} className="break-inside-avoid border-b border-linha">
                <td className="num py-2 pr-3 font-medium">
                  {p.numero}/{p.total}
                </td>
                <td className="num py-2 pr-3">{dataBr(p.vencimento)}</td>
                <td className="num py-2 text-right">{formatarReais(BigInt(p.valor))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </article>
  );
}
