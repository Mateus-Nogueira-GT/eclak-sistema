"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Grade } from "@/components/kit";
import { Badge, Botao, Campo, Card, CardHeader, inputCls } from "@/components/ui";
import { formatarReais } from "@/domain/dinheiro";
import { CENTROS, type Centro, type StatusLancamento } from "@/domain/financeiro";
import { criarCartao, desativarCartao, editarCartao } from "@/server/actions/cartoes";

type CompraTela = {
  origem: "manual" | "pagamento";
  id: string;
  data: string;
  descricao: string;
  pessoa: string | null;
  valor: string;
  viagemId: string | null;
  viagemDestino: string | null;
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

/** Cadastro dos cartões corporativos e, por cartão, as faturas com o total e as compras de cada uma. */
export function Cartoes({ cartoes, contas }: { cartoes: CartaoTela[]; contas: { id: string; nome: string }[] }) {
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

  return (
    <div className="space-y-5">
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
                    <b className="num ml-auto font-bold">{reais(f.total)}</b>
                    <span className="text-[13px] font-semibold text-verde group-open:hidden">Ver compras</span>
                    <span className="hidden text-[13px] font-semibold text-verde group-open:inline">Esconder</span>
                  </summary>
                  <Grade
                    compacta
                    className="mt-3"
                    right={[3]}
                    head={["Data da compra", "Descrição", "Fornecedor ou pessoa", "Valor", "Origem"]}
                    rows={f.compras.map((c) => [
                      <span key="d" className="num">{dataBr(c.data)}</span>,
                      c.descricao,
                      c.pessoa ?? "",
                      <span key="v" className="num">{reais(c.valor)}</span>,
                      c.viagemId ? (
                        <Link key="o" href={`/viagens/${c.viagemId}`} className="font-semibold text-verde hover:underline">
                          Viagem {c.viagemDestino}
                        </Link>
                      ) : (
                        "Lançado à mão"
                      ),
                    ])}
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
