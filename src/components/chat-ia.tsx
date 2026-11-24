"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Send, X } from "lucide-react";
import { historicoParaEnviar, MAX_CARACTERES_CHAT } from "@/domain/chat";
import { conversar } from "@/server/actions/chat";
import { cx } from "./ui";

// Painel lateral do chat (estrutura visual do protótipo). Só lê: sem anexo, sem microfone, sem confirmação de escrita.
// A conversa fica só na memória da página (R-C5): some ao recarregar. Ao servidor vão só `{ de, texto }`; a saudação
// fixa e as mensagens de erro não entram no histórico enviado.

type Msg = { de: "eu" | "ia"; texto: string; erro?: boolean };

const SAUDACAO_CHAT =
  "Posso responder perguntas sobre viagens, tarefas e dailies com o que o seu perfil pode ver. Por enquanto eu só leio: nada é salvo pelo chat.";

export function ChatIA({ aberto, onFechar, perfilNome }: { aberto: boolean; onFechar: () => void; perfilNome: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [texto, setTexto] = useState("");
  const [pendente, iniciar] = useTransition();
  const fimRef = useRef<HTMLDivElement>(null);
  const campoRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fimRef.current?.scrollIntoView({ block: "end" });
  }, [msgs, pendente]);
  useEffect(() => {
    if (aberto) campoRef.current?.focus();
  }, [aberto]);
  // Escape fecha o painel (como o clique fora).
  useEffect(() => {
    if (!aberto) return;
    const tecla = (e: KeyboardEvent) => {
      if (e.key === "Escape") onFechar();
    };
    window.addEventListener("keydown", tecla);
    return () => window.removeEventListener("keydown", tecla);
  }, [aberto, onFechar]);

  const enviar = () => {
    const t = texto.trim();
    if (!t || pendente) return;
    const novas = [...msgs, { de: "eu" as const, texto: t }];
    setMsgs(novas);
    setTexto("");
    iniciar(async () => {
      try {
        const r = await conversar(historicoParaEnviar(novas));
        setMsgs((m) => [...m, r.ok ? { de: "ia", texto: r.texto } : { de: "ia", texto: r.erro, erro: true }]);
      } catch {
        setMsgs((m) => [...m, { de: "ia", texto: "Sem conexão com o sistema agora. Tente de novo.", erro: true }]);
      }
    });
  };

  if (!aberto) return null;
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
          {[{ de: "ia" as const, texto: SAUDACAO_CHAT }, ...msgs].map((m, i) => (
            <div key={i} className={cx("flex", m.de === "eu" ? "justify-end" : "justify-start")}>
              <div
                className={cx(
                  "max-w-[88%] whitespace-pre-wrap break-words rounded-[6px] px-3.5 py-2.5 text-[14px] leading-snug",
                  m.de === "eu"
                    ? "bg-verde text-white"
                    : "erro" in m && m.erro
                      ? "border border-ouro/60 bg-white text-cinza"
                      : "border border-linha bg-white text-texto",
                )}
              >
                {m.texto}
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
          <div className="flex items-end gap-2 rounded-[6px] border border-linha px-2.5 py-1.5 focus-within:border-verde">
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
              placeholder="Pergunte sobre viagens, tarefas ou dailies"
              aria-label="Pergunta"
              className="max-h-[120px] min-h-[34px] flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none"
            />
            <button
              onClick={enviar}
              disabled={pendente || !texto.trim()}
              aria-label="Enviar"
              className="cursor-pointer rounded-[5px] bg-verde p-2 text-white hover:bg-[#254B5C] disabled:cursor-default disabled:opacity-50"
            >
              <Send size={15} />
            </button>
          </div>
          <p className="mt-1.5 text-center text-[11px] text-cinza">Segue o seu nível de acesso. A conversa some ao recarregar a página.</p>
        </div>
      </aside>
    </>
  );
}
