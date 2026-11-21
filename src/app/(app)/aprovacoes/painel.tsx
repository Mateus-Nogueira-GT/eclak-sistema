"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, Check, RotateCcw, Undo2 } from "lucide-react";
import { Badge, Botao, Card, CardHeader, Campo, Eyebrow, Select, cx, inputCls } from "@/components/ui";
import { Grade } from "@/components/kit";
import {
  ajustarItem,
  calcDe,
  custosDoSnapshot,
  MSG_MOTIVO,
  rotuloForma,
  type ItemSnapshot,
  type Snapshot,
} from "@/domain/aprovacoes";
import { formatarPercentual, formatarReais, lerPercentual, lerReais } from "@/domain/dinheiro";
import {
  custoLiquido,
  FORMAS_SIMULADOR,
  margemDaAprovacao,
  taxaDaForma,
  type FormaPagamento,
  type Rateio,
} from "@/domain/precificacao";
import { ROTULO_METODO } from "@/domain/regras";
import { aprovar, aprovarComAjuste, devolver } from "@/server/actions/aprovacoes";
import type { MargemAprovacao, Pedido } from "@/server/queries/viagens";
import { dataBr, dataHora, doisDigitos, pctParaCampo, reaisParaCampo } from "../viagens/formatos";
import { useAcao } from "../viagens/[id]/acao";
import { rotuloSituacao, tomSituacao } from "./situacao";

const RATEIOS: Rateio[] = ["por_dia", "por_faturamento", "por_viagem"];
const COR_FORNECEDORES = "bg-[#A7A9AC]";
const COR_IMPOSTO = "bg-[#C9CDD1]";
const COR_TAXA = "bg-[#DCDEE0]";
const campoNum = "num rounded-[5px] border border-[#C9CDD1] bg-white px-2 py-1.5 text-right text-[13.5px] text-texto outline-none focus:border-verde";

const lerValor = (t: string): bigint | null => {
  try {
    return lerReais(t);
  } catch {
    return null;
  }
};
const lerPct = (t: string): string | null => {
  try {
    const p = lerPercentual(t);
    return Number(p) > 100 ? null : p;
  } catch {
    return null;
  }
};
/** "19.0" ou "-3.2" → milésimos inteiros, para comparar percentuais sem ponto flutuante. */
function milesimos(p: string): bigint {
  const neg = p.startsWith("-");
  const [i, d = ""] = p.replace("-", "").split(".");
  const v = BigInt(i) * 1000n + BigInt(d.padEnd(3, "0").slice(0, 3));
  return neg ? -v : v;
}
const pctBr = (p: string) => `${p.replace(".", ",")}%`;
const formasIguais = (a: FormaPagamento, b: FormaPagamento) => a.tipo === b.tipo && a.parcelas === b.parcelas && !!a.antecipado === !!b.antecipado;
const larguraPct = (v: bigint, total: bigint) => (total > 0n && v > 0n ? Number((v * 10000n) / total) / 100 : 0);

const baseDoItem = (i: ItemSnapshot) => ({
  valor: BigInt(i.ajuste?.valorFornecedor ?? i.precificada.valorBrl),
  com: lerPercentual(pctParaCampo(i.ajuste?.comissaoPct ?? i.precificada.comissaoPct)),
});

type Campos = Record<string, { valor: string; com: string }>;

export function Painel({ pedido: p }: { pedido: Pedido }) {
  const a = useAcao();
  const regras = p.regras;
  const aguardando = p.status === "aguardando";
  const itens = useMemo(() => p.snapshot.itens.filter((i) => i.tipo !== "Aéreo"), [p.snapshot]);

  const camposIniciais = (): Campos =>
    Object.fromEntries(itens.map((i) => [i.id, { valor: reaisParaCampo(baseDoItem(i).valor), com: pctParaCampo(baseDoItem(i).com) }]));

  const [preco, setPreco] = useState(reaisParaCampo(p.preco));
  const [formaSel, setFormaSel] = useState("proposta");
  const [parcelas, setParcelas] = useState(String(p.forma.tipo === "boleto" ? p.forma.parcelas : 4));
  const [rateio, setRateio] = useState<Rateio>(p.rateio);
  const [campos, setCampos] = useState<Campos>(camposIniciais);
  const [ref, setRef] = useState(pctParaCampo(p.referenciaPct));
  const [devolvendo, setDevolvendo] = useState(false);
  const [comentario, setComentario] = useState("");
  const [localErro, setLocalErro] = useState<string | null>(null);
  const [feito, setFeito] = useState<string | null>(null);

  // Entradas inválidas voltam ao valor da proposta e travam a aprovação com ajuste.
  const precoLido = lerValor(preco);
  const precoOk = precoLido !== null && precoLido > 0n;
  const precoSim = precoOk ? precoLido : p.preco;

  const boleto = formaSel === "boleto";
  const parcelasLidas = Number(parcelas);
  const parcelasOk = !boleto || (/^\d+$/.test(parcelas.trim()) && parcelasLidas >= 1 && parcelasLidas <= 10);
  const forma: FormaPagamento = !parcelasOk
    ? p.forma
    : boleto
      ? { tipo: "boleto", parcelas: parcelasLidas }
      : formaSel === "proposta"
        ? p.forma
        : { ...FORMAS_SIMULADOR[Number(formaSel)].forma };

  const linhas = itens.map((i) => {
    const base = baseDoItem(i);
    const c = campos[i.id];
    const v = lerValor(c.valor);
    const pc = lerPct(c.com);
    const valor = v ?? base.valor;
    const com = pc ?? base.com;
    return { i, valor, com, valorOk: v !== null, comOk: pc !== null, mudouValor: valor !== base.valor, mudouCom: milesimos(com) !== milesimos(base.com) };
  });
  const camposOk = linhas.every((l) => l.valorOk && l.comOk);
  const chaveItens = JSON.stringify(linhas.map((l) => [l.i.id, l.mudouValor ? l.valor.toString() : null, l.mudouCom ? l.com : null]));

  const calc = useMemo(() => {
    try {
      const simulado: Snapshot = {
        ...p.snapshot,
        itens: p.snapshot.itens.map((i) => {
          const l = linhas.find((x) => x.i.id === i.id);
          if (!l || (!l.mudouValor && !l.mudouCom)) return i;
          return ajustarItem(i, {
            ...(l.mudouValor ? { valorFornecedor: l.valor.toString() } : {}),
            ...(l.mudouCom ? { comissaoPct: l.com } : {}),
          });
        }),
      };
      const { custo } = custosDoSnapshot(simulado);
      const m = (f: FormaPagamento, r: Rateio): MargemAprovacao => margemDaAprovacao(precoSim, custo, f, p.dias, r, regras);
      return { m, atual: m(forma, rateio), erro: false as const };
    } catch {
      return { erro: true as const };
    }
    // `linhas` é derivado de `campos` e de `p`; a chave de `chaveItens` cobre as mudanças.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.snapshot, chaveItens, precoSim, forma.tipo, forma.parcelas, forma.antecipado, rateio, p.dias, regras]);

  const original = p.margens[p.rateio];
  const mudou =
    (precoOk && precoSim !== p.preco) || !formasIguais(forma, p.forma) || rateio !== p.rateio || linhas.some((l) => l.mudouValor || l.mudouCom);
  const entradasOk = precoOk && parcelasOk && camposOk;
  const m = calc.erro ? original : calc.atual;

  const refPct = lerPct(ref);
  const refEfetiva = refPct ?? p.referenciaPct;
  const acima = milesimos(m.finalPct) >= milesimos(refEfetiva);

  function voltar() {
    setPreco(reaisParaCampo(p.preco));
    setFormaSel("proposta");
    setParcelas(String(p.forma.tipo === "boleto" ? p.forma.parcelas : 4));
    setRateio(p.rateio);
    setCampos(camposIniciais());
  }
  const edita = (id: string, k: "valor" | "com", v: string) => setCampos((c) => ({ ...c, [id]: { ...c[id], [k]: v } }));

  const resp = `Responsável: ${p.consultor}.`;
  function decidirAprovar() {
    a.executar(() => aprovar(p.versaoId), () => setFeito(`Versão ${p.numero} aprovada. Próximo passo: gerar o PDF e enviar ao cliente. ${resp}`));
  }
  function decidirAjuste() {
    const itensAjuste = linhas
      .filter((l) => l.mudouValor || l.mudouCom)
      .map((l) => ({
        itemId: l.i.id,
        ...(l.mudouValor ? { valorFornecedor: reaisParaCampo(l.valor) } : {}),
        ...(l.mudouCom ? { comissaoPct: pctParaCampo(l.com) } : {}),
      }));
    a.executar(async () => {
      const r = await aprovarComAjuste(p.versaoId, {
        preco: reaisParaCampo(precoSim),
        forma,
        rateio,
        ...(itensAjuste.length > 0 ? { itens: itensAjuste } : {}),
      });
      if (r.ok) setFeito(`Versão ${r.numero} criada com os valores simulados e aprovada. Próximo passo: gerar o PDF e enviar ao cliente. ${resp}`);
      return r;
    });
  }
  function decidirDevolver() {
    const texto = comentario.trim();
    if (!texto) {
      setLocalErro(MSG_MOTIVO);
      return;
    }
    setLocalErro(null);
    a.executar(() => devolver(p.versaoId, texto), () => setFeito(`Versão ${p.numero} devolvida com o comentário: “${texto}”. Próximo passo: ajustar e reenviar. ${resp}`));
  }

  const partes = [
    { nome: "Fornecedores", v: m.custo, cor: COR_FORNECEDORES },
    { nome: "Imposto", v: m.imposto, cor: COR_IMPOSTO },
    { nome: "Taxa de pagamento", v: m.taxa, cor: COR_TAXA },
    { nome: "Custo fixo", v: m.fixo, cor: "bg-ouro" },
    { nome: "Margem", v: m.final, cor: acima ? "bg-verde" : "bg-ouro" },
  ];
  const somaBarra = partes.reduce((s, x) => s + (x.v > 0n ? x.v : 0n), 0n);
  let taxa: { pct: string; fixo: bigint } | null = null;
  try {
    taxa = taxaDaForma(forma, regras);
  } catch {
    taxa = null;
  }
  const rotuloTaxa =
    forma.tipo === "boleto"
      ? `Taxa dos boletos (${formatarReais(BigInt(regras.taxas.boletoPorBoleto))} cada)`
      : `Taxa da forma de pagamento (${formatarPercentual(taxa?.pct ?? "0")})`;
  const explicaRateio =
    rateio === "por_dia"
      ? `${formatarReais(m.fixo / BigInt(Math.max(p.dias, 1)))} por dia: custo fixo do mês dividido pelos ${regras.rateio.diasViagemMes} dias de viagem que a ECLAK atende em média por mês.`
      : rateio === "por_faturamento"
        ? `${formatarPercentual(regras.rateio.pctFaturamento)} do preço: custo fixo do mês dividido pelo faturamento médio mensal.`
        : `${formatarReais(m.fixo)} por viagem: custo fixo do mês dividido pelas ${regras.rateio.viagensMes} viagens vendidas em média por mês.`;

  const diferenca = m.final - original.final;
  const formasTabela = [
    ...FORMAS_SIMULADOR.map((f) => ({ rotulo: f.rotulo, forma: f.forma })),
    ...(forma.tipo === "boleto" ? [{ rotulo: rotuloForma(forma), forma }] : []),
  ];

  const seletorRateio = (
    <Campo label="Rateio do custo fixo">
      <Select value={rateio} onChange={(v) => setRateio(v as Rateio)} className="w-full">
        {RATEIOS.map((r) => <option key={r} value={r}>{ROTULO_METODO[r]}</option>)}
      </Select>
    </Campo>
  );

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-linha pb-5">
        <div>
          <p className="num text-[13px] font-bold text-verde">
            {p.codigo} · versão {p.numero} · {itens.length} itens
          </p>
          <h2 className="titulo mt-1 text-[30px] leading-tight text-texto">{p.cliente} · {p.destino}</h2>
          <p className="mt-1 text-[14px] text-cinza">
            {dataBr(p.inicio)} a {dataBr(p.fim)}, {p.dias} dias, {doisDigitos(p.passageiros.length)} {p.passageiros.length === 1 ? "pessoa" : "pessoas"}. Enviado por {p.enviadoPor} em {dataHora(p.enviadoEm)}.
            {p.alteracao ? ` ${p.alteracao}.` : ""}
          </p>
          <p className="mt-2"><Badge tom={tomSituacao(p)}>{rotuloSituacao(p)}</Badge></p>
        </div>
        <Link href={`/viagens/${p.viagemId}`} className="inline-flex items-center gap-1.5 whitespace-nowrap text-[14px] font-semibold text-verde underline decoration-verde/30 underline-offset-[3px]">
          Abrir a precificação <ArrowRight size={15} />
        </Link>
      </div>

      {calc.erro && <p role="alert" className="rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13.5px] text-texto">Não foi possível calcular a simulação com estes valores. Mostrando a proposta enviada.</p>}

      <section className="grid grid-cols-1 gap-6 lg:grid-cols-[1.05fr_1fr]">
        <div>
          <p className="text-[14px] font-semibold text-texto">Margem da viagem, já com o custo fixo</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className={cx("num text-[54px] font-bold leading-none tracking-tight", acima ? "text-verde" : "text-texto")}>{pctBr(m.finalPct)}</span>
            <span className="num text-[22px] font-bold text-texto">{formatarReais(m.final)}</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-texto">
              <span className={cx("h-2.5 w-2.5 rounded-full", acima ? "bg-agua" : "bg-ouro")} /> {acima ? "Acima" : "Abaixo"} da referência de
            </span>
            <label className="flex items-center gap-1.5 text-[14px] text-texto">
              <input inputMode="decimal" value={ref} onChange={(e) => setRef(e.target.value)} className="num w-[72px] rounded-[5px] border border-[#C9CDD1] px-2 py-1 text-right" aria-label="Margem de referência (%)" />%
            </label>
          </div>
          {refPct === null && <p role="status" className="mt-1 text-[12.5px] text-texto">Percentual inválido; usando {formatarPercentual(p.referenciaPct)}.</p>}
          {mudou && (
            <p className="mt-3 text-[13.5px] text-texto">
              Na proposta enviada: <b className="num">{pctBr(original.finalPct)}</b> ({formatarReais(original.final)}). Diferença da simulação:{" "}
              <b className="num">{diferenca >= 0n ? "+" : ""}{formatarReais(diferenca)}</b>.
            </p>
          )}
          <p className="mt-2 text-[12.5px] text-cinza">A referência é só um indicador visual. Nenhuma decisão é bloqueada pelo sistema.</p>
        </div>

        <div>
          <div className="flex h-9 overflow-hidden rounded-[4px]" aria-hidden>
            {partes.map((x) => <div key={x.nome} className={x.cor} style={{ width: `${larguraPct(x.v, somaBarra)}%` }} title={x.nome} />)}
          </div>
          <dl className="mt-3 text-[14px]">
            {[
              ["Preço do pacote", formatarReais(precoSim), ""],
              ["Fornecedores e taxa de roteiro", "- " + formatarReais(m.custo), COR_FORNECEDORES],
              [`Imposto de ${formatarPercentual(regras.impostoSobreMargemPct)} sobre a margem`, "- " + formatarReais(m.imposto), COR_IMPOSTO],
              [rotuloTaxa, "- " + formatarReais(m.taxa), COR_TAXA],
              [`Margem antes do custo fixo (${pctBr(m.antesPct)})`, formatarReais(m.antes), ""],
              [`Custo fixo rateado: ${ROTULO_METODO[rateio].toLowerCase()}`, "- " + formatarReais(m.fixo), "bg-ouro"],
            ].map(([k, v, cor]) => (
              <div key={k} className="flex items-baseline justify-between gap-4 border-b border-linha py-2">
                <dt className="flex items-center gap-2 text-cinza">{cor && <span className={cx("h-2.5 w-2.5 shrink-0 rounded-[2px]", cor)} />}{k}</dt>
                <dd className="num font-semibold text-texto">{v}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 border-t-2 border-verde py-2">
              <dt className="flex items-center gap-2 font-bold text-texto"><span className={cx("h-2.5 w-2.5 rounded-[2px]", acima ? "bg-verde" : "bg-ouro")} />Margem da viagem</dt>
              <dd className="num font-bold text-texto">{formatarReais(m.final)}</dd>
            </div>
          </dl>
          <p className="num mt-1 text-[13px] text-cinza">Antes do rateio, esta viagem paga {m.diasCobertos.replace(".", ",")} dias de custo fixo da ECLAK.</p>
        </div>
      </section>

      {aguardando && !feito && (
        <Card>
          <CardHeader
            title="Simular"
            eyebrow="Mude o preço, a forma de pagamento, o rateio, o valor ou a comissão de qualquer item. É só simulação: a proposta enviada não muda até você aprovar com ajuste."
            right={mudou ? <button type="button" onClick={voltar} className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-[13.5px] font-semibold text-verde"><RotateCcw size={14} /> Voltar à proposta</button> : undefined}
          />
          <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-4">
            <Campo label="Preço do pacote (R$)">
              <input inputMode="decimal" value={preco} onChange={(e) => setPreco(e.target.value)} className={cx(inputCls, precoOk && precoSim !== p.preco && "!border-terracota", !precoOk && "!border-ouro bg-ouro/15")} />
              {!precoOk && <span className="mt-1 block text-[12px] text-texto">Valor inválido</span>}
            </Campo>
            <Campo label="Forma de pagamento do cliente">
              <Select value={formaSel} onChange={setFormaSel} className={cx("w-full", !formasIguais(forma, p.forma) && "!border-terracota")}>
                <option value="proposta">Forma da proposta: {p.formaRotulo}</option>
                {FORMAS_SIMULADOR.map((f, k) => <option key={f.rotulo} value={String(k)}>{f.rotulo}</option>)}
                <option value="boleto">Boleto</option>
              </Select>
            </Campo>
            {boleto && (
              <Campo label="Parcelas do boleto">
                <input inputMode="numeric" value={parcelas} onChange={(e) => setParcelas(e.target.value)} className={cx(inputCls, !parcelasOk && "!border-ouro bg-ouro/15")} />
                {!parcelasOk && <span className="mt-1 block text-[12px] text-texto">Parcelas inválidas</span>}
              </Campo>
            )}
            {seletorRateio}
          </div>
          <p className="px-6 pt-2 text-[13px] text-cinza">{explicaRateio} Custo fixo médio: {formatarReais(BigInt(regras.custoFixoMensal))} por mês.</p>

          <Grade
            className="mt-4"
            compacta
            right={[3, 4, 5, 6]}
            head={["Tipo", "Item", "Fornecedor", "Valor do fornecedor (R$)", "Comissão (%)", "Custo líquido (R$)", "Ganho do item (R$)"]}
            rows={linhas.map((l) => {
              const liq = custoLiquido(calcDe({ ...l.i, ajuste: { valorFornecedor: l.valor.toString(), comissaoPct: l.com } }, l.i.precificada));
              return [
                l.i.tipo,
                <b key="n" className="font-semibold">{l.i.servico}{l.i.cidade ? ` · ${l.i.cidade}` : ""}</b>,
                l.i.precificada.fornecedor ?? "",
                <input key="v" inputMode="decimal" value={campos[l.i.id].valor} onChange={(e) => edita(l.i.id, "valor", e.target.value)} className={cx(campoNum, "w-[130px]", l.mudouValor && "!border-terracota", !l.valorOk && "!border-ouro bg-ouro/15")} aria-label={`Valor do fornecedor de ${l.i.servico}`} />,
                <input key="c" inputMode="decimal" value={campos[l.i.id].com} onChange={(e) => edita(l.i.id, "com", e.target.value)} className={cx(campoNum, "w-[80px]", l.mudouCom && "!border-terracota", !l.comOk && "!border-ouro bg-ouro/15")} aria-label={`Comissão de ${l.i.servico}`} />,
                reaisParaCampo(liq),
                reaisParaCampo(l.valor - liq),
              ];
            })}
          />
          <p className="px-6 pb-5 pt-3 text-[13px] text-cinza">Campos com borda laranja foram alterados na simulação. A taxa de roteiro entra no custo.</p>
        </Card>
      )}

      {!calc.erro && (
        <Card>
          <CardHeader title="Margem em cada forma de pagamento" eyebrow="Com o preço e os itens da simulação, para apoiar a negociação com o cliente." />
          <Grade
            className="mt-3"
            right={[1, 2, 3]}
            head={["Forma de pagamento", "Taxa", "Margem da viagem (R$)", "Margem da viagem (%)", ""]}
            rows={formasTabela.map((f) => {
              let x: MargemAprovacao | null = null;
              let t: { pct: string; fixo: bigint } | null = null;
              try {
                x = calc.m(f.forma, rateio);
                t = taxaDaForma(f.forma, regras);
              } catch {
                // forma sem cálculo nestes Parâmetros: linha em branco
              }
              const atual = formasIguais(f.forma, forma);
              return [
                <b key="f" className={cx("font-semibold", atual && "text-verde")}>{f.rotulo}</b>,
                t ? (t.fixo > 0n ? `${formatarReais(BigInt(regras.taxas.boletoPorBoleto))} por boleto` : formatarPercentual(t.pct)) : "",
                x ? reaisParaCampo(x.final) : "",
                x ? <b key="p" className="font-semibold">{pctBr(x.finalPct)}</b> : "",
                atual ? <span key="a" className="text-[13px] text-cinza">{formasIguais(forma, p.forma) ? "Forma da proposta" : "Forma simulada"}</span> : "",
              ];
            })}
          />
        </Card>
      )}

      <Card className="p-6">
        {feito ? (
          <p role="status" className="flex items-start gap-2 text-[15px] font-semibold text-texto">
            <Check size={18} className="mt-0.5 shrink-0 text-agua" />
            {feito}
          </p>
        ) : !aguardando ? (
          <p className="text-[14px] text-texto">
            {rotuloSituacao(p)}{p.decididoPor ? ` por ${p.decididoPor}` : ""}{p.decididoEm ? ` em ${dataHora(p.decididoEm)}` : ""}.
            {p.comentario ? ` Comentário: ${p.comentario}.` : ""}
          </p>
        ) : devolvendo ? (
          <div>
            <p className="text-[14px] font-bold text-texto">Comentário para {p.consultor} (obrigatório)</p>
            <textarea
              autoFocus
              value={comentario}
              onChange={(e) => { setComentario(e.target.value); setLocalErro(null); }}
              rows={3}
              placeholder="Diga o que precisa mudar"
              aria-label="Motivo da devolução"
              className={cx("mt-2 w-full rounded-[5px] border border-[#C9CDD1] px-3 py-2.5 text-[14px] outline-none focus:border-verde", localErro && "!border-ouro bg-ouro/15")}
            />
            {(localErro ?? a.erro) && <p role="alert" className="mt-2 text-[13px] text-texto">{localErro ?? a.erro}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              <Botao disabled={a.pendente} onClick={decidirDevolver}>Confirmar devolução</Botao>
              <Botao variante="secundario" disabled={a.pendente} onClick={() => { setDevolvendo(false); setLocalErro(null); }}>Cancelar</Botao>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="max-w-[52ch] text-[14px] text-cinza">A decisão fica registrada com quem decidiu, quando e qual versão. Qualquer mudança depois da aprovação pede nova aprovação.</p>
              <div className="flex flex-wrap gap-2">
                <Botao variante="secundario" disabled={a.pendente} onClick={() => setDevolvendo(true)}><Undo2 size={15} /> Devolver com comentário</Botao>
                <Botao variante="secundario" disabled={a.pendente || !mudou || !entradasOk || calc.erro} onClick={decidirAjuste}>Aprovar com ajuste</Botao>
                <Botao disabled={a.pendente} onClick={decidirAprovar}><Check size={16} /> Aprovar versão {p.numero}</Botao>
              </div>
            </div>
            {a.erro && <p role="alert" className="mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{a.erro}</p>}
          </div>
        )}
      </Card>

      <div><Eyebrow>Os parâmetros desta tela (custo fixo, rateio, referência, taxas) ficam em Administração, Parâmetros.</Eyebrow></div>
    </div>
  );
}
