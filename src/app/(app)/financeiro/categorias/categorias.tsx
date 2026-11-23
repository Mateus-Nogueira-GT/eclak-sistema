"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { Botao, Campo, Card, CardHeader, Eyebrow, Tabs, cx, inputCls } from "@/components/ui";
import type { Lado } from "@/domain/financeiro";
import { alternarCategoria, salvarCategoria } from "@/server/actions/financeiro";
import type { CategoriaItem, GrupoCategorias } from "@/server/queries/financeiro";

function Linha({ lado, grupo, c, avisar }: { lado: Lado; grupo: string; c: CategoriaItem; avisar: (m: string | null) => void }) {
  const router = useRouter();
  const [nome, setNome] = useState(c.nome);
  const [pendente, iniciar] = useTransition();

  function renomear() {
    const novo = nome.trim();
    if (novo === c.nome) return;
    avisar(null);
    iniciar(async () => {
      const r = await salvarCategoria({ lado, grupo, nome: novo }, c.id);
      if (r.ok) router.refresh();
      else {
        setNome(c.nome);
        avisar(r.erro);
      }
    });
  }

  function alternar() {
    avisar(null);
    iniciar(async () => {
      const r = await alternarCategoria(c.id, !c.ativa);
      if (r.ok) router.refresh();
      else avisar(r.erro);
    });
  }

  return (
    <li className="flex items-center gap-3 py-2">
      <input
        value={nome}
        onChange={(e) => setNome(e.target.value)}
        onBlur={renomear}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        disabled={pendente}
        aria-label="Nome da categoria"
        className={cx("min-w-0 flex-1 rounded-[5px] border border-transparent bg-transparent px-2 py-1 text-[14px] outline-none hover:border-linha focus:border-verde", !c.ativa && "text-cinza line-through")}
      />
      {c.sistema && <span className="shrink-0 text-[12px] font-semibold text-cinza">{c.sistema === "cartao_corporativo" ? "Usada pelo cartão corporativo" : "Usada pelas viagens"}</span>}
      <span className="num shrink-0 text-[12.5px] text-cinza">
        {c.usos} {c.usos === 1 ? "lançamento" : "lançamentos"}
      </span>
      {!c.sistema && (
        <button onClick={alternar} disabled={pendente} className="shrink-0 cursor-pointer text-[13px] font-semibold text-verde hover:underline">
          {c.ativa ? "Desativar" : "Reativar"}
        </button>
      )}
    </li>
  );
}

export function Categorias({ grupos }: { grupos: GrupoCategorias[] }) {
  const router = useRouter();
  const [lado, setLado] = useState<Lado>("pagar");
  const [nova, setNova] = useState("");
  const [grupo, setGrupo] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();
  const doLado = grupos.filter((g) => g.lado === lado);

  function adicionar() {
    setMsg(null);
    iniciar(async () => {
      const r = await salvarCategoria({ lado, grupo, nome: nova });
      if (r.ok) {
        setNova("");
        router.refresh();
      } else setMsg("campos" in r && r.campos ? Object.values(r.campos)[0] : r.erro);
    });
  }

  return (
    <Card>
      <CardHeader
        title="Categorias financeiras"
        eyebrow="Crie, renomeie e desative quando precisar. Categoria com lançamentos não é apagada: fica desativada e some dos novos lançamentos."
        right={
          <Tabs
            value={lado}
            onChange={(v) => {
              setLado(v);
              setGrupo("");
              setMsg(null);
            }}
            options={[
              { value: "pagar", label: "De contas a pagar" },
              { value: "receber", label: "De contas a receber" },
            ]}
          />
        }
      />
      <div className="mt-4 flex flex-wrap items-end gap-3 border-y border-linha bg-fundo px-6 py-4">
        <Campo label="Nova categoria" className="min-w-[220px] flex-1">
          <input value={nova} onChange={(e) => setNova(e.target.value)} placeholder="ex.: Marketing" className={inputCls} />
        </Campo>
        <Campo label="Grupo" className="min-w-[200px]">
          <select value={grupo} onChange={(e) => setGrupo(e.target.value)} className={inputCls}>
            <option value="">Escolha o grupo</option>
            {doLado.map((g) => (
              <option key={g.grupo}>{g.grupo}</option>
            ))}
          </select>
        </Campo>
        <Botao disabled={pendente || nova.trim().length < 3 || !grupo} onClick={adicionar}>
          <Plus size={16} /> Adicionar
        </Botao>
      </div>
      {msg && (
        <p role="status" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          {msg}
        </p>
      )}
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 px-6 py-5 md:grid-cols-2">
        {doLado.map((g) => (
          <div key={g.grupo}>
            <Eyebrow className="!text-verde">{g.grupo}</Eyebrow>
            <ul className="mt-2 divide-y divide-linha">
              {g.categorias.map((c) => (
                <Linha key={c.id} lado={lado} grupo={g.grupo} c={c} avisar={setMsg} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
