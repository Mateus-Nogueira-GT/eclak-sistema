"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Botao, Badge, Campo, Card, CardHeader, inputCls } from "@/components/ui";
import { Grade } from "@/components/kit";
import { formatarReais } from "@/domain/dinheiro";
import { desativarContaBancaria, salvarContaBancaria } from "@/server/actions/financeiro";

export type ContaTela = { id: string; nome: string; banco: string; saldoInicial: string; saldoInicialEm: string; saldoAtual: string; ativa: boolean };

const VAZIO = { nome: "", banco: "", saldoInicial: "0,00", saldoInicialEm: "" };

/** Centavos (texto) em "1.234,56", com sinal, sem o símbolo da moeda. */
const emReais = (centavos: string) => formatarReais(BigInt(centavos)).replace("R$ ", "");
const dataBr = (iso: string) => iso.split("-").reverse().join("/");

export function ContasBancarias({ contas }: { contas: ContaTela[] }) {
  const router = useRouter();
  const [editando, setEditando] = useState<string | null>(null);
  const [v, setV] = useState(VAZIO);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();

  const mudar = (k: keyof typeof VAZIO, valor: string) => {
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

  function editar(c: ContaTela) {
    setEditando(c.id);
    setV({ nome: c.nome, banco: c.banco, saldoInicial: emReais(c.saldoInicial), saldoInicialEm: c.saldoInicialEm });
    setErros({});
    setMsg(null);
  }

  function salvar() {
    setMsg(null);
    iniciar(async () => {
      const r = await salvarContaBancaria(v, editando ?? undefined);
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

  function desativar(c: ContaTela) {
    if (!window.confirm(`Desativar a conta ${c.nome}? Ela deixa de aparecer nas novas baixas; o histórico fica.`)) return;
    setMsg(null);
    iniciar(async () => {
      const r = await desativarContaBancaria(c.id);
      if (r.ok) {
        if (editando === c.id) limpar();
        router.refresh();
      } else setMsg(r.erro);
    });
  }

  const campo = (k: keyof typeof VAZIO, rotulo: string, extra?: { type?: string; inputMode?: "decimal" }) => (
    <Campo label={rotulo}>
      <input
        type={extra?.type}
        inputMode={extra?.inputMode}
        className={`${inputCls} ${erros[k] ? "!border-ouro bg-ouro/15" : ""}`}
        aria-invalid={erros[k] ? true : undefined}
        value={v[k]}
        onChange={(e) => mudar(k, e.target.value)}
      />
      {erros[k] && <span className="mt-1 block text-[12px] text-texto">{erros[k]}</span>}
    </Campo>
  );

  return (
    <div className="space-y-5">
      <Card className="pb-6">
        <CardHeader title={editando ? "Editar conta bancária" : "Nova conta bancária"} />
        {msg && (
          <p role="status" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
            {msg}
          </p>
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-4">
          {campo("nome", "Nome")}
          {campo("banco", "Banco")}
          {campo("saldoInicial", "Saldo inicial (R$)", { inputMode: "decimal" })}
          {campo("saldoInicialEm", "Saldo em", { type: "date" })}
        </div>
        <div className="mt-4 flex justify-end gap-2 px-6">
          {editando && (
            <Botao variante="secundario" onClick={limpar} disabled={pendente}>
              Cancelar
            </Botao>
          )}
          <Botao onClick={salvar} disabled={pendente}>
            {editando ? "Salvar alterações" : "Adicionar conta"}
          </Botao>
        </div>
      </Card>

      <Card className="pb-2">
        <CardHeader title="Contas cadastradas" />
        {contas.length === 0 ? (
          <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhuma conta bancária cadastrada ainda.</p>
        ) : (
          <Grade
            className="mt-3"
            right={[2, 4]}
            head={["Nome", "Banco", "Saldo inicial", "Em", "Saldo atual", "Situação", ""]}
            rows={contas.map((c) => [
              <b key="n" className="font-semibold">{c.nome}</b>,
              c.banco,
              formatarReais(BigInt(c.saldoInicial)),
              dataBr(c.saldoInicialEm),
              <b key="sa" className={`num font-bold ${BigInt(c.saldoAtual) < 0n ? "text-ouro" : "text-verde"}`}>{formatarReais(BigInt(c.saldoAtual))}</b>,
              c.ativa ? <Badge key="s" tom="verde">Ativa</Badge> : <Badge key="s">Desativada</Badge>,
              <span key="a" className="flex justify-end gap-4">
                {c.ativa && (
                  <>
                    <button onClick={() => editar(c)} className="cursor-pointer text-[13px] font-semibold text-verde hover:underline">Editar</button>
                    <button onClick={() => desativar(c)} disabled={pendente} className="cursor-pointer text-[13px] font-semibold text-verde hover:underline">Desativar</button>
                  </>
                )}
              </span>,
            ])}
          />
        )}
      </Card>
    </div>
  );
}
