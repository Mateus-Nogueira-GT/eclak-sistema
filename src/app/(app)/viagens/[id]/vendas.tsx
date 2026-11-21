"use client";

import { Fragment, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Badge, Botao, Card, CardHeader } from "@/components/ui";
import { formatarCambio } from "@/domain/cambio";
import { arredondar } from "@/domain/decimal";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { custoAVista, custoLiquido } from "@/domain/precificacao";
import { escolherCotacao, removerCotacao, removerItem } from "@/server/actions/viagens";
import type { CotacaoFicha, FichaPrecificacao, ItemFicha } from "@/server/queries/viagens";
import { dataBr, formatarMoeda } from "../formatos";
import { useAcao } from "./acao";
import { FormCotacao, FormItem, type FornecedorOpcao } from "./formularios";

/** Estratégica disponível (o servidor a devolveu e deu certo). */
export function estrategicoOk(f: FichaPrecificacao) {
  return f.estrategico && !("erro" in f.estrategico) ? f.estrategico : null;
}

/** Custo líquido e à vista de uma cotação, pelas fórmulas do domínio. Só chamar com a camada estratégica em mãos. */
export function custosDaCotacao(item: ItemFicha, c: CotacaoFicha): { liquido: bigint; avista: bigint } | null {
  try {
    const x = { id: item.id, tipo: item.tipo, nome: item.servico, diarias: item.diarias, valorFornecedor: c.valorBrl, comissaoPct: c.comissaoPct, descontoAVistaPct: c.descontoAVistaPct };
    return { liquido: custoLiquido(x), avista: custoAVista(x) };
  } catch {
    return null;
  }
}

function BotaoRemover({ rotulo, aoConfirmar, desabilitado }: { rotulo: string; aoConfirmar: () => void; desabilitado: boolean }) {
  const [confirmando, setConfirmando] = useState(false);
  if (!confirmando) {
    return (
      <button type="button" aria-label={rotulo} title={rotulo} onClick={() => setConfirmando(true)} className="cursor-pointer rounded-[5px] p-1.5 text-cinza hover:bg-fundo hover:text-texto">
        <Trash2 size={15} />
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Botao className="!px-2.5 !py-1 !text-[12.5px]" disabled={desabilitado} onClick={() => { aoConfirmar(); setConfirmando(false); }}>Confirmar</Botao>
      <Botao variante="fantasma" className="!px-2 !py-1 !text-[12.5px]" onClick={() => setConfirmando(false)}>Cancelar</Botao>
    </span>
  );
}

type Form = { tipo: "item"; item?: ItemFicha } | { tipo: "cotacao"; item: ItemFicha; cotacao?: CotacaoFicha };

/** Média das cotações de outras viagens × valor lançado, para o aviso de custo de referência. */
function avisoReferencia(i: ItemFicha): string | null {
  if (!i.sugestao || i.cotacoes.length === 0) return null;
  const c = i.cotacoes.find((x) => x.escolhida) ?? i.cotacoes[0];
  const { quantidade, media } = i.sugestao;
  const base = `${i.servico}${i.cidade ? ` em ${i.cidade}` : ""} já tem ${quantidade} cotações registradas, com média de ${formatarReais(media)}.`;
  if (media === 0n) return base;
  const dif = arredondar((c.valorBrl - media) * 1000n, media); // décimos de ponto percentual
  const abs = dif < 0n ? -dif : dif;
  const txt = `${abs / 10n},${abs % 10n}%`;
  const rel = dif === 0n ? "igual à média" : dif > 0n ? `${txt} acima da média` : `${txt} abaixo da média`;
  return `${base} O valor lançado (${formatarReais(c.valorBrl)}) está ${rel}.`;
}

export function Vendas({
  ficha,
  fornecedores,
  limiteDiaria,
  editavel,
}: {
  ficha: FichaPrecificacao;
  fornecedores: FornecedorOpcao[];
  /** Centavos; só vem com a camada estratégica. */
  limiteDiaria: bigint | null;
  editavel: boolean;
}) {
  const est = estrategicoOk(ficha);
  const [form, setForm] = useState<Form | null>(null);
  const [novoAereo, setNovoAereo] = useState(false);
  const fechar = () => { setForm(null); setNovoAereo(false); };
  const porItem = new Map(est?.precificacao.itens.map((x) => [x.id, x]) ?? []);
  const avisos = ficha.itens.map(avisoReferencia).filter((x): x is string => x !== null);
  const acima = (i: ItemFicha) => {
    if (!est || limiteDiaria === null || i.tipo !== "Hotelaria" || !i.diarias || i.cotacoes.length === 0) return false;
    const x = porItem.get(i.id);
    return !!x && x.venda > 0n && i.cotacoes.some((c) => c.valorBrl === x.venda) && x.venda > limiteDiaria * BigInt(i.diarias);
  };
  const destacados = ficha.itens.filter(acima);

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          eyebrow="Uma linha por item, com as cotações de cada um"
          title="Vendas da viagem"
          right={
            <div className="flex flex-wrap items-center gap-3">
              {est && <span className="flex items-center gap-2 text-[12px] text-cinza"><span className="h-3 w-3 rounded-sm bg-verde/15" /> Visão estratégica</span>}
              {editavel && <Botao variante="secundario" onClick={() => { setNovoAereo(false); setForm({ tipo: "item" }); }}><Plus size={15} /> Adicionar item</Botao>}
            </div>
          }
        />
        {ficha.estrategico && "erro" in ficha.estrategico && (
          <p role="status" className="mx-6 mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
            Não foi possível calcular com os Parâmetros vigentes. Fale com o Diretor.
          </p>
        )}
        {editavel && form?.tipo === "item" && !form.item && !novoAereo && (
          <div className="mx-6 mt-4"><FormItem viagemId={ficha.id} aereo={false} onFechar={fechar} /></div>
        )}
        <TabelaItens ficha={ficha} itens={ficha.itens} aereo={false} fornecedores={fornecedores} est={est} porItem={porItem} editavel={editavel} form={form} setForm={setForm} fechar={fechar} acima={acima} />
        {avisos.length > 0 && (
          <div className="mx-6 mb-2 mt-4 border-l-2 border-verde bg-fundo px-4 py-3 text-[14px] text-texto">
            <b>Custo de referência:</b> {avisos[0]}
            {avisos.slice(1).map((a, i) => <span key={i} className="mt-0.5 block text-[13px] text-cinza">{a}</span>)}
            <span className="mt-0.5 block text-[13px] text-cinza">Serviços com poucas cotações ainda não geram sugestão. A referência só indica, não bloqueia.</span>
          </div>
        )}
        {est && destacados.length > 0 && (
          <p className="px-6 pb-5 pt-3 text-[13px] text-cinza">
            Linha destacada: {destacados.map((i) => `${i.servico} tem diária acima do limite de ${formatarReais(limiteDiaria ?? 0n)}`).join("; ")}. A venda fica igual ao valor do fornecedor.
          </p>
        )}
        {est && (
          <div className="grid grid-cols-2 gap-4 border-t border-linha px-6 py-5 sm:grid-cols-3 lg:grid-cols-5">
            {[
              ["Custo líquido (pior caso)", est.precificacao.custo],
              ["Custo à vista", est.precificacao.custoAVista],
              ["Soma das vendas", est.precificacao.somaVendas],
              ["Compensação (2x a 6x)", est.precificacao.porForma[2].compensacao],
              ["Pacote (2x a 6x)", est.precificacao.porForma[2].preco],
            ].map(([r, v]) => (
              <div key={String(r)}>
                <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">{String(r)}</p>
                <p className="num mt-1 text-[17px] font-bold text-verde">{formatarReais(v as bigint)}</p>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          eyebrow="Fica registrado na viagem, mas fora da precificação do terrestre e da margem aprovada"
          title="Aéreo (vendido à parte)"
          right={editavel ? <Botao variante="secundario" onClick={() => { setForm(null); setNovoAereo(true); }}><Plus size={15} /> Adicionar aéreo</Botao> : undefined}
        />
        {editavel && novoAereo && <div className="mx-6 mt-4"><FormItem viagemId={ficha.id} aereo onFechar={fechar} /></div>}
        {ficha.aereo.length === 0 && !novoAereo ? (
          <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhum aéreo lançado. A proposta diz &quot;Não inclui aéreo&quot;.</p>
        ) : (
          <TabelaItens ficha={ficha} itens={ficha.aereo} aereo fornecedores={fornecedores} est={null} porItem={porItem} editavel={editavel} form={form} setForm={setForm} fechar={fechar} acima={() => false} />
        )}
      </Card>
    </div>
  );
}

function TabelaItens({
  ficha,
  itens,
  aereo,
  fornecedores,
  est,
  porItem,
  editavel,
  form,
  setForm,
  fechar,
  acima,
}: {
  ficha: FichaPrecificacao;
  itens: ItemFicha[];
  aereo: boolean;
  fornecedores: FornecedorOpcao[];
  est: ReturnType<typeof estrategicoOk>;
  porItem: Map<string, NonNullable<ReturnType<typeof estrategicoOk>>["precificacao"]["itens"][number]>;
  editavel: boolean;
  form: Form | null;
  setForm: (f: Form | null) => void;
  fechar: () => void;
  acima: (i: ItemFicha) => boolean;
}) {
  const a = useAcao();
  if (itens.length === 0) return <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhum item. Use &quot;Adicionar item&quot; para começar.</p>;
  const cols = 7 + (est ? 5 : 0);
  const th = "whitespace-nowrap border-y border-linha px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.05em] text-verde";
  const td = "px-3 py-2.5 text-[13.5px] align-top";
  return (
    <div className="mt-3 overflow-x-auto">
      {a.erro && <p role="alert" className="mx-6 mb-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{a.erro}</p>}
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th className={`${th} bg-fundo text-left`}>Tipo</th>
            <th className={`${th} bg-fundo text-left`}>Cidade</th>
            <th className={`${th} bg-fundo text-left`}>{aereo ? "Trecho" : "Hotel / serviço"}</th>
            <th className={`${th} bg-fundo text-left`}>Check-in</th>
            <th className={`${th} bg-fundo text-left`}>Check-out</th>
            <th className={`${th} bg-fundo text-right`}>Diárias</th>
            {est && ["Custo líquido", "Custo à vista", "Venda", "Compensação", "Valor final"].map((h) => <th key={h} className={`${th} bg-verde/[0.09] text-right`}>{h}</th>)}
            <th className={`${th} bg-fundo`} />
          </tr>
        </thead>
        <tbody>
          {itens.map((i) => {
            const x = porItem.get(i.id);
            const destaque = acima(i);
            const editandoItem = form?.tipo === "item" && form.item?.id === i.id;
            const novaCotacao = form?.tipo === "cotacao" && form.item.id === i.id && !form.cotacao;
            return (
              <Fragment key={i.id}>
                <tr className={`border-t border-linha ${destaque ? "bg-ouro/15" : ""}`}>
                  <td className={td}>{i.tipo}</td>
                  <td className={td}>{i.cidade ?? ""}</td>
                  <td className={`${td} font-semibold`}>
                    {i.servico}
                    {i.cotacoes.length === 0 && !i.automatico && <span className="ml-2 text-[12px] font-normal text-cinza">Sem cotação</span>}
                    {i.automatico && <span className="ml-2 text-[12px] font-normal text-cinza">Automática</span>}
                  </td>
                  <td className={`${td} num`}>{dataBr(i.checkin)}</td>
                  <td className={`${td} num`}>{dataBr(i.checkout)}</td>
                  <td className={`${td} num text-right`}>{i.diarias ?? ""}</td>
                  {est && (
                    <>
                      <td className={`${td} num bg-verde/[0.04] text-right`}>{x ? formatarReais(x.custoLiquido) : ""}</td>
                      <td className={`${td} num bg-verde/[0.04] text-right`}>{x ? formatarReais(x.custoAVista) : ""}</td>
                      <td className={`${td} num bg-verde/[0.04] text-right`}>{x ? formatarReais(x.venda) : ""}</td>
                      <td className={`${td} num bg-verde/[0.04] text-right`}>{x ? formatarReais(x.compensacao) : ""}</td>
                      <td className={`${td} num bg-verde/[0.04] text-right font-semibold`}>{x ? formatarReais(x.valorFinal) : ""}</td>
                    </>
                  )}
                  <td className={`${td} whitespace-nowrap text-right`}>
                    {editavel && !i.automatico && (
                      <span className="inline-flex items-center gap-1">
                        <Botao variante="fantasma" className="!px-2 !py-1 !text-[12.5px]" onClick={() => setForm({ tipo: "cotacao", item: i })}><Plus size={13} /> Cotação</Botao>
                        <button type="button" aria-label={`Editar ${i.servico}`} title="Editar item" onClick={() => setForm({ tipo: "item", item: i })} className="cursor-pointer rounded-[5px] p-1.5 text-cinza hover:bg-fundo hover:text-texto"><Pencil size={15} /></button>
                        <BotaoRemover rotulo={`Remover ${i.servico}`} desabilitado={a.pendente} aoConfirmar={() => a.executar(() => removerItem(i.id))} />
                      </span>
                    )}
                  </td>
                </tr>
                {(i.cotacoes.length > 0 || editandoItem || novaCotacao || (form?.tipo === "cotacao" && form.item.id === i.id)) && (
                  <tr>
                    <td colSpan={cols} className="bg-white px-3 pb-3 pt-0">
                      <div className="ml-4 space-y-3 border-l-2 border-linha pl-4">
                        {editandoItem && <FormItem viagemId={ficha.id} item={i} aereo={aereo} onFechar={fechar} />}
                        {i.cotacoes.length > 0 && (
                          <Cotacoes item={i} aereo={aereo} est={!!est} editavel={editavel && !i.automatico} setForm={setForm} form={form} fornecedores={fornecedores} fechar={fechar} />
                        )}
                        {form?.tipo === "cotacao" && form.item.id === i.id && !form.cotacao && (
                          <FormCotacao item={i} fornecedores={fornecedores} aereo={aereo} onFechar={fechar} />
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Cotacoes({
  item,
  aereo,
  est,
  editavel,
  form,
  setForm,
  fornecedores,
  fechar,
}: {
  item: ItemFicha;
  aereo: boolean;
  est: boolean;
  editavel: boolean;
  form: Form | null;
  setForm: (f: Form | null) => void;
  fornecedores: FornecedorOpcao[];
  fechar: () => void;
}) {
  const a = useAcao();
  const th = "whitespace-nowrap px-2.5 py-1.5 text-[10.5px] font-bold uppercase tracking-[0.05em] text-cinza";
  const td = "px-2.5 py-2 text-[13px] align-top";
  const varias = item.cotacoes.length > 1;
  return (
    <div className="overflow-x-auto">
      {a.erro && <p role="alert" className="mb-2 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{a.erro}</p>}
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr className="text-left">
            <th className={`${th} w-[24%]`}>Fornecedor</th>
            <th className={`${th} text-right`}>Valor na moeda</th>
            <th className={`${th} text-right`}>Valor em reais</th>
            <th className={`${th} text-right`}>Com.</th>
            <th className={`${th} text-right`}>Desc. à vista</th>
            {aereo && <th className={`${th} text-right`}>Tarifa fixa por bilhete</th>}
            {est && <th className={`${th} text-right`}>Custo líquido</th>}
            {est && <th className={`${th} text-right`}>Custo à vista</th>}
            <th className={`${th} w-[200px]`} />
          </tr>
        </thead>
        <tbody>
          {item.cotacoes.map((c) => {
            if (form?.tipo === "cotacao" && form.cotacao?.id === c.id) {
              return (
                <tr key={c.id}>
                  <td colSpan={9} className="py-2"><FormCotacao item={item} fornecedores={fornecedores} cotacao={c} aereo={aereo} onFechar={fechar} /></td>
                </tr>
              );
            }
            const custos = est ? custosDaCotacao(item, c) : null;
            return (
              <tr key={c.id} className="border-t border-linha/70">
                <td className={td}>{c.fornecedor?.nome ?? <span className="text-cinza">A informar</span>}</td>
                <td className={`${td} num text-right`}>
                  {formatarMoeda(c.valorOriginal, c.moeda)}
                  {c.moeda !== "BRL" && c.cambioAplicado && (
                    <span className="block text-[11.5px] text-cinza">Câmbio aplicado {formatarCambio(c.cambioAplicado)} em {dataBr(c.cambioData)}</span>
                  )}
                </td>
                <td className={`${td} num text-right`}>{formatarReais(c.valorBrl)}</td>
                <td className={`${td} num text-right`}>{formatarPercentual(c.comissaoPct)}</td>
                <td className={`${td} num text-right`}>{c.descontoAVistaPct ? formatarPercentual(c.descontoAVistaPct) : ""}</td>
                {aereo && <td className={`${td} num text-right`}>{c.tarifaFixa > 0n ? formatarReais(c.tarifaFixa) : ""}</td>}
                {est && <td className={`${td} num bg-verde/[0.04] text-right`}>{custos ? formatarReais(custos.liquido) : ""}</td>}
                {est && <td className={`${td} num bg-verde/[0.04] text-right`}>{custos ? formatarReais(custos.avista) : ""}</td>}
                <td className={`${td} whitespace-nowrap text-right`}>
                  {varias && c.escolhida && <Badge tom="grafite" className="mr-1">Escolhida</Badge>}
                  {editavel && (
                    <span className="inline-flex items-center gap-1">
                      {varias && !c.escolhida && (
                        <Botao variante="fantasma" className="!px-2 !py-1 !text-[12.5px]" disabled={a.pendente} onClick={() => a.executar(() => escolherCotacao(c.id))}>Escolher</Botao>
                      )}
                      <button type="button" aria-label="Editar cotação" title="Editar cotação" onClick={() => setForm({ tipo: "cotacao", item, cotacao: c })} className="cursor-pointer rounded-[5px] p-1.5 text-cinza hover:bg-fundo hover:text-texto"><Pencil size={14} /></button>
                      <BotaoRemover rotulo="Remover cotação" desabilitado={a.pendente} aoConfirmar={() => a.executar(() => removerCotacao(c.id))} />
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
