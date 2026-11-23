"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Botao, Campo, Card, CardHeader, inputCls } from "@/components/ui";
import { alterarOrcamento, criarOrcamento } from "@/server/actions/viagens";

export type PessoaOpcao = { id: string; nome: string; detalhe: string };
export type ValoresOrcamento = { destino: string; inicio: string; fim: string; observacoes: string; passageiros: string[] };

const MSG_REMOVIDOS = "Remova do orçamento os passageiros que saíram do cadastro antes de salvar";

/**
 * Cabeçalho do orçamento: destino, datas, passageiros e observações. Sem `id` cria o orçamento do cliente;
 * com `id` edita (o `atualizadoEm` evita sobrescrever alteração de outra pessoa).
 */
export function FormularioOrcamento({
  clienteId,
  pessoas,
  removidos = [],
  inicial,
  id,
  atualizadoEm,
  onFechar,
}: {
  clienteId: string;
  /** Pessoas ativas do cliente. */
  pessoas: PessoaOpcao[];
  /** Passageiros que já saíram do cadastro do cliente (só na edição). */
  removidos?: { id: string; nome: string }[];
  inicial: ValoresOrcamento;
  id?: string;
  atualizadoEm?: string;
  /** Fecha o painel de edição (só na edição). */
  onFechar?: () => void;
}) {
  const router = useRouter();
  const [v, setV] = useState<ValoresOrcamento>(inicial);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [conflito, setConflito] = useState(false);
  const [pendente, iniciar] = useTransition();

  const idsRemovidos = new Set(removidos.map((r) => r.id));
  const removidosMarcados = v.passageiros.filter((p) => idsRemovidos.has(p));

  function mudar<K extends keyof ValoresOrcamento>(k: K, valor: ValoresOrcamento[K]) {
    setV((x) => ({ ...x, [k]: valor }));
    setErros((e) => {
      if (!(k in e)) return e;
      const r = { ...e };
      delete r[k];
      return r;
    });
  }

  function alternar(pessoaId: string) {
    mudar("passageiros", v.passageiros.includes(pessoaId) ? v.passageiros.filter((x) => x !== pessoaId) : [...v.passageiros, pessoaId]);
  }

  function salvar() {
    setMsg(null);
    setConflito(false);
    if (removidosMarcados.length > 0) {
      setErros({ passageiros: MSG_REMOVIDOS });
      setMsg(MSG_REMOVIDOS);
      return;
    }
    const dados = { destino: v.destino, inicio: v.inicio, fim: v.fim, passageiros: v.passageiros, observacoes: v.observacoes.trim() || null };
    iniciar(async () => {
      const r = id ? await alterarOrcamento(id, dados, atualizadoEm ?? "") : await criarOrcamento({ ...dados, clienteId });
      if (r.ok) {
        if (id) {
          onFechar?.();
          router.refresh();
        } else if ("id" in r) {
          router.push(`/viagens/${r.id}`);
          router.refresh();
        }
      } else {
        setErros("campos" in r && r.campos ? r.campos : {});
        setConflito("conflito" in r && r.conflito === true);
        setMsg("campos" in r && r.campos ? "Corrija os campos indicados" : r.erro);
      }
    });
  }

  const marca = (k: string) => (erros[k] ? "!border-ouro bg-ouro/15" : "");
  const erro = (k: string) => (erros[k] ? <span className="mt-1 block text-[12px] text-texto">{erros[k]}</span> : null);

  return (
    <Card className="pb-6">
      <CardHeader title={id ? "Alterar viagem" : "Dados da viagem"} eyebrow="Destino, datas e quem viaja. A taxa de serviço usa os dias da viagem." />
      {msg && (
        <div role="alert" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          <p className={conflito ? "font-semibold" : undefined}>{msg}</p>
          {conflito && id && (
            <button type="button" onClick={() => router.refresh()} className="mt-1 cursor-pointer font-semibold text-verde underline">
              Recarregar
            </button>
          )}
        </div>
      )}
      <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-4">
        <Campo label="Destino" className="lg:col-span-2">
          <input className={`${inputCls} ${marca("destino")}`} value={v.destino} aria-invalid={erros.destino ? true : undefined} onChange={(e) => mudar("destino", e.target.value)} placeholder="Ex.: Itália" />
          {erro("destino")}
        </Campo>
        <Campo label="Ida">
          <input type="date" className={`${inputCls} ${marca("inicio")}`} value={v.inicio} aria-invalid={erros.inicio ? true : undefined} onChange={(e) => mudar("inicio", e.target.value)} />
          {erro("inicio")}
        </Campo>
        <Campo label="Volta">
          <input type="date" className={`${inputCls} ${marca("fim")}`} value={v.fim} aria-invalid={erros.fim ? true : undefined} onChange={(e) => mudar("fim", e.target.value)} />
          {erro("fim")}
        </Campo>
      </div>

      <fieldset className="mx-6 mt-5">
        <legend className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Passageiros</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {removidos.map((r) => (
            <label key={r.id} className={`flex cursor-pointer items-start gap-2.5 rounded-[5px] border px-3 py-2.5 text-[14px] ${v.passageiros.includes(r.id) ? "border-ouro bg-ouro/15" : "border-linha"}`}>
              <input type="checkbox" className="mt-1" checked={v.passageiros.includes(r.id)} onChange={() => alternar(r.id)} />
              <span>
                <span className="block font-semibold">{r.nome}</span>
                <span className="block text-[12px] text-cinza">Removido do cadastro. Desmarque para tirar do orçamento.</span>
              </span>
            </label>
          ))}
          {pessoas.map((p) => (
            <label key={p.id} className="flex cursor-pointer items-start gap-2.5 rounded-[5px] border border-linha px-3 py-2.5 text-[14px] hover:bg-fundo">
              <input type="checkbox" className="mt-1" checked={v.passageiros.includes(p.id)} onChange={() => alternar(p.id)} />
              <span>
                <span className="block font-semibold">{p.nome}</span>
                <span className="block text-[12px] text-cinza">{p.detalhe}</span>
              </span>
            </label>
          ))}
        </div>
        {erro("passageiros")}
      </fieldset>

      <div className="mt-5 px-6">
        <Campo label="Observações">
          <textarea rows={3} className={`${inputCls} ${marca("observacoes")}`} value={v.observacoes} onChange={(e) => mudar("observacoes", e.target.value)} />
          {erro("observacoes")}
        </Campo>
      </div>

      <div className="mt-5 flex flex-wrap gap-2 px-6">
        <Botao onClick={salvar} disabled={pendente}>{id ? "Salvar alterações" : "Criar orçamento"}</Botao>
        {id ? (
          <Botao variante="fantasma" onClick={onFechar} disabled={pendente}>Cancelar</Botao>
        ) : (
          <Link href={`/clientes/${clienteId}`} className="inline-flex items-center rounded-[5px] border border-[#C9CDD1] px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde">
            Cancelar
          </Link>
        )}
      </div>
    </Card>
  );
}
