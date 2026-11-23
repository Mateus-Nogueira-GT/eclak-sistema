"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, Search } from "lucide-react";
import { Badge, Botao, Card, Eyebrow, Select, Tabs, cx, inputCls } from "@/components/ui";
import { rotuloForma, rotuloSituacao, type Lado, type Origem, type Situacao } from "@/domain/financeiro";
import { motivoForaDoLote, type FiltroLancamentos } from "@/domain/financeiro-entrada";
import { formatarReais } from "@/domain/dinheiro";
import { baixarEmLote, desfazerBaixaLinha, desfazerRepasse } from "@/server/actions/financeiro";
import type { GrupoCategorias, LinhaLancamento, TotaisLancamentos } from "@/server/queries/financeiro";
import { MSG_FALHA } from "../../viagens/[id]/acao";
import { dataBr, reaisParaCampo } from "../../viagens/formatos";
import { CampoConta, DialogoBaixa, contaPadrao, type ContaOpcao } from "./baixa";
import { FormularioLancamento, type LancamentoForm, type Opcao } from "./formulario";

type Aba = FiltroLancamentos["lado"];
type Chave = `${Origem}:${string}`;
const chave = (l: { origem: Origem; id: string }): Chave => `${l.origem}:${l.id}`;

const BASE = "/financeiro/lancamentos";
const POR_PAGINA = 50;

/** URL da lista com o filtro alterado (página volta a 1, salvo quando a mudança é a própria página). */
function urlDe(f: FiltroLancamentos, mudar: Record<string, string | number | undefined>): string {
  const v: Record<string, string | number | undefined> = { ...f, pagina: 1, ...mudar };
  const q = new URLSearchParams();
  for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== "" && !(k === "pagina" && x === 1)) q.set(k, String(x));
  return `${BASE}?${q.toString()}`;
}

function somarDias(data: string, n: number): string {
  const [a, m, d] = data.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}
function mes(hoje: string, deslocamento: number): [string, string] {
  const [a, m] = hoje.split("-").map(Number);
  const ini = new Date(Date.UTC(a, m - 1 + deslocamento, 1)).toISOString().slice(0, 10);
  const fim = new Date(Date.UTC(a, m + deslocamento, 0)).toISOString().slice(0, 10);
  return [ini, fim];
}
function periodos(hoje: string): { id: string; rotulo: string; de: string; ate: string }[] {
  const ano = hoje.slice(0, 4);
  const p = (id: string, rotulo: string, [de, ate]: [string, string]) => ({ id, rotulo, de, ate });
  return [
    p("hoje", "Hoje", [hoje, hoje]),
    p("mes", "Este mês", mes(hoje, 0)),
    p("anterior", "Mês passado", mes(hoje, -1)),
    p("proximo", "Próximo mês", mes(hoje, 1)),
    p("prox30", "Próximos 30 dias", [hoje, somarDias(hoje, 30)]),
    p("ult30", "Últimos 30 dias", [somarDias(hoje, -30), hoje]),
    p("ano", "Este ano", [`${ano}-01-01`, `${ano}-12-31`]),
    p("tudo", "Mostrar tudo", ["2000-01-01", "2099-12-31"]),
  ];
}

const TOM: Record<Situacao, "ouro" | "verde" | "cinza" | "agua"> = { vencida: "ouro", vence_hoje: "verde", a_vencer: "cinza", baixada: "agua", cancelada: "cinza" };

const emReais = (c: bigint) => reaisParaCampo(c < 0n ? -c : c);
const comSinal = (c: bigint) => (c < 0n ? `− ${formatarReais(-c)}` : formatarReais(c));

type Props = {
  filtro: FiltroLancamentos;
  hoje: string;
  linhas: LinhaLancamento[];
  totalLinhas: number;
  totais: TotaisLancamentos;
  categorias: GrupoCategorias[];
  contas: (ContaOpcao & { ativa: boolean })[];
  fornecedores: Opcao[];
  clientes: Opcao[];
  edicao: LancamentoForm | null;
  novo: Lado | null;
};

export function ListaLancamentos(p: Props) {
  const { filtro: f, hoje, linhas, totais } = p;
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [busca, setBusca] = useState(f.busca ?? "");
  const [baixando, setBaixando] = useState<LinhaLancamento | null>(null);
  const [marcadas, setMarcadas] = useState<Map<Chave, LinhaLancamento>>(new Map());
  const [dataLote, setDataLote] = useState(hoje);
  const ativas = p.contas.filter((c) => c.ativa);
  const [contaLote, setContaLote] = useState(contaPadrao(ativas));
  const [aviso, setAviso] = useState<string | null>(null);
  const [recusadas, setRecusadas] = useState<Map<Chave, string>>(new Map());
  const [contaInvalida, setContaInvalida] = useState(false);

  const ir = (mudar: Record<string, string | number | undefined>) => router.push(urlDe(f, mudar));
  const nomeCategoria = new Map(p.categorias.flatMap((g) => g.categorias.map((c) => [c.id, c.nome] as const)));
  const lista = periodos(hoje);
  const periodoAtual = lista.find((x) => x.de === f.de && x.ate === f.ate)?.id ?? "personalizado";
  const pagar = f.lado === "pagar";
  const ladoMarcado = marcadas.size > 0 ? [...marcadas.values()][0].lado : null;
  const somaMarcadas = [...marcadas.values()].reduce((t, l) => t + l.valorPrevisto, 0n);

  function alternar(l: LinhaLancamento) {
    setMarcadas((m) => {
      const n = new Map(m);
      if (n.has(chave(l))) n.delete(chave(l));
      else n.set(chave(l), l);
      return n;
    });
  }

  function baixarLote() {
    setAviso(null);
    setRecusadas(new Map());
    setContaInvalida(false);
    iniciar(async () => {
      try {
        const r = await baixarEmLote({ itens: [...marcadas.values()].map((l) => ({ origem: l.origem, id: l.id })), data: dataLote, contaBancariaId: contaLote });
        if (r.ok) {
          setAviso(`${marcadas.size} ${marcadas.size === 1 ? "linha baixada" : "linhas baixadas"}.`);
          setMarcadas(new Map());
          router.refresh();
        } else {
          setAviso(r.erro);
          setContaInvalida("campos" in r && Boolean(r.campos?.contaBancariaId));
          if ("linhas" in r && r.linhas) setRecusadas(new Map(r.linhas.map((x) => [chave(x), x.motivo])));
        }
      } catch {
        setAviso(MSG_FALHA);
      }
    });
  }

  function desfazer(l: LinhaLancamento) {
    if (!window.confirm(`Desfazer a baixa de "${l.pessoa || l.descricao}"? A linha volta a ficar em aberto.`)) return;
    setAviso(null);
    iniciar(async () => {
      try {
        const r = l.origem === "parcela" && l.repasse ? await desfazerRepasse(l.id) : await desfazerBaixaLinha(l.origem, l.id);
        if (r.ok) router.refresh();
        else setAviso(r.erro);
      } catch {
        setAviso(MSG_FALHA);
      }
    });
  }

  // Cartões: no lado da aba; em "Todos", o saldo (receber − pagar) de cada cartão.
  const cartoes: { rotulo: string; chave: keyof TotaisLancamentos["pagar"]; destaque?: boolean }[] = [
    { rotulo: "Vencidos", chave: "vencidos", destaque: true },
    { rotulo: "Vencem hoje", chave: "venceHoje" },
    { rotulo: "A vencer", chave: "aVencer" },
    { rotulo: f.lado === "pagar" ? "Pagos no período" : f.lado === "receber" ? "Recebidos no período" : "Baixados no período", chave: "baixados" },
  ];

  const primeira = (f.pagina - 1) * POR_PAGINA + 1;
  const ultima = Math.min(f.pagina * POR_PAGINA, p.totalLinhas);
  const ultimaPagina = Math.max(1, Math.ceil(p.totalLinhas / POR_PAGINA));

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <Tabs<Aba>
          value={f.lado}
          onChange={(lado) => ir({ lado, situacao: f.situacao })}
          options={[
            { value: "pagar", label: "A pagar" },
            { value: "receber", label: "A receber" },
            { value: "todos", label: "Todos" },
          ]}
        />
        <Botao onClick={() => ir({ pagina: f.pagina, novo: f.lado === "receber" ? "receber" : "pagar" })}>
          <Plus size={16} /> Novo lançamento
        </Botao>
      </div>

      <div className="mb-5 grid grid-cols-4 gap-3">
        {cartoes.map((c) => {
          const valor = f.lado === "todos" ? totais.receber[c.chave] - totais.pagar[c.chave] : totais[f.lado][c.chave];
          const alerta = c.destaque && valor !== 0n;
          return (
            <Card key={c.chave} className={cx("p-4", alerta && "border-ouro")}>
              <Eyebrow>{c.rotulo}</Eyebrow>
              <p className={cx("num mt-1 text-[21px] font-bold", alerta ? "text-texto" : "text-verde")}>
                {alerta && <span className="mr-2 inline-block h-2 w-2 -translate-y-1 rounded-full bg-ouro" aria-hidden />}
                {f.lado === "todos" ? comSinal(valor) : formatarReais(valor)}
              </p>
              <p className="text-[12.5px] text-cinza">
                {f.lado === "todos" ? (
                  <>Receber {emReais(totais.receber[c.chave])} · pagar {emReais(totais.pagar[c.chave])}</>
                ) : c.chave === "baixados" ? (
                  "pela data da baixa"
                ) : (
                  "em aberto, no período"
                )}
              </p>
            </Card>
          );
        })}
      </div>

      <Card>
        <form
          className="flex flex-wrap items-end gap-3 px-5 pt-5"
          onSubmit={(e) => {
            e.preventDefault();
            ir({ busca: busca.trim() || undefined });
          }}
        >
          <label className="relative min-w-[240px] flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-cinza" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              aria-label="Pesquisar"
              placeholder="Pessoa, descrição, código da viagem ou fatura"
              className={cx(inputCls, "pl-9")}
            />
          </label>
          <Select value={f.base} onChange={(base) => ir({ base })}>
            <option value="vencimento">Por vencimento</option>
            <option value="competencia">Por competência</option>
            <option value="baixa">Pela data da baixa</option>
          </Select>
          <Select
            value={periodoAtual}
            onChange={(id) => {
              const x = lista.find((y) => y.id === id);
              if (x) ir({ de: x.de, ate: x.ate });
            }}
          >
            {lista.map((x) => (
              <option key={x.id} value={x.id}>{x.rotulo}</option>
            ))}
            <option value="personalizado" disabled>Personalizado</option>
          </Select>
          <input type="date" aria-label="De" className={cx(inputCls, "!w-[150px]")} value={f.de} onChange={(e) => e.target.value && ir({ de: e.target.value })} />
          <input type="date" aria-label="Até" className={cx(inputCls, "!w-[150px]")} value={f.ate} onChange={(e) => e.target.value && ir({ ate: e.target.value })} />
        </form>
        <div className="flex flex-wrap items-end gap-3 px-5 pt-3">
          <Select value={f.situacao ?? ""} onChange={(s) => ir({ situacao: s || undefined })}>
            <option value="">Todas as situações</option>
            <option value="vencida">Vencidas</option>
            <option value="vence_hoje">Vencem hoje</option>
            <option value="a_vencer">A vencer</option>
            <option value="baixada">{pagar ? "Pagas" : f.lado === "receber" ? "Recebidas" : "Pagas e recebidas"}</option>
            <option value="cancelada">Canceladas</option>
          </Select>
          <Select
            value={f.categoriaId ? `c:${f.categoriaId}` : f.grupo ? `g:${f.grupo}` : ""}
            onChange={(v) => ir({ categoriaId: v.startsWith("c:") ? v.slice(2) : undefined, grupo: v.startsWith("g:") ? v.slice(2) : undefined })}
          >
            <option value="">Todas as categorias</option>
            {p.categorias
              .filter((g) => f.lado === "todos" || g.lado === f.lado)
              .map((g) => (
                <optgroup key={`${g.lado}:${g.grupo}`} label={`${g.grupo}${f.lado === "todos" ? (g.lado === "pagar" ? " (a pagar)" : " (a receber)") : ""}`}>
                  <option value={`g:${g.grupo}`}>Todo o grupo {g.grupo}</option>
                  {g.categorias.map((c) => (
                    <option key={c.id} value={`c:${c.id}`}>{c.nome}</option>
                  ))}
                </optgroup>
              ))}
          </Select>
          <Select value={f.centro ?? ""} onChange={(c) => ir({ centro: c || undefined })}>
            <option value="">MT e RS</option>
            <option value="MT">Só MT</option>
            <option value="RS">Só RS</option>
          </Select>
          <Select value={f.contaBancariaId ?? ""} onChange={(c) => ir({ contaBancariaId: c || undefined })}>
            <option value="">Todas as contas bancárias</option>
            {p.contas.map((c) => (
              <option key={c.id} value={c.id}>{c.nome}{c.ativa ? "" : " (desativada)"}</option>
            ))}
          </Select>
          <Select value={f.origem ?? ""} onChange={(o) => ir({ origem: o || undefined })}>
            <option value="">Viagens e lançados à mão</option>
            <option value="viagem">Só de viagens</option>
            <option value="manual">Só lançados à mão</option>
          </Select>
          {(f.situacao || f.categoriaId || f.grupo || f.centro || f.contaBancariaId || f.origem || f.busca) && (
            <Link href={urlDe(f, { situacao: undefined, categoriaId: undefined, grupo: undefined, centro: undefined, contaBancariaId: undefined, origem: undefined, busca: undefined })} className="py-2 text-[13px] font-semibold text-verde hover:underline" onClick={() => setBusca("")}>
              Limpar filtros
            </Link>
          )}
        </div>

        {aviso && (
          <p role="status" className="mx-5 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-2.5 text-[13.5px] text-texto">
            {aviso}
          </p>
        )}

        {marcadas.size > 0 && (
          <div className="mx-5 mt-4 flex flex-wrap items-end gap-3 rounded-[6px] border border-verde/40 bg-verde/[0.06] px-4 py-3">
            <div className="mr-auto">
              <Eyebrow className="!text-verde">Baixa em lote · {ladoMarcado === "pagar" ? "a pagar" : "a receber"}</Eyebrow>
              <p className="mt-0.5 text-[13.5px]">
                {marcadas.size} {marcadas.size === 1 ? "linha" : "linhas"} pelo valor previsto: <b className="num">{formatarReais(somaMarcadas)}</b>
              </p>
            </div>
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Data</span>
              <input type="date" max={hoje} className={cx(inputCls, "!w-[160px]")} value={dataLote} onChange={(e) => setDataLote(e.target.value)} />
            </label>
            <div className="w-[220px]">
              <CampoConta contas={ativas} valor={contaLote} onChange={setContaLote} invalido={contaInvalida} />
            </div>
            <Botao variante="secundario" onClick={() => { setMarcadas(new Map()); setRecusadas(new Map()); }}>Limpar</Botao>
            <Botao disabled={pendente} onClick={baixarLote}>Baixar selecionadas ({marcadas.size})</Botao>
          </div>
        )}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-[14px]">
            <thead>
              <tr>
                {["", "Código", "Vencimento", "Descrição", "Categoria", "Forma", "Valor", "Situação", "Origem", ""].map((h, i) => (
                  <th key={i} className={cx("whitespace-nowrap border-y border-linha bg-fundo px-3 py-2.5 text-[11px] font-bold uppercase tracking-[0.05em] text-verde", i === 6 ? "text-right" : "text-left")}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linhas.map((l) => {
                const k = chave(l);
                const foraDoLote = motivoForaDoLote(l);
                const podeMarcar = foraDoLote === null && (ladoMarcado === null || ladoMarcado === l.lado);
                const recusa = recusadas.get(k);
                const baixada = l.situacao === "baixada";
                const valor = baixada && l.valorBaixado !== null ? l.valorBaixado : l.valorPrevisto;
                const semFornecedor = l.repasse && l.exigeIndividual;
                return (
                  <tr key={k} className={cx("border-b border-linha last:border-0", recusa ? "bg-ouro/15" : marcadas.has(k) ? "bg-verde/[0.05]" : "hover:bg-fundo/70")}>
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${l.pessoa || l.descricao}`}
                        className="h-4 w-4 cursor-pointer accent-verde disabled:cursor-not-allowed disabled:opacity-30"
                        checked={marcadas.has(k)}
                        disabled={!marcadas.has(k) && !podeMarcar}
                        title={foraDoLote ?? (podeMarcar ? undefined : "O lote é de um lado só")}
                        onChange={() => alternar(l)}
                      />
                    </td>
                    <td className="num whitespace-nowrap px-3 py-3 text-[12.5px] text-cinza">{l.id.slice(0, 8)}</td>
                    <td className="num whitespace-nowrap px-3 py-3">{dataBr(l.vencimento)}</td>
                    <td className="min-w-[260px] px-3 py-3">
                      <b className="block font-semibold">{l.pessoa || l.descricao}</b>
                      <span className="text-[13px] text-cinza">
                        {l.pessoa ? l.descricao : null}
                        {l.parcelaNumero !== null && l.parcelaTotal !== null && <> · parcela {l.parcelaNumero}/{l.parcelaTotal}</>}
                        {l.faturaNumero !== null && <> · Fatura {l.faturaNumero}</>}
                      </span>
                      {recusa && <span className="mt-1 block text-[12.5px] font-semibold text-texto">Fora do lote: {recusa}</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      {nomeCategoria.get(l.categoriaId) ?? l.categoria.nome}
                      <span className="block text-[12px] text-cinza">{l.centro}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">{rotuloForma(l.origem, l.forma)}</td>
                    <td className="num whitespace-nowrap px-3 py-3 text-right font-semibold">
                      {reaisParaCampo(valor)}
                      {baixada && l.valorBaixado !== null && l.valorBaixado !== l.valorPrevisto && (
                        <span className="block text-[12px] font-normal text-cinza">previsto {reaisParaCampo(l.valorPrevisto)}</span>
                      )}
                      {l.moeda && l.moeda !== "BRL" && l.valorOriginal !== null && (
                        <span className="block text-[12px] font-normal text-cinza">{l.moeda} {reaisParaCampo(l.valorOriginal)}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <Badge tom={TOM[l.situacao]}>{rotuloSituacao(l.situacao, l.lado)}</Badge>
                      {baixada && l.baixadoEm && <span className="block text-[12px] text-cinza">em {dataBr(l.baixadoEm)}{l.contaBancaria ? ` · ${l.contaBancaria}` : ""}</span>}
                      {!l.transitaCaixa && <span className="block text-[12px] text-cinza">Fora do caixa</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-[13px]">
                      {l.viagemId ? (
                        <Link href={`/viagens/${l.viagemId}`} className="font-semibold text-verde hover:underline">Viagem {l.viagemCodigo}</Link>
                      ) : (
                        <span className="text-cinza">Lançado à mão</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {l.origem === "manual" && l.statusBase === "em_aberto" && (
                          <button onClick={() => ir({ pagina: f.pagina, editar: l.id })} className="cursor-pointer px-1.5 text-[13px] font-semibold text-verde hover:underline">
                            Editar
                          </button>
                        )}
                        {l.statusBase === "em_aberto" && l.transitaCaixa && !semFornecedor && (
                          <Botao variante="secundario" className="!px-3 !py-1.5 !text-[13px]" onClick={() => setBaixando(l)}>
                            {l.repasse ? "Registrar repasse" : "Dar baixa"}
                          </Botao>
                        )}
                        {semFornecedor && l.statusBase === "em_aberto" && (
                          <Link href={`/viagens/${l.viagemId}`} className="text-[13px] font-semibold text-verde hover:underline">Escolher na viagem</Link>
                        )}
                        {baixada && l.transitaCaixa && (
                          <Botao variante="fantasma" className="!px-3 !py-1.5 !text-[13px]" disabled={pendente} onClick={() => desfazer(l)}>
                            {l.repasse ? "Desfazer repasse" : "Desfazer baixa"}
                          </Botao>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {linhas.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-10 text-center text-cinza">Nenhum lançamento com esses filtros.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5 pt-3 text-[13px] text-cinza">
          <span>
            {p.totalLinhas === 0 ? "Nenhum registro" : `${primeira}–${ultima} de ${p.totalLinhas} ${p.totalLinhas === 1 ? "registro" : "registros"}`}. Totais sem os cancelados e sem o que não passa pelo caixa.
          </span>
          {ultimaPagina > 1 && (
            <span className="flex items-center gap-3">
              {f.pagina > 1 ? <Link href={urlDe(f, { pagina: f.pagina - 1 })} className="font-semibold text-verde hover:underline">Anterior</Link> : <span>Anterior</span>}
              <span className="num">Página {f.pagina} de {ultimaPagina}</span>
              {f.pagina < ultimaPagina ? <Link href={urlDe(f, { pagina: f.pagina + 1 })} className="font-semibold text-verde hover:underline">Próxima</Link> : <span>Próxima</span>}
            </span>
          )}
        </div>
      </Card>

      {baixando && <DialogoBaixa linha={baixando} hoje={hoje} contas={ativas} onFechar={() => setBaixando(null)} />}
      {(p.edicao || p.novo) && (
        <FormularioLancamento
          key={p.edicao?.id ?? `novo-${p.novo}`}
          lancamento={p.edicao}
          ladoNovo={p.novo ?? "pagar"}
          hoje={hoje}
          categorias={p.categorias}
          contas={ativas}
          fornecedores={p.fornecedores}
          clientes={p.clientes}
          onFechar={() => router.push(urlDe(f, { pagina: f.pagina }))}
        />
      )}
    </div>
  );
}
