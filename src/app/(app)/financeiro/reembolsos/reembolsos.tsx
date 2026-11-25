"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Paperclip, Plus } from "lucide-react";
import { Anexos } from "@/components/anexos";
import { Badge, BotaoLink, Botao, Campo, Card, CardHeader, Eyebrow, PageHeader, Tabs, cx, inputCls } from "@/components/ui";
import { formatarReais, lerReais } from "@/domain/dinheiro";
import { FORMAS_DEVOLUCAO, ROTULO_FORMA_DEVOLUCAO, geraContaAPagar, type FormaDevolucao, type SituacaoReembolso } from "@/domain/reembolsos";
import {
  cancelarReembolso,
  clienteReembolsado,
  desfazerMarco,
  editarReembolso,
  fornecedorPagou,
  marcarPedido,
  registrarReembolso,
} from "@/server/actions/reembolsos";
import type { AnexoItem } from "@/server/queries/anexos";
import type { ReembolsoCaso, ResumoReembolsos } from "@/server/queries/reembolsos";
import { useAcao } from "../../viagens/[id]/acao";
import { dataBr, reaisParaCampo } from "../../viagens/formatos";
import { CampoConta, Dialogo, ErroAcao, contaPadrao, marca, type ContaOpcao } from "../lancamentos/baixa";

export type AbaReembolsos = "abertos" | "concluidos";
type Acao = ReturnType<typeof useAcao>;
type Opcao = { id: string; rotulo: string };
type Servico = { contaId: string; servico: string; fornecedor: string | null };
type CasoTela = ReembolsoCaso & { anexos: number };
type Registro = { viagens: Opcao[]; viagemId: string | null; servicos: Servico[] };
type Aberto = { tipo: "pedido" | "fornecedor" | "cliente" | "cancelar"; caso: CasoTela } | null;

const reais = (c: bigint) => formatarReais(c);
const BASE = "/financeiro/reembolsos";
/** Serviço fora das contas da viagem: texto livre, sem fornecedor. */
const OUTRO = "outro";

/** Situação: "Concluído" na cor da marca, as abertas em ouro, "Cancelado" neutro (nunca vermelho). */
const tomDa = (s: SituacaoReembolso) => (s === "Concluído" ? "verde" : s === "Cancelado" ? "cinza" : "ouro");

function urlDe(aba: AbaReembolsos, extra: Record<string, string> = {}) {
  const q = new URLSearchParams();
  if (aba === "concluidos") q.set("aba", aba);
  for (const [k, v] of Object.entries(extra)) q.set(k, v);
  const t = q.toString();
  return t ? `${BASE}?${t}` : BASE;
}

/** Centavos do campo; vazio = 0; ilegível = null (o servidor responde no campo). */
function centavosDe(t: string): bigint | null {
  if (!t.trim()) return 0n;
  try {
    return lerReais(t);
  } catch {
    return null;
  }
}

/**
 * Reembolsos: cartões de resumo, abas Abertos / Concluídos, o registro (ou a edição) do caso e um cartão por caso com
 * os dois lados (cobrar do fornecedor, devolver ao cliente) e os passos de cada um.
 */
export function Reembolsos({
  aba,
  hoje,
  casos,
  resumo,
  contas,
  registro,
  edicao,
  anexosDe,
  anexos,
}: {
  aba: AbaReembolsos;
  hoje: string;
  casos: CasoTela[];
  resumo: ResumoReembolsos;
  contas: ContaOpcao[];
  registro: Registro | null;
  edicao: ReembolsoCaso | null;
  anexosDe: string | null;
  anexos: AnexoItem[];
}) {
  const router = useRouter();
  const [aberto, setAberto] = useState<Aberto>(null);
  const fechar = () => setAberto(null);
  const ir = (extra: Record<string, string> = {}) => router.push(urlDe(aba, extra), { scroll: false });
  const doAnexo = anexosDe ? casos.find((c) => c.id === anexosDe) : undefined;

  return (
    <div>
      <PageHeader
        title="Reembolsos"
        subtitle="Quando um fornecedor não cumpre o combinado, a ECLAK cobra o reembolso dele e devolve ao cliente. As duas pontas ficam aqui, ligadas às contas a receber e a pagar."
        right={
          !registro && !edicao ? (
            <Botao onClick={() => ir({ nova: "1" })}>
              <Plus size={16} /> Registrar ocorrência
            </Botao>
          ) : undefined
        }
      />

      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <Eyebrow>Casos abertos</Eyebrow>
          <p className="num mt-1 text-[21px] font-bold text-verde">{resumo.abertos}</p>
        </Card>
        <Card className="p-4">
          <Eyebrow>A receber de fornecedores</Eyebrow>
          <p className="num mt-1 text-[21px] font-bold text-verde">{reais(resumo.aReceber)}</p>
        </Card>
        <Card className="p-4">
          <Eyebrow>A devolver a clientes</Eyebrow>
          <p className="num mt-1 text-[21px] font-bold text-verde">{reais(resumo.aDevolver)}</p>
        </Card>
      </div>

      {registro && <FormularioCaso key="novo" hoje={hoje} registro={registro} caso={null} onFechar={() => ir()} />}
      {edicao && <FormularioCaso key={edicao.id} hoje={hoje} registro={null} caso={edicao} onFechar={() => ir()} />}

      <div className="mb-4">
        <Tabs
          value={aba}
          onChange={(a) => router.push(urlDe(a), { scroll: false })}
          options={[
            { value: "abertos", label: `Abertos (${resumo.abertos})` },
            { value: "concluidos", label: "Concluídos e cancelados" },
          ]}
        />
      </div>

      <div className="space-y-4">
        {casos.map((c) => (
          <CartaoCaso key={c.id} caso={c} abrir={(tipo) => setAberto({ tipo, caso: c })} editar={() => ir({ editar: c.id })} comprovantes={() => ir({ anexos: c.id })} />
        ))}
        {casos.length === 0 && (
          <Card className="p-10 text-center text-[15px] text-cinza">{aba === "abertos" ? "Nenhum reembolso aberto." : "Nenhum reembolso concluído ou cancelado."}</Card>
        )}
      </div>

      {aberto?.tipo === "pedido" && <DialogoPedido caso={aberto.caso} hoje={hoje} onFechar={fechar} />}
      {aberto?.tipo === "fornecedor" && <DialogoBaixaCaso caso={aberto.caso} lado="fornecedor" hoje={hoje} contas={contas} onFechar={fechar} />}
      {aberto?.tipo === "cliente" &&
        (geraContaAPagar(aberto.caso.formaDevolucao) ? (
          <DialogoBaixaCaso caso={aberto.caso} lado="cliente" hoje={hoje} contas={contas} onFechar={fechar} />
        ) : (
          <DialogoReembolsadoSemConta caso={aberto.caso} hoje={hoje} onFechar={fechar} />
        ))}
      {aberto?.tipo === "cancelar" && <DialogoCancelar caso={aberto.caso} onFechar={fechar} />}
      {doAnexo && (
        <Dialogo eyebrow="Comprovantes" titulo={doAnexo.servico} onFechar={() => ir()} rodape={<Botao variante="secundario" onClick={() => ir()}>Fechar</Botao>}>
          <div className="px-6 py-5">
            <p className="mb-4 text-[13.5px] text-cinza">
              {doAnexo.viagemCodigo} · {doAnexo.clienteNome}. Recibos do cliente, conversa com o fornecedor, comprovante do pagamento.
            </p>
            <Anexos donoTipo="reembolso" donoId={doAnexo.id} anexos={anexos} />
          </div>
        </Dialogo>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartão do caso
// ---------------------------------------------------------------------------

function Passo({ feito, children, acao }: { feito: boolean; children: ReactNode; acao?: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className={cx("mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border", feito ? "border-verde bg-verde text-white" : "border-[#C9CDD1]")}>
        {feito && <Check size={12} aria-label="feito" />}
      </span>
      <span className={feito ? "text-cinza" : "font-semibold text-texto"}>
        {children}
        {acao && <span className="ml-2">{acao}</span>}
      </span>
    </li>
  );
}

function Desfazer({ caso, lado }: { caso: CasoTela; lado: "fornecedor" | "cliente" }) {
  const acao = useAcao();
  return (
    <>
      <button
        className="cursor-pointer text-[13px] font-semibold text-verde hover:underline disabled:cursor-wait"
        disabled={acao.pendente}
        onClick={() => {
          const msg = lado === "fornecedor" ? "Desfazer o recebimento do fornecedor? A conta a receber volta a ficar em aberto." : "Desfazer o reembolso ao cliente? O lado do cliente volta a ficar em aberto.";
          if (window.confirm(msg)) acao.executar(() => desfazerMarco(caso.id, lado));
        }}
      >
        Desfazer
      </button>
      {acao.erro && <span role="alert" className="ml-2 rounded-[3px] bg-ouro/30 px-1.5 text-[12.5px] font-normal text-texto">{acao.erro}</span>}
    </>
  );
}

function CartaoCaso({ caso: c, abrir, editar, comprovantes }: { caso: CasoTela; abrir: (t: "pedido" | "fornecedor" | "cliente" | "cancelar") => void; editar: () => void; comprovantes: () => void }) {
  const f = c.ladoFornecedor;
  const k = c.ladoCliente;
  const cancelado = c.canceladoEm !== null;
  const recebidoDiferente = f.valorRecebido !== null && f.valorRecebido !== f.valor;
  const devolvidoDiferente = k.valorDevolvido !== null && k.valorDevolvido !== k.valor;
  const semBaixa = !f.recebidoEm && !k.reembolsadoEm;

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>
            <Link href={`/viagens/${c.viagemId}`} className="hover:text-verde hover:underline">{c.viagemCodigo}</Link> · {c.clienteNome} · {dataBr(c.ocorridoEm)}
          </Eyebrow>
          <h2 className="mt-1 text-[17px] font-bold text-texto">{c.servico}</h2>
          <p className="mt-1 max-w-[70ch] whitespace-pre-line text-[14px] text-texto">{c.ocorrido}</p>
        </div>
        <Badge tom={tomDa(c.situacao)}>{c.situacao}</Badge>
      </div>

      {cancelado && (
        <p className="mt-4 rounded-[5px] border border-linha bg-fundo px-4 py-3 text-[14px] text-texto">
          Cancelado{c.motivoCancelamento ? `: ${c.motivoCancelamento}` : ""}. As contas em aberto do caso foram canceladas.
        </p>
      )}

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-[6px] border border-linha p-4">
          <Eyebrow>Cobrar do fornecedor{f.fornecedor ? ` · ${f.fornecedor}` : ""}</Eyebrow>
          <p className="num mt-1 text-[20px] font-bold text-verde">{reais(f.valor)}</p>
          {f.valor === 0n ? (
            <p className="mt-3 text-[14px] text-cinza">Nada a cobrar do fornecedor.</p>
          ) : (
            <>
              <ol className="mt-3 space-y-2 text-[14px]">
                <Passo feito={f.pedidoEm !== null}>
                  {f.pedidoEm ? `Reembolso pedido em ${dataBr(f.pedidoEm)}${f.protocolo ? `, protocolo ${f.protocolo}` : ""}` : "Pedir o reembolso ao fornecedor"}
                </Passo>
                <Passo feito={f.recebidoEm !== null} acao={f.recebidoEm && !cancelado ? <Desfazer caso={c} lado="fornecedor" /> : undefined}>
                  {f.recebidoEm
                    ? `Recebido em ${dataBr(f.recebidoEm)}${recebidoDiferente ? ` · ${reais(f.valorRecebido!)}` : ""}`
                    : `Conferir se o fornecedor pagou${f.previsto ? ` · previsto para ${dataBr(f.previsto)}` : ""}`}
                </Passo>
              </ol>
              {!cancelado && !f.recebidoEm && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {!f.pedidoEm ? (
                    <Botao variante="secundario" onClick={() => abrir("pedido")}>Marcar como pedido</Botao>
                  ) : (
                    <Botao variante="secundario" onClick={() => abrir("fornecedor")}>Fornecedor pagou</Botao>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="rounded-[6px] border border-linha p-4">
          <Eyebrow>Devolver ao cliente · {c.rotuloForma}</Eyebrow>
          <p className="num mt-1 text-[20px] font-bold text-verde">{reais(k.valor)}</p>
          {k.valor === 0n ? (
            <p className="mt-3 text-[14px] text-cinza">Nada a devolver ao cliente.</p>
          ) : (
            <>
              <ol className="mt-3 space-y-2 text-[14px]">
                <Passo feito={k.reembolsadoEm !== null} acao={k.reembolsadoEm && !cancelado ? <Desfazer caso={c} lado="cliente" /> : undefined}>
                  {k.reembolsadoEm
                    ? `Cliente reembolsado em ${dataBr(k.reembolsadoEm)}${devolvidoDiferente ? ` · ${reais(k.valorDevolvido!)}` : ""}`
                    : `Reembolsar o cliente até ${dataBr(k.prazo)}`}
                </Passo>
              </ol>
              {!cancelado && !k.reembolsadoEm && (
                <Botao className="mt-3" onClick={() => abrir("cliente")}>Cliente reembolsado</Botao>
              )}
              {!cancelado && <p className="mt-3 text-[12.5px] text-cinza">O cliente não espera o fornecedor: a devolução tem prazo próprio.</p>}
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-linha pt-3">
        <button onClick={comprovantes} className={cx("inline-flex cursor-pointer items-center gap-1.5 text-[13.5px] font-semibold hover:underline", c.anexos > 0 ? "text-verde" : "text-cinza hover:text-verde")}>
          <Paperclip size={15} aria-hidden /> {c.anexos > 0 ? `Comprovantes (${c.anexos})` : "Anexar comprovante"}
        </button>
        {!cancelado && (
          <button onClick={editar} className="cursor-pointer text-[13.5px] font-semibold text-verde hover:underline">Editar</button>
        )}
        {!cancelado && semBaixa && (
          <button onClick={() => abrir("cancelar")} className="cursor-pointer text-[13.5px] font-semibold text-cinza hover:text-verde hover:underline">Cancelar caso</button>
        )}
        {!cancelado && (
          <span className="ml-auto text-[12.5px] text-cinza">
            {f.contaId || k.contaId ? "As contas do caso estão em Lançamentos: a baixa feita lá aparece aqui." : "Sem conta em Lançamentos."}
          </span>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Registro e edição
// ---------------------------------------------------------------------------

function CampoErro({ acao, chave, label, className, children }: { acao: Acao; chave: string; label: string; className?: string; children: ReactNode }) {
  const msg = acao.campos[chave];
  return (
    <Campo label={label} className={className}>
      <span className="block" onChange={() => acao.limparCampo(chave)}>{children}</span>
      {msg && <span className="mt-1 block text-[12px] text-texto">{msg}</span>}
    </Campo>
  );
}

/**
 * Registro do caso (`registro`) ou edição (`caso`). Na edição, a viagem e o serviço ficam como estão (para trocar,
 * cancele e registre outro); o valor a cobrar trava depois que o fornecedor pagou, e o valor a devolver e a forma
 * depois que o cliente foi reembolsado.
 */
function FormularioCaso({ hoje, registro, caso, onFechar }: { hoje: string; registro: Registro | null; caso: ReembolsoCaso | null; onFechar: () => void }) {
  const router = useRouter();
  const acao = useAcao();
  const topo = useRef<HTMLDivElement>(null);
  // Aberto a partir de um cartão lá embaixo: traz o formulário para a vista.
  useEffect(() => topo.current?.scrollIntoView({ block: "start", behavior: "smooth" }), []);
  const [contaPagarId, setContaPagarId] = useState(caso ? (caso.contaPagarId ?? OUTRO) : "");
  const [servicoLivre, setServicoLivre] = useState(caso?.servico ?? "");
  const [ocorridoEm, setOcorridoEm] = useState(caso?.ocorridoEm ?? hoje);
  const [ocorrido, setOcorrido] = useState(caso?.ocorrido ?? "");
  const [valorCobrar, setValorCobrar] = useState(caso && caso.ladoFornecedor.valor > 0n ? reaisParaCampo(caso.ladoFornecedor.valor) : "");
  const [previsto, setPrevisto] = useState(caso?.ladoFornecedor.previsto ?? "");
  const [valorDevolver, setValorDevolver] = useState(caso && caso.ladoCliente.valor > 0n ? reaisParaCampo(caso.ladoCliente.valor) : "");
  const [forma, setForma] = useState<FormaDevolucao>(caso?.formaDevolucao ?? "pix");
  const [prazo, setPrazo] = useState(caso?.ladoCliente.prazo ?? "");

  const viagemId = caso ? caso.viagemId : (registro?.viagemId ?? "");
  const servicos = registro?.servicos ?? [];
  const escolhido = servicos.find((s) => s.contaId === contaPagarId);
  const fornecedorTravado = caso !== null && caso.ladoFornecedor.recebidoEm !== null;
  const clienteTravado = caso !== null && caso.ladoCliente.reembolsadoEm !== null;
  const cobrar = centavosDe(valorCobrar);
  const semServico = caso ? caso.contaPagarId === null : contaPagarId === OUTRO || contaPagarId === "";
  const semFornecedor = cobrar !== null && cobrar > 0n && semServico;

  function trocarViagem(id: string) {
    setContaPagarId("");
    router.replace(id ? `${BASE}?nova=1&viagem=${id}` : `${BASE}?nova=1`, { scroll: false });
  }

  function salvar() {
    const servico = caso ? servicoLivre : escolhido ? escolhido.servico : servicoLivre;
    const dados = {
      viagemId,
      contaPagarId: caso ? (caso.contaPagarId ?? "") : escolhido ? escolhido.contaId : "",
      servico,
      ocorridoEm,
      ocorrido,
      valorCobrar,
      valorDevolver,
      formaDevolucao: forma,
      prazoCliente: prazo,
      previstoFornecedor: previsto,
    };
    acao.executar(() => (caso ? editarReembolso(caso.id, dados) : registrarReembolso(dados)), onFechar);
  }

  return (
    <Card className="mb-5 scroll-mt-28 p-5 sm:p-6">
      <div ref={topo} className="scroll-mt-28" />
      <Eyebrow>{caso ? "Editar ocorrência" : "Nova ocorrência"}</Eyebrow>
      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {caso ? (
          <div className="sm:col-span-2">
            <p className="text-[14px] text-texto">
              <b className="font-semibold">{caso.viagemCodigo}</b> · {caso.clienteNome} · {caso.viagemDestino}
              {caso.ladoFornecedor.fornecedor ? ` · ${caso.ladoFornecedor.fornecedor}` : ""}
            </p>
            <p className="mt-0.5 text-[12.5px] text-cinza">A viagem e o serviço não mudam: para trocar, cancele este caso e registre outro.</p>
          </div>
        ) : (
          <>
            <CampoErro acao={acao} chave="viagemId" label="Viagem">
              <select className={`${inputCls} ${marca(acao, "viagemId")}`} value={viagemId} onChange={(e) => trocarViagem(e.target.value)}>
                <option value="">{registro && registro.viagens.length === 0 ? "Nenhuma viagem vendida" : "Escolha a viagem"}</option>
                {registro?.viagens.map((v) => (
                  <option key={v.id} value={v.id}>{v.rotulo}</option>
                ))}
              </select>
            </CampoErro>
            <CampoErro acao={acao} chave="contaPagarId" label="Serviço do roteiro">
              <select className={`${inputCls} ${marca(acao, "contaPagarId")}`} value={contaPagarId} disabled={!viagemId} onChange={(e) => setContaPagarId(e.target.value)}>
                <option value="">{viagemId ? "Escolha o serviço" : "Escolha antes a viagem"}</option>
                {servicos.map((s) => (
                  <option key={s.contaId} value={s.contaId}>{s.fornecedor ? `${s.servico} · ${s.fornecedor}` : s.servico}</option>
                ))}
                {viagemId && <option value={OUTRO}>Outro serviço (fora das contas da viagem)</option>}
              </select>
            </CampoErro>
          </>
        )}
        {(caso || contaPagarId === OUTRO) && (
          <CampoErro acao={acao} chave="servico" label="Serviço" className="sm:col-span-2">
            <input className={`${inputCls} ${marca(acao, "servico")}`} value={servicoLivre} onChange={(e) => setServicoLivre(e.target.value)} placeholder="Ex.: Transfer hotel > aeroporto" />
          </CampoErro>
        )}
        {!caso && contaPagarId !== OUTRO && acao.campos.servico && <p className="text-[12px] text-texto sm:col-span-2">{acao.campos.servico}</p>}
        <CampoErro acao={acao} chave="ocorridoEm" label="Quando aconteceu">
          <input type="date" className={`${inputCls} ${marca(acao, "ocorridoEm")}`} value={ocorridoEm} onChange={(e) => setOcorridoEm(e.target.value)} />
        </CampoErro>
        <div className="hidden sm:block" />
        <CampoErro acao={acao} chave="ocorrido" label="O que aconteceu" className="sm:col-span-2">
          <textarea rows={3} className={`${inputCls} ${marca(acao, "ocorrido")}`} value={ocorrido} onChange={(e) => setOcorrido(e.target.value)} placeholder="O fornecedor não cumpriu o quê, e o que o cliente fez" />
        </CampoErro>

        <CampoErro acao={acao} chave="valorCobrar" label="Valor a cobrar do fornecedor">
          <input
            inputMode="decimal"
            placeholder="0,00"
            disabled={fornecedorTravado}
            className={`${inputCls} num text-right disabled:bg-fundo disabled:text-cinza ${marca(acao, "valorCobrar")}`}
            value={valorCobrar}
            onChange={(e) => setValorCobrar(e.target.value)}
          />
          <span className="mt-1 block text-[12.5px] normal-case tracking-normal text-cinza">
            {fornecedorTravado ? "O fornecedor já pagou: desfaça a baixa para alterar." : "Se o fornecedor vai abater na conta dele em vez de devolver, deixe o valor a cobrar em 0."}
          </span>
        </CampoErro>
        <CampoErro acao={acao} chave="previstoFornecedor" label="Fornecedor deve pagar até">
          <input type="date" disabled={fornecedorTravado} className={`${inputCls} disabled:bg-fundo disabled:text-cinza ${marca(acao, "previstoFornecedor")}`} value={previsto} onChange={(e) => setPrevisto(e.target.value)} />
        </CampoErro>
        {semFornecedor && (
          <p role="status" className="rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto sm:col-span-2">
            Sem um serviço da viagem escolhido, a conta a receber ficará sem fornecedor.
          </p>
        )}

        <CampoErro acao={acao} chave="valorDevolver" label="Valor a devolver ao cliente">
          <input
            inputMode="decimal"
            placeholder="0,00"
            disabled={clienteTravado}
            className={`${inputCls} num text-right disabled:bg-fundo disabled:text-cinza ${marca(acao, "valorDevolver")}`}
            value={valorDevolver}
            onChange={(e) => setValorDevolver(e.target.value)}
          />
          {clienteTravado && <span className="mt-1 block text-[12.5px] normal-case tracking-normal text-cinza">O cliente já foi reembolsado: desfaça o marco para alterar.</span>}
        </CampoErro>
        <CampoErro acao={acao} chave="formaDevolucao" label="Como devolver ao cliente">
          <select disabled={clienteTravado} className={`${inputCls} disabled:bg-fundo disabled:text-cinza ${marca(acao, "formaDevolucao")}`} value={forma} onChange={(e) => setForma(e.target.value as FormaDevolucao)}>
            {FORMAS_DEVOLUCAO.map((x) => (
              <option key={x} value={x}>{ROTULO_FORMA_DEVOLUCAO[x]}</option>
            ))}
          </select>
          {!geraContaAPagar(forma) && <span className="mt-1 block text-[12.5px] normal-case tracking-normal text-cinza">Não sai dinheiro: não gera conta a pagar.</span>}
        </CampoErro>
        <CampoErro acao={acao} chave="prazoCliente" label="Reembolsar o cliente até">
          <input type="date" className={`${inputCls} ${marca(acao, "prazoCliente")}`} value={prazo} onChange={(e) => setPrazo(e.target.value)} />
        </CampoErro>
      </div>
      {!caso && <p className="mt-4 text-[13px] text-cinza">Os comprovantes (recibos, conversa com o fornecedor) entram no cartão do caso, depois de registrar.</p>}
      <ErroAcao acao={acao} />
      <div className="mt-4 flex flex-wrap gap-2">
        <Botao disabled={acao.pendente} onClick={salvar}>{caso ? "Salvar alterações" : "Registrar"}</Botao>
        <Botao variante="secundario" onClick={onFechar}>Fechar</Botao>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Marcos e cancelamento
// ---------------------------------------------------------------------------

function Rodape({ acao, rotulo, onFechar, onSalvar }: { acao: Acao; rotulo: string; onFechar: () => void; onSalvar: () => void }) {
  return (
    <>
      <Botao variante="secundario" onClick={onFechar}>Fechar</Botao>
      <Botao disabled={acao.pendente} onClick={onSalvar}>{rotulo}</Botao>
    </>
  );
}

/** "Marcar como pedido": a data (até hoje) e o protocolo do fornecedor (opcional). */
function DialogoPedido({ caso, hoje, onFechar }: { caso: CasoTela; hoje: string; onFechar: () => void }) {
  const acao = useAcao();
  const [pedidoEm, setPedidoEm] = useState(hoje);
  const [protocolo, setProtocolo] = useState("");
  return (
    <Dialogo
      eyebrow="Pedido ao fornecedor"
      titulo={caso.servico}
      onFechar={onFechar}
      rodape={<Rodape acao={acao} rotulo="Marcar como pedido" onFechar={onFechar} onSalvar={() => acao.executar(() => marcarPedido(caso.id, { pedidoEm, protocolo }), onFechar)} />}
    >
      <div className="px-6 py-5">
        <p className="mb-4 text-[13.5px] text-cinza">
          {caso.viagemCodigo} · cobrar <span className="num font-semibold text-texto">{reais(caso.ladoFornecedor.valor)}</span>
          {caso.ladoFornecedor.fornecedor ? ` de ${caso.ladoFornecedor.fornecedor}` : ""}
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <CampoErro acao={acao} chave="pedidoEm" label="Pedido em">
            <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "pedidoEm")}`} value={pedidoEm} onChange={(e) => setPedidoEm(e.target.value)} />
          </CampoErro>
          <CampoErro acao={acao} chave="protocolo" label="Protocolo (opcional)">
            <input className={`${inputCls} ${marca(acao, "protocolo")}`} value={protocolo} onChange={(e) => setProtocolo(e.target.value)} placeholder="Ex.: OT-55120" />
          </CampoErro>
        </div>
        <ErroAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

/**
 * "Fornecedor pagou" e "Cliente reembolsado" (PIX e transferência): a baixa da conta do caso, com os campos da baixa da
 * lista única (data, valor, conta bancária e observação, obrigatória quando o valor difere do previsto).
 */
function DialogoBaixaCaso({ caso, lado, hoje, contas, onFechar }: { caso: CasoTela; lado: "fornecedor" | "cliente"; hoje: string; contas: ContaOpcao[]; onFechar: () => void }) {
  const acao = useAcao();
  const previsto = lado === "fornecedor" ? caso.ladoFornecedor.valor : caso.ladoCliente.valor;
  const [data, setData] = useState(hoje);
  const [valor, setValor] = useState(reaisParaCampo(previsto));
  const [conta, setConta] = useState(contaPadrao(contas));
  const [observacao, setObservacao] = useState("");
  const lido = centavosDe(valor);
  const diferente = lido !== null && lido !== previsto;
  const fornecedor = lado === "fornecedor";

  function salvar() {
    const dados = { data, valorPago: valor, juros: "", desconto: "", contaBancariaId: conta, observacao };
    acao.executar(() => (fornecedor ? fornecedorPagou(caso.id, dados) : clienteReembolsado(caso.id, dados)), onFechar);
  }

  return (
    <Dialogo
      eyebrow={fornecedor ? "Fornecedor pagou · baixa a receber" : `Cliente reembolsado · ${caso.rotuloForma}`}
      titulo={caso.servico}
      onFechar={onFechar}
      rodape={<Rodape acao={acao} rotulo="Confirmar baixa" onFechar={onFechar} onSalvar={salvar} />}
    >
      <div className="px-6 py-5">
        <p className="mb-4 text-[13.5px] text-cinza">
          {caso.viagemCodigo} · {fornecedor ? (caso.ladoFornecedor.fornecedor ?? "fornecedor") : caso.clienteNome} · previsto{" "}
          <span className="num font-semibold text-texto">{reais(previsto)}</span>. É a mesma baixa da conta em Lançamentos.
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <CampoErro acao={acao} chave="data" label={fornecedor ? "Data do recebimento" : "Data do pagamento"}>
            <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "data")}`} value={data} onChange={(e) => setData(e.target.value)} />
          </CampoErro>
          <CampoErro acao={acao} chave="valorPago" label={fornecedor ? "Valor recebido" : "Valor devolvido"}>
            <input inputMode="decimal" className={`${inputCls} num text-right ${marca(acao, "valorPago")}`} value={valor} onChange={(e) => setValor(e.target.value)} />
          </CampoErro>
          <CampoConta contas={contas} valor={conta} onChange={setConta} invalido={"contaBancariaId" in acao.campos} />
          <div className="hidden sm:block" />
          <CampoErro acao={acao} chave="observacao" label={diferente ? "Observação (obrigatória: valor diferente do previsto)" : "Observação (opcional)"} className="sm:col-span-2">
            <input
              className={`${inputCls} ${marca(acao, "observacao")}`}
              placeholder={diferente ? (fornecedor ? "Explique a diferença do valor recebido" : "Explique a diferença do valor devolvido") : ""}
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
            />
          </CampoErro>
        </div>
        <ErroAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

/** "Cliente reembolsado" em abatimento e crédito: não sai dinheiro, só a data. */
function DialogoReembolsadoSemConta({ caso, hoje, onFechar }: { caso: CasoTela; hoje: string; onFechar: () => void }) {
  const acao = useAcao();
  const [data, setData] = useState(hoje);
  return (
    <Dialogo
      eyebrow={`Cliente reembolsado · ${caso.rotuloForma}`}
      titulo={caso.servico}
      onFechar={onFechar}
      rodape={<Rodape acao={acao} rotulo="Confirmar" onFechar={onFechar} onSalvar={() => acao.executar(() => clienteReembolsado(caso.id, { data }), onFechar)} />}
    >
      <div className="px-6 py-5">
        <p className="mb-4 text-[13.5px] text-cinza">
          {caso.viagemCodigo} · {caso.clienteNome} · <span className="num font-semibold text-texto">{reais(caso.ladoCliente.valor)}</span>. Não sai dinheiro: registre a data em que o valor foi abatido ou dado como crédito.
        </p>
        <CampoErro acao={acao} chave="data" label="Data" className="max-w-[260px]">
          <input type="date" max={hoje} className={`${inputCls} ${marca(acao, "data")}`} value={data} onChange={(e) => setData(e.target.value)} />
        </CampoErro>
        <ErroAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

/** Cancelar o caso (só sem nenhuma baixa): motivo de 5 a 200 caracteres; as contas em aberto são canceladas junto. */
function DialogoCancelar({ caso, onFechar }: { caso: CasoTela; onFechar: () => void }) {
  const acao = useAcao();
  const [motivo, setMotivo] = useState("");
  return (
    <Dialogo
      eyebrow="Cancelar caso"
      titulo={caso.servico}
      onFechar={onFechar}
      rodape={<Rodape acao={acao} rotulo="Cancelar caso" onFechar={onFechar} onSalvar={() => acao.executar(() => cancelarReembolso(caso.id, motivo), onFechar)} />}
    >
      <div className="px-6 py-5">
        <p className="mb-4 text-[13.5px] text-cinza">{caso.viagemCodigo} · as contas em aberto do caso em Lançamentos são canceladas junto.</p>
        <CampoErro acao={acao} chave="motivo" label="Motivo">
          <input autoFocus className={`${inputCls} ${marca(acao, "motivo")}`} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: Registrado em duplicidade" />
        </CampoErro>
        <ErroAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

// ---------------------------------------------------------------------------
// Bloco na viagem vendida
// ---------------------------------------------------------------------------

/** Bloco "Reembolsos" da viagem vendida (Diretor e financeiros): os casos da viagem e o link para a tela. */
export function ReembolsosDaViagem({ viagemId, casos }: { viagemId: string; casos: ReembolsoCaso[] }) {
  return (
    <Card className="mb-6">
      <CardHeader
        title="Reembolsos"
        eyebrow="O que a ECLAK cobra do fornecedor e devolve ao cliente quando um serviço falha."
        right={<BotaoLink href={`${BASE}?nova=1&viagem=${viagemId}`}>Registrar ocorrência</BotaoLink>}
      />
      <div className="px-6 pb-5 pt-3">
        {casos.length === 0 ? (
          <p className="text-[14px] text-cinza">Nenhum reembolso nesta viagem.</p>
        ) : (
          <ul className="divide-y divide-linha rounded-[5px] border border-linha">
            {casos.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold text-texto">{c.servico}</p>
                  <p className="num text-[12.5px] text-cinza">
                    {dataBr(c.ocorridoEm)} · cobrar {reais(c.ladoFornecedor.valor)} · devolver {reais(c.ladoCliente.valor)} ({c.rotuloForma})
                  </p>
                </div>
                <Badge tom={tomDa(c.situacao)}>{c.situacao}</Badge>
              </li>
            ))}
          </ul>
        )}
        <BotaoLink href={BASE} className="mt-3">Abrir Reembolsos</BotaoLink>
      </div>
    </Card>
  );
}
