"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, CircleCheck, Send, Undo2 } from "lucide-react";
import { Badge, Botao, BotaoLink, Campo, Card, CardHeader, Eyebrow, Select, cx, inputCls } from "@/components/ui";
import { Grade } from "@/components/kit";
import { formatarReais } from "@/domain/dinheiro";
import { rotuloForma } from "@/domain/aprovacoes";
import type { FormaPagamento } from "@/domain/precificacao";
import { cronogramaRecebimento, meioDaForma, ROTULO_MEIO } from "@/domain/venda";
import { fecharVenda, pedirNovaForma, registrarAjustesCliente } from "@/server/actions/vendas";
import type { PropostaLista } from "@/server/queries/vendas";
import { dataBr, dataCurta } from "../viagens/formatos";
import { useAcao } from "../viagens/[id]/acao";
import { ROTULO_ESTADO, TOM_ESTADO } from "./estado";

const TIPOS: { valor: FormaPagamento["tipo"]; rotulo: string }[] = [
  { valor: "pix", rotulo: "Pix" },
  { valor: "boleto", rotulo: "Boleto" },
  { valor: "credito", rotulo: "Cartão de crédito" },
  { valor: "cartao_fornecedor", rotulo: "Cartão direto no fornecedor" },
];

const mesmaForma = (a: FormaPagamento, b: FormaPagamento) =>
  a.tipo === b.tipo && a.parcelas === b.parcelas && !!a.antecipado === !!b.antecipado;

/** `hoje` (Cuiabá) vem do servidor: a renderização do cliente não recalcula a data. */
export function Painel({ p, hoje }: { p: PropostaLista; hoje: string }) {
  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[13px] text-cinza">
              {p.codigo} · {p.destino} · {dataBr(p.inicio)} a {dataBr(p.fim)} · {p.passageiros.length}{" "}
              {p.passageiros.length === 1 ? "pessoa" : "pessoas"} · Consultor: {p.consultor}
            </p>
            <h2 className="mt-1 text-[20px] font-bold text-texto">{p.cliente}</h2>
          </div>
          <Badge tom={TOM_ESTADO[p.estado]}>{ROTULO_ESTADO[p.estado]}</Badge>
        </div>
        <div className="mt-5 grid grid-cols-1 gap-5 border-t border-linha pt-5 sm:grid-cols-3">
          <div>
            <Eyebrow>Preço aprovado</Eyebrow>
            <p className="num mt-1 text-[22px] font-bold text-verde">{formatarReais(BigInt(p.precoCliente))}</p>
          </div>
          <div>
            <Eyebrow>Forma aprovada</Eyebrow>
            <p className="mt-1 text-[16px] font-semibold text-texto">{p.forma}</p>
          </div>
          <div>
            <Eyebrow>Aprovação da gestão</Eyebrow>
            <p className="mt-1 text-[16px] font-semibold text-texto">
              {p.aprovadoPor ?? "Diretor"}
              {p.aprovadoEm ? `, ${dataCurta(p.aprovadoEm)}` : ""}
            </p>
            <p className="text-[13px] text-cinza">Versão {p.numeroVersao}</p>
          </div>
        </div>
      </Card>

      {p.estado === "aguardando" && <RespostaCliente p={p} hoje={hoje} />}
      {p.estado === "vendida" && <ComFinanceiro p={p} />}
      {p.estado === "ajustes" && (
        <Card className="p-6">
          <CardHeader title="Cliente pediu ajustes" eyebrow="A viagem voltou para a precificação. A nova versão passa de novo pela aprovação." />
          <p className="mx-6 mt-4 border-l border-linha pl-4 text-[15px] text-texto">{p.notaCliente ?? "Cliente pediu ajustes na proposta."}</p>
          <p className="px-6 pb-5 pt-4 text-[14px] text-cinza">
            Próximo passo: refazer a precificação. Responsável: {p.consultor}.{" "}
            <BotaoLink href={`/viagens/${p.id}`}>Abrir a viagem</BotaoLink>
          </p>
        </Card>
      )}
    </div>
  );
}

function RespostaCliente({ p, hoje }: { p: PropostaLista; hoje: string }) {
  const router = useRouter();
  const acao = useAcao();
  const [resp, setResp] = useState<"aprovou" | "ajustes">("aprovou");
  const aprovada = p.formaAprovada;

  const [tipo, setTipo] = useState<FormaPagamento["tipo"]>(aprovada.tipo);
  const [parcelas, setParcelas] = useState(aprovada.parcelas);
  const [antecipado, setAntecipado] = useState(!!aprovada.antecipado);
  const [aceiteEm, setAceiteEm] = useState(hoje);
  const [primeiro, setPrimeiro] = useState(hoje);
  const [faturaNome, setFaturaNome] = useState(p.titularNome);
  const [faturaDocumento, setFaturaDocumento] = useState(p.titularDocumento);
  const [comprovante, setComprovante] = useState("");
  const [observacao, setObservacao] = useState("");
  const [notaForma, setNotaForma] = useState("");
  const [pedido, setPedido] = useState("");
  const [fornecedorCartao, setFornecedorCartao] = useState(p.fornecedores.length === 1 ? p.fornecedores[0].id : "");
  const [localErro, setLocalErro] = useState<string | null>(null);

  const umaParcela = tipo === "pix" || tipo === "cartao_fornecedor";
  const qtd = umaParcela ? 1 : parcelas;
  const forma: FormaPagamento = { tipo, parcelas: qtd, ...(tipo === "credito" && antecipado ? { antecipado: true } : {}) };
  const diferente = !mesmaForma(forma, aprovada);
  const total = BigInt(p.precoCliente);

  let cronograma: ReturnType<typeof cronogramaRecebimento> | null = null;
  try {
    cronograma = cronogramaRecebimento(total, qtd, primeiro);
  } catch {
    cronograma = null; // data ainda não preenchida
  }
  const meio = ROTULO_MEIO[meioDaForma(forma)];

  function mudarTipo(v: string) {
    const novo = v as FormaPagamento["tipo"];
    setTipo(novo);
    if (novo === "pix" || novo === "cartao_fornecedor") setParcelas(1);
    if (novo !== "credito") setAntecipado(false);
    setLocalErro(null);
  }

  function confirmar() {
    setLocalErro(null);
    acao.executar(() =>
      fecharVenda(p.id, {
        aceiteEm,
        forma,
        parcelas: qtd,
        primeiroVencimento: primeiro,
        faturaNome,
        faturaDocumento,
        comprovante,
        observacao,
        ...(tipo === "cartao_fornecedor" ? { fornecedorCartaoId: fornecedorCartao } : {}),
      }),
    );
  }

  function enviarNovaForma() {
    if (!notaForma.trim()) {
      setLocalErro("Escreva por que a forma mudou");
      return;
    }
    setLocalErro(null);
    acao.executar(
      () => pedirNovaForma(p.id, { forma, nota: notaForma.trim() }),
      () => router.replace("/vendas?aviso=nova-forma"),
    );
  }

  function enviarAjustes() {
    if (!pedido.trim()) {
      setLocalErro("Escreva o pedido do cliente");
      return;
    }
    setLocalErro(null);
    acao.executar(() => registrarAjustesCliente(p.id, pedido.trim()));
  }

  const erroGeral = localErro ?? acao.erro;
  const marca = (k: string) => (acao.campos[k] ? "!border-ouro bg-ouro/15" : "");
  const msgCampo = (k: string) =>
    acao.campos[k] ? <span className="mt-1 block text-[12px] text-texto">{acao.campos[k]}</span> : null;

  return (
    <Card>
      <CardHeader title="Resposta do cliente" eyebrow="Registre o aceite e confira o cronograma antes de enviar ao financeiro." />
      <div className="px-6 pb-6 pt-4">
        <div className="grid grid-cols-2 gap-2 sm:max-w-[420px]" role="radiogroup" aria-label="Resposta do cliente">
          {(["aprovou", "ajustes"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={resp === r}
              onClick={() => {
                setResp(r);
                setLocalErro(null);
              }}
              className={cx(
                "cursor-pointer rounded-[5px] border px-3 py-2.5 text-[14px] font-semibold transition-colors",
                resp === r ? "border-verde bg-verde/[0.06] text-verde" : "border-[#C9CDD1] text-texto hover:border-verde",
              )}
            >
              {r === "aprovou" ? "Cliente aprovou" : "Cliente pediu ajustes"}
            </button>
          ))}
        </div>

        {resp === "ajustes" ? (
          <div className="mt-6">
            <Campo label="O que o cliente pediu">
              <textarea
                rows={3}
                className={cx(inputCls, marca("nota"))}
                value={pedido}
                onChange={(e) => setPedido(e.target.value)}
              />
              {msgCampo("nota")}
            </Campo>
            {erroGeral && (
              <p role="alert" className="mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{erroGeral}</p>
            )}
            <Botao className="mt-4" variante="secundario" onClick={enviarAjustes} disabled={acao.pendente}>
              <Undo2 size={15} /> Voltar para a precificação
            </Botao>
          </div>
        ) : (
          <>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Campo label="Data do aceite">
                <input type="date" max={hoje} className={cx(inputCls, marca("aceiteEm"))} value={aceiteEm} onChange={(e) => setAceiteEm(e.target.value)} />
                {msgCampo("aceiteEm")}
              </Campo>
              <Campo label="Forma acordada">
                <Select value={tipo} onChange={mudarTipo} className={cx("w-full", diferente && "!border-terracota")}>
                  {TIPOS.map((t) => (
                    <option key={t.valor} value={t.valor}>{t.rotulo}</option>
                  ))}
                </Select>
                {msgCampo("forma")}
              </Campo>
              <Campo label="Parcelas">
                <Select
                  value={String(qtd)}
                  onChange={(v) => setParcelas(Number(v))}
                  className={cx("w-full", umaParcela && "opacity-60")}
                >
                  {(umaParcela ? [1] : Array.from({ length: 10 }, (_, i) => i + 1)).map((o) => (
                    <option key={o} value={o}>{o === 1 ? "À vista" : `${o}x`}</option>
                  ))}
                </Select>
                {msgCampo("parcelas")}
              </Campo>
              <Campo label="Primeiro vencimento">
                <input type="date" className={cx(inputCls, marca("primeiroVencimento"))} value={primeiro} onChange={(e) => setPrimeiro(e.target.value)} />
                {msgCampo("primeiroVencimento")}
              </Campo>
              {tipo === "cartao_fornecedor" && (
                <Campo label="Fornecedor que recebeu no cartão" className="sm:col-span-2">
                  <Select value={fornecedorCartao} onChange={setFornecedorCartao} className={cx("w-full", marca("fornecedorCartaoId"))}>
                    <option value="">{p.fornecedores.length === 0 ? "Nenhum fornecedor na viagem" : "Escolha o fornecedor"}</option>
                    {p.fornecedores.map((f) => (
                      <option key={f.id} value={f.id}>{f.nome}</option>
                    ))}
                  </Select>
                  {msgCampo("fornecedorCartaoId")}
                  <span className="mt-1 block text-[12px] text-cinza">Ele fica com o custo dele e repassa a diferença à ECLAK.</span>
                </Campo>
              )}
              {tipo === "credito" && (
                <label className="flex items-center gap-2 text-[14px] text-texto sm:col-span-2 lg:col-span-4">
                  <input type="checkbox" checked={antecipado} onChange={(e) => setAntecipado(e.target.checked)} />
                  Com antecipação dos recebíveis
                </label>
              )}
              <Campo label="Fatura em nome de" className="sm:col-span-1 lg:col-span-2">
                <input className={cx(inputCls, marca("faturaNome"))} value={faturaNome} onChange={(e) => setFaturaNome(e.target.value)} />
                {msgCampo("faturaNome")}
              </Campo>
              <Campo label="CPF ou CNPJ da fatura" className="sm:col-span-1 lg:col-span-2">
                <input inputMode="numeric" className={cx(inputCls, marca("faturaDocumento"))} value={faturaDocumento} onChange={(e) => setFaturaDocumento(e.target.value)} />
                {msgCampo("faturaDocumento")}
              </Campo>
              <Campo label="Comprovante do aceite" className="sm:col-span-2 lg:col-span-4">
                <input
                  className={cx(inputCls, marca("comprovante"))}
                  placeholder="Descreva onde está o aceite: WhatsApp, e-mail…"
                  value={comprovante}
                  onChange={(e) => setComprovante(e.target.value)}
                />
                {msgCampo("comprovante")}
              </Campo>
            </div>

            {diferente && (
              <div className="mt-4 border-l border-terracota pl-4">
                <p className="text-[14px] text-texto">
                  A forma acordada é diferente da aprovada ({p.forma}). Como a taxa muda a margem, a venda volta para o diretor aprovar a nova forma antes de ir ao financeiro.
                </p>
                <Campo label="Por que a forma mudou" className="mt-3 max-w-[560px]">
                  <textarea
                    rows={2}
                    className={cx(inputCls, marca("nota"))}
                    value={notaForma}
                    onChange={(e) => setNotaForma(e.target.value)}
                  />
                  {msgCampo("nota")}
                </Campo>
                <p className="mt-2 text-[13px] text-cinza">Nova forma: {rotuloForma(forma)}.</p>
              </div>
            )}

            <div className="mt-6">
              <Eyebrow>Cronograma de recebimentos</Eyebrow>
              {cronograma ? (
                <Grade
                  className="mt-2"
                  compacta
                  right={[2]}
                  head={["Parcela", "Vencimento", "Valor (R$)", "Meio"]}
                  rows={cronograma.map((x) => [`${x.numero} de ${qtd}`, dataBr(x.vencimento), formatarReais(x.valor).replace("R$ ", ""), meio])}
                  foot={["Total", "", formatarReais(total).replace("R$ ", ""), ""]}
                />
              ) : (
                <p className="mt-2 text-[13px] text-cinza">Informe o primeiro vencimento para ver o cronograma.</p>
              )}
            </div>

            <Campo label="Observação para o financeiro" className="mt-5">
              <textarea rows={2} className={cx(inputCls, marca("observacao"))} value={observacao} onChange={(e) => setObservacao(e.target.value)} />
              {msgCampo("observacao")}
            </Campo>

            <div className="mt-6 grid grid-cols-1 gap-x-8 gap-y-2 border-t border-linha pt-5 text-[14px] text-texto sm:grid-cols-2">
              <p className="text-[13px] text-cinza sm:col-span-2">Ao confirmar, o sistema faz sozinho:</p>
              <p className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-verde" /> Muda a viagem {p.codigo} para Vendida</p>
              <p className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-verde" /> Lança as parcelas a receber e as contas a pagar</p>
              <p className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-verde" /> Mostra a venda para o financeiro em Viagens</p>
            </div>

            {erroGeral && (
              <p role="alert" className="mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{erroGeral}</p>
            )}
            <div className="mt-6 flex flex-wrap gap-2">
              {diferente ? (
                <Botao onClick={enviarNovaForma} disabled={acao.pendente}>
                  <Send size={15} /> Enviar a nova forma para aprovação
                </Botao>
              ) : (
                <Botao onClick={confirmar} disabled={acao.pendente}>
                  <Send size={15} /> Confirmar venda e avisar o financeiro
                </Botao>
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function ComFinanceiro({ p }: { p: PropostaLista }) {
  const parcelas = p.parcelasLancadas ?? [];
  return (
    <Card>
      <CardHeader
        title="Enviada ao financeiro"
        eyebrow={p.vendidaEm ? `Venda confirmada em ${dataCurta(p.vendidaEm)}.` : undefined}
      />
      <div className="px-6 pb-6 pt-4">
        <div className="grid grid-cols-1 gap-x-8 gap-y-2 text-[14px] text-texto sm:grid-cols-2">
          <p className="flex gap-2"><CircleCheck size={16} className="mt-0.5 shrink-0 text-agua" /> Viagem {p.codigo} marcada como Vendida</p>
          <p className="flex gap-2"><CircleCheck size={16} className="mt-0.5 shrink-0 text-agua" /> Parcelas a receber e contas a pagar lançadas</p>
          <p className="flex gap-2"><CircleCheck size={16} className="mt-0.5 shrink-0 text-agua" /> Venda visível ao financeiro em Viagens</p>
        </div>
        {parcelas.length > 0 && (
          <Grade
            className="mt-5"
            compacta
            right={[2]}
            head={["Parcela", "Vencimento", "Valor (R$)", "Meio"]}
            rows={parcelas.map((x) => [
              `${x.numero} de ${x.totalParcelas}`,
              dataBr(x.vencimento),
              formatarReais(BigInt(x.valor)).replace("R$ ", ""),
              x.meio,
            ])}
            foot={["Total", "", formatarReais(parcelas.reduce((s, x) => s + BigInt(x.valor), 0n)).replace("R$ ", ""), ""]}
          />
        )}
        <div className="mt-5 border-t border-linha pt-4">
          <Link
            href={`/viagens/${p.id}`}
            className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-verde underline decoration-verde/30 underline-offset-[3px] hover:decoration-verde"
          >
            Abrir a viagem
          </Link>
        </div>
      </div>
    </Card>
  );
}
