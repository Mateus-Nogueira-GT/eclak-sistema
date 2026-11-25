"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Paperclip, Send, X } from "lucide-react";
import { ACEITA_ANEXO, tamanhoLegivel } from "@/domain/anexos";
import {
  historicoParaEnviar,
  MAX_CARACTERES_CHAT,
  notaDeDecisao,
  partesComLink,
  rodapeDoChat,
  rotuloLinkAcao,
  saudacaoDoChat,
} from "@/domain/chat";
import type { Proposta } from "@/domain/chat-acoes";
import { conversar } from "@/server/actions/chat";
import { cancelarAcaoChat, confirmarAcaoChat } from "@/server/actions/chat-acoes";
import { anexarNoChat, removerAnexoDoChat } from "@/server/actions/chat-anexos";
import { cx } from "./ui";

// Painel lateral do chat (spec §8). A conversa fica só na memória da página (R-C5): some ao recarregar.
// Toda ação proposta pelo modelo mostra um cartão de confirmação explícito; nada executa sem "Confirmar e executar".
// Links de trello.com, drive.google.com e docs.google.com viram links clicáveis; o restante fica como texto.

type AnexoChat = { id: string; nome: string; tamanho: number };

type EstadoProposta =
  | { fase: "pendente" }
  | { fase: "executando" }
  | { fase: "feita"; texto: string; link: string | null }
  | { fase: "cancelada" }
  | { fase: "erro"; erro: string }
  | { fase: "expirada" };

type Msg = {
  de: "eu" | "ia";
  texto: string;
  erro?: boolean;
  /** Nota fixa de decisão (confirmou/cancelou): vai no histórico ao modelo, sem balão repetido na tela. */
  oculto?: boolean;
  anexos?: AnexoChat[];
  propostas?: Proposta[];
};

function TextoComLinks({ texto, escuro }: { texto: string; escuro: boolean }) {
  const partes = partesComLink(texto);
  return (
    <>
      {partes.map((p, i) =>
        p.tipo === "link" ? (
          <a
            key={i}
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cx("break-all underline", escuro ? "text-white" : "font-medium text-verde hover:opacity-80")}
          >
            {p.url}
          </a>
        ) : (
          <span key={i}>{p.valor}</span>
        ),
      )}
    </>
  );
}

function ValorLinha({ valor }: { valor: string }) {
  const [expandido, setExpandido] = useState(false);
  const longo = valor.length > 260 || valor.split("\n").length > 6;
  return (
    <div>
      <p className={cx("whitespace-pre-wrap break-words text-[13px] leading-snug text-texto", longo && !expandido && "line-clamp-6")}>
        {valor}
      </p>
      {longo && (
        <button
          type="button"
          onClick={() => setExpandido((v) => !v)}
          className="mt-1 cursor-pointer text-[12px] font-semibold text-verde hover:underline"
        >
          {expandido ? "ver menos" : "ver tudo"}
        </button>
      )}
    </div>
  );
}

function CartaoProposta({
  proposta,
  estado,
  onConfirmar,
  onCancelar,
}: {
  proposta: Proposta;
  estado: EstadoProposta;
  onConfirmar: () => void;
  onCancelar: () => void;
}) {
  const [expiradaLocal, setExpiradaLocal] = useState(false);

  useEffect(() => {
    if (estado.fase !== "pendente") return;
    const falta = Date.parse(proposta.expiraEm) - Date.now();
    if (!Number.isFinite(falta)) return;
    const id = window.setTimeout(() => setExpiradaLocal(true), Math.max(0, falta));
    return () => window.clearTimeout(id);
  }, [estado.fase, proposta.expiraEm]);

  const faseAtual: EstadoProposta = estado.fase === "pendente" && expiradaLocal ? { fase: "expirada" } : estado;

  return (
    <div className="mt-2.5 rounded-[6px] border border-linha bg-fundo p-3 text-left">
      <p className="text-[11px] font-bold uppercase tracking-wider text-verde">{proposta.titulo}</p>
      <dl className="mt-2 space-y-1.5">
        {proposta.linhas.map(([rotulo, valor], idx) => (
          <div key={idx}>
            <dt className="text-[11px] font-semibold text-cinza">{rotulo}</dt>
            <dd>
              <ValorLinha valor={valor} />
            </dd>
          </div>
        ))}
      </dl>

      {(faseAtual.fase === "pendente" || faseAtual.fase === "executando") && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onConfirmar}
            disabled={faseAtual.fase === "executando"}
            className="cursor-pointer rounded-[5px] bg-verde px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#254B5C] disabled:cursor-default disabled:opacity-60"
          >
            {faseAtual.fase === "executando" ? "Executando…" : "Confirmar e executar"}
          </button>
          <button
            type="button"
            onClick={onCancelar}
            disabled={faseAtual.fase === "executando"}
            className="cursor-pointer rounded-[5px] border border-linha bg-white px-3 py-1.5 text-[13px] font-medium text-texto hover:bg-fundo disabled:cursor-default disabled:opacity-60"
          >
            Cancelar
          </button>
        </div>
      )}

      {faseAtual.fase === "feita" && (
        <div className="mt-3 rounded-[5px] border border-agua/30 bg-white px-2.5 py-2 text-[13px] text-texto">
          <p className="font-medium text-agua">Feito: {faseAtual.texto}</p>
          {faseAtual.link && (
            <a
              href={faseAtual.link}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-block text-[12.5px] font-semibold text-verde hover:underline"
            >
              {rotuloLinkAcao(faseAtual.link)}
            </a>
          )}
        </div>
      )}

      {faseAtual.fase === "cancelada" && (
        <p className="mt-2.5 text-[12.5px] font-medium text-cinza">Ação cancelada.</p>
      )}

      {faseAtual.fase === "erro" && (
        <div className="mt-3 rounded-[5px] border border-ouro/60 bg-ouro/15 px-2.5 py-2 text-[13px] text-texto">
          {faseAtual.erro}
        </div>
      )}

      {faseAtual.fase === "expirada" && (
        <div className="mt-3 rounded-[5px] border border-ouro/60 bg-ouro/15 px-2.5 py-2 text-[13px] text-texto">
          Esta ação expirou. Peça de novo.
        </div>
      )}
    </div>
  );
}

export function ChatIA({
  aberto,
  onFechar,
  perfilNome,
  trelloLigado = false,
  driveLigado = false,
}: {
  aberto: boolean;
  onFechar: () => void;
  perfilNome: string;
  trelloLigado?: boolean;
  driveLigado?: boolean;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [estados, setEstados] = useState<Record<string, EstadoProposta>>({});
  const [anexos, setAnexos] = useState<AnexoChat[]>([]);
  const [anexando, setAnexando] = useState(false);
  const [erroAnexo, setErroAnexo] = useState<string | null>(null);
  const [texto, setTexto] = useState("");
  const [pendente, iniciar] = useTransition();
  const fimRef = useRef<HTMLDivElement>(null);
  const campoRef = useRef<HTMLTextAreaElement>(null);
  const arquivoRef = useRef<HTMLInputElement>(null);

  const saudacao = saudacaoDoChat({ trello: trelloLigado, drive: driveLigado });
  const rodape = rodapeDoChat({ trello: trelloLigado, drive: driveLigado });

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: "end" });
  }, [msgs, pendente, estados]);
  useEffect(() => {
    if (aberto) campoRef.current?.focus();
  }, [aberto]);
  useEffect(() => {
    if (!aberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFechar();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [aberto, onFechar]);

  const escolherArquivo = async (file: File | undefined) => {
    if (!file || anexando) return;
    setErroAnexo(null);
    setAnexando(true);
    try {
      const fd = new FormData();
      fd.set("arquivo", file);
      const r = await anexarNoChat(fd);
      if (r.ok) {
        setAnexos((lista) => [...lista, { id: r.id, nome: r.nome, tamanho: r.tamanho }]);
      } else {
        setErroAnexo(r.erro);
      }
    } catch {
      setErroAnexo("Não foi possível anexar o arquivo. Tente de novo.");
    } finally {
      setAnexando(false);
      if (arquivoRef.current) arquivoRef.current.value = "";
    }
  };

  const removerAnexo = async (id: string) => {
    setErroAnexo(null);
    setAnexos((lista) => lista.filter((a) => a.id !== id));
    try {
      await removerAnexoDoChat(id);
    } catch {
      // removido localmente; se ainda existir no servidor, expira sozinho
    }
  };

  const enviar = () => {
    const t = texto.trim();
    if (!t || pendente || anexando) return;
    setErroAnexo(null);
    const anexosAtuais = [...anexos];
    const novas: Msg[] = [
      ...msgs,
      { de: "eu", texto: t, ...(anexosAtuais.length ? { anexos: anexosAtuais } : {}) },
    ];
    setMsgs(novas);
    setTexto("");
    iniciar(async () => {
      try {
        const ids = anexosAtuais.map((a) => a.id);
        const r = await conversar(historicoParaEnviar(novas), ids.length > 0 ? ids : undefined);
        if (r.ok) {
          if (r.propostas.length > 0) {
            setEstados((prev) => {
              const prox = { ...prev };
              for (const p of r.propostas) prox[p.id] = { fase: "pendente" };
              return prox;
            });
          }
          setMsgs((m) => [
            ...m,
            { de: "ia", texto: r.texto, ...(r.propostas.length ? { propostas: r.propostas } : {}) },
          ]);
        } else {
          setMsgs((m) => [...m, { de: "ia", texto: r.erro, erro: true }]);
        }
      } catch {
        setMsgs((m) => [...m, { de: "ia", texto: "Sem conexão com o sistema agora. Tente de novo.", erro: true }]);
      }
    });
  };

  const confirmar = async (proposta: Proposta) => {
    setEstados((prev) => ({ ...prev, [proposta.id]: { fase: "executando" } }));
    try {
      const r = await confirmarAcaoChat(proposta.id);
      if (r.ok) {
        setEstados((prev) => ({ ...prev, [proposta.id]: { fase: "feita", texto: r.texto, link: r.link } }));
        setMsgs((m) => [...m, { de: "eu", texto: notaDeDecisao("confirmou", proposta.titulo, "feito"), oculto: true }]);
        if (r.anexoConsumidoId) {
          setAnexos((lista) => lista.filter((a) => a.id !== r.anexoConsumidoId));
        }
      } else {
        const ehExpirada = r.erro === "Esta ação expirou. Peça de novo.";
        setEstados((prev) => ({
          ...prev,
          [proposta.id]: ehExpirada ? { fase: "expirada" } : { fase: "erro", erro: r.erro },
        }));
        setMsgs((m) => [...m, { de: "eu", texto: notaDeDecisao("confirmou", proposta.titulo, `erro: ${r.erro}`), oculto: true }]);
      }
    } catch {
      const msg = "Sem conexão com o sistema agora. Tente de novo.";
      setEstados((prev) => ({ ...prev, [proposta.id]: { fase: "erro", erro: msg } }));
    }
  };

  const cancelar = async (proposta: Proposta) => {
    setEstados((prev) => ({ ...prev, [proposta.id]: { fase: "executando" } }));
    try {
      const r = await cancelarAcaoChat(proposta.id);
      if (r.ok) {
        setEstados((prev) => ({ ...prev, [proposta.id]: { fase: "cancelada" } }));
        setMsgs((m) => [...m, { de: "eu", texto: notaDeDecisao("cancelou", proposta.titulo), oculto: true }]);
      } else {
        const ehExpirada = r.erro === "Esta ação expirou. Peça de novo.";
        setEstados((prev) => ({
          ...prev,
          [proposta.id]: ehExpirada ? { fase: "expirada" } : { fase: "erro", erro: r.erro },
        }));
      }
    } catch {
      setEstados((prev) => ({ ...prev, [proposta.id]: { fase: "erro", erro: "Sem conexão com o sistema agora. Tente de novo." } }));
    }
  };

  if (!aberto) return null;

  const visiveis = [{ de: "ia" as const, texto: saudacao }, ...msgs.filter((m) => !m.oculto)];
  const placeholder =
    trelloLigado || driveLigado
      ? "Pergunte ou peça uma ação"
      : "Pergunte sobre viagens, tarefas ou dailies";

  return (
    <>
      <button aria-label="Fechar chat" onClick={onFechar} className="fixed inset-0 z-40 cursor-default bg-texto/20" />
      <aside
        aria-label="Chat com IA"
        className="surgir fixed inset-y-0 right-0 z-50 flex w-[430px] max-w-full flex-col border-l border-linha bg-white shadow-[-12px_0_40px_rgba(51,49,50,0.14)]"
      >
        <header className="flex h-[58px] shrink-0 items-center justify-between bg-verde px-5 text-white">
          <div>
            <p className="text-[15px] font-bold">Chat com IA</p>
            <p className="text-[12px] text-white/75">Acesso de {perfilNome.toLowerCase()}</p>
          </div>
          <button onClick={onFechar} aria-label="Fechar" className="cursor-pointer rounded-full p-1.5 hover:bg-white/15">
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto bg-fundo px-4 py-4" aria-live="polite">
          {visiveis.map((m, i) => (
            <div key={i} className={cx("flex", m.de === "eu" ? "justify-end" : "justify-start")}>
              <div
                className={cx(
                  "max-w-[88%] whitespace-pre-wrap break-words rounded-[6px] px-3.5 py-2.5 text-[14px] leading-snug",
                  m.de === "eu"
                    ? "bg-verde text-white"
                    : "erro" in m && m.erro
                      ? "border border-ouro/60 bg-ouro/15 text-texto"
                      : "border border-linha bg-white text-texto",
                )}
              >
                <TextoComLinks texto={m.texto} escuro={m.de === "eu"} />
                {"anexos" in m && m.anexos && m.anexos.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {m.anexos.map((a) => (
                      <span
                        key={a.id}
                        className="inline-flex items-center gap-1 rounded-[4px] bg-white/15 px-2 py-0.5 text-[12px] text-white"
                      >
                        <Paperclip size={12} />
                        <span className="max-w-[180px] truncate">{a.nome}</span>
                        <span className="opacity-80">({tamanhoLegivel(a.tamanho)})</span>
                      </span>
                    ))}
                  </div>
                )}
                {"propostas" in m &&
                  m.propostas &&
                  m.propostas.map((p) => (
                    <CartaoProposta
                      key={p.id}
                      proposta={p}
                      estado={estados[p.id] ?? { fase: "pendente" }}
                      onConfirmar={() => confirmar(p)}
                      onCancelar={() => cancelar(p)}
                    />
                  ))}
              </div>
            </div>
          ))}
          {pendente && (
            <div className="flex justify-start">
              <div className="rounded-[6px] border border-linha bg-white px-3.5 py-2.5 text-[14px] text-cinza">Consultando…</div>
            </div>
          )}
          <div ref={fimRef} />
        </div>

        <div className="border-t border-linha bg-white p-3">
          {erroAnexo && (
            <div className="mb-2 rounded-[5px] border border-ouro/60 bg-ouro/15 px-2.5 py-1.5 text-[12.5px] text-texto">
              {erroAnexo}
            </div>
          )}
          {anexos.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {anexos.map((a) => (
                <span
                  key={a.id}
                  className="inline-flex items-center gap-1.5 rounded-[5px] border border-linha bg-fundo px-2 py-1 text-[12px] text-texto"
                >
                  <Paperclip size={12} className="shrink-0 text-verde" />
                  <span className="max-w-[180px] truncate font-medium">{a.nome}</span>
                  <span className="text-cinza">{tamanhoLegivel(a.tamanho)}</span>
                  <button
                    type="button"
                    onClick={() => removerAnexo(a.id)}
                    className="cursor-pointer font-semibold text-verde hover:underline"
                  >
                    remover
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-[6px] border border-linha px-2.5 py-1.5 focus-within:border-verde">
            {driveLigado && (
              <>
                <input
                  ref={arquivoRef}
                  type="file"
                  accept={ACEITA_ANEXO}
                  className="hidden"
                  onChange={(e) => escolherArquivo(e.target.files?.[0])}
                />
                <button
                  type="button"
                  onClick={() => arquivoRef.current?.click()}
                  disabled={anexando || pendente}
                  aria-label="Anexar arquivo"
                  title="Anexar PDF, PNG ou JPEG (até 5 MB)"
                  className="cursor-pointer rounded-[5px] p-2 text-cinza hover:bg-fundo hover:text-verde disabled:cursor-default disabled:opacity-50"
                >
                  <Paperclip size={16} />
                </button>
              </>
            )}
            <textarea
              ref={campoRef}
              rows={1}
              value={texto}
              maxLength={MAX_CARACTERES_CHAT}
              onChange={(e) => setTexto(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  enviar();
                }
              }}
              placeholder={anexando ? "Anexando arquivo…" : placeholder}
              aria-label="Pergunta"
              className="max-h-[120px] min-h-[34px] flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none"
            />
            <button
              type="button"
              onClick={enviar}
              disabled={pendente || anexando || !texto.trim()}
              aria-label="Enviar"
              className="cursor-pointer rounded-[5px] bg-verde p-2 text-white hover:bg-[#254B5C] disabled:cursor-default disabled:opacity-50"
            >
              <Send size={15} />
            </button>
          </div>
          <p className="mt-1.5 text-center text-[11px] text-cinza">{rodape}</p>
        </div>
      </aside>
    </>
  );
}
