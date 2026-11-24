"use client";

import { useState } from "react";
import { Send } from "lucide-react";
import { Botao, Campo, Card, CardHeader, Select, inputCls } from "@/components/ui";
import { MSG_SEM_ITEM_COTADO, msgSemCotacao } from "@/domain/aprovacoes";
import { FORMAS_SIMULADOR, FORMA_REFERENCIA, INDICES_FORMAS_PROPOSTA, type FormaPagamento } from "@/domain/precificacao";
import { enviarParaAprovacao } from "@/server/actions/aprovacoes";
import type { FichaPrecificacao } from "@/server/queries/viagens";
import { reaisParaCampo } from "../formatos";
import { useAcao } from "./acao";
import { estrategicoOk } from "./vendas";

/** Painel de envio: forma de pagamento, preço sugerido (só para a camada estratégica) e o que mudou nesta versão. */
export function Envio({ ficha, onFechar }: { ficha: FichaPrecificacao; onFechar: () => void }) {
  const est = estrategicoOk(ficha);
  const a = useAcao();
  const [forma, setForma] = useState(String(FORMA_REFERENCIA));
  const [parcelas, setParcelas] = useState("4");
  const [preco, setPreco] = useState("");
  const [precoMexido, setPrecoMexido] = useState(false);
  const [alteracao, setAlteracao] = useState("");
  const [localErro, setLocalErro] = useState<string | null>(null);

  const cotados = ficha.itens.filter((i) => !i.automatico && i.cotacoes.length > 0).length;
  const bloqueio =
    cotados === 0 ? MSG_SEM_ITEM_COTADO : ficha.itensSemCotacao.length > 0 ? msgSemCotacao(ficha.itensSemCotacao[0].servico) : null;

  const boleto = forma === "boleto";
  const sugerido = est && !boleto ? reaisParaCampo(est.precificacao.porForma[Number(forma)].preco) : "";
  const campoPreco = precoMexido ? preco : sugerido;

  function montarForma(): FormaPagamento {
    if (boleto) return { tipo: "boleto", parcelas: Number(parcelas) };
    const f = FORMAS_SIMULADOR[Number(forma)].forma;
    return { ...f };
  }

  function enviar() {
    setLocalErro(null);
    if (alteracao.trim().length < 3) {
      setLocalErro("Conte o que mudou nesta versão (mínimo de 3 caracteres)");
      return;
    }
    if (boleto && !(Number.isInteger(Number(parcelas)) && Number(parcelas) >= 1)) {
      setLocalErro("Parcelas inválidas");
      return;
    }
    // Sem preço digitado, o servidor calcula pela fórmula na forma escolhida.
    const enviarPreco = est && precoMexido && preco.trim() ? preco : null;
    a.executar(() => enviarParaAprovacao(ficha.id, { forma: montarForma(), preco: enviarPreco, alteracao: alteracao.trim() }), onFechar);
  }

  const erroGeral = localErro ?? a.erro;
  return (
    <Card className="mb-5 pb-6">
      <CardHeader eyebrow="O Diretor recebe o pedido com o que foi precificado agora." title="Enviar para aprovação" />
      {bloqueio && <p role="status" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13.5px] text-texto">{bloqueio}</p>}
      <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-4">
        <Campo label="Forma de pagamento proposta" className="lg:col-span-2">
          <Select value={forma} onChange={(v) => { setForma(v); a.limparCampo("forma"); }} className="w-full">
            {INDICES_FORMAS_PROPOSTA.map((i) => <option key={FORMAS_SIMULADOR[i].rotulo} value={String(i)}>{FORMAS_SIMULADOR[i].rotulo}</option>)}
            <option value="boleto">Boleto</option>
          </Select>
          {a.campos.forma && <span className="mt-1 block text-[12px] text-texto">{a.campos.forma}</span>}
        </Campo>
        {boleto && (
          <Campo label="Parcelas do boleto">
            <input inputMode="numeric" className={inputCls} value={parcelas} onChange={(e) => setParcelas(e.target.value)} />
            {a.campos.parcelas && <span className="mt-1 block text-[12px] text-texto">{a.campos.parcelas}</span>}
          </Campo>
        )}
        {est && (
          <Campo label="Preço sugerido do pacote (R$)">
            <input
              inputMode="decimal"
              className={`${inputCls} ${a.campos.preco ? "!border-ouro bg-ouro/15" : ""}`}
              placeholder={boleto ? "Calculado pelo sistema" : undefined}
              value={campoPreco}
              onChange={(e) => { setPreco(e.target.value); setPrecoMexido(true); a.limparCampo("preco"); }}
            />
            {a.campos.preco && <span className="mt-1 block text-[12px] text-texto">{a.campos.preco}</span>}
          </Campo>
        )}
        <Campo label="O que mudou nesta versão" className="sm:col-span-2 lg:col-span-4">
          <textarea
            rows={3}
            className={`${inputCls} ${a.campos.alteracao || (localErro && alteracao.trim().length < 3) ? "!border-ouro bg-ouro/15" : ""}`}
            value={alteracao}
            onChange={(e) => { setAlteracao(e.target.value); a.limparCampo("alteracao"); }}
            placeholder="Ex.: troquei o hotel de Florença e incluí o passeio em Capri"
          />
          {a.campos.alteracao && <span className="mt-1 block text-[12px] text-texto">{a.campos.alteracao}</span>}
        </Campo>
      </div>
      {!est && <p className="mt-3 px-6 text-[13px] text-cinza">O preço é calculado pelo sistema com as regras vigentes e conferido pelo Diretor.</p>}
      {erroGeral && <p role="alert" className="mx-6 mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{erroGeral}</p>}
      <div className="mt-4 flex gap-2 px-6">
        <Botao onClick={enviar} disabled={a.pendente || bloqueio !== null}><Send size={15} /> Enviar para aprovação</Botao>
        <Botao variante="fantasma" onClick={onFechar} disabled={a.pendente}>Cancelar</Botao>
      </div>
    </Card>
  );
}
