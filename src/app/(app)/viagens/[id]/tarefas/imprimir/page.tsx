import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { hojeEmCuiaba } from "@/domain/clientes";
import { nomeArquivo } from "@/domain/roteiro";
import { CATEGORIAS_TAREFA, dataBr, ROTULO_CATEGORIA } from "@/domain/tarefas";
import { tarefasDaViagem } from "@/server/queries/operacao";
import { BotaoImprimir } from "../../proposta/imprimir";
import { nomeDoResponsavel, rotuloDia } from "../formatos";

// Impressão das tarefas (padrão da proposta): a mesma tabela por categoria, com o cabeçalho da viagem.
// O <title> é o nome do arquivo, que o navegador sugere ao salvar em PDF.

const carregar = cache((id: string) => tarefasDaViagem(id));

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const r = await carregar((await params).id);
  if (!r) return {};
  const c = r.cabecalho;
  return { title: nomeArquivo("TAREFAS", c.titular, c.destino, c.inicio, c.fim) };
}

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await carregar(id);
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
  const concluidas = r.tarefas.filter((t) => t.concluidaEm).length;

  return (
    <article className="mx-auto max-w-[1000px] text-texto print:max-w-none">
      <style>{`@page { size: A4; margin: 14mm 12mm; } @media print { html, body { background: #fff !important; } }`}</style>
      <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
        <Link href={`/viagens/${id}/tarefas`} className="text-[14px] font-semibold text-verde hover:underline">
          Voltar às tarefas
        </Link>
        <BotaoImprimir />
      </div>

      <header className="flex items-start justify-between gap-6 border-b-2 border-verde pb-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-eclak.png" alt="ECLAK Viagens" className="h-[40px] w-auto" />
        <div className="text-right">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Tarefas da viagem</p>
          <p className="num text-[18px] font-bold text-verde">{c.codigo}</p>
          <p className="text-[12.5px] text-cinza">Impresso em <span className="num">{dataBr(hojeEmCuiaba())}</span></p>
        </div>
      </header>

      <section className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-3">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Cliente</p>
          <p className="text-[15px] font-semibold">{c.cliente}</p>
          <p className="mt-0.5 text-[13px] text-cinza">{c.passageiros.map((p) => p.nome).join(", ")}</p>
        </div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Destino e período</p>
          <p className="text-[15px] font-semibold">{c.destino}</p>
          <p className="num mt-0.5 text-[13px] text-cinza">
            {dataBr(c.inicio)} a {dataBr(c.fim)} ({c.noites} {c.noites === 1 ? "noite" : "noites"})
          </p>
        </div>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Consultor</p>
          <p className="text-[15px] font-semibold">{c.consultor.nome}</p>
          <p className="num mt-0.5 text-[13px] text-cinza">{concluidas} de {r.tarefas.length} tarefas concluídas</p>
        </div>
      </section>

      <p className="mt-4 text-[13px] font-semibold text-texto">Controle interno, não enviar ao cliente.</p>

      {r.tarefas.length === 0 && <p className="mt-6 text-[14px] text-cinza">Nenhuma tarefa nesta viagem.</p>}

      {CATEGORIAS_TAREFA.map((cat) => {
        const ts = r.tarefas.filter((t) => t.categoria === cat);
        if (ts.length === 0) return null;
        return (
          <section key={cat} className="mt-6">
            <h2 className="mb-1.5 text-[13.5px] font-bold text-verde">{ROTULO_CATEGORIA[cat]}</h2>
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="border-b border-linha text-left text-[10px] font-bold uppercase tracking-[0.06em] text-cinza">
                  <th className="w-[26px] py-1.5 pr-2"><span className="sr-only">Concluída</span></th>
                  <th className="w-[80px] py-1.5 pr-2">Dia</th>
                  <th className="py-1.5 pr-2">Item</th>
                  <th className="py-1.5 pr-2">O que fazer</th>
                  <th className="w-[140px] py-1.5 pr-2">Prazo</th>
                  <th className="w-[110px] py-1.5 pr-2">Responsável</th>
                  <th className="py-1.5">Observações</th>
                </tr>
              </thead>
              <tbody>
                {ts.map((t) => {
                  const feita = t.concluidaEm !== null;
                  return (
                    <tr key={t.id} className={`break-inside-avoid border-b border-linha align-top ${feita ? "text-cinza" : ""}`}>
                      <td className="py-1.5 pr-2">
                        <span aria-label={feita ? "Concluída" : "Aberta"} className={`inline-block h-[11px] w-[11px] border border-texto ${feita ? "bg-cinza" : ""}`} />
                      </td>
                      <td className="num py-1.5 pr-2 whitespace-nowrap">{rotuloDia(t.dia)}</td>
                      <td className={`py-1.5 pr-2 font-medium ${feita ? "line-through" : ""}`}>{t.item}</td>
                      <td className="py-1.5 pr-2 whitespace-pre-line">{t.fazer}</td>
                      <td className="num py-1.5 pr-2">
                        {t.rotuloPrazo}
                        {t.situacao === "vencida" && <span className="ml-1 font-bold">(vencida)</span>}
                      </td>
                      <td className="py-1.5 pr-2">{nomeDoResponsavel(t.responsavel)}</td>
                      <td className="py-1.5 whitespace-pre-line">
                        {t.observacao}
                        {feita && t.concluidaPor && <span className="block text-cinza">Concluída por {t.concluidaPor}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      })}
    </article>
  );
}
