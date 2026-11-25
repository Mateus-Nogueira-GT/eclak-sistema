"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Paperclip, Plus, Search, X } from "lucide-react";
import { Anexos } from "@/components/anexos";
import { Badge, Botao, Campo, Card, Eyebrow, Select, cx, inputCls } from "@/components/ui";
import { formatarReais } from "@/domain/dinheiro";
import { NOTAS_POR_PAGINA, type FiltroNotas } from "@/domain/notas-fiscais";
import { formatarDocumento } from "@/domain/venda";
import { cancelarNotaFiscal, criarNotaFiscal, editarNotaFiscal } from "@/server/actions/notas-fiscais";
import type { AnexoItem } from "@/server/queries/anexos";
import type { ListaNotasFiscais, OpcaoViagem } from "@/server/queries/notas-fiscais";
import type { notasFiscais } from "@/server/db/schema";
import { useAcao } from "../../viagens/[id]/acao";
import { dataBr, reaisParaCampo } from "../../viagens/formatos";
import { ErroAcao, marca } from "../lancamentos/baixa";

type Nota = typeof notasFiscais.$inferSelect;
type Opcao = { id: string; nome: string };

const BASE = "/financeiro/notas-fiscais";

/** URL da lista com o filtro alterado (a página volta a 1, salvo quando a mudança é a própria página). */
function urlDe(f: FiltroNotas, mudar: Record<string, string | number | undefined>): string {
  const v: Record<string, string | number | undefined> = { ...f, pagina: 1, ...mudar };
  const q = new URLSearchParams();
  for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== "" && !(k === "pagina" && x === 1)) q.set(k, String(x));
  const s = q.toString();
  return s ? `${BASE}?${s}` : BASE;
}

function somarDias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}
function mes(hoje: string, deslocamento: number): [string, string] {
  const [a, m] = hoje.split("-").map(Number);
  return [new Date(Date.UTC(a, m - 1 + deslocamento, 1)).toISOString().slice(0, 10), new Date(Date.UTC(a, m + deslocamento, 0)).toISOString().slice(0, 10)];
}
function periodos(hoje: string): { id: string; rotulo: string; de: string; ate: string }[] {
  const ano = hoje.slice(0, 4);
  const p = (id: string, rotulo: string, [de, ate]: [string, string]) => ({ id, rotulo, de, ate });
  return [
    p("mes", "Este mês", mes(hoje, 0)),
    p("anterior", "Mês passado", mes(hoje, -1)),
    p("ult30", "Últimos 30 dias", [somarDias(hoje, -29), hoje]),
    p("ult90", "Últimos 90 dias", [somarDias(hoje, -89), hoje]),
    p("ano", "Este ano", [`${ano}-01-01`, `${ano}-12-31`]),
    p("tudo", "Mostrar tudo", ["2000-01-01", "2099-12-31"]),
  ];
}

export function NotasFiscais({
  filtro: f,
  hoje,
  lista,
  edicao,
  nova,
  anexos,
  fornecedores,
  clientes,
  viagens,
}: {
  filtro: FiltroNotas;
  hoje: string;
  lista: ListaNotasFiscais;
  edicao: Nota | null;
  nova: boolean;
  anexos: AnexoItem[];
  fornecedores: Opcao[];
  clientes: Opcao[];
  viagens: OpcaoViagem[];
}) {
  const router = useRouter();
  const [busca, setBusca] = useState(f.destinatario ?? "");
  const ir = (mudar: Record<string, string | number | undefined>) => router.push(urlDe(f, mudar));
  const opcoes = periodos(hoje);
  const periodoAtual = opcoes.find((x) => x.de === f.de && x.ate === f.ate)?.id ?? "personalizado";
  const ultimaPagina = Math.max(1, Math.ceil(lista.totalLinhas / NOTAS_POR_PAGINA));
  const primeira = (f.pagina - 1) * NOTAS_POR_PAGINA + 1;
  const ultima = Math.min(f.pagina * NOTAS_POR_PAGINA, lista.totalLinhas);
  const canceladas = lista.totalLinhas - lista.emitidas;
  const fechar = () => router.push(urlDe(f, { pagina: f.pagina }));

  return (
    <div>
      <div className="mb-5 grid grid-cols-[1fr_1fr_auto] items-stretch gap-3">
        <Card className="p-4">
          <Eyebrow>Notas emitidas no período</Eyebrow>
          <p className="num mt-1 text-[21px] font-bold text-verde">{lista.emitidas}</p>
          <p className="text-[12.5px] text-cinza">{canceladas > 0 ? `mais ${canceladas} ${canceladas === 1 ? "cancelada" : "canceladas"}, fora da soma` : "pela data de emissão"}</p>
        </Card>
        <Card className="p-4">
          <Eyebrow>Valor das notas emitidas</Eyebrow>
          <p className="num mt-1 text-[21px] font-bold text-verde">{formatarReais(lista.total)}</p>
          <p className="text-[12.5px] text-cinza">soma do período, sem as canceladas</p>
        </Card>
        <div className="flex items-end">
          <Botao onClick={() => router.push(urlDe(f, { pagina: f.pagina, nova: 1 }))}>
            <Plus size={16} /> Nova nota
          </Botao>
        </div>
      </div>

      <Card>
        <form
          className="flex flex-wrap items-end gap-3 px-5 pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            ir({ destinatario: busca.trim() || undefined });
          }}
        >
          <label className="relative min-w-[240px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-cinza" />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} aria-label="Destinatário" placeholder="Nome de quem recebeu a nota" className={cx(inputCls, "pl-9")} />
          </label>
          <Select
            value={periodoAtual}
            onChange={(id) => {
              const x = opcoes.find((y) => y.id === id);
              if (x) ir({ de: x.de, ate: x.ate });
            }}
          >
            {opcoes.map((x) => (
              <option key={x.id} value={x.id}>{x.rotulo}</option>
            ))}
            <option value="personalizado" disabled>Personalizado</option>
          </Select>
          <input type="date" aria-label="De" className={cx(inputCls, "!w-[150px]")} value={f.de} onChange={(e) => e.target.value && ir({ de: e.target.value })} />
          <input type="date" aria-label="Até" className={cx(inputCls, "!w-[150px]")} value={f.ate} onChange={(e) => e.target.value && ir({ ate: e.target.value })} />
          {f.destinatario && (
            <button type="button" className="cursor-pointer py-2 text-[13px] font-semibold text-verde hover:underline" onClick={() => { setBusca(""); ir({ destinatario: undefined }); }}>
              Limpar busca
            </button>
          )}
        </form>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr>
                {["Emissão", "Número", "Destinatário", "CPF ou CNPJ", "Valor (R$)", "PDF", "Situação"].map((h, i) => (
                  <th key={h} className={cx("whitespace-nowrap border-y border-linha bg-fundo px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.05em] text-verde", i === 4 ? "text-right" : "text-left")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lista.linhas.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-10 text-center text-[14px] text-cinza">
                    {f.destinatario ? "Nenhuma nota deste destinatário no período." : "Nenhuma nota no período."}
                  </td>
                </tr>
              )}
              {lista.linhas.map((n) => {
                const cancelada = n.status === "cancelada";
                return (
                  <tr key={n.id} className="cursor-pointer border-b border-linha last:border-0 hover:bg-fundo/70" onClick={() => router.push(urlDe(f, { pagina: f.pagina, editar: n.id }))}>
                    <td className="num whitespace-nowrap px-3 py-3">{dataBr(n.emitidaEm)}</td>
                    <td className="num whitespace-nowrap px-3 py-3 font-semibold">
                      <button className="cursor-pointer font-semibold text-verde hover:underline" onClick={(e) => { e.stopPropagation(); router.push(urlDe(f, { pagina: f.pagina, editar: n.id })); }}>
                        {n.numero}
                      </button>
                    </td>
                    <td className={cx("min-w-[220px] px-3 py-3", cancelada && "text-cinza line-through")}>
                      <b className="font-semibold">{n.destinatario}</b>
                    </td>
                    <td className="num whitespace-nowrap px-3 py-3 text-[13px] text-cinza">{n.documento ? formatarDocumento(n.documento) : "—"}</td>
                    <td className={cx("num whitespace-nowrap px-3 py-3 text-right font-semibold", cancelada && "text-cinza line-through")}>{reaisParaCampo(n.valor)}</td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <span className={cx("inline-flex items-center gap-1 text-[13px] font-semibold", n.anexos > 0 ? "text-verde" : "text-[#A7A9AC]")}>
                        <Paperclip size={14} aria-hidden /> {n.anexos > 0 ? n.anexos : "sem PDF"}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      {cancelada ? <Badge tom="ouro">Cancelada</Badge> : <Badge tom="agua">Emitida</Badge>}
                      {cancelada && n.motivoCancelamento && <span className="block max-w-[220px] truncate text-[12px] text-cinza" title={n.motivoCancelamento}>{n.motivoCancelamento}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {lista.totalLinhas > 0 && (
          <div className="flex items-center justify-between px-5 py-4 text-[13px] text-cinza">
            <span>{primeira}–{ultima} de {lista.totalLinhas}</span>
            <div className="flex items-center gap-2">
              <Botao variante="secundario" className="!px-3 !py-1.5 !text-[13px]" disabled={f.pagina <= 1} onClick={() => ir({ pagina: f.pagina - 1 })}>Anterior</Botao>
              <span>Página {f.pagina} de {ultimaPagina}</span>
              <Botao variante="secundario" className="!px-3 !py-1.5 !text-[13px]" disabled={f.pagina >= ultimaPagina} onClick={() => ir({ pagina: f.pagina + 1 })}>Próxima</Botao>
            </div>
          </div>
        )}
      </Card>

      {(nova || edicao) && (
        <PainelNota
          key={edicao?.id ?? "nova"}
          nota={edicao}
          hoje={hoje}
          anexos={anexos}
          fornecedores={fornecedores}
          clientes={clientes}
          viagens={viagens}
          onFechar={fechar}
          onSalva={(id) => router.push(urlDe(f, { pagina: f.pagina, editar: id }))}
        />
      )}
    </div>
  );
}

type Vinculo = string; // "" | "f:<id>" | "c:<id>"

/** Painel lateral: dados da nota e o PDF. Nota nova salva primeiro; o PDF se anexa depois (já na nota salva). */
function PainelNota({
  nota: n,
  hoje,
  anexos,
  fornecedores,
  clientes,
  viagens,
  onFechar,
  onSalva,
}: {
  nota: Nota | null;
  hoje: string;
  anexos: AnexoItem[];
  fornecedores: Opcao[];
  clientes: Opcao[];
  viagens: OpcaoViagem[];
  onFechar: () => void;
  onSalva: (id: string) => void;
}) {
  const acao = useAcao();
  const cancelada = n?.status === "cancelada";
  const [numero, setNumero] = useState(n?.numero ?? "");
  const [emitidaEm, setEmitidaEm] = useState(n?.emitidaEm ?? hoje);
  const [competencia, setCompetencia] = useState(n?.competencia ?? hoje.slice(0, 7));
  const [valor, setValor] = useState(n ? reaisParaCampo(n.valor) : "");
  const [destinatario, setDestinatario] = useState(n?.destinatario ?? "");
  const [documento, setDocumento] = useState(n?.documento ? formatarDocumento(n.documento) : "");
  const [vinculo, setVinculo] = useState<Vinculo>(n?.fornecedorId ? `f:${n.fornecedorId}` : n?.clienteId ? `c:${n.clienteId}` : "");
  const [viagemId, setViagemId] = useState(n?.viagemId ?? "");
  const [observacao, setObservacao] = useState(n?.observacao ?? "");
  const [cancelando, setCancelando] = useState(false);
  const [motivo, setMotivo] = useState("");

  const dados = () => ({
    numero,
    emitidaEm,
    competencia,
    valor,
    destinatario,
    documento,
    fornecedorId: vinculo.startsWith("f:") ? vinculo.slice(2) : "",
    clienteId: vinculo.startsWith("c:") ? vinculo.slice(2) : "",
    viagemId,
    observacao,
  });

  function escolherVinculo(v: Vinculo) {
    setVinculo(v);
    // Sugere o nome do vínculo quando o destinatário ainda está vazio.
    const nome = v.startsWith("f:") ? fornecedores.find((x) => x.id === v.slice(2))?.nome : v.startsWith("c:") ? clientes.find((x) => x.id === v.slice(2))?.nome : undefined;
    if (nome && !destinatario.trim()) setDestinatario(nome);
  }

  function salvar() {
    let id = n?.id;
    acao.executar(
      async () => {
        const r = n ? await editarNotaFiscal(n.id, dados()) : await criarNotaFiscal(dados());
        if (r.ok && "id" in r && r.id) id = r.id;
        return r;
      },
      () => (n ? onFechar() : id && onSalva(id)),
    );
  }

  const desabilitado = Boolean(cancelada);
  const campo = (k: string) => cx(inputCls, marca(acao, k), desabilitado && "bg-fundo text-cinza");
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-texto/40" onClick={onFechar}>
      <aside role="dialog" aria-label={n ? `Nota ${n.numero}` : "Nova nota fiscal"} className="flex h-full w-full max-w-[600px] flex-col bg-white shadow-[0_0_48px_rgba(51,49,50,0.22)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-linha px-6 py-4">
          <div>
            <Eyebrow>{n ? (cancelada ? "Nota fiscal · cancelada" : "Nota fiscal") : "Nova nota fiscal"}</Eyebrow>
            <h2 className="mt-0.5 text-[18px] font-bold text-texto">{n ? `Nota ${n.numero}` : "Dados da nota"}</h2>
          </div>
          <button onClick={onFechar} aria-label="Fechar" className="cursor-pointer rounded-[5px] p-2 text-cinza hover:bg-fundo">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {cancelada && n && (
            <p className="mb-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
              Nota cancelada. Motivo: {n.motivoCancelamento}. O número já pode ser usado por outra nota.
            </p>
          )}
          <div className="grid grid-cols-4 gap-4">
            <Campo label="Número da nota" className="col-span-2">
              <input className={campo("numero")} value={numero} disabled={desabilitado} onChange={(e) => setNumero(e.target.value)} />
            </Campo>
            <Campo label="Valor (R$)" className="col-span-2">
              <input className={cx(campo("valor"), "num text-right")} inputMode="decimal" value={valor} disabled={desabilitado} onChange={(e) => setValor(e.target.value)} placeholder="0,00" />
            </Campo>
            <Campo label="Data de emissão" className="col-span-2">
              <input type="date" className={campo("emitidaEm")} value={emitidaEm} disabled={desabilitado} onChange={(e) => setEmitidaEm(e.target.value)} />
            </Campo>
            <Campo label="Competência" className="col-span-2">
              <input type="month" className={campo("competencia")} value={competencia} disabled={desabilitado} onChange={(e) => setCompetencia(e.target.value)} />
            </Campo>
            <Campo label="Destinatário" className="col-span-4">
              <input className={campo("destinatario")} value={destinatario} disabled={desabilitado} onChange={(e) => setDestinatario(e.target.value)} />
            </Campo>
            <Campo label="CPF ou CNPJ (opcional)" className="col-span-2">
              <input className={cx(campo("documento"), "num")} inputMode="numeric" value={documento} disabled={desabilitado} onChange={(e) => setDocumento(e.target.value)} placeholder="Só números ou com pontuação" />
            </Campo>
            <Campo label="Ligada a (opcional)" className="col-span-2">
              <Select value={vinculo} onChange={escolherVinculo} disabled={desabilitado} className={cx("w-full", marca(acao, "fornecedorId"), marca(acao, "clienteId"))}>
                <option value="">Ninguém: só o nome</option>
                <optgroup label="Fornecedores">
                  {fornecedores.map((x) => (
                    <option key={x.id} value={`f:${x.id}`}>{x.nome}</option>
                  ))}
                </optgroup>
                <optgroup label="Clientes">
                  {clientes.map((x) => (
                    <option key={x.id} value={`c:${x.id}`}>{x.nome}</option>
                  ))}
                </optgroup>
              </Select>
            </Campo>
            <Campo label="Viagem (opcional)" className="col-span-4">
              <Select value={viagemId} onChange={setViagemId} disabled={desabilitado} className={cx("w-full", marca(acao, "viagemId"))}>
                <option value="">Nenhuma</option>
                {viagens.map((x) => (
                  <option key={x.id} value={x.id}>{x.rotulo}</option>
                ))}
              </Select>
            </Campo>
            <Campo label="Observação (opcional)" className="col-span-4">
              <textarea rows={2} className={campo("observacao")} value={observacao} disabled={desabilitado} onChange={(e) => setObservacao(e.target.value)} />
            </Campo>
          </div>
          <ErroAcao acao={acao} />

          <div className="mt-6 border-t border-linha pt-5">
            {n ? (
              <Anexos donoTipo="nota_fiscal" donoId={n.id} anexos={anexos} />
            ) : (
              <p className="rounded-[5px] border border-dashed border-linha px-4 py-4 text-[13px] text-cinza">Salve a nota para anexar o PDF dela.</p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-linha px-6 py-4">
          {cancelando && n ? (
            <div className="flex w-full flex-wrap items-end gap-3">
              <Campo label="Motivo do cancelamento" className="min-w-[200px] flex-1">
                <input autoFocus className={`${inputCls} ${marca(acao, "motivo")}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: emitida em duplicidade" />
              </Campo>
              <Botao variante="secundario" onClick={() => setCancelando(false)}>Voltar</Botao>
              <Botao disabled={acao.pendente} onClick={() => acao.executar(() => cancelarNotaFiscal(n.id, motivo), onFechar)}>Cancelar nota</Botao>
            </div>
          ) : (
            <>
              {n && !cancelada && (
                <Botao variante="fantasma" className="mr-auto" onClick={() => setCancelando(true)}>Cancelar nota</Botao>
              )}
              <Botao variante="secundario" onClick={onFechar}>Fechar</Botao>
              {!cancelada && <Botao disabled={acao.pendente} onClick={salvar}>{n ? "Salvar alterações" : "Salvar nota"}</Botao>}
            </>
          )}
        </div>
      </aside>
    </div>
  );
}
