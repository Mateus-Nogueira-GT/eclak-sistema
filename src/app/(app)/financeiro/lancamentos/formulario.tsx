"use client";

import { useState } from "react";
import { Botao, Campo, Tabs, inputCls } from "@/components/ui";
import { FORMAS_FINANCEIRO, FREQUENCIAS, ROTULO_FORMA_FINANCEIRO, competenciaDe, type Frequencia, type Lado } from "@/domain/financeiro";
import { cancelarLancamento, criarLancamento, editarLancamento } from "@/server/actions/financeiro";
import type { GrupoCategorias } from "@/server/queries/financeiro";
import { useAcao } from "../../viagens/[id]/acao";
import { reaisParaCampo } from "../../viagens/formatos";
import { CampoConta, Dialogo, ErroAcao, marca, type ContaOpcao } from "./baixa";

/** O lançamento manual em edição (do servidor). */
export type LancamentoForm = {
  id: string;
  lado: Lado;
  descricao: string;
  fornecedorId: string | null;
  clienteId: string | null;
  pessoaTexto: string | null;
  categoriaId: string;
  centro: "MT" | "RS";
  competencia: string;
  emissao: string;
  vencimento: string;
  valor: bigint;
  forma: keyof typeof ROTULO_FORMA_FINANCEIRO;
  contaBancariaId: string | null;
  observacao: string | null;
  parcelaNumero: number | null;
  parcelaTotal: number | null;
  status: "em_aberto" | "baixado" | "cancelado";
};

export type Opcao = { id: string; nome: string };

type TipoPessoa = "fornecedor" | "cliente" | "texto";
type Repeticao = "unica" | "parcelado" | "recorrente";
const ROTULO_FREQUENCIA: Record<Frequencia, string> = { semanal: "Toda semana", mensal: "Todo mês", anual: "Todo ano" };

/**
 * Novo lançamento ou edição de um manual: aba Dados (pessoa, categoria, valores, datas) e Detalhes (repetição,
 * conta bancária, observação). Na edição de uma série, "só esta" ou "esta e as próximas em aberto".
 */
export function FormularioLancamento({
  lancamento,
  ladoNovo,
  hoje,
  categorias,
  contas,
  fornecedores,
  clientes,
  onFechar,
}: {
  lancamento: LancamentoForm | null;
  ladoNovo: Lado;
  hoje: string;
  categorias: GrupoCategorias[];
  contas: ContaOpcao[];
  fornecedores: Opcao[];
  clientes: Opcao[];
  onFechar: () => void;
}) {
  const acao = useAcao();
  const l = lancamento;
  const [aba, setAba] = useState<"dados" | "detalhes">("dados");
  const [lado, setLado] = useState<Lado>(l?.lado ?? ladoNovo);
  const [tipoPessoa, setTipoPessoa] = useState<TipoPessoa>(l?.fornecedorId ? "fornecedor" : l?.clienteId ? "cliente" : "texto");
  const [fornecedorId, setFornecedorId] = useState(l?.fornecedorId ?? "");
  const [clienteId, setClienteId] = useState(l?.clienteId ?? "");
  const [pessoaTexto, setPessoaTexto] = useState(l?.pessoaTexto ?? "");
  const [categoriaId, setCategoriaId] = useState(l?.categoriaId ?? "");
  const [descricao, setDescricao] = useState(l?.descricao ?? "");
  const [forma, setForma] = useState<string>(l ? ROTULO_FORMA_FINANCEIRO[l.forma] : "");
  const [emissao, setEmissao] = useState(l?.emissao ?? hoje);
  const [competencia, setCompetencia] = useState(l?.competencia ?? competenciaDe(hoje));
  const [vencimento, setVencimento] = useState(l?.vencimento ?? "");
  const [valor, setValor] = useState(l ? reaisParaCampo(l.valor) : "");
  const [centro, setCentro] = useState<"MT" | "RS">(l?.centro ?? "MT");
  const [repeticao, setRepeticao] = useState<Repeticao>("unica");
  const [parcelas, setParcelas] = useState("2");
  const [frequencia, setFrequencia] = useState<Frequencia>("mensal");
  const [quantidade, setQuantidade] = useState("12");
  const [conta, setConta] = useState(l?.contaBancariaId ?? "");
  const [observacao, setObservacao] = useState(l?.observacao ?? "");
  const [alcance, setAlcance] = useState<"esta" | "proximas">("esta");
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const emSerie = l !== null && l.parcelaTotal !== null;
  const doLado = categorias.filter((g) => g.lado === lado);

  function dados() {
    const n = (t: string) => Number.parseInt(t, 10);
    return {
      lado,
      descricao,
      fornecedorId: tipoPessoa === "fornecedor" ? fornecedorId : "",
      clienteId: tipoPessoa === "cliente" ? clienteId : "",
      pessoaTexto: tipoPessoa === "texto" ? pessoaTexto : "",
      categoriaId,
      centro,
      competencia,
      emissao,
      vencimento,
      valor,
      forma,
      contaBancariaId: conta,
      observacao,
      repeticao:
        repeticao === "parcelado"
          ? { tipo: "parcelado", parcelas: n(parcelas) }
          : repeticao === "recorrente"
            ? { tipo: "recorrente", frequencia, quantidade: n(quantidade) }
            : { tipo: "unica" },
    };
  }

  function salvar() {
    acao.executar(() => (l ? editarLancamento(l.id, dados(), alcance) : criarLancamento(dados())), onFechar);
  }

  // Erro num campo: a aba do campo avisa "(corrigir)".
  const ABA_DETALHES = ["repeticao", "contaBancariaId", "observacao"];
  const naDetalhes = (k: string) => ABA_DETALHES.some((d) => k.startsWith(d));
  const erroEmDetalhes = Object.keys(acao.campos).some(naDetalhes);
  const erroEmDados = Object.keys(acao.campos).some((k) => !naDetalhes(k));

  const titulo = l ? l.descricao : lado === "pagar" ? "Nova conta a pagar" : "Nova conta a receber";
  const serie = emSerie ? ` · parcela ${l.parcelaNumero}/${l.parcelaTotal}` : "";
  return (
    <Dialogo
      eyebrow={`${lado === "pagar" ? "Conta a pagar" : "Conta a receber"} · ${l ? "Lançado à mão" : "Novo lançamento"}${serie}`}
      titulo={titulo}
      largura="max-w-[780px]"
      onFechar={onFechar}
      rodape={
        cancelando ? (
          <div className="flex w-full flex-wrap items-end gap-3">
            <Campo label="Motivo do cancelamento" className="min-w-[260px] flex-1">
              <input autoFocus className={`${inputCls} ${marca(acao, "motivo")}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: lançado em duplicidade" />
            </Campo>
            <Botao variante="secundario" onClick={() => setCancelando(false)}>Voltar</Botao>
            <Botao disabled={acao.pendente} onClick={() => l && acao.executar(() => cancelarLancamento(l.id, motivo, alcance), onFechar)}>
              Cancelar lançamento
            </Botao>
          </div>
        ) : (
          <>
            {l && l.status === "em_aberto" && (
              <Botao variante="fantasma" className="mr-auto" onClick={() => setCancelando(true)}>
                Cancelar lançamento
              </Botao>
            )}
            <Botao variante="secundario" onClick={onFechar}>Fechar</Botao>
            <Botao disabled={acao.pendente} onClick={salvar}>{l ? "Salvar alterações" : "Salvar"}</Botao>
          </>
        )
      }
    >
      <div className="px-6 pt-3">
        <Tabs
          value={aba}
          onChange={setAba}
          options={[
            { value: "dados", label: erroEmDados ? "Dados (corrigir)" : "Dados" },
            { value: "detalhes", label: erroEmDetalhes ? "Detalhes (corrigir)" : "Detalhes" },
          ]}
        />
      </div>
      <div className="px-6 py-5">
        {aba === "dados" ? (
          <div className="grid grid-cols-6 gap-4">
            {!l && (
              <Campo label="Lado" className="col-span-2">
                <select className={inputCls} value={lado} onChange={(e) => { setLado(e.target.value as Lado); setCategoriaId(""); }}>
                  <option value="pagar">A pagar</option>
                  <option value="receber">A receber</option>
                </select>
              </Campo>
            )}
            <Campo label="Pessoa" className="col-span-2">
              <select className={inputCls} value={tipoPessoa} onChange={(e) => setTipoPessoa(e.target.value as TipoPessoa)}>
                <option value="texto">Nome livre</option>
                <option value="fornecedor">Fornecedor</option>
                <option value="cliente">Cliente</option>
              </select>
            </Campo>
            <Campo label={tipoPessoa === "fornecedor" ? "Fornecedor" : tipoPessoa === "cliente" ? "Cliente" : "Nome"} className={l ? "col-span-4" : "col-span-2"}>
              {tipoPessoa === "texto" ? (
                <input className={`${inputCls} ${marca(acao, "pessoaTexto")}`} value={pessoaTexto} onChange={(e) => setPessoaTexto(e.target.value)} placeholder="Empresa ou pessoa (opcional)" />
              ) : (
                <select
                  className={`${inputCls} ${marca(acao, tipoPessoa === "fornecedor" ? "fornecedorId" : "clienteId")}`}
                  value={tipoPessoa === "fornecedor" ? fornecedorId : clienteId}
                  onChange={(e) => (tipoPessoa === "fornecedor" ? setFornecedorId(e.target.value) : setClienteId(e.target.value))}
                >
                  <option value="">Escolha</option>
                  {(tipoPessoa === "fornecedor" ? fornecedores : clientes).map((o) => (
                    <option key={o.id} value={o.id}>{o.nome}</option>
                  ))}
                </select>
              )}
            </Campo>
            <Campo label="Categoria financeira" className="col-span-3">
              <select className={`${inputCls} ${marca(acao, "categoriaId")}`} value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
                <option value="">Escolha a categoria</option>
                {doLado.map((g) => (
                  <optgroup key={g.grupo} label={g.grupo}>
                    {g.categorias
                      .filter((c) => (c.ativa && !c.sistema) || c.id === categoriaId)
                      .map((c) => (
                        <option key={c.id} value={c.id}>{c.nome}</option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </Campo>
            <Campo label="Forma de pagamento" className="col-span-3">
              <select className={`${inputCls} ${marca(acao, "forma")}`} value={forma} onChange={(e) => setForma(e.target.value)}>
                <option value="">Escolha</option>
                {FORMAS_FINANCEIRO.map((f) => (
                  <option key={f}>{f}</option>
                ))}
              </select>
            </Campo>
            <Campo label="Descrição" className="col-span-6">
              <input className={`${inputCls} ${marca(acao, "descricao")}`} value={descricao} onChange={(e) => setDescricao(e.target.value)} placeholder="Ex.: Aluguel do escritório" />
            </Campo>
            <Campo label={repeticao === "parcelado" ? "Valor total" : "Valor"} className="col-span-2">
              <input className={`${inputCls} num text-right ${marca(acao, "valor")}`} inputMode="decimal" placeholder="0,00" value={valor} onChange={(e) => setValor(e.target.value)} />
            </Campo>
            <Campo label={repeticao === "unica" ? "Vencimento" : "Primeiro vencimento"} className="col-span-2">
              <input type="date" className={`${inputCls} ${marca(acao, "vencimento")}`} value={vencimento} onChange={(e) => setVencimento(e.target.value)} />
            </Campo>
            <Campo label="Centro de custo" className="col-span-2">
              <select className={inputCls} value={centro} onChange={(e) => setCentro(e.target.value as "MT" | "RS")}>
                <option value="MT">MT (Rondonópolis)</option>
                <option value="RS">RS</option>
              </select>
            </Campo>
            <Campo label="Emissão" className="col-span-2">
              <input type="date" className={`${inputCls} ${marca(acao, "emissao")}`} value={emissao} onChange={(e) => setEmissao(e.target.value)} />
            </Campo>
            <Campo label="Competência" className="col-span-2">
              <input type="month" className={`${inputCls} ${marca(acao, "competencia")}`} value={competencia} onChange={(e) => setCompetencia(e.target.value)} />
            </Campo>
          </div>
        ) : (
          <div className="grid grid-cols-6 gap-4">
            {!l ? (
              <>
                <Campo label="Repetir" className="col-span-2">
                  <select className={`${inputCls} ${marca(acao, "repeticao")}`} value={repeticao} onChange={(e) => setRepeticao(e.target.value as Repeticao)}>
                    <option value="unica">Não repete</option>
                    <option value="parcelado">Em parcelas (divide o valor)</option>
                    <option value="recorrente">Recorrente (repete o valor)</option>
                  </select>
                </Campo>
                {repeticao === "parcelado" && (
                  <Campo label="Parcelas" className="col-span-2">
                    <input className={`${inputCls} num ${marca(acao, "repeticao.parcelas")}`} inputMode="numeric" value={parcelas} onChange={(e) => setParcelas(e.target.value)} />
                  </Campo>
                )}
                {repeticao === "recorrente" && (
                  <>
                    <Campo label="Frequência" className="col-span-2">
                      <select className={inputCls} value={frequencia} onChange={(e) => setFrequencia(e.target.value as Frequencia)}>
                        {FREQUENCIAS.map((f) => (
                          <option key={f} value={f}>{ROTULO_FREQUENCIA[f]}</option>
                        ))}
                      </select>
                    </Campo>
                    <Campo label="Quantidade" className="col-span-2">
                      <input className={`${inputCls} num ${marca(acao, "repeticao.quantidade")}`} inputMode="numeric" value={quantidade} onChange={(e) => setQuantidade(e.target.value)} />
                    </Campo>
                  </>
                )}
                {repeticao !== "unica" && (
                  <p className="col-span-6 text-[13px] text-cinza">
                    {repeticao === "parcelado"
                      ? "O valor total é dividido em parcelas mensais no mesmo dia; a última absorve os centavos."
                      : "Todas as repetições são lançadas de uma vez, com o mesmo valor."}
                  </p>
                )}
              </>
            ) : emSerie ? (
              <fieldset className="col-span-6">
                <legend className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Aplicar a alteração</legend>
                <div className="flex flex-wrap gap-5 text-[14px]">
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="radio" name="alcance" checked={alcance === "esta"} onChange={() => setAlcance("esta")} className="accent-verde" /> Só esta
                  </label>
                  <label className="flex cursor-pointer items-center gap-2">
                    <input type="radio" name="alcance" checked={alcance === "proximas"} onChange={() => setAlcance("proximas")} className="accent-verde" /> Esta e as próximas em aberto
                  </label>
                </div>
                <p className="mt-1 text-[12.5px] text-cinza">As datas mudam só nesta parcela; as baixadas nunca mudam.</p>
              </fieldset>
            ) : null}
            <div className="col-span-3">
              <CampoConta contas={contas} valor={conta} onChange={setConta} invalido={"contaBancariaId" in acao.campos} rotulo="Conta bancária prevista (opcional)" />
            </div>
            <Campo label="Observação" className="col-span-6">
              <textarea rows={3} className={`${inputCls} ${marca(acao, "observacao")}`} value={observacao} onChange={(e) => setObservacao(e.target.value)} placeholder="Fica registrada com o seu nome e a data" />
            </Campo>
          </div>
        )}
        <ErroAcao acao={acao} />
      </div>
    </Dialogo>
  );
}
