"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { Badge, Botao, Card, Tabs, cx, inputCls } from "@/components/ui";
import { conferirDaily, dataDeGeracao } from "@/domain/daily";
import type { Idioma } from "@/domain/roteiro";
import { dataBr } from "@/domain/tarefas";
import {
  desfazerEnvio,
  gerarDaily,
  marcarEnviado,
  marcarRevisado,
  salvarInterno,
  salvarTextoDaily,
} from "@/server/actions/dailies";
import type { DailyTela } from "@/server/queries/operacao";
import { ComReescrita } from "../reescrever";

type Aviso = { msg: string; tipo: "erro" | "conflito" | "ok" } | null;
type Resultado = { ok: true; atualizadoEm?: string } | { ok: false; erro: string; conflito?: true };

const ddmm = (d: string) => dataBr(d).slice(0, 5);

const quando = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Cuiaba",
  day: "2-digit",
  month: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function dataHora(iso: string): string {
  const p = Object.fromEntries(quando.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} às ${p.hour}h${p.minute}`;
}

const DESCARTAR_AO_TROCAR = "Há alterações não salvas neste dia. Trocar de dia e descartá-las?";
const DESCARTAR_INTERNO_AO_GERAR = "A versão interna tem alterações não salvas e será recarregada. Gerar mesmo assim?";

const NOTA_INTERNA = "A versão interna não é enviada ao cliente. Serve para o controle de plantão.";

function FaixaAviso({ aviso }: { aviso: Aviso }) {
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
        <button type="button" onClick={() => window.location.reload()} className="mt-1 cursor-pointer font-semibold text-verde underline">
          Recarregar
        </button>
      )}
    </div>
  );
}

export function Dailies({
  roteiro,
  destino,
  encerramento,
  usuarios,
  dias,
  diaInicial,
  iaLigada,
}: {
  roteiro: { id: string; idioma: Idioma; fuso: string };
  destino: string;
  encerramento: string;
  usuarios: { id: string; nome: string }[];
  dias: DailyTela[];
  diaInicial: string;
  /** "Reescrever com IA" só aparece com a IA configurada. */
  iaLigada: boolean;
}) {
  const [aberto, setAberto] = useState(diaInicial);
  const dia = dias.find((d) => d.data === aberto) ?? dias[0];
  // O painel do dia avisa aqui se tem alterações não salvas; trocar de dia desmonta o painel e as perderia.
  const sujo = useRef(false);
  const aoMudarSujo = useCallback((v: boolean) => {
    sujo.current = v;
  }, []);

  function abrir(data: string) {
    if (data === dia?.data) return;
    if (sujo.current && !window.confirm(DESCARTAR_AO_TROCAR)) return;
    sujo.current = false;
    setAberto(data);
    // Mantém o dia aberto num recarregamento, sem nova navegação.
    window.history.replaceState(null, "", `?dia=${data}`);
  }

  if (!dia) return <p className="text-[14px] text-cinza">O roteiro não tem dias.</p>;

  return (
    <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-6">
      <Card className="overflow-hidden">
        <p className="border-b border-linha px-4 py-3 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Dias do roteiro</p>
        <ul className="max-h-[calc(100vh-260px)] overflow-y-auto">
          {dias.map((d) => {
            const ativo = d.data === dia.data;
            return (
              <li key={d.data}>
                <button
                  type="button"
                  onClick={() => abrir(d.data)}
                  aria-current={ativo ? "true" : undefined}
                  className={cx(
                    "flex w-full cursor-pointer flex-col gap-1 border-b border-l-[3px] border-b-linha px-4 py-3 text-left transition-colors",
                    ativo ? "border-l-verde bg-verde/[0.06]" : "border-l-transparent hover:bg-fundo",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={cx("num text-[14px] text-texto", ativo ? "font-bold" : "font-semibold")}>{d.rotuloDia}</span>
                  </span>
                  <span className="text-[13px] text-cinza">{d.cidade}</span>
                  <Badge tom={d.estado.tom}>{d.estado.rotulo}</Badge>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      <PainelDia
        key={dia.data}
        roteiro={roteiro}
        destino={destino}
        encerramento={encerramento}
        usuarios={usuarios}
        dia={dia}
        aoMudarSujo={aoMudarSujo}
        iaLigada={iaLigada}
      />
    </div>
  );
}

function PainelDia({
  roteiro,
  destino,
  encerramento,
  usuarios,
  dia,
  aoMudarSujo,
  iaLigada,
}: {
  roteiro: { id: string; idioma: Idioma; fuso: string };
  destino: string;
  encerramento: string;
  usuarios: { id: string; nome: string }[];
  dia: DailyTela;
  aoMudarSujo: (sujo: boolean) => void;
  iaLigada: boolean;
}) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [aba, setAba] = useState<"cliente" | "interno">("cliente");
  const [aviso, setAviso] = useState<Aviso>(null);
  const [confirmar, setConfirmar] = useState(false);

  const d = dia.daily;
  const srvVersao = d?.atualizadoEm ?? null;
  const srvTexto = d && d.estado !== "pendente" ? (d.texto ?? "") : "";
  const srvPlantao = d?.plantao?.id ?? "";
  const srvInterno = d?.interno ?? "";

  // Uma versão por linha (as duas abas gravam a mesma linha). Ela vem das próprias ações e, quando a tela recarrega
  // os dados, só é aceita junto com o conteúdo do servidor: nunca por cima de alterações não salvas de outra pessoa.
  const [visto, setVisto] = useState(srvVersao);
  const [versao, setVersao] = useState(srvVersao);
  const [texto, setTexto] = useState(srvTexto);
  const [baseTexto, setBaseTexto] = useState(srvTexto);
  const [plantao, setPlantao] = useState(srvPlantao);
  const [interno, setInterno] = useState(srvInterno);
  const [baseInterno, setBaseInterno] = useState({ plantao: srvPlantao, interno: srvInterno });
  const [forcar, setForcar] = useState(false);
  const textoSujo = texto !== baseTexto;
  const internoSujo = plantao !== baseInterno.plantao || interno !== baseInterno.interno;
  const algoSujo = textoSujo || internoSujo;

  // Como no editor do roteiro: avisa a lista de dias e pede confirmação ao sair da página com alterações não salvas.
  useEffect(() => {
    aoMudarSujo(algoSujo);
    if (!algoSujo) return;
    const aoSair = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", aoSair);
    return () => window.removeEventListener("beforeunload", aoSair);
  }, [algoSujo, aoMudarSujo]);

  if (srvVersao !== visto) {
    setVisto(srvVersao);
    if (forcar || versao === srvVersao || (!textoSujo && !internoSujo)) {
      setVersao(srvVersao);
      if (forcar || !textoSujo) {
        setTexto(srvTexto);
        setBaseTexto(srvTexto);
      }
      if (forcar || !internoSujo) {
        setPlantao(srvPlantao);
        setInterno(srvInterno);
        setBaseInterno({ plantao: srvPlantao, interno: srvInterno });
      }
      setForcar(false);
    }
  }

  const temTexto = !!d && d.estado !== "pendente";
  const enviado = d?.estado === "enviado";
  const indicadores = temTexto ? conferirDaily(texto, { troca: dia.troca, idioma: roteiro.idioma, encerramento }) : null;
  const falhas = indicadores?.filter((i) => !i.ok).length ?? 0;

  function rodar(acao: () => Promise<Resultado>, okMsg: string | null, depois?: (r: { atualizadoEm?: string }) => void) {
    setAviso(null);
    iniciar(async () => {
      const r = await acao();
      if (!r.ok) {
        setAviso({ msg: r.erro, tipo: r.conflito ? "conflito" : "erro" });
        return;
      }
      if (r.atualizadoEm) setVersao(r.atualizadoEm);
      depois?.(r);
      if (okMsg) setAviso({ msg: okMsg, tipo: "ok" });
      router.refresh();
    });
  }

  function gerar() {
    // Gerar recarrega a linha inteira (texto e versão interna); não descarta edições internas sem perguntar.
    if (internoSujo && !window.confirm(DESCARTAR_INTERNO_AO_GERAR)) return;
    setConfirmar(false);
    rodar(() => gerarDaily(roteiro.id, dia.data, versao ?? undefined), "Texto gerado. Revise antes de enviar.", () => setForcar(true));
  }

  function salvarTexto() {
    if (!d) return;
    const enviadoTexto = texto;
    rodar(() => salvarTextoDaily(d.id, enviadoTexto, versao ?? ""), "Mensagem salva.", () => setBaseTexto(enviadoTexto));
  }

  function salvarVersaoInterna() {
    const dados = { plantaoId: plantao || null, interno };
    rodar(() => salvarInterno(roteiro.id, dia.data, dados, versao ?? undefined), "Versão interna salva.", () =>
      setBaseInterno({ plantao: dados.plantaoId ?? "", interno: dados.interno }),
    );
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setAviso({ msg: "Mensagem copiada", tipo: "ok" });
    } catch {
      setAviso({ msg: "Não foi possível copiar. Selecione o texto e copie manualmente.", tipo: "erro" });
    }
  }

  return (
    <Card className="px-6 py-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="text-[18px] font-bold text-texto">{dia.rotuloDia}</h3>
            <Badge tom={dia.estado.tom}>{dia.estado.rotulo}</Badge>
          </div>
          <p className="mt-1 text-[13.5px] text-cinza">
            {dia.cidade} · Enviar no dia anterior: <span className="num font-semibold text-texto">{ddmm(dia.dataEnvio)}</span>
          </p>
          {d?.enviadoEm && (
            <p className="mt-1 text-[13.5px] text-cinza">
              Enviado por {d.enviadoPor ?? "—"} em {dataHora(d.enviadoEm)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!temTexto &&
            (dia.estado.noPrazoDeGerar ? (
              <Botao onClick={gerar} disabled={pendente}>Gerar texto</Botao>
            ) : (
              <>
                <span className="text-[13px] text-cinza">Gera em {ddmm(dataDeGeracao(dia.data))}</span>
                <Botao variante="secundario" onClick={gerar} disabled={pendente}>Gerar agora</Botao>
              </>
            ))}
          {temTexto && !enviado && !confirmar && (
            <Botao variante="secundario" onClick={() => setConfirmar(true)} disabled={pendente}>Gerar de novo</Botao>
          )}
        </div>
      </div>

      {confirmar && (
        <div role="alert" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          <span>O texto atual será substituído pelo modelo e o daily volta a &quot;Gerado, a revisar&quot;.</span>
          <span className="flex gap-2">
            <Botao onClick={gerar} disabled={pendente}>Gerar de novo</Botao>
            <Botao variante="secundario" onClick={() => setConfirmar(false)}>Cancelar</Botao>
          </span>
        </div>
      )}

      {dia.roteiroMudou && !enviado && !confirmar && (
        <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          <span className="font-semibold">O roteiro mudou depois que este daily foi gerado.</span>
          <Botao variante="secundario" onClick={() => setConfirmar(true)} disabled={pendente}>Gerar de novo</Botao>
        </div>
      )}

      <FaixaAviso aviso={aviso} />

      <Tabs
        value={aba}
        onChange={setAba}
        options={[
          { value: "cliente", label: "Para o cliente" },
          { value: "interno", label: "Interno (plantão)" },
        ]}
      />

      {aba === "cliente" ? (
        temTexto ? (
          <div className="mt-5 grid grid-cols-[minmax(0,1fr)_340px] gap-6">
            <div>
              <label htmlFor={`texto-${dia.data}`} className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">
                Mensagem ao cliente
              </label>
              {/* Enviado é só leitura: sem "Reescrever com IA". */}
              <ComReescrita
                ligada={iaLigada && !enviado}
                texto={texto}
                finalidade="daily"
                idioma={roteiro.idioma}
                roteiroId={roteiro.id}
                onUsar={setTexto}
              >
                <textarea
                  id={`texto-${dia.data}`}
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                  readOnly={enviado}
                  rows={20}
                  maxLength={8000}
                  className={cx(inputCls, "resize-y font-[inherit] leading-[1.55]", enviado && "bg-fundo text-cinza")}
                />
              </ComReescrita>
              {enviado && <p className="mt-1.5 text-[13px] text-cinza">Daily já enviado: desfaça o envio para editar.</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {!enviado && (
                  <Botao onClick={salvarTexto} disabled={pendente || !textoSujo || texto.trim() === ""}>Salvar mensagem</Botao>
                )}
                <Botao variante="secundario" onClick={copiar} disabled={textoSujo}>
                  <Copy size={15} aria-hidden /> Copiar mensagem
                </Botao>
                {d?.estado === "gerado" && (
                  <Botao variante="secundario" onClick={() => rodar(() => marcarRevisado(d.id), "Daily pronto para enviar.")} disabled={pendente || textoSujo}>
                    Marcar como revisado
                  </Botao>
                )}
                {(d?.estado === "gerado" || d?.estado === "revisado") && (
                  <Botao variante="secundario" onClick={() => rodar(() => marcarEnviado(d.id), "Daily marcado como enviado.")} disabled={pendente || textoSujo}>
                    Marcar como enviado
                  </Botao>
                )}
                {enviado && d && (
                  <Botao variante="secundario" onClick={() => rodar(() => desfazerEnvio(d.id), "Envio desfeito.")} disabled={pendente}>
                    Desfazer envio
                  </Botao>
                )}
              </div>
              {textoSujo && <p className="mt-2 text-[13px] text-cinza">Salve a mensagem antes de copiar ou mudar o estado.</p>}
            </div>
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Padrão do daily ECLAK</p>
              <p className="mb-3 text-[13px] text-cinza">
                {falhas === 0 ? "Os 6 itens conferem." : `${falhas} ${falhas === 1 ? "item a conferir" : "itens a conferir"}. Não bloqueia o envio.`}
              </p>
              <ul className="space-y-3">
                {indicadores!.map((i) => (
                  <li key={i.nome} className="flex gap-2.5 text-[13.5px]">
                    {i.ok ? (
                      <Check size={16} className="mt-0.5 shrink-0 text-verde" aria-label="Confere" />
                    ) : (
                      <TriangleAlert size={16} className="mt-0.5 shrink-0 text-ouro" aria-label="A conferir" />
                    )}
                    <span>
                      <span className={cx("block text-texto", !i.ok && "font-semibold")}>{i.nome}</span>
                      {!i.ok && <span className="mt-0.5 block text-[13px] text-cinza">{i.dica}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ) : (
          <div className="mt-5 rounded-[5px] border border-dashed border-linha px-6 py-10 text-center">
            <p className="text-[14px] font-semibold text-texto">Texto ainda não gerado</p>
            <p className="mt-1 text-[13.5px] text-cinza">
              O texto sai do roteiro deste dia, com a saudação em {saudacaoDe(roteiro.idioma)} e o encerramento definido em Parâmetros.
            </p>
          </div>
        )
      ) : (
        <div className="mt-5 space-y-5">
          <div>
            <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Horários do dia</p>
            {dia.horarios.length === 0 ? (
              <p className="text-[13.5px] text-cinza">Nenhum item com horário neste dia do roteiro.</p>
            ) : (
              <table className="w-full border-collapse text-[14px]">
                <thead>
                  <tr>
                    <th className="bg-fundo px-3 py-2 text-left text-[11px] font-bold uppercase tracking-[0.06em] text-verde">Item</th>
                    <th className="bg-fundo px-3 py-2 text-right text-[11px] font-bold uppercase tracking-[0.06em] text-verde">Horário em {dia.cidade || destino}</th>
                    <th className="bg-fundo px-3 py-2 text-right text-[11px] font-bold uppercase tracking-[0.06em] text-verde">Horário em Mato Grosso</th>
                    <th className="bg-fundo px-3 py-2 text-right text-[11px] font-bold uppercase tracking-[0.06em] text-verde">Horário em Brasília</th>
                  </tr>
                </thead>
                <tbody>
                  {dia.horarios.map((h, i) => (
                    <tr key={`${h.hora}-${i}`} className="border-t border-linha">
                      <td className="px-3 py-2.5">{h.titulo}</td>
                      <td className="num px-3 py-2.5 text-right font-semibold">{h.destino}</td>
                      <td className="num px-3 py-2.5 text-right">{h.mt}</td>
                      <td className="num px-3 py-2.5 text-right">{h.brasilia}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-5">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Plantão do dia</span>
              <select value={plantao} onChange={(e) => setPlantao(e.target.value)} className={cx(inputCls, "cursor-pointer")}>
                <option value="">Sem plantão definido</option>
                {usuarios.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nome}
                  </option>
                ))}
                {d?.plantao && !usuarios.some((u) => u.id === d.plantao!.id) && (
                  <option value={d.plantao.id}>{d.plantao.nome} (inativo)</option>
                )}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Localizadores e contatos</span>
              <textarea
                value={interno}
                onChange={(e) => setInterno(e.target.value)}
                rows={8}
                maxLength={4000}
                placeholder="Localizadores, telefone do plantão, guia, motorista, apoio local"
                className={cx(inputCls, "resize-y font-[inherit] leading-[1.55]")}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-cinza">{NOTA_INTERNA}</p>
            <Botao onClick={salvarVersaoInterna} disabled={pendente || !internoSujo}>Salvar versão interna</Botao>
          </div>
        </div>
      )}
    </Card>
  );
}

const IDIOMA_NA_FRASE: Record<Idioma, string> = {
  italiano: "italiano",
  espanhol: "espanhol",
  frances: "francês",
  ingles: "inglês",
  alemao: "alemão",
  portugues: "português",
};
const saudacaoDe = (i: Idioma) => IDIOMA_NA_FRASE[i];
