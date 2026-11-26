"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Megaphone, Plus } from "lucide-react";
import { avisosMudaram } from "@/components/contador-avisos";
import { Botao, Campo, Card, Eyebrow, PageHeader, Tabs, cx, inputCls } from "@/components/ui";
import { SETORES, SETORES_DO_PERFIL, type AvisoCentral, type Setor, type TipoAviso } from "@/domain/avisos";
import type { Perfil } from "@/domain/perfis";
import { criarComunicado, desfazerDispensa, dispensarAviso, resolverComunicado } from "@/server/actions/avisos";
import type { Comunicado, Dispensado } from "@/server/avisos";
import { useAcao } from "../viagens/[id]/acao";
import { dataHora } from "../viagens/formatos";

export type AbaAvisos = "abertos" | "dispensados";
/** "Para mim" (padrão) ou, só para o Diretor, "todos" e cada setor. */
export type VisaoAvisos = "mim" | "todos" | Setor;
type Acao = ReturnType<typeof useAcao>;

const BASE = "/avisos";

/** Tipo do aviso em caixa alta no cartão. */
const ROTULO_TIPO: Record<TipoAviso, string> = {
  caixa: "Caixa",
  margem: "Margem",
  parcela: "Parcelas vencidas",
  comissao: "Comissões a receber",
  pagar: "Contas a pagar",
  conciliacao: "Conciliação",
  aprovacao: "Aprovação",
  tarefa_vencida: "Tarefas vencidas",
  daily_a_gerar: "Daily a gerar",
  aniversario: "Aniversário",
  estoque_minimo: "Estoque mínimo",
  caixa_a_montar: "Caixa de experiência",
  reembolso_pedir: "Reembolso a pedir",
  reembolso_fornecedor: "Reembolso do fornecedor",
  reembolso_cliente: "Reembolso ao cliente",
};

const para = (s: Setor) => (s === "Geral" ? "Geral (toda a agência)" : s);

function urlDe(aba: AbaAvisos, visao: VisaoAvisos) {
  const q = new URLSearchParams();
  if (aba === "dispensados") q.set("aba", aba);
  if (visao !== "mim") q.set("setor", visao);
  const t = q.toString();
  return t ? `${BASE}?${t}` : BASE;
}

/** Depois de gravar: a página já é atualizada pelo `useAcao`; o sino do topo precisa ser avisado. */
function executar(acao: Acao, fn: Parameters<Acao["executar"]>[0], aoSucesso?: () => void) {
  acao.executar(fn, () => {
    aoSucesso?.();
    avisosMudaram();
  });
}

/** Mensagem do servidor no campo (ouro, nunca vermelho). */
function ErroCampo({ children }: { children?: string }) {
  if (!children) return null;
  return (
    <span role="alert" className="mt-1.5 block text-[13px] text-texto">
      <span className="rounded-[3px] bg-ouro/30 px-1.5 py-0.5">{children}</span>
    </span>
  );
}

const marca = (acao: Acao, k: string) => (acao.campos[k] ? "!border-ouro bg-ouro/15" : "");
/** Falha sem campo (aviso não encontrado, não pode dispensar, rede). */
const erroGeral = (acao: Acao) => (acao.erro && Object.keys(acao.campos).length === 0 ? acao.erro : undefined);

/**
 * Central de avisos: abas Abertos / Dispensados, filtro do Diretor, o formulário do comunicado ("Novo aviso") e um
 * cartão por aviso, com o próximo passo e o setor de destino.
 */
export function Avisos({
  aba,
  visao,
  perfil,
  abertos,
  comunicados,
  dispensados,
}: {
  aba: AbaAvisos;
  visao: VisaoAvisos;
  perfil: Perfil;
  abertos: AvisoCentral[];
  comunicados: Comunicado[];
  dispensados: Dispensado[];
}) {
  const router = useRouter();
  const [novo, setNovo] = useState(false);
  const diretor = perfil === "diretor";
  const total = abertos.length + comunicados.length;
  const ir = (a: AbaAvisos, v: VisaoAvisos) => router.push(urlDe(a, v), { scroll: false });
  const filtros: { valor: VisaoAvisos; rotulo: string }[] = [
    { valor: "mim", rotulo: "Para mim" },
    ...(diretor ? [{ valor: "todos" as const, rotulo: "Todos os setores" }, ...SETORES.map((s) => ({ valor: s, rotulo: s }))] : []),
  ];

  return (
    <div>
      <PageHeader
        title="Avisos"
        subtitle="Cada aviso diz o próximo passo e o setor responsável. Para dispensar, é preciso justificar."
        right={
          aba === "abertos" && !novo ? (
            <Botao variante="secundario" onClick={() => setNovo(true)}>
              <Plus size={15} /> Novo aviso
            </Botao>
          ) : undefined
        }
      />

      <div className="mb-4">
        <Tabs
          value={aba}
          onChange={(a) => ir(a, visao)}
          options={[
            { value: "abertos", label: `Abertos (${total})` },
            { value: "dispensados", label: `Dispensados (${dispensados.length})` },
          ]}
        />
      </div>

      {aba === "abertos" ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {filtros.map((f) => (
              <Link
                key={f.valor}
                href={urlDe("abertos", f.valor)}
                scroll={false}
                aria-current={visao === f.valor ? "page" : undefined}
                className={cx(
                  "rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-colors",
                  visao === f.valor ? "border-verde bg-verde text-white" : "border-linha bg-white text-texto hover:border-verde/40",
                )}
              >
                {f.rotulo}
              </Link>
            ))}
          </div>
          <p className="text-[13px] text-cinza">
            {visao === "mim"
              ? `Você recebe os avisos de ${SETORES_DO_PERFIL[perfil].join(", ")} e os que você escreveu.`
              : visao === "todos"
                ? "Os avisos de todos os setores."
                : `Os avisos do setor ${visao}.`}
          </p>

          {novo && <NovoAviso onFechar={() => setNovo(false)} />}

          {comunicados.map((c) => (
            <CartaoComunicado key={c.id} comunicado={c} />
          ))}
          {abertos.map((a) => (
            <CartaoAviso key={a.chave} aviso={a} />
          ))}
          {total === 0 && <Card className="p-10 text-center text-[15px] text-cinza">Nenhum aviso aberto.</Card>}
        </div>
      ) : (
        <ListaDispensados dispensados={dispensados} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cartões
// ---------------------------------------------------------------------------

function CartaoAviso({ aviso }: { aviso: AvisoCentral }) {
  const acao = useAcao();
  const [dispensando, setDispensando] = useState(false);
  const [justificativa, setJustificativa] = useState("");

  return (
    <Card className="p-5">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-6">
        <div className="min-w-0">
          <Eyebrow className="!text-verde">{ROTULO_TIPO[aviso.tipo]}</Eyebrow>
          <p className="mt-1 text-[15px] font-semibold text-texto">{aviso.titulo}</p>
          <p className="mt-0.5 text-[14px] leading-relaxed text-cinza">{aviso.detalhe}</p>
          <p className="mt-1.5 text-[14px] text-texto">Próximo passo: {aviso.passo}.</p>
          <p className="mt-1.5 text-[13px] font-semibold text-texto">Para: {para(aviso.setor)}</p>
        </div>
        {!dispensando && (
          <div className="flex shrink-0 gap-2">
            <Link href={aviso.href} className="inline-flex items-center rounded-[5px] border border-[#C9CDD1] px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde">
              Abrir
            </Link>
            {aviso.dispensavel && (
              <Botao variante="secundario" onClick={() => setDispensando(true)}>
                Dispensar
              </Botao>
            )}
          </div>
        )}
      </div>
      {dispensando && (
        <div className="surgir mt-4 border-t border-linha pt-4">
          <Campo label="Por que dispensar? (obrigatório)">
            <textarea
              autoFocus
              value={justificativa}
              onChange={(e) => {
                setJustificativa(e.target.value);
                acao.limparCampo("justificativa");
              }}
              rows={2}
              placeholder="A justificativa fica registrada com o seu nome e a data"
              className={cx(inputCls, "py-2.5", marca(acao, "justificativa"))}
            />
            <ErroCampo>{acao.campos.justificativa ?? erroGeral(acao)}</ErroCampo>
          </Campo>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Botao disabled={acao.pendente} onClick={() => executar(acao, () => dispensarAviso(aviso.chave, justificativa))}>
              Dispensar aviso
            </Botao>
            <Botao
              variante="secundario"
              onClick={() => {
                setDispensando(false);
                setJustificativa("");
              }}
            >
              Cancelar
            </Botao>
            <span className="text-[13px] text-cinza">De 10 a 500 caracteres. O aviso volta se o texto mudar ou depois de 30 dias.</span>
          </div>
        </div>
      )}
    </Card>
  );
}

function CartaoComunicado({ comunicado: c }: { comunicado: Comunicado }) {
  const acao = useAcao();
  return (
    <Card className="p-5">
      <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow className="!text-verde">{c.setor === "Geral" ? "Comunicado geral" : "Comunicado"}</Eyebrow>
            <span className="text-[12px] text-cinza">
              {c.por}, {dataHora(c.criadoEm)}
            </span>
          </div>
          <p className="mt-1 whitespace-pre-line text-[15px] font-semibold text-texto">{c.texto}</p>
          {c.passo && <p className="mt-1.5 text-[14px] text-texto">Próximo passo: {c.passo}</p>}
          <p className="mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-texto">
            {c.setor === "Geral" && <Megaphone size={14} className="text-verde" />}
            Para: {para(c.setor)}
          </p>
        </div>
        <Botao className="shrink-0" disabled={acao.pendente} onClick={() => executar(acao, () => resolverComunicado(c.id))}>
          Resolver
        </Botao>
      </div>
      <ErroCampo>{erroGeral(acao)}</ErroCampo>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Novo aviso (comunicado)
// ---------------------------------------------------------------------------

function NovoAviso({ onFechar }: { onFechar: () => void }) {
  const acao = useAcao();
  const [setor, setSetor] = useState("");
  const [texto, setTexto] = useState("");
  const [passo, setPasso] = useState("");
  const enviar = () => executar(acao, () => criarComunicado({ setor: setor || undefined, texto, passo: passo || undefined }), onFechar);

  return (
    <Card className="surgir p-5">
      <h2 className="text-[16px] font-bold text-texto">Novo aviso</h2>
      <p className="mt-0.5 text-[13px] text-cinza">Fica aberto para o setor até alguém de lá (ou você) resolver.</p>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Campo label="Setor">
          <select
            value={setor}
            onChange={(e) => {
              setSetor(e.target.value);
              acao.limparCampo("setor");
            }}
            className={cx(inputCls, "cursor-pointer", marca(acao, "setor"))}
          >
            <option value="">Escolha o setor</option>
            {SETORES.map((s) => (
              <option key={s} value={s}>
                {para(s)}
              </option>
            ))}
          </select>
          <ErroCampo>{acao.campos.setor}</ErroCampo>
        </Campo>
        <div className="hidden sm:block" />
        <Campo label="Aviso" className="sm:col-span-2">
          <textarea
            value={texto}
            onChange={(e) => {
              setTexto(e.target.value);
              acao.limparCampo("texto");
            }}
            rows={2}
            placeholder="O que aconteceu (5 a 500 caracteres)"
            className={cx(inputCls, "py-2.5", marca(acao, "texto"))}
          />
          <ErroCampo>{acao.campos.texto}</ErroCampo>
        </Campo>
        <Campo label="Próximo passo (opcional)" className="sm:col-span-2">
          <input
            value={passo}
            onChange={(e) => {
              setPasso(e.target.value);
              acao.limparCampo("passo");
            }}
            placeholder="O que fazer e até quando"
            className={cx(inputCls, marca(acao, "passo"))}
          />
          <ErroCampo>{acao.campos.passo}</ErroCampo>
        </Campo>
      </div>
      <ErroCampo>{erroGeral(acao)}</ErroCampo>
      <div className="mt-4 flex flex-wrap gap-2">
        <Botao disabled={acao.pendente} onClick={enviar}>
          Enviar aviso
        </Botao>
        <Botao variante="secundario" onClick={onFechar}>
          Cancelar
        </Botao>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Dispensados
// ---------------------------------------------------------------------------

function ListaDispensados({ dispensados }: { dispensados: Dispensado[] }) {
  return (
    <Card>
      <div className="px-6 pt-5">
        <h2 className="text-[16px] font-bold text-texto">Avisos dispensados</h2>
        <p className="mt-0.5 text-[13px] text-cinza">Os dos últimos 90 dias, com quem dispensou e por quê. Fica no histórico.</p>
      </div>
      <ul className="mt-3">
        {dispensados.map((d) => (
          <LinhaDispensado key={d.id} dispensado={d} />
        ))}
        {dispensados.length === 0 && <li className="border-t border-linha px-6 py-8 text-center text-[15px] text-cinza">Nenhum aviso dispensado nos últimos 90 dias.</li>}
      </ul>
    </Card>
  );
}

function LinhaDispensado({ dispensado: d }: { dispensado: Dispensado }) {
  const acao = useAcao();
  return (
    <li className="border-t border-linha px-6 py-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:gap-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow className="!text-verde">{ROTULO_TIPO[d.tipo]}</Eyebrow>
            <span className="text-[12px] text-cinza">Para: {para(d.setor)}</span>
          </div>
          <p className="mt-1 text-[15px] font-semibold text-texto">{d.titulo}</p>
          <p className="mt-0.5 text-[14px] leading-relaxed text-cinza">{d.detalhe}</p>
          <p className="mt-2 text-[14px] text-texto">
            <span className="font-semibold">Justificativa:</span> {d.justificativa}
          </p>
          <p className="mt-1 text-[13px] text-cinza">
            {d.por}, {dataHora(d.criadoEm)}
          </p>
        </div>
        {d.podeDesfazer && (
          <Botao variante="secundario" className="shrink-0" disabled={acao.pendente} onClick={() => executar(acao, () => desfazerDispensa(d.id))}>
            Desfazer dispensa
          </Botao>
        )}
      </div>
      <ErroCampo>{erroGeral(acao)}</ErroCampo>
    </li>
  );
}
