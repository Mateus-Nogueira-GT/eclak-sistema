"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Plus, Printer, Trash2 } from "lucide-react";
import { Badge, Botao, Campo, Card, cx, inputCls } from "@/components/ui";
import {
  conteudoRoteiroSchema,
  FUSOS_SUGERIDOS,
  IDIOMAS,
  rotuloDiaRoteiro,
  ROTULO_IDIOMA,
  textoAniversario,
  type Aniversario,
  type ConteudoRoteiro,
  type DiaRoteiro,
  type HotelRoteiro,
  type Idioma,
  type ItemRoteiro,
  type VooRoteiro,
} from "@/domain/roteiro";
import { dataEmCuiaba } from "@/domain/clientes";
import { dataBr } from "@/domain/tarefas";
import {
  aprovarRoteiro,
  criarRoteiro,
  desfazerAprovacao,
  marcarEnviadoAoCliente,
  salvarRoteiro,
  trazerHoteisEVoos,
} from "@/server/actions/roteiros";
import type { RoteiroTela } from "@/server/queries/operacao";
import { DocumentoRoteiro, NOTA_VOOS, ROTULO_STATUS_ROTEIRO, TOM_STATUS_ROTEIRO } from "./previa";

type Aviso = { msg: string; tipo: "erro" | "conflito" | "ok" } | null;

const ddmm = (d: string) => dataBr(d).slice(0, 5);
const ouNull = (s: string) => (s.trim() === "" ? null : s);

const tituloAniversario = (a: Aniversario) => `Aniversário de ${a.nome} (${a.idade} anos)`;

function SeletorFuso({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const opcoes = FUSOS_SUGERIDOS.some((f) => f.id === value) || !value ? FUSOS_SUGERIDOS : [{ id: value, rotulo: value }, ...FUSOS_SUGERIDOS];
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={cx(inputCls, "cursor-pointer")}>
      {!value && <option value="">Escolha o fuso</option>}
      {opcoes.map((f) => (
        <option key={f.id} value={f.id}>
          {f.rotulo} ({f.id})
        </option>
      ))}
    </select>
  );
}

function SeletorIdioma({ value, onChange }: { value: Idioma | ""; onChange: (v: Idioma) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as Idioma)} className={cx(inputCls, "cursor-pointer")}>
      {!value && <option value="">Escolha o idioma</option>}
      {IDIOMAS.map((i) => (
        <option key={i} value={i}>
          {ROTULO_IDIOMA[i]}
        </option>
      ))}
    </select>
  );
}

function FaixaAviso({ aviso, onRecarregar }: { aviso: Aviso; onRecarregar: () => void }) {
  if (!aviso) return null;
  if (aviso.tipo === "ok") {
    return (
      <div role="status" className="mb-4 rounded-[5px] border border-agua bg-agua/10 px-4 py-3 text-[14px] font-semibold text-texto">
        {aviso.msg}
      </div>
    );
  }
  return (
    <div role="alert" className="mb-4 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
      <p className={aviso.tipo === "conflito" ? "font-semibold" : undefined}>{aviso.msg}</p>
      {aviso.tipo === "conflito" && (
        <button type="button" onClick={onRecarregar} className="mt-1 cursor-pointer font-semibold text-verde underline">
          Recarregar
        </button>
      )}
    </div>
  );
}

function FaixaAniversarios({ aniversarios, children }: { aniversarios: Aniversario[]; children?: (a: Aniversario) => ReactNode }) {
  if (aniversarios.length === 0) return null;
  return (
    <div className="mb-5 space-y-2">
      {aniversarios.map((a) => (
        <div key={a.pessoaId} role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          <p>
            <span className="font-semibold">Aniversário durante a viagem:</span> {textoAniversario(a)}
          </p>
          {children?.(a)}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sem roteiro: idioma e fuso
// ---------------------------------------------------------------------------

export function CriarRoteiro({
  viagemId,
  sugestao,
  aniversarios,
}: {
  viagemId: string;
  sugestao: { idioma: Idioma; fuso: string } | null;
  aniversarios: Aniversario[];
}) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [idioma, setIdioma] = useState<Idioma | "">(sugestao?.idioma ?? "");
  const [fuso, setFuso] = useState(sugestao?.fuso ?? "");
  const [erro, setErro] = useState<string | null>(null);

  function criar() {
    setErro(null);
    if (!idioma) return setErro("Escolha o idioma");
    if (!fuso) return setErro("Escolha o fuso");
    iniciar(async () => {
      const r = await criarRoteiro(viagemId, { idioma, fuso });
      if (!r.ok) setErro(r.erro);
      router.refresh();
    });
  }

  return (
    <div>
      <h1 className="titulo mb-5 text-[26px] leading-[1.1] text-texto">Roteiro da viagem</h1>
      <FaixaAniversarios aniversarios={aniversarios} />
      <Card className="max-w-[640px] px-6 py-5">
        <h2 className="text-[16px] font-bold text-texto">Criar roteiro</h2>
        <p className="mt-1 text-[14px] text-cinza">
          {sugestao
            ? "Idioma e fuso sugeridos pelo destino. Confira antes de criar."
            : "Escolha o idioma das saudações e o fuso do destino."}{" "}
          O roteiro nasce com um dia por data da viagem e com os hotéis e voos dos itens.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Campo label="Idioma">
            <SeletorIdioma value={idioma} onChange={setIdioma} />
          </Campo>
          <Campo label="Fuso do destino">
            <SeletorFuso value={fuso} onChange={setFuso} />
          </Campo>
        </div>
        {erro && (
          <p role="alert" className="mt-3 text-[14px] font-semibold text-texto">
            {erro}
          </p>
        )}
        <div className="mt-5">
          <Botao onClick={criar} disabled={pendente}>
            Criar roteiro
          </Botao>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type Documento = { idioma: Idioma; fuso: string; abertura: string; conteudo: ConteudoRoteiro };

/** Normaliza o documento para gravar: vazios viram null, dica vazia some, linhas gastronômicas vazias saem. */
function normalizar(c: ConteudoRoteiro): ConteudoRoteiro {
  return {
    dias: c.dias.map((d) => ({
      ...d,
      itens: d.itens.map((i) => ({ ...i, hora: i.hora || null, mapa: i.mapa?.trim() ? i.mapa.trim() : null })),
      dica: d.dica && (d.dica.tema.trim() || d.dica.texto.trim()) ? d.dica : null,
      porque: d.porque?.trim() ? d.porque : null,
      gastro: d.gastro.filter((g) => g.trim() !== ""),
    })),
    hoteis: c.hoteis.map((h) => ({
      ...h,
      entrada: h.entrada || null,
      saida: h.saida || null,
      horaCheckin: h.horaCheckin || null,
      horaCheckout: h.horaCheckout || null,
      mapa: h.mapa?.trim() ? h.mapa.trim() : null,
    })),
    voos: c.voos.map((v) => ({ ...v, data: v.data || null, saida: v.saida || null, chegada: v.chegada || null })),
  };
}

/** Primeiro erro de validação com o lugar (dia, hotel ou voo) para a pessoa achar. */
function descreverErro(c: ConteudoRoteiro, path: PropertyKey[], msg: string): string {
  const [lista, i] = path;
  if (lista === "dias" && typeof i === "number" && c.dias[i]) return `${rotuloDiaRoteiro(c.dias[i].data)}: ${msg}`;
  if (lista === "hoteis" && typeof i === "number") return `Hotel ${i + 1}: ${msg}`;
  if (lista === "voos" && typeof i === "number") return `Voo ${i + 1}: ${msg}`;
  return msg;
}

function mover<T>(lista: T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (j < 0 || j >= lista.length) return lista;
  const nova = [...lista];
  [nova[i], nova[j]] = [nova[j], nova[i]];
  return nova;
}

const botaoIcone =
  "inline-flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[4px] text-cinza hover:bg-fundo hover:text-verde disabled:cursor-not-allowed disabled:opacity-40";

const inputPequeno = cx(inputCls, "px-2 py-1.5 text-[13.5px]");

export function EditorRoteiro({
  viagemId,
  destino,
  inicio,
  fim,
  roteiro,
  aniversarios,
}: {
  viagemId: string;
  destino: string;
  inicio: string;
  fim: string;
  roteiro: RoteiroTela;
  aniversarios: Aniversario[];
}) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [doc, setDoc] = useState<Documento>({
    idioma: roteiro.idioma,
    fuso: roteiro.fuso,
    abertura: roteiro.abertura,
    conteudo: roteiro.conteudo,
  });
  const [versao, setVersao] = useState(roteiro.atualizadoEm);
  const [alterado, setAlterado] = useState(false);
  const [aviso, setAviso] = useState<Aviso>(null);
  // Versão do servidor já vista e pedido de "Recarregar". Quando o servidor traz outra versão (trazer hotéis e voos,
  // recarregar depois de um conflito), o documento local é refeito, mas nunca por cima de alterações não salvas, a
  // não ser que a pessoa tenha pedido para recarregar.
  const [vista, setVista] = useState(roteiro.atualizadoEm);
  const [forcar, setForcar] = useState(false);
  if (roteiro.atualizadoEm !== vista && (!alterado || forcar)) {
    setVista(roteiro.atualizadoEm);
    setForcar(false);
    if (roteiro.atualizadoEm !== versao) {
      setDoc({ idioma: roteiro.idioma, fuso: roteiro.fuso, abertura: roteiro.abertura, conteudo: roteiro.conteudo });
      setVersao(roteiro.atualizadoEm);
      setAlterado(false);
    }
  }

  useEffect(() => {
    if (!alterado) return;
    const aoSair = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", aoSair);
    return () => window.removeEventListener("beforeunload", aoSair);
  }, [alterado]);

  const mudar = (fn: (d: Documento) => Documento) => {
    setDoc(fn);
    setAlterado(true);
    setForcar(false);
  };
  const mudarConteudo = (fn: (c: ConteudoRoteiro) => ConteudoRoteiro) => mudar((d) => ({ ...d, conteudo: fn(d.conteudo) }));
  const mudarDia = (i: number, fn: (d: DiaRoteiro) => DiaRoteiro) =>
    mudarConteudo((c) => ({ ...c, dias: c.dias.map((d, k) => (k === i ? fn(d) : d)) }));

  function recarregar() {
    setAviso(null);
    setForcar(true);
    router.refresh();
  }

  function salvar() {
    setAviso(null);
    const conteudo = normalizar(doc.conteudo);
    const v = conteudoRoteiroSchema(inicio, fim).safeParse(conteudo);
    if (!v.success) {
      const i = v.error.issues[0];
      return setAviso({ msg: descreverErro(conteudo, i.path, i.message), tipo: "erro" });
    }
    iniciar(async () => {
      const r = await salvarRoteiro(roteiro.id, { ...doc, conteudo }, versao);
      if (!r.ok) {
        setAviso({ msg: r.erro, tipo: r.conflito ? "conflito" : "erro" });
        return;
      }
      setVersao(r.atualizadoEm);
      setAlterado(false);
      setAviso({ msg: "Roteiro salvo.", tipo: "ok" });
      router.refresh();
    });
  }

  function trazer() {
    if (!window.confirm("Trazer hotéis e voos da viagem? As listas de hotéis e voos do roteiro serão substituídas pelos itens da viagem.")) return;
    setAviso(null);
    iniciar(async () => {
      const r = await trazerHoteisEVoos(roteiro.id, versao);
      if (!r.ok) setAviso({ msg: r.erro, tipo: r.conflito ? "conflito" : "erro" });
      router.refresh();
    });
  }

  function status(fn: () => Promise<{ ok: true; tarefasCriadas?: number } | { ok: false; erro: string }>) {
    setAviso(null);
    iniciar(async () => {
      const r = await fn();
      if (!r.ok) setAviso({ msg: r.erro, tipo: "erro" });
      else if (r.tarefasCriadas !== undefined)
        setAviso({
          msg: r.tarefasCriadas > 0 ? "Roteiro aprovado. Tarefas criadas: passeios, ingressos e trem" : "Roteiro aprovado. As tarefas do roteiro já existiam",
          tipo: "ok",
        });
      router.refresh();
    });
  }

  function incluirAniversario(a: Aniversario) {
    const i = doc.conteudo.dias.findIndex((d) => d.data === a.data);
    if (i < 0) return;
    mudarDia(i, (d) => ({ ...d, itens: [...d.itens, { hora: null, titulo: tituloAniversario(a), texto: "", mapa: null }] }));
  }

  const c = doc.conteudo;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h1 className="titulo text-[26px] leading-[1.1] text-texto">Roteiro da viagem</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <Badge tom={TOM_STATUS_ROTEIRO[roteiro.status]}>{ROTULO_STATUS_ROTEIRO[roteiro.status]}</Badge>
            {roteiro.alteradoDepoisDaAprovacao && <Badge tom="ouro">Alterado depois da aprovação</Badge>}
            {roteiro.status === "aprovado" && roteiro.aprovadoEm && (
              <span className="text-[13px] text-cinza">
                Marcado por {roteiro.aprovadoPor ?? "alguém"} em <span className="num">{dataBr(dataEmCuiaba(new Date(roteiro.aprovadoEm)))}</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {roteiro.status === "rascunho" && (
            <Botao variante="secundario" disabled={pendente} onClick={() => status(() => marcarEnviadoAoCliente(roteiro.id))}>
              Marcar como enviado ao cliente
            </Botao>
          )}
          {roteiro.status !== "aprovado" && (
            <Botao variante="secundario" disabled={pendente} onClick={() => status(() => aprovarRoteiro(roteiro.id))}>
              Marcar como aprovado pelo cliente
            </Botao>
          )}
          {roteiro.status === "aprovado" && (
            <Botao
              variante="secundario"
              disabled={pendente}
              onClick={() => {
                if (window.confirm("Desfazer a aprovação? O roteiro volta para Aguardando o cliente; as tarefas criadas ficam.")) status(() => desfazerAprovacao(roteiro.id));
              }}
            >
              Desfazer aprovação
            </Botao>
          )}
          <Link
            href={`/viagens/${viagemId}/roteiro/imprimir`}
            className="inline-flex items-center gap-2 rounded-[5px] border border-[#C9CDD1] bg-white px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde"
          >
            <Printer size={15} /> Imprimir
          </Link>
          <Botao onClick={salvar} disabled={pendente || !alterado}>
            Salvar
          </Botao>
        </div>
      </div>

      <FaixaAviso aviso={aviso} onRecarregar={recarregar} />

      <FaixaAniversarios aniversarios={aniversarios}>
        {(a) => {
          const dia = c.dias.find((d) => d.data === a.data);
          const incluido = dia?.itens.some((it) => it.titulo === tituloAniversario(a)) ?? false;
          return (
            <Botao variante="secundario" disabled={incluido || !dia || pendente} onClick={() => incluirAniversario(a)}>
              {incluido ? `Incluído no dia ${ddmm(a.data)}` : `Incluir no dia ${ddmm(a.data)}`}
            </Botao>
          );
        }}
      </FaixaAniversarios>

      {alterado && <p className="mb-3 text-[13px] font-semibold text-texto">Alterações não salvas.</p>}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
        <fieldset disabled={pendente} className="min-w-0 space-y-5">
          <Card className="px-6 py-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Campo label="Idioma das saudações">
                <SeletorIdioma value={doc.idioma} onChange={(v) => mudar((d) => ({ ...d, idioma: v }))} />
              </Campo>
              <Campo label="Fuso do destino">
                <SeletorFuso value={doc.fuso} onChange={(v) => mudar((d) => ({ ...d, fuso: v }))} />
              </Campo>
            </div>
            <Campo label="Sua viagem" className="mt-4">
              <textarea
                value={doc.abertura}
                maxLength={4000}
                rows={4}
                onChange={(e) => {
                  const abertura = e.target.value;
                  mudar((d) => ({ ...d, abertura }));
                }}
                className={inputCls}
                placeholder="Texto de abertura do roteiro ao cliente"
              />
            </Campo>
          </Card>

          <Card className="px-6 py-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-[16px] font-bold text-texto">Hotéis e voos</h2>
              <Botao
                variante="secundario"
                onClick={trazer}
                disabled={pendente || alterado}
                title={alterado ? "Salve as alterações antes de trazer da viagem" : undefined}
              >
                Trazer hotéis e voos da viagem
              </Botao>
            </div>
            {alterado && <p className="mt-1 text-[12.5px] text-cinza">Salve as alterações antes de trazer da viagem.</p>}
            <TabelaHoteis hoteis={c.hoteis} onChange={(hoteis) => mudarConteudo((x) => ({ ...x, hoteis }))} />
            <TabelaVoos voos={c.voos} onChange={(voos) => mudarConteudo((x) => ({ ...x, voos }))} />
          </Card>

          {c.dias.map((d, i) => (
            <EditorDia key={d.data} dia={d} onChange={(fn) => mudarDia(i, fn)} />
          ))}

          <div className="flex justify-end">
            <Botao onClick={salvar} disabled={pendente || !alterado}>
              Salvar
            </Botao>
          </div>
        </fieldset>

        <aside className="min-w-0 xl:sticky xl:top-4">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Prévia do PDF</p>
          <div className="max-h-[calc(100vh-7rem)] overflow-y-auto rounded-[6px] border border-linha bg-white px-6 py-6 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div style={{ zoom: 0.82 }}>
              <DocumentoRoteiro destino={destino} abertura={doc.abertura} conteudo={c} />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Partes do editor
// ---------------------------------------------------------------------------

function Rotulo({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">{children}</p>;
}

function TabelaHoteis({ hoteis, onChange }: { hoteis: HotelRoteiro[]; onChange: (h: HotelRoteiro[]) => void }) {
  const set = (i: number, p: Partial<HotelRoteiro>) => onChange(hoteis.map((h, k) => (k === i ? { ...h, ...p } : h)));
  return (
    <div className="mt-4">
      <Rotulo>Hotéis</Rotulo>
      {hoteis.length === 0 && <p className="mb-2 text-[13.5px] text-cinza">Nenhum hotel.</p>}
      <div className="space-y-2">
        {hoteis.map((h, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_30px] gap-x-1.5 rounded-[5px] border border-linha p-2">
            <div className="grid gap-1.5">
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.4fr)] gap-1.5">
                <input aria-label="Cidade" placeholder="Cidade" value={h.cidade} maxLength={120} onChange={(e) => set(i, { cidade: e.target.value })} className={inputPequeno} />
                <input aria-label="Hotel" placeholder="Hotel" value={h.nome} maxLength={200} onChange={(e) => set(i, { nome: e.target.value })} className={inputPequeno} />
                <input aria-label="Link do mapa" placeholder="Link do mapa (https://)" value={h.mapa ?? ""} maxLength={500} onChange={(e) => set(i, { mapa: ouNull(e.target.value) })} className={inputPequeno} />
              </div>
              <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5 text-[11px] font-semibold text-cinza">
                <label className="block">Entrada<input aria-label="Entrada" type="date" value={h.entrada ?? ""} onChange={(e) => set(i, { entrada: ouNull(e.target.value) })} className={cx(inputPequeno, "mt-0.5 font-normal")} /></label>
                <label className="block">Saída<input aria-label="Saída" type="date" value={h.saida ?? ""} onChange={(e) => set(i, { saida: ouNull(e.target.value) })} className={cx(inputPequeno, "mt-0.5 font-normal")} /></label>
                <label className="block">Check-in<input aria-label="Hora do check-in" type="time" value={h.horaCheckin ?? ""} onChange={(e) => set(i, { horaCheckin: ouNull(e.target.value) })} className={cx(inputPequeno, "mt-0.5 font-normal")} /></label>
                <label className="block">Check-out<input aria-label="Hora do check-out" type="time" value={h.horaCheckout ?? ""} onChange={(e) => set(i, { horaCheckout: ouNull(e.target.value) })} className={cx(inputPequeno, "mt-0.5 font-normal")} /></label>
              </div>
            </div>
            <button type="button" aria-label="Remover hotel" className={botaoIcone} onClick={() => onChange(hoteis.filter((_, k) => k !== i))}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <Botao
        variante="fantasma"
        className="mt-2"
        disabled={hoteis.length >= 30}
        onClick={() => onChange([...hoteis, { cidade: "", nome: "", entrada: null, saida: null, horaCheckin: null, horaCheckout: null, mapa: null }])}
      >
        <Plus size={15} /> Adicionar hotel
      </Botao>
    </div>
  );
}

function TabelaVoos({ voos, onChange }: { voos: VooRoteiro[]; onChange: (v: VooRoteiro[]) => void }) {
  const set = (i: number, p: Partial<VooRoteiro>) => onChange(voos.map((v, k) => (k === i ? { ...v, ...p } : v)));
  return (
    <div className="mt-5">
      <Rotulo>Voos</Rotulo>
      {voos.length === 0 && <p className="mb-2 text-[13.5px] text-cinza">Nenhum voo.</p>}
      <div className="space-y-2">
        {voos.map((v, i) => (
          <div key={i} className="grid grid-cols-[132px_110px_1fr_84px_84px_30px] items-center gap-1.5">
            <input aria-label="Data do voo" type="date" value={v.data ?? ""} onChange={(e) => set(i, { data: ouNull(e.target.value) })} className={inputPequeno} />
            <input aria-label="Voo" placeholder="Voo" value={v.voo} maxLength={40} onChange={(e) => set(i, { voo: e.target.value })} className={inputPequeno} />
            <input aria-label="Trecho" placeholder="Trecho" value={v.trecho} maxLength={120} onChange={(e) => set(i, { trecho: e.target.value })} className={inputPequeno} />
            <input aria-label="Saída" title="Saída" type="time" value={v.saida ?? ""} onChange={(e) => set(i, { saida: ouNull(e.target.value) })} className={inputPequeno} />
            <input aria-label="Chegada" title="Chegada" type="time" value={v.chegada ?? ""} onChange={(e) => set(i, { chegada: ouNull(e.target.value) })} className={inputPequeno} />
            <button type="button" aria-label="Remover voo" className={botaoIcone} onClick={() => onChange(voos.filter((_, k) => k !== i))}>
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      <Botao
        variante="fantasma"
        className="mt-2"
        disabled={voos.length >= 20}
        onClick={() => onChange([...voos, { data: null, voo: "", trecho: "", saida: null, chegada: null }])}
      >
        <Plus size={15} /> Adicionar voo
      </Botao>
      <p className="mt-2 text-[12.5px] text-cinza">{NOTA_VOOS}</p>
    </div>
  );
}

function EditorDia({ dia, onChange }: { dia: DiaRoteiro; onChange: (fn: (d: DiaRoteiro) => DiaRoteiro) => void }) {
  const setItem = (i: number, p: Partial<ItemRoteiro>) => onChange((d) => ({ ...d, itens: d.itens.map((it, k) => (k === i ? { ...it, ...p } : it)) }));
  const dica = dia.dica ?? { tema: "", texto: "" };
  return (
    <Card className="px-6 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="num w-[150px] shrink-0 text-[14px] font-bold text-verde">{rotuloDiaRoteiro(dia.data)}</h2>
        <input
          aria-label={`Título do dia ${dataBr(dia.data)}`}
          placeholder="Título do dia"
          value={dia.titulo}
          maxLength={120}
          onChange={(e) => {
            const titulo = e.target.value;
            onChange((d) => ({ ...d, titulo }));
          }}
          className={cx(inputCls, "min-w-0 flex-1 font-semibold")}
        />
      </div>

      <div className="mt-4 space-y-3">
        {dia.itens.map((it, i) => (
          <div key={i} className="rounded-[5px] border border-linha p-3">
            <div className="grid grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-2">
              <input aria-label="Hora" type="time" value={it.hora ?? ""} onChange={(e) => setItem(i, { hora: ouNull(e.target.value) })} className={inputPequeno} />
              <input aria-label="Título do item" placeholder="Título do item" value={it.titulo} maxLength={160} onChange={(e) => setItem(i, { titulo: e.target.value })} className={cx(inputPequeno, "font-semibold")} />
              <div className="flex items-center">
                <button type="button" aria-label="Subir item" className={botaoIcone} disabled={i === 0} onClick={() => onChange((d) => ({ ...d, itens: mover(d.itens, i, -1) }))}>
                  <ArrowUp size={15} />
                </button>
                <button type="button" aria-label="Descer item" className={botaoIcone} disabled={i === dia.itens.length - 1} onClick={() => onChange((d) => ({ ...d, itens: mover(d.itens, i, 1) }))}>
                  <ArrowDown size={15} />
                </button>
                <button type="button" aria-label="Remover item" className={botaoIcone} onClick={() => onChange((d) => ({ ...d, itens: d.itens.filter((_, k) => k !== i) }))}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
            <textarea aria-label="Texto do item" placeholder="Texto" rows={2} maxLength={2000} value={it.texto} onChange={(e) => setItem(i, { texto: e.target.value })} className={cx(inputPequeno, "mt-2")} />
            <input aria-label="Link do mapa do item" placeholder="Link do mapa (https://)" maxLength={500} value={it.mapa ?? ""} onChange={(e) => setItem(i, { mapa: ouNull(e.target.value) })} className={cx(inputPequeno, "mt-2")} />
          </div>
        ))}
        <Botao
          variante="fantasma"
          disabled={dia.itens.length >= 40}
          onClick={() => onChange((d) => ({ ...d, itens: [...d.itens, { hora: null, titulo: "", texto: "", mapa: null }] }))}
        >
          <Plus size={15} /> Adicionar item
        </Botao>
      </div>

      <div className="mt-4 border-l-[3px] border-terracota bg-fundo px-4 py-3">
        <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-texto">DICA ECLAK{dica.tema.trim() ? ` · ${dica.tema.trim().toUpperCase()}` : ""}</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-[200px_minmax(0,1fr)]">
          <input aria-label="Tema da dica" placeholder="Tema" maxLength={40} value={dica.tema} onChange={(e) => { const tema = e.target.value; onChange((d) => ({ ...d, dica: { tema, texto: d.dica?.texto ?? "" } })); }} className={inputPequeno} />
          <textarea aria-label="Texto da dica" placeholder="Texto da dica" rows={2} maxLength={1000} value={dica.texto} onChange={(e) => { const texto = e.target.value; onChange((d) => ({ ...d, dica: { tema: d.dica?.tema ?? "", texto } })); }} className={inputPequeno} />
        </div>
      </div>

      <div className="mt-4">
        <Rotulo>POR QUE ESCOLHEMOS</Rotulo>
        <textarea aria-label="Por que escolhemos" rows={2} maxLength={1000} value={dia.porque ?? ""} onChange={(e) => { const porque = e.target.value; onChange((d) => ({ ...d, porque })); }} className={inputPequeno} />
      </div>

      <div className="mt-4">
        <Rotulo>SUGESTÕES GASTRONÔMICAS</Rotulo>
        <div className="space-y-1.5">
          {dia.gastro.map((g, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                aria-label={`Sugestão gastronômica ${i + 1}`}
                placeholder="Restaurante | Bairro | Especialidade"
                maxLength={200}
                value={g}
                onChange={(e) => { const v = e.target.value; onChange((d) => ({ ...d, gastro: d.gastro.map((x, k) => (k === i ? v : x)) })); }}
                className={inputPequeno}
              />
              <button type="button" aria-label="Remover sugestão" className={botaoIcone} onClick={() => onChange((d) => ({ ...d, gastro: d.gastro.filter((_, k) => k !== i) }))}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
        <Botao variante="fantasma" className="mt-1" disabled={dia.gastro.length >= 10} onClick={() => onChange((d) => ({ ...d, gastro: [...d.gastro, ""] }))}>
          <Plus size={15} /> Adicionar linha
        </Botao>
        <p className="text-[12px] text-cinza">Colunas separadas por &quot; | &quot;.</p>
      </div>
    </Card>
  );
}
