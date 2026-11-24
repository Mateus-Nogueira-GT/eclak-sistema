"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil, Plus, Printer, Trash2 } from "lucide-react";
import { Badge, Botao, Campo, Card, cx, inputCls, Tabs } from "@/components/ui";
import { rotuloDiaRoteiro } from "@/domain/roteiro";
import { CATEGORIAS_TAREFA, ROTULO_CATEGORIA, type CategoriaTarefa, type TarefaEntrada } from "@/domain/tarefas";
import {
  concluirTarefa,
  criarTarefa,
  criarTarefasDaVenda,
  desfazerConclusao,
  editarTarefa,
  excluirTarefa,
} from "@/server/actions/tarefas";
import type { TarefaLinha } from "@/server/queries/operacao";
import { nomeDoResponsavel, rotuloDia, SUBTITULO_TAREFAS } from "./formatos";

type Usuario = { id: string; nome: string };

type Aviso = { msg: string; conflito: boolean } | null;

export function TarefasDaViagem({
  viagemId,
  tarefas,
  temDaVenda,
  usuarios,
  datas,
}: {
  viagemId: string;
  tarefas: TarefaLinha[];
  temDaVenda: boolean;
  usuarios: Usuario[];
  datas: string[];
}) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [aba, setAba] = useState<"todas" | "abertas">("todas");
  const [formulario, setFormulario] = useState<{ tarefa: TarefaLinha | null } | null>(null);
  const [aviso, setAviso] = useState<Aviso>(null);

  const concluidas = tarefas.filter((t) => t.concluidaEm !== null).length;
  const visiveis = aba === "abertas" ? tarefas.filter((t) => t.concluidaEm === null) : tarefas;
  const pct = tarefas.length === 0 ? 0 : Math.round((concluidas / tarefas.length) * 100);

  function rodar(fn: () => Promise<{ ok: true } | { ok: false; erro: string; conflito?: true }>) {
    setAviso(null);
    iniciar(async () => {
      const r = await fn();
      if (!r.ok) setAviso({ msg: r.erro, conflito: r.conflito === true });
      router.refresh();
    });
  }

  function criarDaVenda() {
    setAviso(null);
    iniciar(async () => {
      const r = await criarTarefasDaVenda(viagemId);
      if (!r.ok) setAviso({ msg: r.erro, conflito: false });
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h1 className="titulo text-[26px] leading-[1.1] text-texto">Tarefas da viagem</h1>
          <p className="mt-2 max-w-[80ch] text-[14.5px] leading-relaxed text-cinza">{SUBTITULO_TAREFAS}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!temDaVenda && (
            <Botao variante="secundario" onClick={criarDaVenda} disabled={pendente}>
              Criar as tarefas da venda
            </Botao>
          )}
          <Link
            href={`/viagens/${viagemId}/tarefas/imprimir`}
            className="inline-flex items-center gap-2 rounded-[5px] border border-[#C9CDD1] bg-white px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde"
          >
            <Printer size={15} /> Imprimir
          </Link>
          <Botao onClick={() => setFormulario({ tarefa: null })} disabled={pendente}>
            <Plus size={15} /> Nova tarefa
          </Botao>
        </div>
      </div>

      {aviso && (
        <div role="alert" className="mb-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          <p className={aviso.conflito ? "font-semibold" : undefined}>{aviso.msg}</p>
          {aviso.conflito && (
            <button type="button" onClick={() => { setAviso(null); router.refresh(); }} className="mt-1 cursor-pointer font-semibold text-verde underline">
              Recarregar
            </button>
          )}
        </div>
      )}

      {formulario && (
        <FormularioTarefa
          key={formulario.tarefa ? `${formulario.tarefa.id}:${formulario.tarefa.atualizadoEm}` : "nova"}
          viagemId={viagemId}
          tarefa={formulario.tarefa}
          usuarios={usuarios}
          datas={datas}
          onFechar={() => setFormulario(null)}
        />
      )}

      <Card className="mb-5 px-6 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[14px] text-texto">
            <span className="num font-bold text-verde">{concluidas}</span> de <span className="num font-bold">{tarefas.length}</span> tarefas concluídas
          </p>
          <span className="num text-[13px] text-cinza">{pct}%</span>
        </div>
        <div className="mt-2 h-[6px] w-full overflow-hidden rounded-full bg-linha" role="progressbar" aria-valuemin={0} aria-valuemax={tarefas.length} aria-valuenow={concluidas}>
          <div className="h-full rounded-full bg-verde" style={{ width: `${pct}%` }} />
        </div>
      </Card>

      <div className="mb-4">
        <Tabs
          value={aba}
          onChange={setAba}
          options={[
            { value: "todas", label: "Todas" },
            { value: "abertas", label: "Só as abertas" },
          ]}
        />
      </div>

      {tarefas.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="text-[15px] font-semibold text-texto">Nenhuma tarefa nesta viagem</p>
          <p className="mt-1 text-[14px] text-cinza">
            {temDaVenda ? "Use \"Nova tarefa\" para registrar o que a equipe precisa fazer." : "Crie as tarefas da venda ou registre uma nova tarefa."}
          </p>
        </Card>
      ) : visiveis.length === 0 ? (
        <Card className="px-6 py-10 text-center">
          <p className="text-[15px] font-semibold text-texto">Todas as tarefas estão concluídas</p>
        </Card>
      ) : (
        <div className="space-y-5">
          {CATEGORIAS_TAREFA.map((cat, i) => {
            const doGrupo = visiveis.filter((t) => t.categoria === cat);
            if (doGrupo.length === 0) return null;
            return (
              <CardCategoria
                key={cat}
                categoria={cat}
                destaque={i === 0}
                tarefas={doGrupo}
                pendente={pendente}
                onConcluir={(t) => rodar(() => (t.concluidaEm ? desfazerConclusao(t.id) : concluirTarefa(t.id)))}
                onEditar={(t) => { setAviso(null); setFormulario({ tarefa: t }); }}
                onExcluir={(t) => {
                  if (!window.confirm(`Excluir a tarefa "${t.item}"? Ela sai da lista, mas o histórico fica registrado.`)) return;
                  if (formulario?.tarefa?.id === t.id) setFormulario(null);
                  rodar(() => excluirTarefa(t.id));
                }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function CardCategoria({
  categoria,
  destaque,
  tarefas,
  pendente,
  onConcluir,
  onEditar,
  onExcluir,
}: {
  categoria: CategoriaTarefa;
  destaque: boolean;
  tarefas: TarefaLinha[];
  pendente: boolean;
  onConcluir: (t: TarefaLinha) => void;
  onEditar: (t: TarefaLinha) => void;
  onExcluir: (t: TarefaLinha) => void;
}) {
  return (
    <Card className={cx("overflow-hidden", destaque && "border-l-[3px] border-l-terracota")}>
      <div className="flex items-baseline justify-between gap-4 px-5 pb-3 pt-4">
        <h2 className="text-[15.5px] font-bold text-texto">{ROTULO_CATEGORIA[categoria]}</h2>
        <span className="num text-[13px] text-cinza">
          {tarefas.filter((t) => t.concluidaEm).length}/{tarefas.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-[14px]">
          <thead>
            <tr className="border-y border-linha bg-fundo text-left text-[11px] font-bold uppercase tracking-[0.06em] text-verde">
              <th className="w-[44px] px-3 py-2.5"><span className="sr-only">Concluída</span></th>
              <th className="w-[110px] px-3 py-2.5">Dia</th>
              <th className="px-3 py-2.5">Item</th>
              <th className="px-3 py-2.5">O que fazer</th>
              <th className="w-[190px] px-3 py-2.5">Prazo</th>
              <th className="w-[160px] px-3 py-2.5">Responsável</th>
              <th className="px-3 py-2.5">Observações</th>
              <th className="w-[84px] px-3 py-2.5"><span className="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody>
            {tarefas.map((t) => {
              const feita = t.concluidaEm !== null;
              return (
                <tr key={t.id} className={cx("border-b border-linha align-top last:border-b-0", feita && "text-cinza")}>
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={feita}
                      disabled={pendente}
                      onChange={() => onConcluir(t)}
                      aria-label={feita ? `Desfazer a conclusão de "${t.item}"` : `Concluir "${t.item}"`}
                      className="h-4 w-4 cursor-pointer accent-verde"
                    />
                  </td>
                  <td className={cx("num px-3 py-3 whitespace-nowrap", feita && "line-through")}>{rotuloDia(t.dia)}</td>
                  <td className={cx("px-3 py-3 font-medium", feita ? "line-through" : "text-texto")}>{t.item}</td>
                  <td className={cx("px-3 py-3 whitespace-pre-line", feita && "line-through")}>{t.fazer}</td>
                  <td className="px-3 py-3">
                    <span className={cx("num block", feita && "line-through")}>{t.rotuloPrazo}</span>
                    {t.situacao === "vencida" && <Badge tom="ouro" className="mt-1">Vencida</Badge>}
                    {t.situacao === "vence_hoje" && <Badge tom="ouro" className="mt-1">Vence hoje</Badge>}
                  </td>
                  <td className={cx("px-3 py-3", feita && "line-through")}>{nomeDoResponsavel(t.responsavel)}</td>
                  <td className="px-3 py-3">
                    {t.observacao && <span className={cx("block whitespace-pre-line", feita && "line-through")}>{t.observacao}</span>}
                    {feita && t.concluidaPor && (
                      <span className="mt-1 block text-[12.5px] text-cinza">Concluída por {t.concluidaPor}</span>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex justify-end gap-1">
                      <button type="button" onClick={() => onEditar(t)} disabled={pendente} title="Editar" aria-label={`Editar "${t.item}"`} className="cursor-pointer rounded-[4px] p-1.5 text-cinza hover:bg-verde/8 hover:text-verde disabled:cursor-not-allowed">
                        <Pencil size={15} />
                      </button>
                      <button type="button" onClick={() => onExcluir(t)} disabled={pendente} title="Excluir" aria-label={`Excluir "${t.item}"`} className="cursor-pointer rounded-[4px] p-1.5 text-cinza hover:bg-verde/8 hover:text-verde disabled:cursor-not-allowed">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Formulário (nova tarefa e edição)
// ---------------------------------------------------------------------------

type Form = {
  categoria: CategoriaTarefa;
  dia: string;
  item: string;
  fazer: string;
  prazoTipo: "sem" | "data" | "dias_antes";
  prazoData: string;
  prazoDias: string;
  /** "" = ninguém; "customer_care"; ou id do usuário. */
  responsavel: string;
  observacao: string;
};

function formDe(t: TarefaLinha | null): Form {
  return {
    categoria: t?.categoria ?? "ingressos",
    dia: t?.dia ?? "",
    item: t?.item ?? "",
    fazer: t?.fazer ?? "",
    prazoTipo: t?.prazo?.tipo ?? "sem",
    prazoData: t?.prazo?.tipo === "data" ? t.prazo.data : "",
    prazoDias: t?.prazo?.tipo === "dias_antes" ? String(t.prazo.dias) : "",
    responsavel: !t?.responsavel ? "" : t.responsavel.tipo === "customer_care" ? "customer_care" : t.responsavel.id,
    observacao: t?.observacao ?? "",
  };
}

function entradaDe(f: Form): TarefaEntrada {
  const dias = f.prazoDias.trim();
  return {
    categoria: f.categoria,
    dia: f.dia || null,
    item: f.item,
    fazer: f.fazer,
    prazo:
      f.prazoTipo === "data"
        ? { tipo: "data", data: f.prazoData }
        : f.prazoTipo === "dias_antes"
          ? { tipo: "dias_antes", dias: /^\d+$/.test(dias) ? Number(dias) : NaN }
          : null,
    responsavel: f.responsavel === "" ? null : f.responsavel === "customer_care" ? { tipo: "customer_care" } : { tipo: "usuario", id: f.responsavel },
    observacao: f.observacao,
  };
}

function FormularioTarefa({
  viagemId,
  tarefa,
  usuarios,
  datas,
  onFechar,
}: {
  viagemId: string;
  tarefa: TarefaLinha | null;
  usuarios: Usuario[];
  datas: string[];
  onFechar: () => void;
}) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [f, setF] = useState<Form>(() => formDe(tarefa));
  const [erros, setErros] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState<Aviso>(null);

  const mudar = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const erroDe = (...ks: string[]) => ks.map((k) => erros[k]).find(Boolean);
  const marca = (...ks: string[]) => (erroDe(...ks) ? "!border-ouro bg-ouro/15" : "");
  const erro = (...ks: string[]) => {
    const e = erroDe(...ks);
    return e ? <span className="mt-1 block text-[12px] text-texto">{e}</span> : null;
  };

  // Responsável atual inativo continua visível na lista (o servidor pede outro ao salvar).
  const atual = tarefa?.responsavel?.tipo === "usuario" ? tarefa.responsavel : null;
  const opcoes = atual && !usuarios.some((u) => u.id === atual.id) ? [...usuarios, { id: atual.id, nome: `${atual.nome} (inativo)` }] : usuarios;
  // Dia fora das datas atuais da viagem (datas mudaram) continua visível.
  const dias = f.dia && !datas.includes(f.dia) ? [f.dia, ...datas] : datas;

  function salvar() {
    setAviso(null);
    iniciar(async () => {
      const dados = entradaDe(f);
      const r = tarefa ? await editarTarefa(tarefa.id, dados, tarefa.atualizadoEm) : await criarTarefa(viagemId, dados);
      if (r.ok) {
        onFechar();
        router.refresh();
        return;
      }
      const campos = "campos" in r && r.campos ? r.campos : {};
      setErros(campos);
      setAviso({ msg: Object.keys(campos).length > 0 ? "Corrija os campos indicados" : r.erro, conflito: "conflito" in r && r.conflito === true });
    });
  }

  return (
    <Card className="mb-5 pb-5">
      <div className="flex items-start justify-between gap-4 px-6 pt-5">
        <div>
          <h2 className="text-[16px] font-bold text-texto">{tarefa ? "Editar tarefa" : "Nova tarefa"}</h2>
          {tarefa && tarefa.origem !== "manual" && (
            <p className="mt-0.5 text-[13px] text-cinza">Tarefa criada automaticamente {tarefa.origem === "venda" ? "na venda" : "na aprovação do roteiro"}.</p>
          )}
        </div>
      </div>
      {aviso && (
        <div role="alert" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          <p className={aviso.conflito ? "font-semibold" : undefined}>{aviso.msg}</p>
          {aviso.conflito && (
            <button type="button" onClick={() => { onFechar(); router.refresh(); }} className="mt-1 cursor-pointer font-semibold text-verde underline">
              Recarregar
            </button>
          )}
        </div>
      )}
      <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-4">
        <Campo label="Categoria" className="lg:col-span-2">
          <select className={`${inputCls} cursor-pointer ${marca("categoria")}`} value={f.categoria} onChange={(e) => mudar("categoria", e.target.value as CategoriaTarefa)}>
            {CATEGORIAS_TAREFA.map((c) => (
              <option key={c} value={c}>{ROTULO_CATEGORIA[c]}</option>
            ))}
          </select>
          {erro("categoria")}
        </Campo>
        <Campo label="Dia">
          <select className={`${inputCls} cursor-pointer ${marca("dia")}`} value={f.dia} onChange={(e) => mudar("dia", e.target.value)}>
            <option value="">Geral</option>
            {dias.map((d) => (
              <option key={d} value={d}>{rotuloDiaRoteiro(d)}</option>
            ))}
          </select>
          {erro("dia")}
        </Campo>
        <Campo label="Responsável">
          <select className={`${inputCls} cursor-pointer ${marca("responsavel", "responsavel.id")}`} value={f.responsavel} onChange={(e) => mudar("responsavel", e.target.value)}>
            <option value="">Ninguém</option>
            <option value="customer_care">Customer care</option>
            {opcoes.map((u) => (
              <option key={u.id} value={u.id}>{u.nome}</option>
            ))}
          </select>
          {erro("responsavel", "responsavel.id")}
        </Campo>
        <Campo label="Item" className="sm:col-span-2 lg:col-span-4">
          <input className={`${inputCls} ${marca("item")}`} value={f.item} maxLength={200} aria-invalid={erros.item ? true : undefined} onChange={(e) => mudar("item", e.target.value)} placeholder="Ex.: Trem Veneza > Florença" />
          {erro("item")}
        </Campo>
        <Campo label="O que fazer" className="sm:col-span-2">
          <textarea className={`${inputCls} min-h-[84px] ${marca("fazer")}`} value={f.fazer} maxLength={2000} onChange={(e) => mudar("fazer", e.target.value)} />
          {erro("fazer")}
        </Campo>
        <Campo label="Observações" className="sm:col-span-2">
          <textarea className={`${inputCls} min-h-[84px] ${marca("observacao")}`} value={f.observacao} maxLength={2000} onChange={(e) => mudar("observacao", e.target.value)} />
          {erro("observacao")}
        </Campo>
        <fieldset className="sm:col-span-2 lg:col-span-4">
          <legend className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Prazo</legend>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[14px] text-texto">
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input type="radio" name="prazo" className="accent-verde" checked={f.prazoTipo === "sem"} onChange={() => mudar("prazoTipo", "sem")} /> Sem prazo
            </label>
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input type="radio" name="prazo" className="accent-verde" checked={f.prazoTipo === "data"} onChange={() => mudar("prazoTipo", "data")} /> Até a data
            </label>
            {f.prazoTipo === "data" && (
              <input type="date" aria-label="Data do prazo" className={`${inputCls} !w-auto ${marca("prazo", "prazo.data")}`} value={f.prazoData} onChange={(e) => mudar("prazoData", e.target.value)} />
            )}
            <label className="inline-flex cursor-pointer items-center gap-2">
              <input type="radio" name="prazo" className="accent-verde" checked={f.prazoTipo === "dias_antes"} onChange={() => mudar("prazoTipo", "dias_antes")} /> Dias antes do embarque
            </label>
            {f.prazoTipo === "dias_antes" && (
              <span className="inline-flex items-center gap-2">
                <input inputMode="numeric" aria-label="Dias antes do embarque" className={`${inputCls} num !w-[84px] ${marca("prazo", "prazo.dias")}`} value={f.prazoDias} onChange={(e) => mudar("prazoDias", e.target.value)} />
                dias antes do embarque
              </span>
            )}
          </div>
          {erro("prazo", "prazo.data", "prazo.dias")}
        </fieldset>
      </div>
      <div className="mt-5 flex gap-2 px-6">
        <Botao onClick={salvar} disabled={pendente}>{tarefa ? "Salvar alterações" : "Criar tarefa"}</Botao>
        <Botao variante="secundario" onClick={onFechar} disabled={pendente}>Cancelar</Botao>
      </div>
    </Card>
  );
}
