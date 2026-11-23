import Link from "next/link";
import { FileText } from "lucide-react";
import { Badge, Card, CardHeader, Eyebrow, PageHeader } from "@/components/ui";
import { Grade } from "@/components/kit";
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarReais } from "@/domain/dinheiro";
import { ROTULO_SITUACAO_PARCELA, situacaoDaParcela, type SituacaoParcela } from "@/domain/faturas";
import { formatarDocumento } from "@/domain/venda";
import { listarFaturas, obterFatura, proximoNumeroFatura, vendasParaFaturar, type ParcelaDaFatura } from "@/server/queries/faturas";
import { dataBr, dataCurta } from "../../viagens/formatos";
import { BotaoEmitir, BotaoReemitir } from "./acoes";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

const TOM_SITUACAO: Record<SituacaoParcela, "agua" | "ouro" | "verde" | undefined> = { recebida: "agua", cancelada: undefined, vencida: "ouro", vence_hoje: "verde", a_vencer: undefined };

function Situacao({ p, hoje }: { p: ParcelaDaFatura; hoje: string }) {
  const s = situacaoDaParcela(p, hoje);
  return (
    <Badge tom={TOM_SITUACAO[s]}>
      {ROTULO_SITUACAO_PARCELA[s]}
      {s === "recebida" ? ` em ${dataBr(p.recebidaEm)}` : ""}
    </Badge>
  );
}

export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const [vendas, faturas, contador] = await Promise.all([vendasParaFaturar(), listarFaturas(), proximoNumeroFatura()]);
  const selecionada = primeiro(sp.id) ?? faturas[0]?.id;
  const f = selecionada ? await obterFatura(selecionada) : null;
  const hoje = hojeEmCuiaba();

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader
        title="Faturas"
        subtitle="Cada venda fechada chega aqui para o financeiro emitir a fatura. A numeração segue em sequência, sem buracos."
        right={
          <p className="text-[14px] text-cinza">
            Próxima fatura: <b className="num text-[18px] text-verde">{contador.proximo}</b>
          </p>
        }
      />

      <Card className="mb-5 pb-2">
        <CardHeader title="Vendas para faturar" eyebrow="Vendas fechadas pelo comercial, com a forma e as parcelas acordadas." />
        {vendas.length === 0 ? (
          <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhuma venda aguardando fatura.</p>
        ) : (
          <Grade
            className="mt-3"
            right={[5]}
            head={["Viagem", "Cliente", "Fatura em nome de", "Venda em", "Forma acordada", "Total", ""]}
            rows={vendas.map((v) => [
              <span key="v">
                <b className="font-semibold">{v.destino}</b> · <Link href={`/viagens/${v.viagemId}`} className="num text-verde hover:underline">{v.codigoViagem}</Link>
              </span>,
              v.cliente,
              v.faturaNome,
              <span key="d" className="num">{dataBr(v.aceiteEm)}</span>,
              `${v.forma}, 1º vencimento ${dataBr(v.primeiroVencimento)}`,
              formatarReais(v.total),
              <span key="e" className="flex justify-end">
                <BotaoEmitir vendaId={v.vendaId} />
              </span>,
            ])}
          />
        )}
      </Card>

      {faturas.length === 0 ? (
        <Card className="p-6">
          <p className="text-[14px] text-cinza">Nenhuma fatura emitida ainda.</p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[400px_1fr]">
          <Card className="self-start p-2">
            <ul>
              {faturas.map((x) => (
                <li key={x.id}>
                  <Link
                    href={`/financeiro/faturas?id=${x.id}`}
                    aria-current={x.id === f?.id ? "true" : undefined}
                    className={`block rounded-[5px] px-4 py-3.5 ${x.id === f?.id ? "bg-verde/[0.08]" : "hover:bg-fundo"}`}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-verde">
                        Fatura {x.numero} · emitida em {dataCurta(x.emitidaEm)}
                      </span>
                      {x.desatualizada && <Badge tom="ouro">Fatura desatualizada</Badge>}
                    </span>
                    <span className="mt-0.5 block text-[15px] font-semibold text-texto">{x.nome}</span>
                    <span className="flex items-center justify-between text-[13px] text-cinza">
                      <span>
                        {x.destino} · <span className="num">{x.codigoViagem}</span>
                      </span>
                      <b className="num text-verde">{formatarReais(x.total)}</b>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {f && (
            <div className="space-y-5">
              <Card className="p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <Eyebrow>
                      Fatura {f.numero} · versão {f.versao} emitida em {dataCurta(f.emitidaEm)} por {f.emitidaPor}
                    </Eyebrow>
                    <p className="mt-1 text-[16px] font-semibold text-texto">
                      {f.dados.nome} <span className="num text-[14px] font-normal text-cinza">· {formatarDocumento(f.dados.documento)}</span>
                    </p>
                    <p className="mt-0.5 text-[14px] text-cinza">
                      {f.dados.destino} · <Link href={`/viagens/${f.viagemId}`} className="num text-verde hover:underline">{f.dados.codigoViagem}</Link> ·{" "}
                      <span className="num">{dataBr(f.dados.inicio)} a {dataBr(f.dados.fim)}</span> · {f.dados.forma}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    {f.desatualizada && <BotaoReemitir faturaId={f.id} />}
                    <Link
                      href={`/financeiro/faturas/${f.id}/imprimir`}
                      className="inline-flex items-center gap-2 rounded-[5px] border border-[#C9CDD1] bg-white px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde"
                    >
                      <FileText size={15} /> Imprimir
                    </Link>
                  </div>
                </div>
                {f.desatualizada && (
                  <p role="status" className="mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
                    Fatura desatualizada: as parcelas da venda mudaram depois da última emissão. Reemita para gerar a versão {f.versoes.length + 1} com o mesmo número.
                  </p>
                )}
                <div className="mt-5 grid grid-cols-1 gap-5 border-t border-linha pt-5 sm:grid-cols-3">
                  <div>
                    <Eyebrow>Total a pagar</Eyebrow>
                    <p className="num mt-1 text-[24px] font-bold text-verde">{formatarReais(f.totais.aPagar)}</p>
                    <dl className="mt-1 space-y-0.5 text-[13px] text-cinza">
                      <div className="flex justify-between gap-3">
                        <dt>Valor da venda</dt>
                        <dd className="num">{formatarReais(f.totais.venda)}</dd>
                      </div>
                      {f.totais.canceladas > 0n && (
                        <div className="flex justify-between gap-3">
                          <dt>
                            Parcelas canceladas <span className="num">({f.totais.numerosCancelados})</span>
                          </dt>
                          <dd className="num">− {formatarReais(f.totais.canceladas)}</dd>
                        </div>
                      )}
                    </dl>
                  </div>
                  <div>
                    <Eyebrow>Recebido</Eyebrow>
                    <p className="num mt-1 text-[24px] font-bold text-verde">{formatarReais(f.recebido)}</p>
                  </div>
                  <div>
                    <Eyebrow>Versões</Eyebrow>
                    <p className="mt-2 flex flex-wrap gap-x-3 text-[14px]">
                      {f.versoes.map((n) => (
                        <Link key={n} href={`/financeiro/faturas/${f.id}/imprimir?versao=${n}`} className="font-semibold text-verde hover:underline">
                          Versão {n}
                        </Link>
                      ))}
                    </p>
                  </div>
                </div>
              </Card>

              <Card className="pb-2">
                <CardHeader eyebrow="Situação atual das parcelas da venda; as baixas são feitas na viagem ou em Lançamentos." title="Cronograma de recebimentos" />
                <Grade
                  className="mt-3"
                  right={[2]}
                  head={["Parcela", "Vencimento", "Valor", "Situação"]}
                  rows={f.parcelas.map((p) => [
                    <b key="p" className={p.status === "cancelada" ? "font-semibold text-cinza line-through" : "font-semibold"}>
                      Parcela {p.numero} de {p.total}
                    </b>,
                    <span key="v" className="num">{dataBr(p.vencimento)}</span>,
                    formatarReais(p.valor),
                    <Situacao key="s" p={p} hoje={hoje} />,
                  ])}
                />
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
