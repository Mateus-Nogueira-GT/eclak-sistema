"use client";

import Link from "next/link";
import { useState } from "react";
import { FileText, History, Lock, Pencil, Send } from "lucide-react";
import { Bilhete } from "@/components/bilhete";
import { StatusOrcamentoBadge } from "@/components/status-orcamento";
import { SoGestao, Semaforo } from "@/components/kit";
import { Botao, Card, Eyebrow, Tabs } from "@/components/ui";
import { formatarReais } from "@/domain/dinheiro";
import { FORMA_REFERENCIA } from "@/domain/precificacao";
import type { StatusOrcamento } from "@/domain/viagens";
import type { FichaPrecificacao } from "@/server/queries/viagens";
import { dataBr, doisDigitos, pct1 } from "../formatos";
import { FormularioOrcamento, type PessoaOpcao } from "../formulario";
import { Avista, Comparacao, PorProduto, Simulador } from "./analises";
import { Envio } from "./envio";
import type { FornecedorOpcao } from "./formularios";
import { estrategicoOk, Vendas } from "./vendas";
import { Versoes } from "./versoes";

export type Extras = {
  semCompensacaoPct: string | null;
  diasCobertos: string | null;
  limiteDiaria: bigint;
  /** Parâmetros vigentes do semáforo da margem. */
  margemAlvoPct: string;
  margemReferenciaPct: string;
};
type Aba = "vendas" | "comparacao" | "simulador" | "avista" | "produto";

const PROXIMO_PASSO: Record<StatusOrcamento, string> = {
  em_edicao: "Confira as cotações e envie para aprovação. Responsável: Consultor.",
  aguardando_aprovacao: "Pedido enviado. O Diretor aprova ou devolve com comentário. Responsável: Diretor.",
  aprovado: "Proposta liberada. Gere o PDF e envie ao cliente. Responsável: Consultor.",
  devolvido: "Devolvido pelo Diretor. Veja o comentário em Versões, ajuste e envie de novo. Responsável: Consultor.",
  vendida: "Venda fechada. Acompanhe recebimentos e pagamentos a fornecedores. Responsável: Financeiro.",
};

export function Painel({
  ficha,
  pessoas,
  removidos,
  fornecedores,
  extras,
}: {
  ficha: FichaPrecificacao;
  pessoas: PessoaOpcao[];
  removidos: { id: string; nome: string }[];
  fornecedores: FornecedorOpcao[];
  extras: Extras | null;
}) {
  const est = estrategicoOk(ficha);
  const erroEst = ficha.estrategico && "erro" in ficha.estrategico ? ficha.estrategico.erro : null;
  const erroRef = ficha.referenciaErro || erroEst !== null;
  const [aba, setAba] = useState<Aba>("vendas");
  const [editando, setEditando] = useState(false);
  const [versoes, setVersoes] = useState(false);
  const [enviando, setEnviando] = useState(false);

  const aguardando = ficha.status === "aguardando_aprovacao";
  const editavel = !aguardando;
  const idsRemovidos = new Set(removidos.map((r) => r.id));
  const temCotados = ficha.itens.some((i) => !i.automatico && i.cotacoes.length > 0);
  const ref = est?.precificacao.porForma[FORMA_REFERENCIA];

  const abas: { value: Aba; label: string }[] = [
    { value: "vendas", label: "Vendas da viagem" },
    { value: "comparacao", label: "Comparação de fornecedores" },
    ...(est
      ? ([
          { value: "simulador", label: "Simulador" },
          { value: "avista", label: "Fornecedor à vista" },
          { value: "produto", label: "Por produto" },
        ] as { value: Aba; label: string }[])
      : []),
  ];

  const pdf = ficha.versaoAprovadaId ? (
    <Link href={`/viagens/${ficha.id}/proposta`} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[5px] bg-verde px-3.5 py-2 text-[14px] font-semibold text-white hover:bg-[#254B5C]">
      <FileText size={15} /> Gerar PDF da proposta
    </Link>
  ) : (
    <Botao variante="secundario" disabled title="O PDF só pode ser gerado depois da aprovação do Diretor">
      <Lock size={15} /> Gerar PDF da proposta
    </Botao>
  );

  return (
    <div>
      <Bilhete
        codigo={ficha.codigo}
        cliente={ficha.cliente}
        destino={ficha.destino}
        periodo={`${dataBr(ficha.inicio)} a ${dataBr(ficha.fim)}`}
        noites={ficha.noites}
        passageiros={ficha.passageiros.map((p) => ({ nome: p.nome, removido: idsRemovidos.has(p.id) }))}
        consultor={ficha.consultor.nome}
        etapa={ficha.status === "aguardando_aprovacao" || ficha.status === "aprovado" ? "aprovacao" : "precificacao"}
        href={`/viagens/${ficha.id}`}
        right={
          <>
            <StatusOrcamentoBadge status={ficha.status} />
            <Botao variante="secundario" onClick={() => setVersoes((x) => !x)} aria-expanded={versoes}><History size={15} /> Versões</Botao>
            <Botao variante="secundario" onClick={() => setEditando((x) => !x)} disabled={aguardando} title={aguardando ? "Aguardando aprovação. Peça ao Diretor para devolver antes de alterar." : undefined}>
              <Pencil size={15} /> Alterar viagem
            </Botao>
          </>
        }
      />

      {editando && editavel && (
        <div className="mb-5">
          <FormularioOrcamento
            key={ficha.atualizadoEm}
            clienteId={ficha.clienteId}
            pessoas={pessoas}
            removidos={removidos}
            id={ficha.id}
            atualizadoEm={ficha.atualizadoEm}
            inicial={{ destino: ficha.destino, inicio: ficha.inicio, fim: ficha.fim, observacoes: ficha.observacoes ?? "", passageiros: ficha.passageiros.map((p) => p.id) }}
            onFechar={() => setEditando(false)}
          />
        </div>
      )}
      {versoes && <Versoes versoes={ficha.versoes} />}
      {removidos.length > 0 && !editando && (
        <p role="status" className="mb-5 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          {removidos.map((r) => r.nome).join(", ")} {removidos.length === 1 ? "saiu" : "saíram"} do cadastro do cliente. Abra &quot;Alterar viagem&quot; para tirar {removidos.length === 1 ? "essa pessoa" : "essas pessoas"} do orçamento.
        </p>
      )}
      {aguardando && (
        <p role="status" className="mb-5 rounded-[5px] border border-linha bg-fundo px-4 py-3 text-[14px] text-texto">
          Orçamento aguardando aprovação. Peça ao Diretor para devolver antes de alterar.
        </p>
      )}

      <div className={`mb-6 grid gap-5 ${est ? "grid-cols-1 lg:grid-cols-[1.4fr_1fr_1fr_1fr]" : "grid-cols-1 lg:grid-cols-[1.3fr_1fr]"}`}>
        <Card className="p-6">
          <Eyebrow>Valor de referência para o cliente</Eyebrow>
          {ficha.referencia ? (
            <>
              <p className="num mt-1.5 text-[32px] font-bold tracking-tight text-verde">{formatarReais(BigInt(ficha.referencia.precoCliente))}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-cinza">
                {formatarReais(BigInt(ficha.referencia.porPessoa))} por pessoa · {formatarReais(BigInt(ficha.referencia.precoCliente))} para {doisDigitos(ficha.passageiros.length)} {ficha.passageiros.length === 1 ? "pessoa" : "pessoas"}, em 2x a 6x. Orçamento sem caráter de reserva; os valores podem variar conforme as datas. Não inclui aéreo.
              </p>
            </>
          ) : (
            <>
              <p className="mt-1.5 text-[20px] font-bold text-cinza">{erroRef ? "Indisponível" : "A definir"}</p>
              <p className="mt-1 text-[13px] leading-relaxed text-cinza">
                {erroRef
                  ? "Não foi possível calcular o valor com os Parâmetros vigentes. Fale com o Diretor."
                  : "Cote ao menos um item para ver o valor. Orçamento sem caráter de reserva; os valores podem variar conforme as datas. Não inclui aéreo."}
              </p>
            </>
          )}
        </Card>

        {est && ref ? (
          <>
            <Card className="p-6">
              <div className="flex items-center justify-between gap-2"><Eyebrow>Margem líquida</Eyebrow><SoGestao>Gestão</SoGestao></div>
              {temCotados ? (
                <>
                  <p className="num mt-1.5 text-[26px] font-bold text-verde">{pct1(ref.margemLiquidaPct)}</p>
                  <p className="num text-[13px] text-cinza">{formatarReais(ref.margemLiquida)} em 2x a 6x</p>
                  {extras && <div className="mt-2"><Semaforo margemPct={ref.margemLiquidaPct} alvoPct={extras.margemAlvoPct} referenciaPct={extras.margemReferenciaPct} /></div>}
                </>
              ) : <p className="mt-1.5 text-[14px] text-cinza">Sem itens cotados.</p>}
            </Card>
            <Card className="p-6">
              <div className="flex items-center justify-between gap-2"><Eyebrow>Compensação</Eyebrow><SoGestao>Gestão</SoGestao></div>
              {temCotados ? (
                <>
                  <p className="num mt-1.5 text-[26px] font-bold text-verde">{formatarReais(ref.compensacao)}</p>
                  <p className="text-[13px] text-cinza">{extras?.semCompensacaoPct ? `Só com as regras por item a viagem rende ${pct1(extras.semCompensacaoPct)}.` : "Diferença entre o preço e a soma das vendas por item."}</p>
                </>
              ) : <p className="mt-1.5 text-[14px] text-cinza">Sem itens cotados.</p>}
            </Card>
            <Card className="p-6">
              <div className="flex items-center justify-between gap-2"><Eyebrow>Custo fixo pago</Eyebrow><SoGestao>Gestão</SoGestao></div>
              {temCotados ? (
                <>
                  <p className="num mt-1.5 text-[26px] font-bold text-verde">{extras?.diasCobertos ? `${extras.diasCobertos.replace(".", ",")} dias` : "-"}</p>
                  <p className="text-[13px] text-cinza">Mínimo sem autorização: {formatarReais(ref.preco)}.</p>
                </>
              ) : <p className="mt-1.5 text-[14px] text-cinza">Sem itens cotados.</p>}
            </Card>
          </>
        ) : erroEst ? (
          <Card className="p-6">
            <Eyebrow>Camada estratégica</Eyebrow>
            <p className="mt-1.5 text-[15px] text-texto">Não foi possível calcular com os Parâmetros vigentes. Fale com o Diretor.</p>
          </Card>
        ) : (
          <Card className="p-6">
            <Eyebrow>Próximo passo</Eyebrow>
            <p className="mt-1.5 text-[15px] text-texto">{PROXIMO_PASSO[ficha.status]}</p>
            <p className="mt-2 text-[13px] text-cinza">Custos, margens e compensação ficam visíveis só para a gestão.</p>
          </Card>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <Tabs value={aba} onChange={setAba} options={abas} />
        <div className="flex flex-wrap gap-2">
          {!aguardando && (
            <Botao onClick={() => setEnviando((x) => !x)} aria-expanded={enviando}><Send size={15} /> Enviar para aprovação</Botao>
          )}
          {ficha.status === "aprovado" && (
            <Link href={`/vendas?viagem=${ficha.id}`} className="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[5px] border border-[#C9CDD1] bg-white px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde">
              Registrar resposta do cliente
            </Link>
          )}
          {pdf}
        </div>
      </div>

      {enviando && !aguardando && <Envio key={ficha.atualizadoEm} ficha={ficha} onFechar={() => setEnviando(false)} />}

      {aba === "vendas" && <Vendas ficha={ficha} fornecedores={fornecedores} limiteDiaria={extras?.limiteDiaria ?? null} editavel={editavel} />}
      {aba === "comparacao" && <Comparacao ficha={ficha} editavel={editavel} />}
      {est && aba === "simulador" && <Simulador ficha={ficha} est={est} />}
      {est && aba === "avista" && <Avista est={est} />}
      {est && aba === "produto" && <PorProduto ficha={ficha} est={est} />}
    </div>
  );
}
