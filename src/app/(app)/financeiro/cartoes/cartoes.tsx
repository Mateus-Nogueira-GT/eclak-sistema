"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Grade } from "@/components/kit";
import { Badge, Botao, Campo, Card, CardHeader, inputCls } from "@/components/ui";
import type { Moeda } from "@/domain/cambio";
import { formatarReais } from "@/domain/dinheiro";
import { CENTROS, type Centro, type StatusLancamento } from "@/domain/financeiro";
import { criarCartao, desativarCartao, editarCartao } from "@/server/actions/cartoes";
import { desfazerBaixaLinha } from "@/server/actions/financeiro";
import { DialogoBaixaFatura } from "../lancamentos/baixa";
import { formatarMoeda } from "../../viagens/formatos";

type CompraTela = {
  origem: "manual" | "pagamento";
  id: string;
  data: string;
  descricao: string;
  pessoa: string | null;
  valor: string;
  viagemId: string | null;
  viagemDestino: string | null;
  moeda: Moeda;
  valorOriginal: string;
  paga: boolean;
  valorPago: string | null;
};
type FaturaTela = { id: string; fechamento: string; vencimento: string; status: StatusLancamento; pagoEm: string | null; valorPago: string | null; total: string; compras: CompraTela[] };
export type CartaoTela = {
  id: string;
  nome: string;
  final: string;
  diaFechamento: number;
  diaVencimento: number;
  contaBancariaId: string;
  contaBancaria: string;
  centro: Centro;
  ativo: boolean;
  faturas: FaturaTela[];
};

const VAZIO = { nome: "", final: "", diaFechamento: "", diaVencimento: "", contaBancariaId: "", centro: "MT" as string };
type Chave = keyof typeof VAZIO;

const dataBr = (iso: string) => iso.split("-").reverse().join("/");
const reais = (centavos: string) => formatarReais(BigInt(centavos));

function SituacaoFatura({ f }: { f: FaturaTela }) {
  if (f.status === "baixado") return <Badge tom="agua">Paga em {dataBr(f.pagoEm!)}</Badge>;
  return <Badge tom="cinza">Em aberto</Badge>;
}

/**
 * Cadastro dos cartões corporativos e, por cartão, as faturas com o total e as compras de cada uma. `faturaAberta`
 * (`?fatura=<id>`) mostra o detalhe da fatura no topo, com "Dar baixa" e "Desfazer baixa".
 */
export function Cartoes({
  cartoes,
  contas,
  hoje,
  faturaAberta,
}: {
  cartoes: CartaoTela[];
  contas: { id: string; nome: string }[];
  hoje: string;
  faturaAberta: string | null;
}) {
  const router = useRouter();
  const [editando, setEditando] = useState<string | null>(null);
  const [v, setV] = useState(VAZIO);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();

  const mudar = (k: Chave, valor: string) => {
    setV((x) => ({ ...x, [k]: valor }));
    setErros((e) => {
      const r = { ...e };
      delete r[k];
      return r;
    });
  };

  function limpar() {
    setEditando(null);
    setV(VAZIO);
    setErros({});
    setMsg(null);
  }

  function editar(k: CartaoTela) {
    setEditando(k.id);
    setV({ nome: k.nome, final: k.final, diaFechamento: String(k.diaFechamento), diaVencimento: String(k.diaVencimento), contaBancariaId: k.contaBancariaId, centro: k.centro });
    setErros({});
    setMsg(null);
  }

  function salvar() {
    setMsg(null);
    iniciar(async () => {
      const r = editando ? await editarCartao(editando, v) : await criarCartao(v);
      if (r.ok) {
        limpar();
        router.refresh();
      } else {
        const campos = "campos" in r ? r.campos : undefined;
        setErros(campos ?? {});
        setMsg(campos ? "Corrija os campos indicados" : r.erro);
      }
    });
  }

  function desativar(k: CartaoTela) {
    if (!window.confirm(`Desativar o cartão ${k.nome}? Ele deixa de aparecer nas compras novas; as faturas e as compras ficam.`)) return;
    setMsg(null);
    iniciar(async () => {
      const r = await desativarCartao(k.id);
      if (r.ok) {
        if (editando === k.id) limpar();
        router.refresh();
      } else setMsg(r.erro);
    });
  }

  const marca = (k: Chave) => (erros[k] ? "!border-ouro bg-ouro/15" : "");
  const erro = (k: Chave) => erros[k] && <span className="mt-1 block text-[12px] text-texto">{erros[k]}</span>;
  const texto = (k: Chave, rotulo: string, extra?: { inputMode?: "numeric"; maxLength?: number; placeholder?: string }) => (
    <Campo label={rotulo}>
      <input
        inputMode={extra?.inputMode}
        maxLength={extra?.maxLength}
        placeholder={extra?.placeholder}
        className={`${inputCls} ${marca(k)}`}
        aria-invalid={erros[k] ? true : undefined}
        value={v[k]}
        onChange={(e) => mudar(k, e.target.value)}
      />
      {erro(k)}
    </Campo>
  );

  const aberta = faturaAberta ? cartoes.flatMap((k) => k.faturas.map((f) => ({ k, f }))).find((x) => x.f.id === faturaAberta) : undefined;

  return (
    <div className="space-y-5">
      {faturaAberta && <FaturaDetalhe aberta={aberta} contas={contas} hoje={hoje} />}
      <Card className="pb-6">
        <CardHeader title={editando ? "Editar cartão" : "Novo cartão"} />
        {msg && (
          <p role="status" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
            {msg}
          </p>
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-6">
          <div className="lg:col-span-2">{texto("nome", "Nome", { placeholder: "Ex.: Visa empresarial" })}</div>
          {texto("final", "Final (4 dígitos)", { inputMode: "numeric", maxLength: 4, placeholder: "1234" })}
          {texto("diaFechamento", "Dia de fechamento", { inputMode: "numeric", maxLength: 2, placeholder: "1 a 28" })}
          {texto("diaVencimento", "Dia de vencimento", { inputMode: "numeric", maxLength: 2, placeholder: "1 a 28" })}
          <Campo label="Centro de custo">
            <select className={`${inputCls} ${marca("centro")}`} value={v.centro} onChange={(e) => mudar("centro", e.target.value)}>
              {CENTROS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
            {erro("centro")}
          </Campo>
          <Campo label="Conta de débito da fatura" className="sm:col-span-2 lg:col-span-3">
            <select className={`${inputCls} ${marca("contaBancariaId")}`} value={v.contaBancariaId} onChange={(e) => mudar("contaBancariaId", e.target.value)}>
              <option value="">{contas.length === 0 ? "Cadastre uma conta bancária antes" : "Escolha a conta"}</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>{c.nome}</option>
              ))}
            </select>
            {erro("contaBancariaId")}
          </Campo>
        </div>
        <div className="mt-4 flex justify-end gap-2 px-6">
          {editando && (
            <Botao variante="secundario" onClick={limpar} disabled={pendente}>
              Cancelar
            </Botao>
          )}
          <Botao onClick={salvar} disabled={pendente}>
            {editando ? "Salvar alterações" : "Adicionar cartão"}
          </Botao>
        </div>
      </Card>

      <Card className="pb-2">
        <CardHeader title="Cartões cadastrados" />
        {cartoes.length === 0 ? (
          <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhum cartão corporativo cadastrado ainda.</p>
        ) : (
          <Grade
            className="mt-3"
            head={["Nome", "Final", "Fecha dia", "Vence dia", "Conta de débito", "Centro", "Situação", ""]}
            rows={cartoes.map((k) => [
              <b key="n" className="font-semibold">{k.nome}</b>,
              <span key="f" className="num">{k.final}</span>,
              <span key="df" className="num">{k.diaFechamento}</span>,
              <span key="dv" className="num">{k.diaVencimento}</span>,
              k.contaBancaria,
              k.centro,
              k.ativo ? <Badge key="s" tom="verde">Ativo</Badge> : <Badge key="s">Desativado</Badge>,
              <span key="a" className="flex justify-end gap-4">
                {k.ativo && (
                  <>
                    <button onClick={() => editar(k)} className="cursor-pointer text-[13px] font-semibold text-verde hover:underline">Editar</button>
                    <button onClick={() => desativar(k)} disabled={pendente} className="cursor-pointer text-[13px] font-semibold text-verde hover:underline">Desativar</button>
                  </>
                )}
              </span>,
            ])}
          />
        )}
      </Card>

      {cartoes.map((k) => (
        <Card key={k.id} className="pb-2">
          <CardHeader eyebrow="Faturas" title={`${k.nome} · final ${k.final}`} />
          {k.faturas.length === 0 ? (
            <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhuma compra neste cartão ainda.</p>
          ) : (
            <div className="mt-3 divide-y divide-linha border-t border-linha">
              {k.faturas.map((f) => (
                <details key={f.id} className="group px-6 py-3">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-8 gap-y-1 text-[14px]">
                    <span className="w-[150px]">
                      <span className="text-cinza">Fecha </span>
                      <span className="num font-semibold">{dataBr(f.fechamento)}</span>
                    </span>
                    <span className="w-[150px]">
                      <span className="text-cinza">Vence </span>
                      <span className="num font-semibold">{dataBr(f.vencimento)}</span>
                    </span>
                    <span className="w-[160px]">
                      <SituacaoFatura f={f} />
                    </span>
                    <span className="text-cinza">
                      {f.compras.length} {f.compras.length === 1 ? "compra" : "compras"}
                    </span>
                    <b className="num ml-auto font-bold">{reais(f.status === "baixado" && f.valorPago !== null ? f.valorPago : f.total)}</b>
                    <Link href={`/financeiro/cartoes?fatura=${f.id}`} className="text-[13px] font-semibold text-verde hover:underline">
                      Abrir fatura
                    </Link>
                    <span className="text-[13px] font-semibold text-verde group-open:hidden">Ver compras</span>
                    <span className="hidden text-[13px] font-semibold text-verde group-open:inline">Esconder</span>
                  </summary>
                  <Grade
                    compacta
                    className="mt-3"
                    right={[3]}
                    head={["Data da compra", "Descrição", "Fornecedor ou pessoa", "Valor", "Origem"]}
                    rows={f.compras.map((c) => linhaCompra(c, f.status === "baixado"))}
                  />
                </details>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

/**
 * Uma compra da fatura numa linha da grade: data, descrição, pessoa, valor (com a moeda original) e a origem. A compra
 * lançada à mão fica fora da lista (a fatura a substitui): daqui ela abre para editar ou cancelar (só com a fatura em
 * aberto; paga, a baixa da fatura é desfeita antes) e para os anexos. A de viagem abre a viagem.
 */
function linhaCompra(c: CompraTela, faturaPaga: boolean, comPago = false) {
  const estrangeira = c.moeda !== "BRL";
  const link = "font-semibold text-verde hover:underline";
  return [
    <span key="d" className="num">{dataBr(c.data)}</span>,
    c.descricao,
    c.pessoa ?? "",
    <span key="v" className="num">
      {reais(comPago && c.paga && c.valorPago !== null ? c.valorPago : c.valor)}
      {estrangeira && <span className="block text-[12px] text-cinza">{formatarMoeda(BigInt(c.valorOriginal), c.moeda)}</span>}
      {comPago && c.paga && c.valorPago !== null && c.valorPago !== c.valor && <span className="block text-[12px] text-cinza">previsto {reais(c.valor)}</span>}
    </span>,
    c.origem === "pagamento" ? (
      <span key="o" className="flex flex-wrap gap-x-3">
        {c.viagemId && (
          <Link href={`/viagens/${c.viagemId}`} className={link}>
            Viagem {c.viagemDestino}
          </Link>
        )}
        <Link href={`/financeiro/lancamentos?anexos=pagamento:${c.id}`} className={link}>
          Anexos
        </Link>
      </span>
    ) : (
      <span key="o" className="flex flex-wrap items-baseline gap-x-3">
        <span>Lançado à mão</span>
        {faturaPaga ? (
          <span className="text-[12px] text-cinza">desfaça a baixa da fatura para editar</span>
        ) : (
          <Link href={`/financeiro/lancamentos?editar=${c.id}`} className={link}>
            Editar ou cancelar
          </Link>
        )}
        <Link href={`/financeiro/lancamentos?anexos=manual:${c.id}`} className={link}>
          Anexos
        </Link>
      </span>
    ),
  ];
}

const MESES = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const mesAno = (iso: string) => `${MESES[Number(iso.slice(5, 7)) - 1]}/${iso.slice(0, 4)}`;

/** Detalhe da fatura (`?fatura=<id>`): compras, total e a baixa (ou o desfazer) da fatura inteira. */
function FaturaDetalhe({ aberta, contas, hoje }: { aberta: { k: CartaoTela; f: FaturaTela } | undefined; contas: { id: string; nome: string }[]; hoje: string }) {
  const router = useRouter();
  const [baixando, setBaixando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();
  if (!aberta) {
    return (
      <Card className="pb-5">
        <CardHeader eyebrow="Fatura do cartão" title="Fatura não encontrada" />
        <p className="px-6 pt-3 text-[14px] text-cinza">
          Ela pode ter ficado sem compras. <Link href="/financeiro/cartoes" className="font-semibold text-verde hover:underline">Voltar aos cartões</Link>
        </p>
      </Card>
    );
  }
  const { k, f } = aberta;
  const paga = f.status === "baixado";
  const titulo = `${k.nome} · final ${k.final}`;
  const descricao = `Fatura do cartão · ${mesAno(f.fechamento)}`;
  const estrangeiras = f.compras
    .filter((c) => c.origem === "pagamento" && c.moeda !== "BRL")
    .map((c) => ({ id: c.id, descricao: c.descricao, pessoa: c.pessoa, moeda: c.moeda, valorOriginal: BigInt(c.valorOriginal), valorPrevisto: BigInt(c.valor) }));

  function desfazer() {
    if (!window.confirm(`Desfazer a baixa da ${descricao.toLowerCase()} (${titulo})? A fatura e as compras dela voltam a ficar em aberto.`)) return;
    setMsg(null);
    iniciar(async () => {
      try {
        const r = await desfazerBaixaLinha("fatura_cartao", f.id);
        if (r.ok) router.refresh();
        else setMsg(r.erro);
      } catch {
        setMsg("Não foi possível concluir. Tente de novo.");
      }
    });
  }

  return (
    <Card className="pb-2">
      <CardHeader eyebrow={descricao} title={titulo} />
      <div className="flex flex-wrap items-center gap-x-8 gap-y-2 px-6 pt-3 text-[14px]">
        <span>
          <span className="text-cinza">Fecha </span>
          <span className="num font-semibold">{dataBr(f.fechamento)}</span>
        </span>
        <span>
          <span className="text-cinza">Vence </span>
          <span className="num font-semibold">{dataBr(f.vencimento)}</span>
        </span>
        <SituacaoFatura f={f} />
        <span className="ml-auto text-right">
          <span className="text-cinza">{paga ? "Pago " : "Total "}</span>
          <b className="num text-[18px] font-bold">{reais(paga && f.valorPago !== null ? f.valorPago : f.total)}</b>
          {paga && f.valorPago !== null && f.valorPago !== f.total && <span className="block text-[12px] text-cinza">previsto {reais(f.total)}</span>}
        </span>
        {paga ? (
          <Botao variante="fantasma" disabled={pendente} onClick={desfazer}>Desfazer baixa</Botao>
        ) : (
          <Botao disabled={f.compras.length === 0} onClick={() => setBaixando(true)}>Dar baixa</Botao>
        )}
        <Link href="/financeiro/cartoes" className="text-[13px] font-semibold text-verde hover:underline">Fechar</Link>
      </div>
      {msg && (
        <p role="alert" className="mx-6 mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          {msg}
        </p>
      )}
      {f.compras.length === 0 ? (
        <p className="px-6 pb-4 pt-4 text-[14px] text-cinza">Nenhuma compra ativa nesta fatura.</p>
      ) : (
        <Grade
          compacta
          className="mt-4"
          right={[3]}
          head={["Data da compra", "Descrição", "Fornecedor ou pessoa", "Valor", "Origem"]}
          rows={f.compras.map((c) => linhaCompra(c, paga, true))}
        />
      )}
      {baixando && (
        <DialogoBaixaFatura
          fatura={{ id: f.id, titulo, descricao, vencimento: f.vencimento, total: BigInt(f.total) }}
          estrangeiras={estrangeiras}
          hoje={hoje}
          contas={contas}
          contaInicial={k.contaBancariaId}
          onFechar={() => setBaixando(false)}
        />
      )}
    </Card>
  );
}
