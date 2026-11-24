"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Card, cx, inputCls, Select, Tabs } from "@/components/ui";
import { ROTULO_CATEGORIA } from "@/domain/tarefas";
import { concluirTarefa, desfazerConclusao } from "@/server/actions/tarefas";
import type { FiltroTarefas, TarefaDaLista } from "@/server/queries/operacao";
import { nomeDoResponsavel, rotuloDia } from "../viagens/[id]/tarefas/formatos";

function urlDe(f: FiltroTarefas): string {
  const q = new URLSearchParams();
  if (f.visao === "todas") q.set("visao", "todas");
  if (f.visao === "todas" && f.responsavel) q.set("responsavel", f.responsavel);
  if (f.situacao !== "abertas") q.set("situacao", f.situacao);
  if (f.viagem) q.set("viagem", f.viagem);
  const s = q.toString();
  return s ? `/tarefas?${s}` : "/tarefas";
}

const VAZIO: Record<FiltroTarefas["situacao"], string> = {
  abertas: "Nenhuma tarefa aberta",
  vencidas: "Nenhuma tarefa vencida",
  concluidas: "Nenhuma tarefa concluída",
};

export function ListaTarefas({
  filtro,
  linhas,
  usuarios,
  limite,
}: {
  filtro: FiltroTarefas;
  linhas: TarefaDaLista[];
  usuarios: { id: string; nome: string }[];
  limite: number;
}) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [busca, setBusca] = useState(filtro.viagem ?? "");
  const [erro, setErro] = useState<string | null>(null);

  const ir = (mudar: Partial<FiltroTarefas>) => router.push(urlDe({ ...filtro, ...mudar }));

  function alternar(t: TarefaDaLista) {
    setErro(null);
    iniciar(async () => {
      const r = t.concluidaEm ? await desfazerConclusao(t.id) : await concluirTarefa(t.id);
      if (!r.ok) setErro(r.erro);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-4">
        <Tabs
          value={filtro.visao}
          onChange={(visao) => ir({ visao, responsavel: undefined })}
          options={[
            { value: "minhas", label: "Minhas tarefas" },
            { value: "todas", label: "Todas" },
          ]}
        />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        {filtro.visao === "todas" && (
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Responsável</span>
            <Select value={filtro.responsavel ?? ""} onChange={(v) => ir({ responsavel: v || undefined })} className="min-w-[200px]">
              <option value="">Todos</option>
              <option value="customer_care">Customer care</option>
              <option value="ninguem">Sem responsável</option>
              {usuarios.map((u) => (
                <option key={u.id} value={u.id}>{u.nome}</option>
              ))}
            </Select>
          </label>
        )}
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Situação</span>
          <Select value={filtro.situacao} onChange={(v) => ir({ situacao: v as FiltroTarefas["situacao"] })} className="min-w-[160px]">
            <option value="abertas">Abertas</option>
            <option value="vencidas">Vencidas</option>
            <option value="concluidas">Concluídas</option>
          </Select>
        </label>
        <form
          className="block"
          onSubmit={(e) => {
            e.preventDefault();
            ir({ viagem: busca.trim() || undefined });
          }}
        >
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Viagem</span>
            <input
              className={`${inputCls} !w-[220px]`}
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              onBlur={() => { if ((busca.trim() || undefined) !== filtro.viagem) ir({ viagem: busca.trim() || undefined }); }}
              placeholder="Código, ex.: ECL-0001-01"
            />
          </label>
        </form>
      </div>

      {erro && (
        <p role="alert" className="mb-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">{erro}</p>
      )}

      <Card className="overflow-hidden">
        {linhas.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[15px] font-semibold text-texto">{VAZIO[filtro.situacao]}</p>
            <p className="mt-1 text-[14px] text-cinza">
              {filtro.visao === "minhas" ? "Aqui aparecem as tarefas em que você é o responsável." : "Mude os filtros para ver outras tarefas."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-linha bg-fundo text-left text-[11px] font-bold uppercase tracking-[0.06em] text-verde">
                  <th className="w-[44px] px-3 py-2.5"><span className="sr-only">Concluída</span></th>
                  <th className="w-[200px] px-3 py-2.5">Prazo</th>
                  <th className="px-3 py-2.5">Item</th>
                  <th className="w-[200px] px-3 py-2.5">Viagem</th>
                  <th className="px-3 py-2.5">Categoria</th>
                  <th className="w-[100px] px-3 py-2.5">Dia</th>
                  <th className="w-[170px] px-3 py-2.5">Responsável</th>
                </tr>
              </thead>
              <tbody>
                {linhas.map((t) => {
                  const feita = t.concluidaEm !== null;
                  return (
                    <tr key={t.id} className={cx("border-b border-linha align-top last:border-b-0", feita && "text-cinza")}>
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={feita}
                          disabled={pendente}
                          onChange={() => alternar(t)}
                          aria-label={feita ? `Desfazer a conclusão de "${t.item}"` : `Concluir "${t.item}"`}
                          className="h-4 w-4 cursor-pointer accent-verde"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <span className="num block">{t.rotuloPrazo}</span>
                        {t.situacao === "vencida" && <Badge tom="ouro" className="mt-1">Vencida</Badge>}
                        {t.situacao === "vence_hoje" && <Badge tom="ouro" className="mt-1">Vence hoje</Badge>}
                      </td>
                      <td className={cx("px-3 py-3 font-medium", feita ? "line-through" : "text-texto")}>
                        {t.item}
                        {t.fazer && <span className="mt-0.5 block text-[13px] font-normal text-cinza">{t.fazer}</span>}
                      </td>
                      <td className="px-3 py-3">
                        <Link href={`/viagens/${t.viagem.id}/tarefas`} className="num font-semibold text-verde hover:underline">
                          {t.viagem.codigo}
                        </Link>
                        <span className="block text-[13px] text-cinza">{t.viagem.destino}</span>
                      </td>
                      <td className="px-3 py-3 text-[13.5px]">{ROTULO_CATEGORIA[t.categoria]}</td>
                      <td className="num px-3 py-3 whitespace-nowrap">{rotuloDia(t.dia)}</td>
                      <td className="px-3 py-3">
                        {nomeDoResponsavel(t.responsavel)}
                        {feita && t.concluidaPor && <span className="mt-0.5 block text-[12.5px] text-cinza">Concluída por {t.concluidaPor}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {linhas.length >= limite && (
        <p className="mt-3 text-[13px] text-cinza">Mostrando as primeiras {limite} tarefas. Use os filtros para ver as demais.</p>
      )}
    </div>
  );
}
