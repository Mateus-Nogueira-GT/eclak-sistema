"use client";

import { useState } from "react";
import { Botao, Campo, Select, inputCls } from "@/components/ui";
import { MOEDAS, type Moeda } from "@/domain/cambio";
import { TIPOS_ITEM_ENTRADA } from "@/domain/viagens-entrada";
import { salvarCotacao, salvarItem } from "@/server/actions/viagens";
import type { CotacaoFicha, ItemFicha } from "@/server/queries/viagens";
import { pctParaCampo, reaisParaCampo } from "../formatos";
import { useAcao } from "./acao";

export type FornecedorOpcao = { id: string; nome: string; comissaoPct: string; tarifaFixa: bigint };

function Erro({ texto }: { texto?: string }) {
  return texto ? <span className="mt-1 block text-[12px] text-texto">{texto}</span> : null;
}

function Aviso({ texto }: { texto: string | null }) {
  return texto ? (
    <p role="alert" className="mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{texto}</p>
  ) : null;
}

const diasEntre = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Item novo (sem `item`) ou edição. `aereo` fixa o tipo em Aéreo. */
export function FormItem({ viagemId, item, aereo, onFechar }: { viagemId: string; item?: ItemFicha; aereo: boolean; onFechar: () => void }) {
  const a = useAcao();
  const [tipo, setTipo] = useState<string>(item?.tipo ?? (aereo ? "Aéreo" : "Hotelaria"));
  const [servico, setServico] = useState(item?.servico ?? "");
  const [cidade, setCidade] = useState(item?.cidade ?? "");
  const [checkin, setCheckin] = useState(item?.checkin ?? "");
  const [checkout, setCheckout] = useState(item?.checkout ?? "");
  const [diarias, setDiarias] = useState(item?.diarias != null ? String(item.diarias) : "");
  const [diariasMexidas, setDiariasMexidas] = useState(item?.diarias != null);

  function datas(ci: string, co: string) {
    if (!diariasMexidas && ci && co && co >= ci) setDiarias(String(diasEntre(ci, co)));
  }

  function salvar() {
    a.executar(
      () =>
        salvarItem(
          viagemId,
          {
            tipo: tipo as (typeof TIPOS_ITEM_ENTRADA)[number],
            servico,
            cidade: cidade.trim() || null,
            checkin: checkin || null,
            checkout: checkout || null,
            diarias: diarias.trim() === "" ? null : Number(diarias),
          },
          item?.id,
        ),
      onFechar,
    );
  }

  const marca = (k: string) => (a.campos[k] ? "!border-ouro bg-ouro/15" : "");
  const tipos = TIPOS_ITEM_ENTRADA.filter((t) => (aereo ? t === "Aéreo" : t !== "Aéreo"));
  return (
    <div className="rounded-[6px] border border-linha bg-fundo/60 p-4">
      <p className="mb-3 text-[14px] font-bold text-texto">{item ? "Editar item" : aereo ? "Novo item de aéreo" : "Novo item"}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        {!aereo && (
          <Campo label="Tipo">
            <Select value={tipo} onChange={setTipo} className="w-full">
              {tipos.map((t) => <option key={t} value={t}>{t}</option>)}
            </Select>
            <Erro texto={a.campos.tipo} />
          </Campo>
        )}
        <Campo label={aereo ? "Trecho ou descrição" : "Hotel / serviço"} className={aereo ? "lg:col-span-3" : "lg:col-span-2"}>
          <input className={`${inputCls} ${marca("servico")}`} value={servico} onChange={(e) => { setServico(e.target.value); a.limparCampo("servico"); }} />
          <Erro texto={a.campos.servico} />
        </Campo>
        <Campo label="Cidade">
          <input className={`${inputCls} ${marca("cidade")}`} value={cidade} onChange={(e) => setCidade(e.target.value)} />
          <Erro texto={a.campos.cidade} />
        </Campo>
        <Campo label="Check-in">
          <input type="date" className={`${inputCls} ${marca("checkin")}`} value={checkin} onChange={(e) => { setCheckin(e.target.value); datas(e.target.value, checkout); }} />
          <Erro texto={a.campos.checkin} />
        </Campo>
        <Campo label="Check-out">
          <input type="date" className={`${inputCls} ${marca("checkout")}`} value={checkout} onChange={(e) => { setCheckout(e.target.value); datas(checkin, e.target.value); }} />
          <Erro texto={a.campos.checkout} />
        </Campo>
        {tipo === "Hotelaria" && (
          <Campo label="Diárias">
            <input inputMode="numeric" className={`${inputCls} ${marca("diarias")}`} value={diarias} onChange={(e) => { setDiarias(e.target.value); setDiariasMexidas(true); }} />
            <Erro texto={a.campos.diarias} />
          </Campo>
        )}
      </div>
      <Aviso texto={a.erro} />
      <div className="mt-4 flex gap-2">
        <Botao onClick={salvar} disabled={a.pendente}>{item ? "Salvar item" : "Adicionar item"}</Botao>
        <Botao variante="fantasma" onClick={onFechar} disabled={a.pendente}>Cancelar</Botao>
      </div>
    </div>
  );
}

/** Cotação nova (sem `cotacao`) ou edição. Fornecedor preenche comissão (e a tarifa fixa do aéreo) com o padrão dele. */
export function FormCotacao({
  item,
  fornecedores,
  cotacao,
  aereo,
  onFechar,
}: {
  item: ItemFicha;
  fornecedores: FornecedorOpcao[];
  cotacao?: CotacaoFicha;
  aereo: boolean;
  onFechar: () => void;
}) {
  const a = useAcao();
  const [moeda, setMoeda] = useState<Moeda>(cotacao?.moeda ?? "BRL");
  const [valor, setValor] = useState(cotacao ? reaisParaCampo(cotacao.valorOriginal) : "");
  const [fornecedorId, setFornecedorId] = useState(cotacao?.fornecedor?.id ?? "");
  const [comissao, setComissao] = useState(cotacao ? pctParaCampo(cotacao.comissaoPct) : "");
  const [desconto, setDesconto] = useState(cotacao?.descontoAVistaPct ? pctParaCampo(cotacao.descontoAVistaPct) : "");
  const [tarifa, setTarifa] = useState(cotacao && cotacao.tarifaFixa > 0n ? reaisParaCampo(cotacao.tarifaFixa) : "");

  function escolherFornecedor(id: string) {
    setFornecedorId(id);
    const f = fornecedores.find((x) => x.id === id);
    if (!f) return;
    setComissao(pctParaCampo(f.comissaoPct));
    if (aereo) setTarifa(f.tarifaFixa > 0n ? reaisParaCampo(f.tarifaFixa) : "");
    a.limparCampo("comissao");
  }

  function salvar() {
    a.executar(
      () =>
        salvarCotacao(
          item.id,
          {
            moeda,
            valor,
            fornecedorId: fornecedorId || null,
            comissao: comissao.trim() || null,
            descontoAVista: desconto.trim() || null,
            tarifaFixa: aereo ? tarifa.trim() || null : null,
          },
          cotacao?.id,
        ),
      onFechar,
    );
  }

  const marca = (k: string) => (a.campos[k] ? "!border-ouro bg-ouro/15" : "");
  return (
    <div className="rounded-[6px] border border-linha bg-white p-4">
      <p className="mb-3 text-[14px] font-bold text-texto">
        {cotacao ? "Editar cotação" : "Nova cotação"} · {item.servico}
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Campo label="Moeda">
          <Select value={moeda} onChange={(v) => { setMoeda(v as Moeda); a.limparCampo("moeda"); }} className="w-full">
            {MOEDAS.map((m) => <option key={m} value={m}>{m}</option>)}
          </Select>
          <Erro texto={a.campos.moeda} />
        </Campo>
        <Campo label={`Valor em ${moeda}`}>
          <input inputMode="decimal" placeholder="0,00" className={`${inputCls} ${marca("valor")}`} value={valor} onChange={(e) => { setValor(e.target.value); a.limparCampo("valor"); }} />
          <Erro texto={a.campos.valor} />
        </Campo>
        <Campo label="Fornecedor" className="lg:col-span-2">
          <Select value={fornecedorId} onChange={escolherFornecedor} className="w-full">
            <option value="">Sem fornecedor (a informar)</option>
            {fornecedores.map((f) => <option key={f.id} value={f.id}>{f.nome}</option>)}
          </Select>
          <Erro texto={a.campos.fornecedorId} />
        </Campo>
        <Campo label="Comissão (%)">
          <input inputMode="decimal" placeholder="0" className={`${inputCls} ${marca("comissao")}`} value={comissao} onChange={(e) => { setComissao(e.target.value); a.limparCampo("comissao"); }} />
          <Erro texto={a.campos.comissao} />
        </Campo>
        <Campo label="Desconto à vista (%)">
          <input inputMode="decimal" placeholder="Sem desconto" className={`${inputCls} ${marca("descontoAVista")}`} value={desconto} onChange={(e) => { setDesconto(e.target.value); a.limparCampo("descontoAVista"); }} />
          <Erro texto={a.campos.descontoAVista} />
        </Campo>
        {aereo && (
          <Campo label="Tarifa fixa por bilhete (R$)">
            <input inputMode="decimal" placeholder="0,00" className={`${inputCls} ${marca("tarifaFixa")}`} value={tarifa} onChange={(e) => { setTarifa(e.target.value); a.limparCampo("tarifaFixa"); }} />
            <Erro texto={a.campos.tarifaFixa} />
          </Campo>
        )}
      </div>
      {moeda !== "BRL" && (
        <p className="mt-3 text-[12.5px] text-cinza">
          O câmbio aplicado é o dos Parâmetros vigentes (comercial mais o acréscimo) e fica gravado na cotação.
        </p>
      )}
      <Aviso texto={a.erro} />
      <div className="mt-4 flex gap-2">
        <Botao onClick={salvar} disabled={a.pendente}>{cotacao ? "Salvar cotação" : "Adicionar cotação"}</Botao>
        <Botao variante="fantasma" onClick={onFechar} disabled={a.pendente}>Cancelar</Botao>
      </div>
    </div>
  );
}
