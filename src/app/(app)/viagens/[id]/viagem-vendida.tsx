"use client";

import { useState, type ReactNode } from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Bilhete } from "@/components/bilhete";
import { Grade, Semaforo, SoGestao } from "@/components/kit";
import { Badge, Botao, Campo, Card, CardHeader, Eyebrow, Select, Tabs, inputCls } from "@/components/ui";
import { formatarCambio } from "@/domain/cambio";
import { formatarReais, lerReais } from "@/domain/dinheiro";
import { desfazerDaParcela } from "@/domain/financeiro";
import { ROTULO_FORMA_FORNECEDOR, type ComissaoTipo, type FormaPagamentoFornecedorTipo, type LinhaPonte } from "@/domain/venda";
import {
  atualizarPrevisto,
  baixarPagamento,
  baixarParcela,
  cancelarParcela,
  comissaoNaoRecebida,
  conciliar,
  contestar,
  definirComissaoTipo,
  definirFormaFornecedor,
  desfazerBaixaPagamento,
  desfazerBaixaParcela,
  desfazerComissao,
  desfazerConciliacao,
  registrarComissao,
} from "@/server/actions/financeiro-viagem";
import { baixarRepasse, definirFornecedorCartao, desfazerRepasse } from "@/server/actions/financeiro";
import type { ComissaoVendida, ContaVendida, PagamentoVendido, ParcelaVendida, ViagemVendida } from "@/server/queries/vendas";
import type { FichaPrecificacao } from "@/server/queries/viagens";
import { dataBr, dataCurta, formatarMoeda, pct1, reaisParaCampo } from "../formatos";
import { useAcao } from "./acao";
import { Vendas } from "./vendas";

type Aba = "entradas" | "saidas" | "conciliacao" | "precificacao";

/** Conta bancária ativa para as baixas (do servidor, só para quem age). */
export type ContaBancariaOpcao = { id: string; nome: string };

type Painel =
  | { tipo: "baixaParcela"; parcela: ParcelaVendida }
  | { tipo: "cancelarParcela"; parcela: ParcelaVendida }
  | { tipo: "repasse"; parcela: ParcelaVendida }
  | { tipo: "baixaPagamento"; conta: ContaVendida; pag: PagamentoVendido }
  | { tipo: "forma"; conta: ContaVendida }
  | { tipo: "comissaoTipo"; conta: ContaVendida }
  | { tipo: "previsto"; conta: ContaVendida }
  | { tipo: "contestar"; conta: ContaVendida }
  | { tipo: "comissaoRecebida"; c: ComissaoVendida }
  | { tipo: "comissaoNao"; c: ComissaoVendida };

const ABA_DO_PAINEL: Record<Painel["tipo"], Aba> = {
  baixaParcela: "entradas",
  cancelarParcela: "entradas",
  repasse: "entradas",
  baixaPagamento: "saidas",
  forma: "saidas",
  comissaoTipo: "saidas",
  previsto: "saidas",
  contestar: "saidas",
  comissaoRecebida: "conciliacao",
  comissaoNao: "conciliacao",
};

const TOM_STATUS = { vendida: "agua", em_viagem: "agua", recebendo: "ouro", conciliada: "grafite", orcamento: "cinza" } as const;

/** "19.0" → milésimos de ponto percentual. */
function milesimos(p: string): bigint {
  const neg = p.trim().startsWith("-");
  const [i, d = ""] = p.trim().replace("-", "").split(".");
  const v = BigInt(i || "0") * 1000n + BigInt(d.padEnd(3, "0").slice(0, 3));
  return neg ? -v : v;
}

/** Diferença real − planejada em pontos percentuais, com sinal: "-1,8 p.p.". */
function diferencaPP(real: string, planejada: string): string {
  const d = milesimos(real) - milesimos(planejada);
  const abs = d < 0n ? -d : d;
  const decimos = (abs + 50n) / 100n;
  const txt = `${decimos / 10n},${decimos % 10n}`;
  return `${d < 0n ? "-" : d > 0n ? "+" : ""}${txt} p.p.`;
}

/** Valor de margem com sinal: "+ R$ 120,00", "- R$ 80,00". */
function comSinal(v: bigint): string {
  return v > 0n ? `+ ${formatarReais(v)}` : v < 0n ? `- ${formatarReais(-v)}` : formatarReais(0n);
}

const msgErroCalculo = "Não foi possível calcular com os Parâmetros vigentes. Fale com o Diretor.";

function BotaoMini({ children, onClick, variante = "secundario" }: { children: ReactNode; onClick: () => void; variante?: "secundario" | "fantasma" }) {
  return (
    <Botao variante={variante} className="!px-2.5 !py-1 !text-[12.5px]" onClick={onClick}>
      {children}
    </Botao>
  );
}

function Erro({ acao }: { acao: ReturnType<typeof useAcao> }) {
  if (!acao.erro) return null;
  const extras = [...new Set(Object.values(acao.campos))].filter((m) => m !== acao.erro);
  return (
    <p role="alert" className="mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
      {acao.erro}
      {extras.length > 0 && `: ${extras.join("; ")}`}
    </p>
  );
}

function Formulario({
  titulo,
  acao,
  rotuloEnviar,
  onEnviar,
  onFechar,
  children,
}: {
  titulo: string;
  acao: ReturnType<typeof useAcao>;
  rotuloEnviar: string;
  onEnviar: () => void;
  onFechar: () => void;
  children: ReactNode;
}) {
  return (
    <Card className="mb-5">
      <CardHeader title={titulo} />
      <form
        className="px-6 pb-6 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          onEnviar();
        }}
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">{children}</div>
        <Erro acao={acao} />
        <div className="mt-4 flex flex-wrap gap-2">
          <Botao type="submit" disabled={acao.pendente}>{rotuloEnviar}</Botao>
          <Botao type="button" variante="fantasma" onClick={onFechar}>Cancelar</Botao>
        </div>
      </form>
    </Card>
  );
}

const marca = (acao: ReturnType<typeof useAcao>, k: string) => (acao.campos[k] ? "!border-ouro bg-ouro/15" : "");

// ---------------------------------------------------------------------------
// Formulários (painéis em linha)
// ---------------------------------------------------------------------------

/** Conta bancária escolhida por padrão: a única ativa, se só houver uma; senão nenhuma (escolha obrigatória). */
const contaPadrao = (contas: ContaBancariaOpcao[]) => (contas.length === 1 ? contas[0].id : "");

function CampoContaBancaria({ contas, valor, onChange, acao }: { contas: ContaBancariaOpcao[]; valor: string; onChange: (v: string) => void; acao: ReturnType<typeof useAcao> }) {
  return (
    <Campo label="Conta bancária">
      <Select value={valor} onChange={onChange} className={`w-full ${marca(acao, "contaBancariaId")}`}>
        <option value="">{contas.length === 0 ? "Nenhuma conta ativa" : "Escolha a conta"}</option>
        {contas.map((c) => (
          <option key={c.id} value={c.id}>{c.nome}</option>
        ))}
      </Select>
      {contas.length === 0 && <span className="mt-1 block text-[12px] text-cinza">Cadastre em Financeiro › Contas bancárias.</span>}
    </Campo>
  );
}

function FormBaixaParcela({ parcela, hoje, contas, onFechar }: { parcela: ParcelaVendida; hoje: string; contas: ContaBancariaOpcao[]; onFechar: () => void }) {
  const acao = useAcao();
  const [data, setData] = useState(hoje);
  const [conta, setConta] = useState(contaPadrao(contas));
  const [valor, setValor] = useState(reaisParaCampo(parcela.valor));
  const [taxa, setTaxa] = useState("");
  const [observacao, setObservacao] = useState("");
  let diferente = false;
  try {
    diferente = lerReais(valor) !== parcela.valor;
  } catch {
    // valor ilegível: o servidor responde com o erro do campo
  }
  return (
    <Formulario
      titulo={`Dar baixa na parcela ${parcela.numero}/${parcela.totalParcelas}`}
      acao={acao}
      rotuloEnviar="Confirmar baixa"
      onFechar={onFechar}
      onEnviar={() =>
        acao.executar(
          () => baixarParcela(parcela.id, { recebidaEm: data, valorRecebido: valor, taxaEfetiva: taxa || null, observacao: observacao || null, contaBancariaId: conta }),
          onFechar,
        )
      }
    >
      <Campo label="Data do recebimento">
        <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "recebidaEm")}`} value={data} onChange={(e) => setData(e.target.value)} />
      </Campo>
      <Campo label="Valor recebido">
        <input className={`${inputCls} num ${marca(acao, "valorRecebido")}`} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
      </Campo>
      <Campo label="Taxa efetiva (opcional)">
        <input className={`${inputCls} num ${marca(acao, "taxaEfetiva")}`} inputMode="decimal" placeholder="Deixe vazio para usar a prevista" value={taxa} onChange={(e) => setTaxa(e.target.value)} />
      </Campo>
      <CampoContaBancaria contas={contas} valor={conta} onChange={setConta} acao={acao} />
      <Campo label={diferente ? "Observação (obrigatória: valor diferente da parcela)" : "Observação (opcional)"} className="sm:col-span-2 lg:col-span-4">
        <input
          className={`${inputCls} ${marca(acao, "observacao")}`}
          placeholder={diferente ? "Explique a diferença do valor recebido" : ""}
          value={observacao}
          onChange={(e) => setObservacao(e.target.value)}
        />
      </Campo>
    </Formulario>
  );
}

type CartaoFornecedor = NonNullable<ViagemVendida["cartaoFornecedor"]>;

/**
 * Repasse do fornecedor que recebeu no cartão: data, valor repassado (o esperado, da lista do financeiro, vem
 * preenchido) e conta bancária onde entrou. O que o fornecedor reteve a mais vira taxa da forma.
 */
function FormRepasse({ parcela, cartao, hoje, contas, onFechar }: { parcela: ParcelaVendida; cartao: CartaoFornecedor; hoje: string; contas: ContaBancariaOpcao[]; onFechar: () => void }) {
  const acao = useAcao();
  const [data, setData] = useState(hoje);
  const [conta, setConta] = useState(contaPadrao(contas));
  const esperado = cartao.repasseEsperado ?? 0n;
  const [valor, setValor] = useState(reaisParaCampo(esperado < 0n ? 0n : esperado));
  let retido: bigint | null = null;
  try {
    retido = esperado - lerReais(valor);
  } catch {
    // valor ilegível: o servidor responde com o erro do campo
  }
  return (
    <Formulario
      titulo={`Registrar repasse de ${cartao.fornecedor ?? "fornecedor"}`}
      acao={acao}
      rotuloEnviar="Confirmar repasse"
      onFechar={onFechar}
      onEnviar={() => acao.executar(() => baixarRepasse(parcela.id, { data, valorRepassado: valor, contaBancariaId: conta }), onFechar)}
    >
      <Campo label="Data do repasse">
        <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "data")}`} value={data} onChange={(e) => setData(e.target.value)} />
      </Campo>
      <Campo label="Valor repassado">
        <input className={`${inputCls} num ${marca(acao, "valorRepassado")}`} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
      </Campo>
      <CampoContaBancaria contas={contas} valor={conta} onChange={setConta} acao={acao} />
      <p className="text-[13px] text-cinza sm:col-span-2 lg:col-span-4">
        O cliente pagou {formatarReais(parcela.valor)} no cartão de {cartao.fornecedor}. Repasse esperado:{" "}
        <span className="num font-semibold text-texto">{formatarReais(esperado)}</span> (a parcela menos as contas do fornecedor na viagem, que ficam
        quitadas pelo previsto).
        {retido !== null && retido > 0n && <> O fornecedor reteve <span className="num font-semibold text-texto">{formatarReais(retido)}</span> a mais: entra como taxa da forma.</>}
      </p>
    </Formulario>
  );
}

/** Venda em cartão direto sem o fornecedor que recebeu (vendas antigas): aviso e escolha. */
function EscolhaFornecedorCartao({ viagemId, cartao, agir }: { viagemId: string; cartao: CartaoFornecedor; agir: boolean }) {
  const acao = useAcao();
  const [fornecedor, setFornecedor] = useState("");
  return (
    <div role="status" className="mb-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
      <p className="font-semibold">Escolha o fornecedor que recebeu no cartão</p>
      <p className="mt-0.5 text-[13px]">Sem ele, o repasse não pode ser registrado.</p>
      {agir && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            acao.executar(() => definirFornecedorCartao(viagemId, fornecedor));
          }}
        >
          <Campo label="Fornecedor do cartão">
            <Select value={fornecedor} onChange={setFornecedor} className={`min-w-[240px] ${marca(acao, "fornecedorCartaoId")}`}>
              <option value="">Escolha o fornecedor</option>
              {cartao.opcoes.map((f) => (
                <option key={f.id} value={f.id}>{f.nome}</option>
              ))}
            </Select>
          </Campo>
          <Botao type="submit" disabled={acao.pendente}>Salvar fornecedor</Botao>
        </form>
      )}
      <Erro acao={acao} />
    </div>
  );
}

function FormCancelarParcela({ parcela, onFechar }: { parcela: ParcelaVendida; onFechar: () => void }) {
  const acao = useAcao();
  const [motivo, setMotivo] = useState("");
  return (
    <Formulario
      titulo={`Cancelar a parcela ${parcela.numero}/${parcela.totalParcelas}`}
      acao={acao}
      rotuloEnviar="Cancelar parcela"
      onFechar={onFechar}
      onEnviar={() => acao.executar(() => cancelarParcela(parcela.id, motivo), onFechar)}
    >
      <Campo label="Motivo" className="sm:col-span-2 lg:col-span-4">
        <input className={`${inputCls} ${marca(acao, "motivo")}`} placeholder="Ex.: cliente pagou à parte" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </Campo>
    </Formulario>
  );
}

function FormBaixaPagamento({ conta, pag, hoje, contas, onFechar }: { conta: ContaVendida; pag: PagamentoVendido; hoje: string; contas: ContaBancariaOpcao[]; onFechar: () => void }) {
  const acao = useAcao();
  const [data, setData] = useState(hoje);
  const [contaBancaria, setContaBancaria] = useState(contaPadrao(contas));
  const [valor, setValor] = useState(reaisParaCampo(pag.valorOriginal));
  const [cambio, setCambio] = useState("");
  const estrangeira = conta.moeda !== "BRL";
  return (
    <Formulario
      titulo={`Dar baixa: ${conta.fornecedor ?? conta.descricao}, pagamento ${pag.numero}`}
      acao={acao}
      rotuloEnviar="Confirmar baixa"
      onFechar={onFechar}
      onEnviar={() =>
        acao.executar(
          () => baixarPagamento(pag.id, { pagoEm: data, valorOriginalPago: valor, cambioEfetivo: estrangeira ? cambio || null : null, contaBancariaId: contaBancaria }),
          onFechar,
        )
      }
    >
      <Campo label="Data do pagamento">
        <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "pagoEm")}`} value={data} onChange={(e) => setData(e.target.value)} />
      </Campo>
      <Campo label={`Valor pago (${conta.moeda})`}>
        <input className={`${inputCls} num ${marca(acao, "valorOriginalPago")}`} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
      </Campo>
      {estrangeira && (
        <Campo label="Câmbio efetivo">
          <input
            className={`${inputCls} num ${marca(acao, "cambioEfetivo")}`}
            inputMode="decimal"
            placeholder={conta.cambioAplicado ? `Venda: ${formatarCambio(conta.cambioAplicado)}` : "Ex.: 6,2000"}
            value={cambio}
            onChange={(e) => setCambio(e.target.value)}
          />
        </Campo>
      )}
      <CampoContaBancaria contas={contas} valor={contaBancaria} onChange={setContaBancaria} acao={acao} />
    </Formulario>
  );
}

function somaCampos(valores: string[]): bigint | null {
  try {
    return valores.reduce((t, v) => t + lerReais(v), 0n);
  } catch {
    return null;
  }
}

function FormForma({ conta, onFechar }: { conta: ContaVendida; onFechar: () => void }) {
  const acao = useAcao();
  const primeira = conta.pagamentos[0]?.vencimento ?? "";
  const alvo = conta.pagamentos.reduce((t, p) => t + p.valorOriginal, 0n);
  // Com desconto à vista aplicado a soma das linhas atuais não é o previsto cheio: aí o servidor confere.
  const alvoConhecido = !(conta.forma === "a_vista" && conta.descontoAVistaPct && Number(conta.descontoAVistaPct) > 0);
  const [tipo, setTipo] = useState<FormaPagamentoFornecedorTipo>(conta.forma ?? "a_vista");
  const [vencimento, setVencimento] = useState(primeira);
  const metade = alvoConhecido ? alvo / 2n : 0n;
  const [linhas, setLinhas] = useState<{ vencimento: string; valor: string }[]>([
    { vencimento: primeira, valor: alvoConhecido ? reaisParaCampo(metade) : "" },
    { vencimento: "", valor: alvoConhecido ? reaisParaCampo(alvo - metade) : "" },
  ]);
  const soma = somaCampos(linhas.map((l) => l.valor));
  const mexer = (i: number, k: "vencimento" | "valor", v: string) => setLinhas((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));

  function enviar() {
    acao.executar(
      () =>
        definirFormaFornecedor(
          conta.id,
          tipo === "a_vista"
            ? { tipo, ...(vencimento ? { vencimento } : {}) }
            : tipo === "cartao_corporativo"
              ? { tipo, vencimento }
              : { tipo, parcelas: linhas },
        ),
      onFechar,
    );
  }

  return (
    <Formulario titulo={`Forma de pagamento: ${conta.fornecedor ?? conta.descricao}`} acao={acao} rotuloEnviar="Salvar forma" onFechar={onFechar} onEnviar={enviar}>
      <Campo label="Forma">
        <Select value={tipo} onChange={(v) => setTipo(v as FormaPagamentoFornecedorTipo)} className="w-full">
          {(Object.keys(ROTULO_FORMA_FORNECEDOR) as FormaPagamentoFornecedorTipo[]).map((t) => (
            <option key={t} value={t}>{ROTULO_FORMA_FORNECEDOR[t]}</option>
          ))}
        </Select>
      </Campo>
      {tipo !== "parcelado" && (
        <Campo label={tipo === "cartao_corporativo" ? "Vencimento da fatura do cartão" : "Vencimento"}>
          <input type="date" className={`${inputCls} ${marca(acao, "vencimento")}`} value={vencimento} onChange={(e) => setVencimento(e.target.value)} />
        </Campo>
      )}
      {tipo === "parcelado" && (
        <div className="sm:col-span-2 lg:col-span-4">
          <Eyebrow className="mb-2">Parcelas ({conta.moeda})</Eyebrow>
          <div className="space-y-2">
            {linhas.map((l, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="num w-6 text-[13px] text-cinza">{i + 1}</span>
                <input type="date" aria-label={`Vencimento da parcela ${i + 1}`} className={`${inputCls} !w-[170px]`} value={l.vencimento} onChange={(e) => mexer(i, "vencimento", e.target.value)} />
                <input aria-label={`Valor da parcela ${i + 1}`} className={`${inputCls} num !w-[150px]`} inputMode="decimal" placeholder="0,00" value={l.valor} onChange={(e) => mexer(i, "valor", e.target.value)} />
                {linhas.length > 1 && (
                  <button type="button" aria-label={`Remover parcela ${i + 1}`} className="cursor-pointer rounded-[5px] p-1.5 text-cinza hover:bg-fundo hover:text-texto" onClick={() => setLinhas((ls) => ls.filter((_, j) => j !== i))}>
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <BotaoMini onClick={() => setLinhas((ls) => [...ls, { vencimento: "", valor: "" }])}><Plus size={13} /> Adicionar parcela</BotaoMini>
            <span className="num text-[13px] text-cinza">
              Soma: {soma === null ? "-" : formatarMoeda(soma, conta.moeda)}
              {alvoConhecido && ` de ${formatarMoeda(alvo, conta.moeda)}`}
            </span>
          </div>
        </div>
      )}
    </Formulario>
  );
}

function FormComissaoTipo({ conta, onFechar }: { conta: ContaVendida; onFechar: () => void }) {
  const acao = useAcao();
  const [tipo, setTipo] = useState<ComissaoTipo>(conta.comissaoTipo);
  const [para, setPara] = useState(conta.comissao?.previstaPara ?? "");
  return (
    <Formulario
      titulo={`Tipo de comissão: ${conta.fornecedor ?? conta.descricao}`}
      acao={acao}
      rotuloEnviar="Salvar tipo"
      onFechar={onFechar}
      onEnviar={() => acao.executar(() => definirComissaoTipo(conta.id, { tipo, previstaPara: tipo === "a_receber" && para ? para : null }), onFechar)}
    >
      <Campo label="Tipo">
        <Select value={tipo} onChange={(v) => setTipo(v as ComissaoTipo)} className="w-full">
          <option value="descontada">Descontada (paga o líquido)</option>
          <option value="a_receber">A receber (paga o cheio)</option>
        </Select>
      </Campo>
      {tipo === "a_receber" && (
        <Campo label="Comissão prevista para">
          <input type="date" className={`${inputCls} ${marca(acao, "previstaPara")}`} value={para} onChange={(e) => setPara(e.target.value)} />
        </Campo>
      )}
    </Formulario>
  );
}

function FormPrevisto({ conta, onFechar }: { conta: ContaVendida; onFechar: () => void }) {
  const acao = useAcao();
  const [valor, setValor] = useState(reaisParaCampo(conta.previstoBrl));
  const [motivo, setMotivo] = useState("");
  return (
    <Formulario
      titulo={`Atualizar valor previsto: ${conta.fornecedor ?? conta.descricao}`}
      acao={acao}
      rotuloEnviar="Atualizar"
      onFechar={onFechar}
      onEnviar={() => acao.executar(() => atualizarPrevisto(conta.id, valor, motivo), onFechar)}
    >
      <Campo label="Novo valor previsto (R$)">
        <input className={`${inputCls} num ${marca(acao, "valorBrl")}`} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
      </Campo>
      <Campo label="Motivo" className="sm:col-span-2">
        <input className={`${inputCls} ${marca(acao, "motivo")}`} placeholder="Ex.: hotel cobrou diária extra" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </Campo>
    </Formulario>
  );
}

function FormContestar({ conta, onFechar }: { conta: ContaVendida; onFechar: () => void }) {
  const acao = useAcao();
  const [texto, setTexto] = useState(conta.contestacao ?? "");
  return (
    <Formulario
      titulo={`Contestar com o fornecedor: ${conta.fornecedor ?? conta.descricao}`}
      acao={acao}
      rotuloEnviar="Registrar contestação"
      onFechar={onFechar}
      onEnviar={() => acao.executar(() => contestar(conta.id, texto), onFechar)}
    >
      <Campo label="O que foi contestado" className="sm:col-span-2 lg:col-span-4">
        <textarea rows={3} className={`${inputCls} ${marca(acao, "texto")}`} value={texto} onChange={(e) => setTexto(e.target.value)} />
      </Campo>
    </Formulario>
  );
}

function FormComissaoRecebida({ c, hoje, contas, onFechar }: { c: ComissaoVendida; hoje: string; contas: ContaBancariaOpcao[]; onFechar: () => void }) {
  const acao = useAcao();
  const [data, setData] = useState(hoje);
  const [conta, setConta] = useState(contaPadrao(contas));
  const [valor, setValor] = useState(reaisParaCampo(c.valorPrevisto));
  return (
    <Formulario
      titulo={`Comissão recebida: ${c.fornecedor}`}
      acao={acao}
      rotuloEnviar="Marcar recebida"
      onFechar={onFechar}
      onEnviar={() => acao.executar(() => registrarComissao(c.id, { recebidaEm: data, valorRecebido: valor, contaBancariaId: conta }), onFechar)}
    >
      <Campo label="Data do recebimento">
        <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "recebidaEm")}`} value={data} onChange={(e) => setData(e.target.value)} />
      </Campo>
      <Campo label="Valor recebido">
        <input className={`${inputCls} num ${marca(acao, "valorRecebido")}`} inputMode="decimal" value={valor} onChange={(e) => setValor(e.target.value)} />
      </Campo>
      <CampoContaBancaria contas={contas} valor={conta} onChange={setConta} acao={acao} />
    </Formulario>
  );
}

function FormComissaoNao({ c, onFechar }: { c: ComissaoVendida; onFechar: () => void }) {
  const acao = useAcao();
  const [motivo, setMotivo] = useState("");
  return (
    <Formulario
      titulo={`Comissão não será recebida: ${c.fornecedor}`}
      acao={acao}
      rotuloEnviar="Confirmar"
      onFechar={onFechar}
      onEnviar={() => acao.executar(() => comissaoNaoRecebida(c.id, motivo), onFechar)}
    >
      <Campo label="Motivo" className="sm:col-span-2">
        <input className={inputCls} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
      </Campo>
    </Formulario>
  );
}

/** Botão de ação direta (desfazer, conciliar): erro aparece ao lado. */
function AcaoDireta({ rotulo, executar, variante = "secundario", mini }: { rotulo: string; executar: () => Promise<{ ok: true } | { ok: false; erro: string; campos?: Record<string, string> }>; variante?: "primario" | "secundario" | "fantasma"; mini?: boolean }) {
  const acao = useAcao();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Botao variante={variante} className={mini ? "!px-2.5 !py-1 !text-[12.5px]" : undefined} disabled={acao.pendente} onClick={() => acao.executar(executar)}>
        {rotulo}
      </Botao>
      {acao.erro && <span role="alert" className="max-w-[320px] whitespace-normal rounded-[5px] border border-ouro bg-ouro/15 px-2 py-1 text-[12px] text-texto">{acao.erro}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tela
// ---------------------------------------------------------------------------

export function ViagemVendidaView({
  v,
  ficha,
  podeAgir,
  ehDiretor,
  margem,
  hoje,
  contasBancarias,
}: {
  v: ViagemVendida;
  ficha: FichaPrecificacao | null;
  /** Diretor, financeiro operacional e estratégico; o servidor confere de novo em toda action. */
  podeAgir: boolean;
  ehDiretor: boolean;
  /** Parâmetros do semáforo; só com a camada estratégica. */
  margem: { alvoPct: string; referenciaPct: string } | null;
  /** Hoje em Cuiabá, do servidor (limite das datas de baixa; a renderização do cliente não recalcula). */
  hoje: string;
  /** Contas bancárias ativas para as baixas (vazio para quem não age). */
  contasBancarias: ContaBancariaOpcao[];
}) {
  const [aba, setAba] = useState<Aba>("entradas");
  const [painel, setPainel] = useState<Painel | null>(null);
  const conciliada = v.conciliadaEm !== null;
  const agir = podeAgir && !conciliada;
  const fechar = () => setPainel(null);
  const abrir = (p: Painel) => setPainel(p);
  const est = v.estrategico;

  const abas: { value: Aba; label: ReactNode }[] = [
    { value: "entradas", label: "Entradas" },
    { value: "saidas", label: "Saídas" },
    {
      value: "conciliacao",
      label: (
        <span className="inline-flex items-center gap-2">
          Conciliação
          {v.divergencias > 0 && (
            <span className="num rounded-[3px] bg-ouro/30 px-1.5 py-0.5 text-[11.5px] font-bold text-texto" aria-label={`${v.divergencias} divergências`}>{v.divergencias}</span>
          )}
        </span>
      ),
    },
    { value: "precificacao", label: "Precificação" },
  ];

  const painelDaAba = painel && ABA_DO_PAINEL[painel.tipo] === aba ? painel : null;
  const chave = painelDaAba ? JSON.stringify([painelDaAba.tipo, "parcela" in painelDaAba ? painelDaAba.parcela.id : "pag" in painelDaAba ? painelDaAba.pag.id : "conta" in painelDaAba ? painelDaAba.conta.id : painelDaAba.c.id]) : "";

  return (
    <div>
      <Bilhete
        codigo={v.codigo}
        cliente={v.cliente}
        destino={v.destino}
        periodo={`${dataBr(v.inicio)} a ${dataBr(v.fim)}`}
        noites={Math.max(0, Math.round((Date.parse(v.fim) - Date.parse(v.inicio)) / 86_400_000))}
        passageiros={v.passageiros.map((nome) => ({ nome }))}
        consultor={v.consultor}
        etapa="aprovacao"
        href={`/viagens/${v.id}`}
        right={<Badge tom={TOM_STATUS[v.status]}>{v.rotuloStatus}</Badge>}
      />

      <div className={`mb-6 grid grid-cols-2 gap-5 ${est ? "lg:grid-cols-6" : "lg:grid-cols-5"}`}>
        {(
          [
            ["Valor vendido", v.resumo.valorVendido],
            ["Recebido", v.resumo.recebido],
            ["A receber", v.resumo.aReceber],
            ["Pago a fornecedores", v.resumo.pagoFornecedores],
            ["A pagar", v.resumo.aPagar],
          ] as const
        ).map(([rotulo, valor]) => (
          <Card key={rotulo} className="p-5">
            <Eyebrow>{rotulo}</Eyebrow>
            <p className="num mt-1.5 text-[20px] font-bold tracking-tight text-verde">{formatarReais(valor)}</p>
            {rotulo === "A receber" && v.resumo.diferencaRecebimento !== 0n && (
              <p className="num mt-1 text-[12.5px] text-texto">Diferença no recebimento: {comSinal(v.resumo.diferencaRecebimento)}</p>
            )}
          </Card>
        ))}
        {est && (
          <Card className="col-span-2 p-5 lg:col-span-1">
            <div className="flex items-center justify-between gap-2"><Eyebrow>Margem planejada × real</Eyebrow><SoGestao>Gestão</SoGestao></div>
            {"erro" in est.real ? (
              <p className="mt-1.5 text-[13.5px] text-texto">{msgErroCalculo}</p>
            ) : (
              <>
                <p className="num mt-1.5 flex flex-wrap items-center gap-1.5 text-[20px] font-bold text-verde">
                  {pct1(est.planejada.finalPct)} <ArrowRight size={16} aria-label="para" /> {pct1(est.real.finalPct)}
                </p>
                <p className="num text-[13px] text-cinza">{diferencaPP(est.real.finalPct, est.planejada.finalPct)}</p>
                {margem && <div className="mt-1.5"><Semaforo margemPct={est.real.finalPct} alvoPct={margem.alvoPct} referenciaPct={margem.referenciaPct} /></div>}
              </>
            )}
          </Card>
        )}
      </div>

      <p className="mb-4 text-[13.5px] text-cinza">
        Aceite em {dataBr(v.venda.aceiteEm)} · {v.venda.forma} · primeiro vencimento em {dataBr(v.venda.primeiroVencimento)} · fatura em nome de {v.venda.faturaNome} ({v.venda.faturaDocumento})
        {v.venda.observacao ? ` · ${v.venda.observacao}` : ""}
      </p>
      {conciliada && v.conciliadaEm && (
        <p role="status" className="mb-4 rounded-[5px] border border-linha bg-fundo px-4 py-3 text-[14px] text-texto">
          Viagem conciliada em {dataCurta(v.conciliadaEm)}. As baixas e os ajustes ficam bloqueados.
          {ehDiretor && <span className="ml-3 inline-block align-middle"><AcaoDireta rotulo="Desfazer conciliação" mini executar={() => desfazerConciliacao(v.id)} /></span>}
        </p>
      )}

      <div className="mb-4">
        <Tabs value={aba} onChange={(a) => { setAba(a); setPainel(null); }} options={abas} />
      </div>

      {painelDaAba && (
        <div key={chave}>
          {painelDaAba.tipo === "baixaParcela" && <FormBaixaParcela parcela={painelDaAba.parcela} hoje={hoje} contas={contasBancarias} onFechar={fechar} />}
          {painelDaAba.tipo === "cancelarParcela" && <FormCancelarParcela parcela={painelDaAba.parcela} onFechar={fechar} />}
          {painelDaAba.tipo === "repasse" && v.cartaoFornecedor && (
            <FormRepasse parcela={painelDaAba.parcela} cartao={v.cartaoFornecedor} hoje={hoje} contas={contasBancarias} onFechar={fechar} />
          )}
          {painelDaAba.tipo === "baixaPagamento" && <FormBaixaPagamento conta={painelDaAba.conta} pag={painelDaAba.pag} hoje={hoje} contas={contasBancarias} onFechar={fechar} />}
          {painelDaAba.tipo === "forma" && <FormForma conta={painelDaAba.conta} onFechar={fechar} />}
          {painelDaAba.tipo === "comissaoTipo" && <FormComissaoTipo conta={painelDaAba.conta} onFechar={fechar} />}
          {painelDaAba.tipo === "previsto" && <FormPrevisto conta={painelDaAba.conta} onFechar={fechar} />}
          {painelDaAba.tipo === "contestar" && <FormContestar conta={painelDaAba.conta} onFechar={fechar} />}
          {painelDaAba.tipo === "comissaoRecebida" && <FormComissaoRecebida c={painelDaAba.c} hoje={hoje} contas={contasBancarias} onFechar={fechar} />}
          {painelDaAba.tipo === "comissaoNao" && <FormComissaoNao c={painelDaAba.c} onFechar={fechar} />}
        </div>
      )}

      {aba === "entradas" && <Entradas v={v} agir={agir} abrir={abrir} />}
      {aba === "saidas" && <Saidas v={v} agir={agir} abrir={abrir} />}
      {aba === "conciliacao" && <Conciliacao v={v} agir={agir} abrir={abrir} />}
      {aba === "precificacao" && (
        <div>
          <p className="mb-4 text-[13.5px] text-cinza">Somente leitura: viagem vendida não aceita mudança de itens ou cotações. Ajustes de valor vão em Saídas, na conta do fornecedor.</p>
          {ficha ? <Vendas ficha={ficha} fornecedores={[]} limiteDiaria={null} editavel={false} /> : <Card className="p-6 text-[14px] text-cinza">Precificação indisponível.</Card>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entradas
// ---------------------------------------------------------------------------

function Entradas({ v, agir, abrir }: { v: ViagemVendida; agir: boolean; abrir: (p: Painel) => void }) {
  const cartao = v.cartaoFornecedor;
  const doCartao = (p: ParcelaVendida) => cartao !== null && p.id === cartao.parcelaId;
  const rows = v.parcelas.map((p) => [
    <span key="n" className="font-semibold">{p.numero}/{p.totalParcelas}</span>,
    doCartao(p) && cartao?.fornecedor ? (
      <span key="f" className="flex flex-col">
        {p.rotuloMeio}
        <span className="text-[12px] text-cinza">Repasse de {cartao.fornecedor}{p.status !== "cancelada" && cartao.repasseEsperado !== null ? `: esperado ${formatarReais(cartao.repasseEsperado)}` : ""}</span>
      </span>
    ) : (
      p.rotuloMeio
    ),
    dataBr(p.vencimento),
    formatarReais(p.valor),
    p.status === "recebida" ? (
      <span key="s" className="flex flex-col items-start gap-1">
        <Badge tom="agua">Recebida em {dataBr(p.recebidaEm)}{p.valorRecebido !== null && p.valorRecebido !== p.valor ? ` (${formatarReais(p.valorRecebido)})` : ""}</Badge>
        {p.observacao && <span className="whitespace-pre-line text-[12px] text-cinza">{p.observacao}</span>}
      </span>
    ) : p.status === "cancelada" ? (
      <span key="s" className="flex flex-col items-start gap-1">
        <Badge tom="cinza">Cancelada</Badge>
        {p.observacao && <span className="whitespace-pre-line text-[12px] text-cinza">{p.observacao}</span>}
      </span>
    ) : (
      <Badge key="s" tom="cinza">A receber</Badge>
    ),
    agir && doCartao(p) && p.status === "a_receber" ? (
      <span key="a" className="inline-flex gap-1.5">
        {cartao?.fornecedorId && <BotaoMini onClick={() => abrir({ tipo: "repasse", parcela: p })}>Registrar repasse</BotaoMini>}
        <BotaoMini variante="fantasma" onClick={() => abrir({ tipo: "cancelarParcela", parcela: p })}>Cancelar parcela</BotaoMini>
      </span>
    ) : agir && doCartao(p) && p.status === "recebida" ? (
      <AcaoDireta key="a" rotulo="Desfazer repasse" mini variante="fantasma" executar={() => desfazerRepasse(p.id)} />
    ) : agir && p.status === "a_receber" ? (
      <span key="a" className="inline-flex gap-1.5">
        <BotaoMini onClick={() => abrir({ tipo: "baixaParcela", parcela: p })}>Dar baixa</BotaoMini>
        <BotaoMini variante="fantasma" onClick={() => abrir({ tipo: "cancelarParcela", parcela: p })}>Cancelar parcela</BotaoMini>
      </span>
    ) : agir && p.status === "recebida" ? (
      <AcaoDireta key="a" rotulo="Desfazer baixa" mini variante="fantasma" executar={() => desfazerBaixaParcela(p.id)} />
    ) : agir && p.status === "cancelada" ? (
      <AcaoDireta
        key="a"
        rotulo="Desfazer cancelamento"
        mini
        variante="fantasma"
        executar={() => (desfazerDaParcela(p.meio) === "repasse" ? desfazerRepasse(p.id) : desfazerBaixaParcela(p.id))}
      />
    ) : null,
  ]);
  return (
    <>
      {cartao && !cartao.fornecedorId && <EscolhaFornecedorCartao viagemId={v.id} cartao={cartao} agir={agir} />}
      <Card>
        <Grade
          head={["Parcela", "Forma", "Vencimento", "Valor", "Status", ""]}
          rows={rows}
          right={[3]}
          foot={["Total", "", "", formatarReais(v.parcelas.reduce((t, p) => (p.status === "cancelada" ? t : t + p.valor), 0n)), `${formatarReais(v.resumo.recebido)} recebido`, ""]}
        />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Saídas
// ---------------------------------------------------------------------------

function statusConta(c: ContaVendida): ReactNode {
  if (c.status === "cancelada") return <Badge tom="cinza">Cancelada</Badge>;
  const base =
    c.status === "paga" ? <Badge tom="agua">Pago</Badge> : c.forma === "cartao_corporativo" ? <Badge tom="cinza">No cartão</Badge> : <Badge tom="cinza">A pagar</Badge>;
  return (
    <span className="flex flex-col items-start gap-1">
      {base}
      {c.contestada && <Badge tom="ouro">Contestada</Badge>}
    </span>
  );
}

function vencimentoDaConta(c: ContaVendida): string {
  if (c.pagamentos.length === 0) return "";
  if (c.pagamentos.length === 1) return dataBr(c.pagamentos[0].vencimento);
  return `${c.pagamentos.length} parcelas`;
}

function Saidas({ v, agir, abrir }: { v: ViagemVendida; agir: boolean; abrir: (p: Painel) => void }) {
  const contas = v.contas.filter((c) => c.status !== "cancelada");
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {["Fornecedor", "Descrição", "Valor previsto", "Vencimento", "Forma de pagamento", "Status"].map((h, i) => (
                <th key={h} className={`whitespace-nowrap border-y border-linha bg-fundo px-4 py-3 text-[11px] font-bold uppercase tracking-[0.05em] text-verde ${i === 2 ? "text-right" : "text-left"}`}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {contas.map((c) => {
              const semPagamento = !c.pagamentos.some((p) => p.status === "pago");
              return (
                <ContaLinhas key={c.id} c={c} agir={agir} semPagamento={semPagamento} noCartao={c.moeda === "BRL" && c.fornecedorId !== null && c.fornecedorId === v.cartaoFornecedor?.fornecedorId} abrir={abrir} />
              );
            })}
            {contas.length === 0 && (
              <tr><td colSpan={6} className="py-10 text-center text-[14px] text-cinza">Nenhuma conta a pagar.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** `noCartao`: conta em reais do fornecedor que recebeu no cartão direto (quitada só pelo repasse, sem baixa direta). */
function ContaLinhas({ c, agir, semPagamento, noCartao, abrir }: { c: ContaVendida; agir: boolean; semPagamento: boolean; noCartao: boolean; abrir: (p: Painel) => void }) {
  return (
    <>
      <tr className={`border-t border-linha ${c.divergente || c.contestada ? "bg-ouro/10" : ""}`}>
        <td className="px-4 py-3 text-[14px]">
          <p className="font-semibold">{c.fornecedor ?? c.descricao}</p>
          {c.aereo && <p className="text-[12px] text-cinza">Aéreo, fora da margem</p>}
        </td>
        <td className="px-4 py-3 text-[14px] text-cinza">
          {c.descricao}
          {c.comissaoTipo === "a_receber" && <Badge tom="agua" className="ml-2">Comissão a receber</Badge>}
        </td>
        <td className="num px-4 py-3 text-right text-[14px] font-semibold">
          {formatarReais(c.previstoBrl)}
          {c.divergente && <p className="text-[12px] font-semibold text-texto">orçado {formatarReais(c.previstoVendaBrl)}</p>}
          {c.moeda !== "BRL" && c.cambioAplicado && (
            <p className="text-[12px] font-normal text-cinza">{formatarMoeda(c.valorOriginal, c.moeda)} × {formatarCambio(c.cambioAplicado)}</p>
          )}
        </td>
        <td className="num px-4 py-3 text-[14px]">{vencimentoDaConta(c)}</td>
        <td className="px-4 py-3 text-[13px] text-cinza">{c.forma ? ROTULO_FORMA_FORNECEDOR[c.forma] : "À vista"}</td>
        <td className="px-4 py-3 text-[14px]">{statusConta(c)}</td>
      </tr>
      {c.motivoPrevisto && c.divergente && (
        <tr><td colSpan={6} className="px-4 pb-2 text-[12.5px] text-cinza">Valor atualizado: {c.motivoPrevisto}</td></tr>
      )}
      {c.contestacao && (
        <tr><td colSpan={6} className="px-4 pb-2 text-[12.5px] text-cinza">Contestação{c.contestadaEm ? ` (${dataCurta(c.contestadaEm)})` : ""}: {c.contestacao}</td></tr>
      )}
      {c.pagamentos.map((p) => (
        <tr key={p.id}>
          <td colSpan={6} className="px-4 pb-2 pl-10 text-[13px] text-cinza">
            <span className="inline-flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>{c.pagamentos.length > 1 ? `Parcela ${p.numero}/${c.pagamentos.length}` : "Pagamento"}</span>
              <span className="num">vence {dataBr(p.vencimento)}</span>
              <span className="num">{formatarMoeda(p.valorOriginal, c.moeda)}{c.moeda !== "BRL" && ` (${formatarReais(p.valorBrlPrevisto)})`}</span>
              {p.status === "pago" ? (
                <>
                  <Badge tom="agua">
                    Pago em {dataBr(p.pagoEm)}: {p.valorBrlPago !== null ? formatarReais(p.valorBrlPago) : ""}
                    {c.moeda !== "BRL" && p.valorOriginalPago !== null && p.cambioEfetivo ? ` (${formatarMoeda(p.valorOriginalPago, c.moeda)} a ${formatarCambio(p.cambioEfetivo)})` : ""}
                  </Badge>
                  {p.peloRepasse ? (
                    <span className="text-[12px]">Quitado pelo repasse do cartão (desfaça o repasse em Entradas)</span>
                  ) : (
                    agir && <AcaoDireta rotulo="Desfazer baixa" mini variante="fantasma" executar={() => desfazerBaixaPagamento(p.id)} />
                  )}
                </>
              ) : noCartao ? (
                <span className="text-[12px]">Pago pelo cliente no cartão do fornecedor (quitado pelo repasse em Entradas)</span>
              ) : (
                agir && <BotaoMini onClick={() => abrir({ tipo: "baixaPagamento", conta: c, pag: p })}>Dar baixa</BotaoMini>
              )}
            </span>
          </td>
        </tr>
      ))}
      {agir && (
        <tr>
          <td colSpan={6} className="px-4 pb-3 pl-10">
            <span className="flex flex-wrap gap-2">
              {semPagamento && <BotaoMini onClick={() => abrir({ tipo: "forma", conta: c })}>Forma de pagamento</BotaoMini>}
              {semPagamento && c.fornecedorId && <BotaoMini onClick={() => abrir({ tipo: "comissaoTipo", conta: c })}>Tipo de comissão</BotaoMini>}
              <BotaoMini onClick={() => abrir({ tipo: "previsto", conta: c })}>Atualizar previsto</BotaoMini>
              <BotaoMini onClick={() => abrir({ tipo: "contestar", conta: c })}>Contestar</BotaoMini>
            </span>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Conciliação
// ---------------------------------------------------------------------------

function realizadoDaConta(c: ContaVendida): bigint {
  return c.pagamentos.length === 0 ? c.previstoBrl : c.pagamentos.reduce((t, p) => t + (p.status === "pago" ? (p.valorBrlPago ?? 0n) : p.valorBrlPrevisto), 0n);
}

/** Linhas da ponte: a primeira é a margem planejada e a última a real; as do meio levam o sinal. */
function Ponte({ linhas }: { linhas: LinhaPonte[] }) {
  return (
    <ol className="max-w-[640px]">
      {linhas.map((l, i) => {
        const ponta = i === 0 || i === linhas.length - 1;
        return (
          <li
            key={i}
            className={`flex items-baseline justify-between gap-4 py-2 text-[14px] ${ponta ? `font-bold text-verde ${i === 0 ? "border-b border-linha" : "border-t-2 border-verde"}` : "border-b border-linha/70"}`}
          >
            <span className={ponta ? "" : "text-texto"}>{l.rotulo}</span>
            <span className={`num whitespace-nowrap ${ponta ? "" : l.valor < 0n ? "font-semibold text-texto" : "text-cinza"}`}>{ponta ? formatarReais(l.valor) : comSinal(l.valor)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Conciliacao({ v, agir, abrir }: { v: ViagemVendida; agir: boolean; abrir: (p: Painel) => void }) {
  const est = v.estrategico;
  const contas = v.contas.filter((c) => c.status !== "cancelada");
  const pendentes = v.comissoes.filter((c) => c.pendente);
  const tratadas = v.comissoes.filter((c) => !c.pendente);
  const recebimentos = v.parcelas.filter(
    (p) => p.status === "cancelada" || (p.status === "recebida" && p.valorRecebido !== null && p.valorRecebido !== p.valor),
  );
  const situacao = (c: ContaVendida) =>
    c.contestada ? "Contestada com o fornecedor" : c.divergente ? `Valor atualizado${c.motivoPrevisto ? `: ${c.motivoPrevisto}` : ""}` : realizadoDaConta(c) !== c.previstoBrl ? "Pago diferente do previsto" : "Conforme";

  return (
    <div className="space-y-5">
      {est && (
        <Card>
          <CardHeader title="Margem planejada × real" right={<SoGestao>Gestão</SoGestao>} />
          <div className="px-6 pb-6 pt-3">
            {"erro" in est.real ? (
              <p className="text-[14px] text-texto">{msgErroCalculo}</p>
            ) : (
              <p className="num text-[15px] text-texto">
                Margem planejada de <b>{pct1(est.planejada.finalPct)}</b> ({formatarReais(est.planejada.final)}), margem real de <b>{pct1(est.real.finalPct)}</b> ({formatarReais(est.real.final)}).
              </p>
            )}
            <div className="mt-4">
              <Eyebrow className="mb-2">Ponte da margem</Eyebrow>
              {"erro" in est.ponte ? (
                <p className="text-[14px] text-texto">{msgErroCalculo}</p>
              ) : (
                <Ponte linhas={est.ponte} />
              )}
            </div>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Orçado × realizado" eyebrow="Contas a pagar da viagem. Linhas em ouro têm divergência." />
        <div className="mt-3">
          <Grade
            head={["Fornecedor", "Orçado", "Realizado", "Situação"]}
            right={[1, 2]}
            destaque={(i) => contas[i].divergente || contas[i].contestada}
            rows={contas.map((c) => [c.fornecedor ?? c.descricao, formatarReais(c.previstoVendaBrl), formatarReais(realizadoDaConta(c)), situacao(c)])}
            foot={["Total", formatarReais(contas.reduce((t, c) => t + c.previstoVendaBrl, 0n)), formatarReais(contas.reduce((t, c) => t + realizadoDaConta(c), 0n)), ""]}
          />
        </div>
      </Card>

      {recebimentos.length > 0 && (
        <Card>
          <CardHeader title="Recebimentos com diferença" eyebrow="Parcelas recebidas com valor diferente do previsto ou canceladas." />
          <div className="mt-3">
            <Grade
              head={["Parcela", "Valor", "Recebido", "Situação"]}
              right={[1, 2]}
              destaque={() => true}
              rows={recebimentos.map((p) => [
                `${p.numero}/${p.totalParcelas}`,
                formatarReais(p.valor),
                p.status === "cancelada" ? "-" : formatarReais(p.valorRecebido ?? p.valor),
                `${p.status === "cancelada" ? "Cancelada" : (p.valorRecebido ?? p.valor) < p.valor ? "Recebido a menos" : "Recebido a mais"}${p.observacao ? `: ${p.observacao}` : ""}`,
              ])}
            />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Comissões" eyebrow="Comissões a receber dos fornecedores." />
        <div className="mt-3">
          {v.comissoes.length === 0 ? (
            <p className="px-6 pb-6 text-[14px] text-cinza">Nenhuma comissão a receber nesta viagem.</p>
          ) : (
            <Grade
              head={["Fornecedor", "Prevista para", "Valor", "Situação", ""]}
              right={[2]}
              rows={[...pendentes, ...tratadas].map((c) => [
                c.fornecedor,
                dataBr(c.previstaPara),
                formatarReais(c.status === "recebida" ? (c.valorRecebido ?? c.valorPrevisto) : c.valorPrevisto),
                c.status === "recebida" ? <Badge key="s" tom="agua">Recebida em {dataBr(c.recebidaEm)}</Badge> : c.status === "nao_recebida" ? <Badge key="s" tom="cinza">Não será recebida{c.motivo ? `: ${c.motivo}` : ""}</Badge> : <Badge key="s" tom="ouro">Pendente</Badge>,
                agir ? (
                  c.pendente ? (
                    <span key="a" className="flex flex-wrap gap-2">
                      <BotaoMini onClick={() => abrir({ tipo: "comissaoRecebida", c })}>Marcar recebida</BotaoMini>
                      <BotaoMini onClick={() => abrir({ tipo: "comissaoNao", c })}>Não será recebida</BotaoMini>
                    </span>
                  ) : (
                    <AcaoDireta key="a" rotulo="Desfazer" mini variante="fantasma" executar={() => desfazerComissao(c.id)} />
                  )
                ) : null,
              ])}
            />
          )}
        </div>
      </Card>

      {agir && (
        <div className="flex flex-wrap items-start gap-4">
          <AcaoDireta rotulo="Conciliar viagem" variante="primario" executar={() => conciliar(v.id)} />
          <p className="max-w-[56ch] pt-2 text-[13px] text-cinza">A conciliação só é possível com todas as parcelas recebidas, pagamentos baixados e comissões recebidas ou marcadas como não recebidas.</p>
        </div>
      )}
    </div>
  );
}
