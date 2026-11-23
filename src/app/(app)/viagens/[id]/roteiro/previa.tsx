// Documento do roteiro (RT) ao cliente: usado na prévia do editor (cliente) e na impressão (servidor).
// Módulo só de apresentação: sem "use client", sem hooks e sem nada de `@/components/ui` (que é cliente).
import type { ReactNode } from "react";
import { noitesDoHotel, rotuloDiaRoteiro, type ConteudoRoteiro, type HotelRoteiro, type StatusRoteiro } from "@/domain/roteiro";
import { dataBr } from "@/domain/tarefas";

export const NOTA_VOOS = "Horários de voos sujeitos a alteração pela companhia aérea.";

export const ROTULO_STATUS_ROTEIRO: Record<StatusRoteiro, string> = {
  rascunho: "Rascunho",
  aguardando_cliente: "Aguardando o cliente",
  aprovado: "Aprovado pelo cliente",
};

export const TOM_STATUS_ROTEIRO: Record<StatusRoteiro, "cinza" | "ouro" | "agua"> = {
  rascunho: "cinza",
  aguardando_cliente: "ouro",
  aprovado: "agua",
};

/** Rodapé fixo do RT, texto exato do spec §5.4. */
export function RodapeRoteiro() {
  return (
    <p className="text-[11.5px] leading-snug text-texto">
      <strong>ATENÇÃO:</strong> confira sempre o horário oficial no voucher da atração e 24h antes com o nosso customer care, disponível no WhatsApp.
    </p>
  );
}

/** Link de mapa do hotel: o informado ou uma busca pelo nome e cidade (`%20`, não "+", D14). */
export function mapaDoHotel(h: HotelRoteiro): string {
  return h.mapa ?? `https://maps.google.com/?q=${encodeURIComponent(`${h.nome} ${h.cidade}`.trim())}`;
}

const ddmm = (d: string | null) => (d ? dataBr(d).slice(0, 5) : "");

function Secao({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="mt-6 break-inside-avoid-page">
      <h2 className="mb-2 border-b border-linha pb-1 text-[11px] font-bold uppercase tracking-[0.08em] text-verde">{titulo}</h2>
      {children}
    </section>
  );
}

const linkCls = "font-semibold text-verde underline decoration-verde/30 underline-offset-2";

export function DocumentoRoteiro({ destino, abertura, conteudo }: { destino: string; abertura: string; conteudo: ConteudoRoteiro }) {
  const { hoteis, voos, dias } = conteudo;
  return (
    <div className="text-[13px] leading-relaxed text-texto">
      <header className="flex items-end justify-between gap-6 border-b-2 border-verde pb-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-eclak.png" alt="ECLAK Viagens" className="h-[40px] w-auto" />
        <p className="text-right text-[12px] font-bold uppercase tracking-[0.08em] text-verde">Roteiro de viagem · {destino.toUpperCase()}</p>
      </header>

      {abertura.trim() && (
        <Secao titulo="Sua viagem">
          <p className="whitespace-pre-line">{abertura}</p>
        </Secao>
      )}

      {hoteis.length > 0 && (
        <Secao titulo="Hotéis">
          <table className="w-full border-collapse text-[12.5px]">
            <tbody>
              {hoteis.map((h, i) => (
                <tr key={i} className="border-b border-linha align-top last:border-0">
                  <td className="w-[26%] py-1.5 pr-3 font-semibold">{h.cidade}</td>
                  <td className="py-1.5 pr-3">
                    {h.nome}
                    {(h.horaCheckin || h.horaCheckout) && (
                      <span className="block text-[11.5px] text-cinza">
                        {h.horaCheckin && `Check-in ${h.horaCheckin}`}
                        {h.horaCheckin && h.horaCheckout && " · "}
                        {h.horaCheckout && `Check-out ${h.horaCheckout}`}
                      </span>
                    )}
                  </td>
                  <td className="num w-[34%] py-1.5 pr-3 text-cinza">{noitesDoHotel(h) ?? ""}</td>
                  <td className="w-[44px] py-1.5 text-right">
                    <a href={mapaDoHotel(h)} className={linkCls}>Mapa</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Secao>
      )}

      {voos.length > 0 && (
        <Secao titulo="Voos">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[10px] font-bold uppercase tracking-[0.06em] text-cinza">
                <th className="py-1 pr-3 font-bold">Data</th>
                <th className="py-1 pr-3 font-bold">Voo</th>
                <th className="py-1 pr-3 font-bold">Trecho</th>
                <th className="py-1 pr-3 font-bold">Saída</th>
                <th className="py-1 font-bold">Chegada</th>
              </tr>
            </thead>
            <tbody>
              {voos.map((v, i) => (
                <tr key={i} className="num border-t border-linha">
                  <td className="py-1.5 pr-3">{ddmm(v.data)}</td>
                  <td className="py-1.5 pr-3">{v.voo}</td>
                  <td className="py-1.5 pr-3 font-semibold">{v.trecho}</td>
                  <td className="py-1.5 pr-3">{v.saida ?? ""}</td>
                  <td className="py-1.5">{v.chegada ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11.5px] text-cinza">{NOTA_VOOS}</p>
        </Secao>
      )}

      {dias.map((d) => (
        <section key={d.data} className="mt-7 break-inside-avoid-page">
          <div className="flex flex-wrap items-baseline gap-x-3 border-b border-verde/40 pb-1">
            <h3 className="num text-[13px] font-bold text-verde">{rotuloDiaRoteiro(d.data)}</h3>
            {d.titulo && <p className="text-[14px] font-bold">{d.titulo}</p>}
          </div>

          {d.itens.length > 0 && (
            <ul className="mt-2 space-y-2">
              {d.itens.map((it, i) => (
                <li key={i} className="grid grid-cols-[48px_minmax(0,1fr)] gap-x-2 break-inside-avoid">
                  <span className="num font-bold text-verde">{it.hora ?? ""}</span>
                  <div>
                    <p className="font-semibold">{it.titulo}</p>
                    {it.texto && <p className="whitespace-pre-line">{it.texto}</p>}
                    {it.mapa && <a href={it.mapa} className={`${linkCls} text-[12px]`}>Ver no mapa</a>}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {d.dica && (d.dica.tema.trim() || d.dica.texto.trim()) && (
            <div className="mt-3 break-inside-avoid border-l-[3px] border-terracota bg-fundo px-3 py-2">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-texto">
                DICA ECLAK{d.dica.tema.trim() ? ` · ${d.dica.tema.trim().toUpperCase()}` : ""}
              </p>
              <p className="mt-0.5 whitespace-pre-line">{d.dica.texto}</p>
            </div>
          )}

          {d.porque && (
            <div className="mt-3 break-inside-avoid">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-verde">POR QUE ESCOLHEMOS</p>
              <p className="mt-0.5 whitespace-pre-line">{d.porque}</p>
            </div>
          )}

          {d.gastro.length > 0 && (
            <div className="mt-3 break-inside-avoid">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.08em] text-verde">SUGESTÕES GASTRONÔMICAS</p>
              <table className="mt-1 w-full border-collapse text-[12.5px]">
                <tbody>
                  {d.gastro.map((linha, i) => (
                    <tr key={i} className="border-b border-linha align-top last:border-0">
                      {linha.split(" | ").map((col, j) => (
                        <td key={j} className={`py-1 pr-3 ${j === 0 ? "font-semibold" : ""}`}>{col}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
