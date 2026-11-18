"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Botao, Campo, Card, CardHeader, PageHeader, Select, inputCls } from "@/components/ui";
import { MODALIDADES, ROTULO_MODALIDADE, TIPOS_SERVICO, type Modalidade, type TipoServico } from "@/domain/fornecedores";
import type { ValoresFornecedor } from "./valores";
import { excluirFornecedor, salvarFornecedor } from "@/server/actions/fornecedores";

export function FormularioFornecedor({
  inicial,
  id,
  podeExcluir = false,
}: {
  inicial: ValoresFornecedor;
  id?: string;
  podeExcluir?: boolean;
}) {
  const router = useRouter();
  const [v, setV] = useState(inicial);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();

  function mudar<K extends keyof ValoresFornecedor>(k: K, valor: ValoresFornecedor[K]) {
    setV((x) => ({ ...x, [k]: valor }));
    setErros((e) => {
      if (!(k in e)) return e;
      const r = { ...e };
      delete r[k];
      return r;
    });
  }

  function alternarTipo(t: TipoServico) {
    mudar("tipos", v.tipos.includes(t) ? v.tipos.filter((x) => x !== t) : [...v.tipos, t]);
  }

  function salvar() {
    setMsg(null);
    iniciar(async () => {
      const r = await salvarFornecedor(v, id);
      if (r.ok) { router.push("/fornecedores"); router.refresh(); }
      else {
        setErros(r.campos ?? {});
        setMsg(r.campos ? "Corrija os campos indicados" : r.erro);
      }
    });
  }

  function excluir() {
    if (!id || !window.confirm("Excluir este fornecedor? Ele sai da lista, mas o histórico fica registrado.")) return;
    iniciar(async () => {
      const r = await excluirFornecedor(id);
      if (r.ok) { router.push("/fornecedores"); router.refresh(); }
      else setMsg(r.erro);
    });
  }

  const texto = (k: keyof ValoresFornecedor, rotulo: string, extra?: { className?: string; inputMode?: "decimal" }) => (
    <Campo label={rotulo} className={extra?.className}>
      <input
        className={`${inputCls} ${erros[k] ? "!border-ouro bg-ouro/15" : ""}`}
        aria-invalid={erros[k] ? true : undefined}
        inputMode={extra?.inputMode}
        value={v[k] as string}
        onChange={(e) => mudar(k, e.target.value as never)}
      />
      {erros[k] && <span className="mt-1 block text-[12px] text-texto">{erros[k]}</span>}
    </Campo>
  );

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title={id ? "Editar fornecedor" : "Novo fornecedor"}
        subtitle="As condições padrão preenchem a linha da cotação e podem ser alteradas caso a caso."
        right={
          <div className="flex flex-wrap gap-2">
            <Link
              href="/fornecedores"
              className="inline-flex items-center rounded-[5px] border border-[#C9CDD1] px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde"
            >
              Cancelar
            </Link>
            {podeExcluir && (
              <Botao variante="secundario" onClick={excluir} disabled={pendente}>Excluir</Botao>
            )}
            <Botao onClick={salvar} disabled={pendente}>Salvar fornecedor</Botao>
          </div>
        }
      />
      {msg && (
        <p role="status" className="mb-5 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          {msg}
        </p>
      )}
      <div className="space-y-5">
        <Card className="pb-6">
          <CardHeader title="Dados do fornecedor" />
          <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
            {texto("nome", "Nome", { className: "sm:col-span-2" })}
            {texto("cidade", "Cidade")}
            <div className="sm:col-span-2 lg:col-span-3">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Tipos de serviço</span>
              <div className="flex flex-wrap gap-x-5 gap-y-2" role="group" aria-label="Tipos de serviço">
                {TIPOS_SERVICO.map((t) => (
                  <label key={t} className="inline-flex cursor-pointer items-center gap-2 text-[14px] text-texto">
                    <input type="checkbox" checked={v.tipos.includes(t)} onChange={() => alternarTipo(t)} className="accent-verde" />
                    {t}
                  </label>
                ))}
              </div>
              {erros.tipos && <span className="mt-1 block text-[12px] text-texto">{erros.tipos}</span>}
            </div>
          </div>
        </Card>

        <Card className="pb-6">
          <CardHeader title="Contatos" eyebrow="O contato do plantão aparece no daily interno de cada dia de viagem." />
          <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
            {texto("contatoNome", "Contato comercial")}
            {texto("contatoEmail", "E-mail")}
            {texto("contatoTelefone", "Telefone")}
            {texto("plantao", "Plantão (contato e horário)", { className: "sm:col-span-2 lg:col-span-3" })}
          </div>
        </Card>

        <Card className="pb-6">
          <CardHeader title="Condições padrão" />
          <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-4">
            <Campo label="Modalidade">
              <Select value={v.modalidade} onChange={(x) => mudar("modalidade", x as Modalidade)} className="w-full">
                {MODALIDADES.map((m) => <option key={m} value={m}>{ROTULO_MODALIDADE[m]}</option>)}
              </Select>
            </Campo>
            {texto("comissaoPct", "Comissão padrão (%)", { inputMode: "decimal" })}
            {texto("tarifaFixa", "Tarifa fixa do serviço (R$)", { inputMode: "decimal" })}
            {texto("descontoAVista", "Desconto à vista")}
            {texto("operacaoFinanceiraOperadora", "Operação financeira pela operadora", { className: "lg:col-span-2" })}
          </div>
        </Card>

        <Card className="pb-6">
          <CardHeader title="Observações" />
          <div className="mt-4 px-6">
            <textarea
              rows={3}
              aria-label="Observações"
              className={inputCls}
              value={v.observacoes}
              onChange={(e) => mudar("observacoes", e.target.value)}
            />
            {erros.observacoes && <span className="mt-1 block text-[12px] text-texto">{erros.observacoes}</span>}
          </div>
        </Card>
      </div>
    </div>
  );
}
