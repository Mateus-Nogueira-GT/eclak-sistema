"use client";

import type { ReactNode } from "react";
import { Badge, Botao, Card, CardHeader, Eyebrow } from "@/components/ui";
import { Grade } from "@/components/kit";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { FORMAS_SIMULADOR } from "@/domain/precificacao";
import { escolherCotacao } from "@/server/actions/viagens";
import type { FichaPrecificacao, ItemFicha } from "@/server/queries/viagens";
import { formatarMoeda, pct1 } from "../formatos";
import { useAcao } from "./acao";
import { custosDaCotacao, estrategicoOk } from "./vendas";

type Est = NonNullable<ReturnType<typeof estrategicoOk>>;
const formas = FORMAS_SIMULADOR.map((f) => f.rotulo);
const reais = (v: bigint) => formatarReais(v);
const forte = (t: ReactNode) => <span className="font-bold text-verde">{t}</span>;

function matriz(linhas: [string, ReactNode[], boolean?][]) {
  return linhas.map(([rot, vals, f]) => [f ? forte(rot) : rot, ...vals.map((v) => (f ? forte(v) : v))]);
}

/** Pior custo de cada item (o mesmo critério do servidor: maior custo líquido, empate fica com a mais antiga). */
function indicePior(item: ItemFicha): number {
  let pior = 0;
  let max = -1n;
  item.cotacoes.forEach((c, i) => {
    const cl = custosDaCotacao(item, c)?.liquido ?? 0n;
    if (cl > max) [pior, max] = [i, cl];
  });
  return pior;
}

export function Comparacao({ ficha, editavel }: { ficha: FichaPrecificacao; editavel: boolean }) {
  const est = estrategicoOk(ficha);
  const a = useAcao();
  const itens = ficha.itens.filter((i) => !i.automatico && i.cotacoes.length > 0);
  const precificados = new Map(est?.precificacao.itens.map((x) => [x.id, x]) ?? []);
  const rows: ReactNode[][] = [];
  const destaque: boolean[] = [];
  for (const i of itens) {
    const pior = indicePior(i);
    const custos = i.cotacoes.map((c) => custosDaCotacao(i, c)?.liquido ?? 0n);
    const melhor = custos.reduce((m, c, k) => (c < custos[m] ? k : m), 0);
    i.cotacoes.forEach((c, k) => {
      const cu = est ? custosDaCotacao(i, c) : null;
      const x = precificados.get(i.id);
      const situacao = i.cotacoes.length === 1 ? "Única" : k === pior ? "Pior custo" : k === melhor ? "Melhor custo" : "Intermediária";
      const escolha = c.escolhida ? (
        <Badge key="e" tom="grafite">Escolhida</Badge>
      ) : editavel ? (
        <Botao key="b" variante="fantasma" className="!px-2 !py-1 !text-[12.5px]" disabled={a.pendente} onClick={() => a.executar(() => escolherCotacao(c.id))}>Escolher</Botao>
      ) : (
        ""
      );
      rows.push([
        k === 0 ? <b key="h" className="font-semibold">{i.servico}</b> : "",
        c.fornecedor?.nome ?? "A informar",
        formatarMoeda(c.valorOriginal, c.moeda),
        formatarPercentual(c.comissaoPct),
        ...(est
          ? [
              cu ? reais(cu.liquido) : "",
              cu ? reais(cu.avista) : "",
              k === pior && x ? reais(x.venda) : "",
              k === pior && x ? reais(x.valorFinal) : "",
              <Badge key="s" tom={situacao === "Melhor custo" ? "agua" : situacao === "Pior custo" ? "ouro" : "cinza"}>{situacao}</Badge>,
              escolha,
            ]
          : [escolha]),
      ]);
      destaque.push(false);
    });
  }
  return (
    <Card>
      <CardHeader eyebrow="Várias cotações para o mesmo item. O preço usa o pior custo; a escolhida define o custo esperado." title="Comparação de fornecedores" />
      {a.erro && <p role="alert" className="mx-6 mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">{a.erro}</p>}
      {rows.length === 0 ? (
        <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhum item cotado ainda.</p>
      ) : (
        <Grade
          className="mt-3"
          estrategicoDe={est ? 4 : undefined}
          right={est ? [2, 3, 4, 5, 6, 7] : [2, 3]}
          head={["Item", "Fornecedor", "Valor forn.", "Com.", ...(est ? ["Custo líquido", "Custo à vista", "Venda", "Preço do item", "Situação", "Escolha"] : ["Escolha"])]}
          rows={rows}
          destaque={(i) => destaque[i]}
        />
      )}
      {est && (
        <div className="grid grid-cols-1 gap-4 border-t border-linha px-6 py-5 sm:grid-cols-2 lg:grid-cols-3">
          <div><Eyebrow>Custo pelo pior caso (base do preço)</Eyebrow><p className="num mt-1 text-[20px] font-bold text-verde">{reais(est.precificacao.custo)}</p></div>
          <div><Eyebrow>Custo com os fornecedores escolhidos</Eyebrow><p className="num mt-1 text-[20px] font-bold text-verde">{reais(est.custoEscolhidas)}</p></div>
          <div><Eyebrow>Margem extra, sem mexer no preço</Eyebrow><p className="num mt-1 text-[20px] font-bold text-verde">{reais(est.margemExtra)}</p></div>
        </div>
      )}
    </Card>
  );
}

export function Simulador({ ficha, est }: { ficha: FichaPrecificacao; est: Est }) {
  const f = est.precificacao.porForma;
  const p = est.precificacao;
  const linhas: [string, ReactNode[], boolean?][] = [
    ["Taxa total da forma de pagamento", f.map((x) => `${x.taxaPct.replace(".", ",")}%`)],
    ["Soma dos itens (venda pelas regras por item)", f.map(() => reais(p.somaVendas))],
    ["(+) Linha de compensação", f.map((x) => reais(x.compensacao))],
    ["(=) Preço do pacote", f.map((x) => reais(x.preco)), true],
    ["(-) Custo real", f.map(() => reais(p.custo))],
    ["(-) Imposto sobre a margem", f.map((x) => reais(x.imposto))],
    ["(-) Taxas financeiras", f.map((x) => reais(x.taxas))],
    ["(=) Margem líquida (R$)", f.map((x) => reais(x.margemLiquida)), true],
    ["(=) Margem líquida (%)", f.map((x) => pct1(x.margemLiquidaPct)), true],
    [`Taxa de serviço (${ficha.dias} dias)`, f.map((x) => reais(x.taxaServico))],
    ["Preço apresentado ao cliente", f.map((x) => reais(x.precoCliente)), true],
    ["Margem se a taxa de serviço não for concedida", f.map((x) => pct1(x.margemSemTaxaServicoPct))],
  ];
  return (
    <Card>
      <CardHeader eyebrow="Preço do pacote por forma de pagamento" title="Simulador" />
      <Grade className="mt-3" right={[1, 2, 3, 4, 5]} head={["Linha", ...formas]} rows={matriz(linhas)} destaque={(i) => i === 2} />
      <p className="px-6 pb-5 pt-3 text-[13px] text-cinza">Ordem de concessão ao negociar: taxa de serviço, desconto à vista, diferença de taxa da forma de pagamento.</p>
    </Card>
  );
}

export function Avista({ est }: { est: Est }) {
  const v = est.precificacao.avista;
  const linhas: [string, ReactNode[], boolean?][] = [
    ["Custo pagando no prazo", formas.map(() => reais(v.custoNoPrazo))],
    ["(-) Desconto à vista dos fornecedores", formas.map(() => reais(v.desconto))],
    ["Custo pagando à vista", formas.map(() => reais(v.custoAVista)), true],
    ["Opção A: manter o preço. Margem com o desconto", v.opcaoAMargemPct.map(pct1)],
    ["Opção B: manter a margem alvo. Preço do pacote", v.opcaoBPreco.map(reais)],
    ["Opção B: redução possível para o cliente", v.opcaoBReducao.map(reais)],
  ];
  return (
    <Card>
      <CardHeader eyebrow="Decisão de compra" title="Fornecedor à vista" />
      <Grade className="mt-3" right={[1, 2, 3, 4, 5]} head={["Linha", ...formas]} rows={matriz(linhas)} />
      <div className="grid grid-cols-1 gap-4 border-t border-linha px-6 py-5 text-[14px] sm:grid-cols-2">
        <p><b className="text-verde">Opção A.</b> O desconto vira margem. Indicada quando a margem de partida está no limite.</p>
        <p><b className="text-verde">Opção B.</b> O desconto vira preço menor para o cliente, mantendo a margem alvo.</p>
      </div>
    </Card>
  );
}

export function PorProduto({ ficha, est }: { ficha: FichaPrecificacao; est: Est }) {
  const p = est.precificacao;
  const rows: ReactNode[][] = [];
  for (const i of ficha.itens) {
    const x = p.itens.find((y) => y.id === i.id);
    if (!x) continue;
    const pior = i.cotacoes[indicePior(i)];
    const escolhida = i.cotacoes.find((c) => c.escolhida) ?? i.cotacoes[0];
    rows.push([
      i.tipo,
      <b key="s" className="font-semibold">{i.servico}</b>,
      pior?.fornecedor?.nome ?? "A informar",
      escolhida?.fornecedor?.nome ?? "A informar",
      ...x.precoPorForma.map(reais),
    ]);
  }
  return (
    <Card>
      <CardHeader eyebrow="Valor aberto por item, para quando o cliente pede especificação" title="Por produto" />
      {rows.length === 0 ? (
        <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhum item cotado ainda.</p>
      ) : (
        <Grade
          className="mt-3"
          compacta
          right={[4, 5, 6, 7, 8]}
          head={["Tipo", "Hotel / serviço", "Precificado com", "Fechado com", ...formas]}
          rows={rows}
          foot={["Total", "", "", "", ...p.porForma.map((f) => reais(f.preco))]}
        />
      )}
    </Card>
  );
}
