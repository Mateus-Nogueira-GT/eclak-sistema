"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Grade } from "@/components/kit";
import { Badge, Botao, Campo, Card, CardHeader, cx, inputCls } from "@/components/ui";
import { formatarReais } from "@/domain/dinheiro";
import type { Centro } from "@/domain/financeiro";
import { cancelarCaixa, confirmarCaixa, salvarCaixa } from "@/server/actions/caixa-experiencia";
import type { CaixaDaViagem, ProdutoParaCaixa } from "@/server/queries/caixa-experiencia";
import { dataHora } from "../formatos";
import { useAcao } from "./acao";

type Acao = ReturnType<typeof useAcao>;

/** Linha do editor: produto da lista ou item do rascunho que saiu dela (desativado ou trocado de uso). */
type Linha = { id: string; nome: string; disponivel: number; custoMedio?: bigint; fora: boolean };

const estoqueDe = (filial: Centro) => `estoque ${filial}`;

function MsgAcao({ acao }: { acao: Acao }) {
  const msg = acao.campos.itens ?? acao.campos.motivo ?? acao.erro;
  if (!msg) return null;
  return (
    <p role="alert" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
      {msg}
    </p>
  );
}

/**
 * Bloco "Caixa de experiência" da viagem vendida (spec §5.3 e §14), para os cinco perfis. Os valores (custo de cada
 * item e total) só aparecem quando o servidor os manda: para consultor e operacional os campos não existem e o bloco
 * não mostra valor nenhum. `somenteLeitura`: viagem conciliada.
 */
export function CaixaExperiencia({
  viagemId,
  filial,
  caixa,
  produtos,
  somenteLeitura,
}: {
  viagemId: string;
  filial: Centro;
  caixa: CaixaDaViagem | null;
  produtos: ProdutoParaCaixa[];
  somenteLeitura: boolean;
}) {
  const situacao = caixa?.situacao ?? null;
  return (
    <Card id="caixa-experiencia" className="mb-6 pb-2">
      <CardHeader
        title="Caixa de experiência"
        eyebrow={`Os itens saem do ${estoqueDe(caixa?.filial ?? filial)} quando a caixa é confirmada.`}
        right={situacao === "confirmada" ? <Badge tom="agua">Confirmada</Badge> : situacao === "rascunho" ? <Badge tom="ouro">Rascunho</Badge> : <Badge>Sem caixa</Badge>}
      />
      {caixa?.situacao === "confirmada" || (somenteLeitura && caixa) ? (
        <Confirmada viagemId={viagemId} caixa={caixa} somenteLeitura={somenteLeitura} />
      ) : somenteLeitura ? (
        <p className="px-6 pb-4 pt-3 text-[14px] text-cinza">Viagem conciliada sem caixa de experiência.</p>
      ) : (
        // A chave refaz o editor com o que o servidor gravou (o `router.refresh` não zera o estado local).
        <Editor key={JSON.stringify(caixa?.itens.map((i) => [i.produtoId, i.quantidade]) ?? null)} viagemId={viagemId} filial={filial} caixa={caixa} produtos={produtos} />
      )}
    </Card>
  );
}

function Confirmada({ viagemId, caixa, somenteLeitura }: { viagemId: string; caixa: CaixaDaViagem; somenteLeitura: boolean }) {
  const acao = useAcao();
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const valores = caixa.total !== undefined;
  const head = valores ? ["Produto", "Quantidade", "Custo unitário", "Subtotal"] : ["Produto", "Quantidade"];
  return (
    <div>
      <Grade
        className="mt-4"
        right={valores ? [1, 2, 3] : [1]}
        head={head}
        rows={caixa.itens.map((i) =>
          i.custoUnitario !== undefined
            ? [i.nome, i.quantidade, formatarReais(i.custoUnitario), formatarReais(BigInt(i.quantidade) * i.custoUnitario)]
            : [i.nome, i.quantidade],
        )}
        foot={caixa.total !== undefined ? ["Total", caixa.itens.reduce((t, i) => t + i.quantidade, 0), "", formatarReais(caixa.total)] : undefined}
      />
      {caixa.situacao === "confirmada" && (
        <p className="px-6 pt-3 text-[13.5px] text-cinza">
          Confirmada{caixa.confirmadaEm ? ` em ${dataHora(caixa.confirmadaEm)}` : ""}
          {caixa.confirmadaPor ? ` por ${caixa.confirmadaPor}` : ""}. Os itens já saíram do {estoqueDe(caixa.filial)}.
          {!somenteLeitura && " Para mudar, cancele e monte outra."}
        </p>
      )}
      {!somenteLeitura &&
        (cancelando ? (
          <form
            className="px-6 pb-4 pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              acao.executar(() => cancelarCaixa(viagemId, motivo));
            }}
          >
            <Campo label="Motivo do cancelamento" className="max-w-[560px]">
              <input
                className={cx(inputCls, acao.campos.motivo && "!border-ouro bg-ouro/15")}
                value={motivo}
                onChange={(e) => {
                  setMotivo(e.target.value);
                  acao.limparCampo("motivo");
                }}
                placeholder="Ex.: cliente pediu outros itens"
              />
            </Campo>
            <p className="mt-2 text-[13px] text-cinza">Os itens voltam ao {estoqueDe(caixa.filial)}. Depois, outra caixa pode ser montada.</p>
            <div className="-mx-6"><MsgAcao acao={acao} /></div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Botao type="submit" disabled={acao.pendente}>Cancelar a caixa</Botao>
              <Botao type="button" variante="fantasma" onClick={() => setCancelando(false)}>Voltar</Botao>
            </div>
          </form>
        ) : (
          <div className="px-6 pb-4 pt-4">
            <Botao variante="secundario" onClick={() => setCancelando(true)}>Cancelar caixa</Botao>
          </div>
        ))}
    </div>
  );
}

function Editor({ viagemId, filial, caixa, produtos }: { viagemId: string; filial: Centro; caixa: CaixaDaViagem | null; produtos: ProdutoParaCaixa[] }) {
  const acao = useAcao();
  const [aberto, setAberto] = useState(caixa !== null);
  const inicial = Object.fromEntries((caixa?.itens ?? []).map((i) => [i.produtoId, i.quantidade]));
  const [qtd, setQtd] = useState<Record<string, number>>(inicial);

  // Produtos da lista mais os itens do rascunho que saíram dela, para poder tirá-los.
  const linhas: Linha[] = [
    ...produtos.map((p) => ({ id: p.id, nome: p.nome, disponivel: p.disponivel, custoMedio: p.custoMedio, fora: false })),
    ...(caixa?.itens ?? []).filter((i) => !produtos.some((p) => p.id === i.produtoId)).map((i) => ({ id: i.produtoId, nome: i.nome, disponivel: i.disponivel, custoMedio: i.custoUnitario, fora: true })),
  ];
  const valores = produtos.some((p) => p.custoMedio !== undefined) || caixa?.total !== undefined;
  const itens = linhas.filter((l) => (qtd[l.id] ?? 0) > 0).map((l) => ({ produtoId: l.id, quantidade: qtd[l.id] }));
  const pecas = itens.reduce((t, i) => t + i.quantidade, 0);
  const total = valores ? linhas.reduce((t, l) => t + BigInt(qtd[l.id] ?? 0) * (l.custoMedio ?? 0n), 0n) : null;
  const mudar = (l: Linha, d: number) => {
    acao.limparCampo("itens");
    setQtd((q) => ({ ...q, [l.id]: Math.max(0, (q[l.id] ?? 0) + d) }));
  };

  if (!aberto) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-4 pt-3">
        <p className="text-[14px] text-cinza">Nenhuma caixa montada para esta viagem.</p>
        <Botao onClick={() => setAberto(true)}><Plus size={16} /> Montar caixa</Botao>
      </div>
    );
  }

  return (
    <div>
      {linhas.length === 0 ? (
        <p className="px-6 pb-2 pt-3 text-[14px] text-cinza">Nenhum produto de caixa de experiência cadastrado no estoque.</p>
      ) : (
        <ul className="mt-4 divide-y divide-linha border-y border-linha">
          {linhas.map((l) => {
            const q = qtd[l.id] ?? 0;
            const passa = q > l.disponivel;
            return (
              <li
                key={l.id}
                className={cx(
                  "grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-6 py-3",
                  valores && "sm:grid-cols-[1fr_auto_110px]",
                  passa || l.fora ? "bg-ouro/15" : q > 0 && "bg-verde/[0.04]",
                )}
              >
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-texto">{l.nome}</p>
                  <p className="text-[12.5px] text-cinza">
                    {l.custoMedio !== undefined && !l.fora && `${formatarReais(l.custoMedio)} cada · `}
                    {l.disponivel} no {estoqueDe(filial)}
                    {l.fora ? " · não está mais disponível para a caixa: tire da lista" : passa ? " · passa do disponível" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => mudar(l, -1)}
                    disabled={q === 0}
                    aria-label={`Tirar ${l.nome}`}
                    className="cursor-pointer rounded-[5px] border border-[#C9CDD1] p-1.5 text-verde disabled:cursor-not-allowed disabled:text-[#C9CDD1]"
                  >
                    <Minus size={14} />
                  </button>
                  <span className="num w-8 text-center text-[15px] font-semibold" aria-label={`Quantidade de ${l.nome}`}>{q}</span>
                  <button
                    type="button"
                    onClick={() => mudar(l, 1)}
                    disabled={l.fora || q >= l.disponivel}
                    aria-label={`Adicionar ${l.nome}`}
                    className="cursor-pointer rounded-[5px] border border-[#C9CDD1] p-1.5 text-verde disabled:cursor-not-allowed disabled:text-[#C9CDD1]"
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {valores && (
                  <p className="num col-start-2 text-right text-[14px] font-semibold text-texto sm:col-start-auto">
                    {q > 0 && l.custoMedio !== undefined ? formatarReais(BigInt(q) * l.custoMedio) : "-"}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <MsgAcao acao={acao} />
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 pb-4 pt-4">
        <p className="text-[13.5px] text-cinza">
          {pecas === 0 ? "Nenhum item escolhido." : `${pecas} ${pecas === 1 ? "item" : "itens"}`}
          {total !== null && pecas > 0 && (
            <>
              {" · total estimado pelo custo médio atual: "}
              <b className="num text-texto">{formatarReais(total)}</b>
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {caixa ? (
            <Botao variante="fantasma" disabled={acao.pendente} onClick={() => acao.executar(() => cancelarCaixa(viagemId, ""))}>Descartar rascunho</Botao>
          ) : (
            <Botao variante="fantasma" onClick={() => { setQtd({}); setAberto(false); }}>Fechar</Botao>
          )}
          <Botao variante="secundario" disabled={acao.pendente} onClick={() => acao.executar(() => salvarCaixa(viagemId, itens))}>Salvar rascunho</Botao>
          <Botao
            disabled={acao.pendente || pecas === 0}
            onClick={() =>
              // Grava o que está na tela e confirma esse rascunho.
              acao.executar(async () => {
                const r = await salvarCaixa(viagemId, itens);
                return r.ok ? confirmarCaixa(viagemId) : r;
              })
            }
          >
            Confirmar caixa
          </Botao>
        </div>
      </div>
    </div>
  );
}
