"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { FileText, Paperclip } from "lucide-react";
import { Botao, Eyebrow } from "@/components/ui";
import { ACEITA_ANEXO, MSG_TAMANHO_ANEXO, TAMANHO_MAXIMO_ANEXO, tamanhoLegivel, type DonoAnexo } from "@/domain/anexos";
import { enviarAnexo, linkDoAnexo, removerAnexo } from "@/server/actions/anexos";
import type { AnexoItem } from "@/server/queries/anexos";

const MSG_FALHA = "Não foi possível concluir. Tente de novo.";

const dataHora = (d: Date) =>
  new Date(d).toLocaleString("pt-BR", { timeZone: "America/Cuiaba", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * Anexos de um lançamento (comprovante, boleto, nota): lista, enviar, abrir (URL assinada de 60 s) e remover.
 * O tipo e o tamanho são conferidos de novo no servidor, pelos bytes; aqui o tamanho só evita mandar o que vai ser
 * recusado.
 */
export function Anexos({ donoTipo, donoId, anexos, className }: { donoTipo: DonoAnexo; donoId: string; anexos: AnexoItem[]; className?: string }) {
  const router = useRouter();
  const campo = useRef<HTMLInputElement>(null);
  const [pendente, iniciar] = useTransition();
  const [erro, setErro] = useState<string | null>(null);

  function enviar(arquivo: File | undefined) {
    if (campo.current) campo.current.value = "";
    if (!arquivo) return;
    setErro(null);
    if (arquivo.size > TAMANHO_MAXIMO_ANEXO) {
      setErro(MSG_TAMANHO_ANEXO);
      return;
    }
    const dados = new FormData();
    dados.set("donoTipo", donoTipo);
    dados.set("donoId", donoId);
    dados.set("arquivo", arquivo);
    iniciar(async () => {
      try {
        const r = await enviarAnexo(dados);
        if (r.ok) router.refresh();
        else setErro(r.erro);
      } catch {
        setErro(MSG_FALHA);
      }
    });
  }

  function abrir(a: AnexoItem) {
    setErro(null);
    // A aba abre já no clique (senão o bloqueador de pop-up barra); o endereço chega depois.
    const aba = window.open("about:blank", "_blank");
    iniciar(async () => {
      try {
        const r = await linkDoAnexo(a.id);
        if (r.ok) {
          if (aba) {
            aba.opener = null;
            aba.location.href = r.url;
          } else window.location.assign(r.url);
        } else {
          aba?.close();
          setErro(r.erro);
        }
      } catch {
        aba?.close();
        setErro(MSG_FALHA);
      }
    });
  }

  function remover(a: AnexoItem) {
    if (!window.confirm(`Remover o anexo "${a.nome}"? Ele sai da lista; o registro do envio fica no histórico.`)) return;
    setErro(null);
    iniciar(async () => {
      try {
        const r = await removerAnexo(a.id);
        if (r.ok) router.refresh();
        else setErro(r.erro);
      } catch {
        setErro(MSG_FALHA);
      }
    });
  }

  return (
    <section className={className} aria-label="Anexos">
      <div className="flex items-end justify-between gap-3">
        <div>
          <Eyebrow>Anexos{anexos.length > 0 ? ` · ${anexos.length}` : ""}</Eyebrow>
          <p className="mt-0.5 text-[12.5px] text-cinza">PDF, PNG ou JPEG, até 10 MB.</p>
        </div>
        <input ref={campo} type="file" accept={ACEITA_ANEXO} className="hidden" aria-label="Arquivo para anexar" onChange={(e) => enviar(e.target.files?.[0])} />
        <Botao variante="secundario" className="!px-3 !py-1.5 !text-[13px]" disabled={pendente} onClick={() => campo.current?.click()}>
          <Paperclip size={15} /> {pendente ? "Aguarde..." : "Anexar arquivo"}
        </Botao>
      </div>
      {anexos.length === 0 ? (
        <p className="mt-3 rounded-[5px] border border-dashed border-linha px-4 py-4 text-center text-[13px] text-cinza">Nenhum anexo ainda.</p>
      ) : (
        <ul className="mt-3 divide-y divide-linha rounded-[5px] border border-linha">
          {anexos.map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText size={17} className="shrink-0 text-verde" aria-hidden />
              <div className="min-w-0 flex-1">
                <button onClick={() => abrir(a)} disabled={pendente} className="block max-w-full cursor-pointer truncate text-left text-[14px] font-semibold text-verde hover:underline disabled:cursor-wait">
                  {a.nome}
                </button>
                <span className="block text-[12px] text-cinza">
                  {tamanhoLegivel(a.tamanho)} · {a.enviadoPorNome} · {dataHora(a.enviadoEm)}
                </span>
              </div>
              <Botao variante="fantasma" className="!px-2.5 !py-1 !text-[13px]" disabled={pendente} onClick={() => remover(a)}>
                Remover
              </Botao>
            </li>
          ))}
        </ul>
      )}
      {erro && (
        <p role="alert" className="mt-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
          {erro}
        </p>
      )}
    </section>
  );
}
