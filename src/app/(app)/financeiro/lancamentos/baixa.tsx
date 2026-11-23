"use client";

import { useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Botao, Campo, Eyebrow, Select, inputCls } from "@/components/ui";
import { lerReais } from "@/domain/dinheiro";
import type { Moeda } from "@/domain/cambio";
import { baixarLinha, baixarRepasse } from "@/server/actions/financeiro";
import type { LinhaLancamento } from "@/server/queries/financeiro";
import { useAcao } from "../../viagens/[id]/acao";
import { dataBr, formatarMoeda, reaisParaCampo } from "../../viagens/formatos";

export type ContaOpcao = { id: string; nome: string };

/** Janela sobre a lista (o mesmo molde do formulário de lançamento). */
export function Dialogo({ eyebrow, titulo, largura = "max-w-[640px]", onFechar, children, rodape }: { eyebrow: string; titulo: string; largura?: string; onFechar: () => void; children: ReactNode; rodape: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-texto/40 p-4 pt-[6vh]" onClick={onFechar}>
      <div role="dialog" aria-label={titulo} className={`w-full ${largura} rounded-[7px] bg-white shadow-[0_18px_48px_rgba(51,49,50,0.22)]`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-linha px-6 py-4">
          <div>
            <Eyebrow>{eyebrow}</Eyebrow>
            <h2 className="mt-0.5 text-[18px] font-bold text-texto">{titulo}</h2>
          </div>
          <button onClick={onFechar} aria-label="Fechar" className="cursor-pointer rounded-[5px] p-2 text-cinza hover:bg-fundo">
            <X size={18} />
          </button>
        </div>
        {children}
        <div className="flex items-center justify-end gap-2 border-t border-linha px-6 py-4">{rodape}</div>
      </div>
    </div>
  );
}

export function ErroAcao({ acao }: { acao: ReturnType<typeof useAcao> }) {
  if (!acao.erro) return null;
  const extras = [...new Set(Object.values(acao.campos))].filter((m) => m !== acao.erro);
  return (
    <p role="alert" className="mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
      {acao.erro}
      {extras.length > 0 && `: ${extras.join("; ")}`}
    </p>
  );
}

export const marca = (acao: ReturnType<typeof useAcao>, k: string) => (acao.campos[k] ? "!border-ouro bg-ouro/15" : "");

/** A única conta ativa já vem escolhida; com mais de uma, a escolha é obrigatória. */
export const contaPadrao = (contas: ContaOpcao[]) => (contas.length === 1 ? contas[0].id : "");

export function CampoConta({ contas, valor, onChange, invalido, rotulo = "Conta bancária" }: { contas: ContaOpcao[]; valor: string; onChange: (v: string) => void; invalido?: boolean; rotulo?: string }) {
  return (
    <Campo label={rotulo}>
      <Select value={valor} onChange={onChange} className={`w-full ${invalido ? "!border-ouro bg-ouro/15" : ""}`}>
        <option value="">{contas.length === 0 ? "Nenhuma conta ativa" : "Escolha a conta"}</option>
        {contas.map((c) => (
          <option key={c.id} value={c.id}>{c.nome}</option>
        ))}
      </Select>
      {contas.length === 0 && <span className="mt-1 block text-[12px] text-cinza">Cadastre em Financeiro › Contas bancárias.</span>}
    </Campo>
  );
}

const diferenteDe = (texto: string, centavos: bigint) => {
  try {
    return lerReais(texto) !== centavos;
  } catch {
    return false; // ilegível: o servidor responde com o erro do campo
  }
};

/**
 * Baixa de uma linha da lista: os campos da baixa conforme a origem (os mesmos da tela da viagem). A parcela de
 * repasse do cartão pede o valor repassado; o pagamento em moeda estrangeira pede o câmbio efetivo.
 */
export function DialogoBaixa({ linha, hoje, contas, onFechar }: { linha: LinhaLancamento; hoje: string; contas: ContaOpcao[]; onFechar: () => void }) {
  const acao = useAcao();
  const [data, setData] = useState(hoje);
  const [conta, setConta] = useState(contaPadrao(contas));
  const valorInicial = linha.origem === "pagamento" && linha.valorOriginal !== null ? linha.valorOriginal : linha.valorPrevisto;
  const [valor, setValor] = useState(reaisParaCampo(valorInicial > 0n ? valorInicial : 0n));
  const [juros, setJuros] = useState("");
  const [desconto, setDesconto] = useState("");
  const [taxa, setTaxa] = useState("");
  const [cambio, setCambio] = useState("");
  const [observacao, setObservacao] = useState("");
  const pagar = linha.lado === "pagar";
  const estrangeira = linha.origem === "pagamento" && linha.moeda !== null && linha.moeda !== "BRL";
  const repasse = linha.origem === "parcela" && linha.repasse;

  let corpo: ReactNode;
  let enviar: () => Promise<{ ok: true } | { ok: false; erro: string; campos?: Record<string, string> }>;
  const campoData = (k: string, rotulo: string) => (
    <Campo label={rotulo}>
      <input type="date" max={hoje} className={`${inputCls} ${marca(acao, k)}`} value={data} onChange={(e) => setData(e.target.value)} />
    </Campo>
  );
  const campoValor = (k: string, rotulo: string) => (
    <Campo label={rotulo}>
      <input className={`${inputCls} num text-right ${marca(acao, k)}`} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
    </Campo>
  );
  const campoObservacao = (obrigatoria: boolean, dica: string) => (
    <Campo label={obrigatoria ? "Observação (obrigatória: valor diferente do previsto)" : "Observação (opcional)"} className="col-span-2">
      <input className={`${inputCls} ${marca(acao, "observacao")}`} placeholder={obrigatoria ? dica : ""} value={observacao} onChange={(e) => setObservacao(e.target.value)} />
    </Campo>
  );
  const contaCampo = <CampoConta contas={contas} valor={conta} onChange={setConta} invalido={"contaBancariaId" in acao.campos} />;

  if (repasse) {
    enviar = () => baixarRepasse(linha.id, { data, valorRepassado: valor, contaBancariaId: conta });
    corpo = (
      <>
        {campoData("data", "Data do repasse")}
        {campoValor("valorRepassado", "Valor repassado")}
        {contaCampo}
        <p className="col-span-2 text-[13px] text-cinza">
          O que o fornecedor reteve a mais que o esperado ({reaisParaCampo(linha.valorPrevisto)}) vira taxa da forma; as contas dele na viagem ficam quitadas pelo previsto.
        </p>
      </>
    );
  } else if (linha.origem === "manual") {
    let diferente = false;
    try {
      diferente = lerReais(valor) !== linha.valorPrevisto + (juros ? lerReais(juros) : 0n) - (desconto ? lerReais(desconto) : 0n);
    } catch {
      // ilegível: o servidor responde
    }
    enviar = () => baixarLinha("manual", linha.id, { data, valorPago: valor, juros, desconto, contaBancariaId: conta, observacao });
    corpo = (
      <>
        {campoData("data", pagar ? "Data do pagamento" : "Data do recebimento")}
        {campoValor("valorPago", pagar ? "Valor pago" : "Valor recebido")}
        <Campo label="Juros e multa (opcional)">
          <input className={`${inputCls} num text-right ${marca(acao, "juros")}`} inputMode="decimal" placeholder="0,00" value={juros} onChange={(e) => setJuros(e.target.value)} />
        </Campo>
        <Campo label="Desconto (opcional)">
          <input className={`${inputCls} num text-right ${marca(acao, "desconto")}`} inputMode="decimal" placeholder="0,00" value={desconto} onChange={(e) => setDesconto(e.target.value)} />
        </Campo>
        {contaCampo}
        <div />
        {campoObservacao(diferente, "Explique a diferença do valor pago")}
      </>
    );
  } else if (linha.origem === "parcela") {
    enviar = () => baixarLinha("parcela", linha.id, { recebidaEm: data, valorRecebido: valor, taxaEfetiva: taxa || null, observacao: observacao || null, contaBancariaId: conta });
    corpo = (
      <>
        {campoData("recebidaEm", "Data do recebimento")}
        {campoValor("valorRecebido", "Valor recebido")}
        <Campo label="Taxa efetiva (opcional)">
          <input
            className={`${inputCls} num text-right ${marca(acao, "taxaEfetiva")}`}
            inputMode="decimal"
            placeholder={`Prevista: ${reaisParaCampo(linha.taxa)}`}
            value={taxa}
            onChange={(e) => setTaxa(e.target.value)}
          />
        </Campo>
        {contaCampo}
        {campoObservacao(diferenteDe(valor, linha.valorPrevisto), "Explique a diferença do valor recebido")}
      </>
    );
  } else if (linha.origem === "pagamento") {
    enviar = () => baixarLinha("pagamento", linha.id, { pagoEm: data, valorOriginalPago: valor, cambioEfetivo: estrangeira ? cambio || null : null, contaBancariaId: conta });
    corpo = (
      <>
        {campoData("pagoEm", "Data do pagamento")}
        {campoValor("valorOriginalPago", `Valor pago (${linha.moeda ?? "BRL"})`)}
        {estrangeira && (
          <Campo label="Câmbio efetivo">
            <input className={`${inputCls} num text-right ${marca(acao, "cambioEfetivo")}`} inputMode="decimal" placeholder="Ex.: 6,2000" value={cambio} onChange={(e) => setCambio(e.target.value)} />
          </Campo>
        )}
        {contaCampo}
      </>
    );
  } else {
    enviar = () => baixarLinha("comissao", linha.id, { recebidaEm: data, valorRecebido: valor, contaBancariaId: conta });
    corpo = (
      <>
        {campoData("recebidaEm", "Data do recebimento")}
        {campoValor("valorRecebido", "Valor recebido")}
        {contaCampo}
      </>
    );
  }

  const previsto =
    estrangeira && linha.valorOriginal !== null && linha.moeda
      ? `${formatarMoeda(linha.valorOriginal, linha.moeda)} (previsto em reais: ${reaisParaCampo(linha.valorPrevisto)})`
      : formatarMoeda(linha.valorPrevisto, "BRL");
  return (
    <Dialogo
      eyebrow={repasse ? "Registrar repasse" : pagar ? "Dar baixa · a pagar" : "Dar baixa · a receber"}
      titulo={linha.pessoa || linha.descricao}
      onFechar={onFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={onFechar}>Cancelar</Botao>
          <Botao disabled={acao.pendente} onClick={() => acao.executar(enviar, onFechar)}>
            {repasse ? "Confirmar repasse" : "Confirmar baixa"}
          </Botao>
        </>
      }
    >
      <div className="px-6 py-5">
        <p className="mb-4 text-[13.5px] text-cinza">
          {linha.descricao} · vence em {dataBr(linha.vencimento)} · previsto <span className="num font-semibold text-texto">{previsto}</span>
          {linha.viagemCodigo && <> · Viagem {linha.viagemCodigo} (a mesma baixa da tela da viagem)</>}
        </p>
        <div className="grid grid-cols-2 gap-4">{corpo}</div>
        <ErroAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

/** Compra em moeda estrangeira de uma fatura do cartão: na baixa, pede o valor em reais cobrado (com IOF). */
export type CompraEstrangeira = { id: string; descricao: string; pessoa: string | null; moeda: Moeda; valorOriginal: bigint; valorPrevisto: bigint };

/**
 * Baixa da fatura do cartão corporativo (a mesma na lista e na tela de cartões): data, conta bancária (a de débito do
 * cartão já vem escolhida, se ativa) e, para cada compra em moeda estrangeira, o valor em reais cobrado na fatura.
 * Uma saída só no banco, pelo total; as compras ficam quitadas junto.
 */
export function DialogoBaixaFatura({
  fatura,
  estrangeiras,
  hoje,
  contas,
  contaInicial,
  onFechar,
}: {
  fatura: { id: string; titulo: string; descricao: string; vencimento: string; total: bigint };
  estrangeiras: CompraEstrangeira[];
  hoje: string;
  contas: ContaOpcao[];
  contaInicial: string | null;
  onFechar: () => void;
}) {
  const acao = useAcao();
  const [data, setData] = useState(hoje);
  const [conta, setConta] = useState(contaInicial && contas.some((c) => c.id === contaInicial) ? contaInicial : contaPadrao(contas));
  const [valores, setValores] = useState<Record<string, string>>({});
  let total = fatura.total;
  let legivel = true;
  for (const e of estrangeiras) {
    try {
      total += (valores[e.id] ? lerReais(valores[e.id]) : e.valorPrevisto) - e.valorPrevisto;
    } catch {
      legivel = false;
    }
  }
  const enviar = () =>
    baixarLinha("fatura_cartao", fatura.id, {
      data,
      contaBancariaId: conta,
      estrangeiras: estrangeiras.map((e) => ({ pagamentoId: e.id, valorBrl: valores[e.id] ?? "" })),
    });
  return (
    <Dialogo
      eyebrow="Dar baixa · fatura do cartão"
      titulo={fatura.titulo}
      onFechar={onFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={onFechar}>Cancelar</Botao>
          <Botao disabled={acao.pendente} onClick={() => acao.executar(enviar, onFechar)}>Confirmar baixa</Botao>
        </>
      }
    >
      <div className="px-6 py-5">
        <p className="mb-4 text-[13.5px] text-cinza">
          {fatura.descricao} · vence em {dataBr(fatura.vencimento)} · previsto <span className="num font-semibold text-texto">{formatarMoeda(fatura.total, "BRL")}</span>
        </p>
        <div className="grid grid-cols-2 gap-4">
          <Campo label="Data do pagamento">
            <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "data")}`} value={data} onChange={(e) => setData(e.target.value)} />
          </Campo>
          <CampoConta contas={contas} valor={conta} onChange={setConta} invalido={"contaBancariaId" in acao.campos} />
        </div>
        {estrangeiras.length > 0 && (
          <div className="mt-5">
            <Eyebrow>Compras em moeda estrangeira</Eyebrow>
            <p className="mt-1 text-[13px] text-cinza">Informe o valor em reais cobrado na fatura (com IOF). O câmbio efetivo de cada compra sai dele.</p>
            <div className="mt-3 space-y-3">
              {estrangeiras.map((e) => {
                const k = `estrangeiras.${e.id}`;
                const invalido = k in acao.campos || "estrangeiras" in acao.campos;
                return (
                  <div key={e.id} className="grid grid-cols-[1fr_200px] items-end gap-4">
                    <div className="text-[13.5px]">
                      <b className="font-semibold">{e.pessoa || e.descricao}</b>
                      <span className="block text-cinza">
                        {e.descricao} · {formatarMoeda(e.valorOriginal, e.moeda)} · previsto {formatarMoeda(e.valorPrevisto, "BRL")}
                      </span>
                      {acao.campos[k] && <span className="block text-[12px] text-texto">{acao.campos[k]}</span>}
                    </div>
                    <Campo label="Valor em reais cobrado">
                      <input
                        className={`${inputCls} num text-right ${invalido ? "!border-ouro bg-ouro/15" : ""}`}
                        inputMode="decimal"
                        placeholder="0,00"
                        aria-invalid={invalido || undefined}
                        value={valores[e.id] ?? ""}
                        onChange={(ev) => {
                          const v = ev.target.value;
                          setValores((x) => ({ ...x, [e.id]: v }));
                          acao.limparCampo(k);
                        }}
                      />
                    </Campo>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        <p className="mt-5 flex items-baseline justify-between border-t border-linha pt-3 text-[14px]">
          <span className="text-cinza">Sai da conta</span>
          <b className="num text-[16px]">{legivel ? formatarMoeda(total, "BRL") : "—"}</b>
        </p>
        <ErroAcao acao={acao} />
      </div>
    </Dialogo>
  );
}
