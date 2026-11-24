"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Botao, Campo, Card, Th, Td, inputCls } from "@/components/ui";
import { formatarReais } from "@/domain/dinheiro";
import type { Origem } from "@/domain/financeiro";
import { confirmarPar, criarLancamentoDaTransacao, desfazerConciliacao, ignorarTransacao } from "@/server/actions/conciliacao";
import type { LinhaConciliacao } from "@/server/queries/conciliacao";
import { MSG_FALHA, useAcao } from "../../viagens/[id]/acao";
import { dataBr } from "../../viagens/formatos";
import { Dialogo } from "../lancamentos/baixa";

type Grupo = { lado: "pagar" | "receber"; grupo: string; categorias: { id: string; nome: string }[] };
type Candidata = LinhaConciliacao["opcoes"][number];

const TOM = { confere: "agua", diferenca: "ouro", nao_conciliado: "ouro", ignorado: "cinza", baixa_mudou: "ouro" } as const;
const MAX_DESCRICAO = 200;

const comSinal = (c: bigint) => (c < 0n ? `− ${formatarReais(-c)}` : formatarReais(c));
const ROTULO_ORIGEM: Record<Origem, string> = {
  manual: "Lançamento",
  pagamento: "Pagamento de viagem",
  parcela: "Parcela de viagem",
  comissao: "Comissão",
  fatura_cartao: "Fatura do cartão",
};

function Par({ c }: { c: Candidata }) {
  return (
    <div>
      <p className="text-[14px] text-texto">{c.pessoa || c.descricao}</p>
      <p className="text-[12.5px] text-cinza">
        {ROTULO_ORIGEM[c.origem]} · {c.pessoa ? `${c.descricao} · ` : ""}baixa em {dataBr(c.data)} · <span className="num">{comSinal(c.valor)}</span>
      </p>
    </div>
  );
}

type Aberto = { tipo: "escolher" | "criar" | "ignorar"; linha: LinhaConciliacao } | null;

export function ListaConciliacao({ linhas, categorias, vazio }: { linhas: LinhaConciliacao[]; categorias: Grupo[]; vazio: string }) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [aviso, setAviso] = useState<string | null>(null);
  const [aberto, setAberto] = useState<Aberto>(null);

  function executar(fn: () => Promise<{ ok: true } | { ok: false; erro: string }>) {
    setAviso(null);
    iniciar(async () => {
      try {
        const r = await fn();
        if (r.ok) router.refresh();
        else setAviso(r.erro);
      } catch {
        setAviso(MSG_FALHA);
      }
    });
  }

  const confirmar = (l: LinhaConciliacao, c: Candidata) => executar(() => confirmarPar(l.transacao.id, c.origem, c.id));
  const desfazer = (l: LinhaConciliacao) => {
    if (!window.confirm(`Desfazer o tratamento de "${l.transacao.descricao}"? A transação volta a ficar pendente.`)) return;
    executar(() => desfazerConciliacao(l.transacao.id));
  };

  return (
    <div>
      {aviso && (
        <p role="alert" className="mb-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
          {aviso}
        </p>
      )}
      <Card className="overflow-hidden">
        <table className="w-full table-fixed text-left">
          <thead>
            <tr>
              <Th className="w-[100px]">Data</Th>
              <Th className="w-[24%]">Extrato</Th>
              <Th className="w-[120px] text-right">Extrato (R$)</Th>
              <Th className="w-[24%]">Sistema</Th>
              <Th className="w-[120px] text-right">Sistema (R$)</Th>
              <Th className="w-[170px]">Situação</Th>
              <Th className="text-right">Ações</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-linha">
            {linhas.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-[14px] text-cinza">{vazio}</td>
              </tr>
            )}
            {linhas.map((l) => {
              const t = l.transacao;
              const sistema = l.linha ?? (l.situacao.tipo === "nao_conciliado" ? l.sugestao : null);
              const ehSugestao = l.linha === null && l.sugestao !== null && l.situacao.tipo === "nao_conciliado";
              return (
                <tr key={t.id} className="align-top">
                  <Td className="whitespace-nowrap">{dataBr(t.data)}</Td>
                  <Td>
                    <p className="text-texto [overflow-wrap:anywhere]">{t.descricao}</p>
                    {t.tipo && <p className="text-[12.5px] text-cinza">{t.tipo}</p>}
                  </Td>
                  <Td className="num whitespace-nowrap text-right font-semibold">{comSinal(t.valor)}</Td>
                  <Td>
                    {sistema ? (
                      <>
                        {ehSugestao && <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">Sugestão</p>}
                        <Par c={sistema} />
                      </>
                    ) : t.situacao === "ignorada" ? (
                      <p className="text-[13px] text-cinza">Motivo: {t.ignoradaMotivo}</p>
                    ) : (
                      <span className="text-cinza">—</span>
                    )}
                  </Td>
                  <Td className="num whitespace-nowrap text-right">{sistema ? comSinal(sistema.valor) : ""}</Td>
                  <Td>
                    <Badge tom={TOM[l.situacao.tipo]}>{l.situacao.rotulo}</Badge>
                  </Td>
                  <Td className="text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {t.situacao === "pendente" ? (
                        <>
                          {l.sugestao && (
                            <Botao disabled={pendente} onClick={() => confirmar(l, l.sugestao!)} className="!px-2.5 !py-1 !text-[13px]">
                              Confirmar
                            </Botao>
                          )}
                          {l.opcoes.length > 0 && (
                            <Botao variante="secundario" disabled={pendente} onClick={() => setAberto({ tipo: "escolher", linha: l })} className="!px-2.5 !py-1 !text-[13px]">
                              {l.sugestao ? "Escolher outra" : "Escolher baixa"}
                            </Botao>
                          )}
                          <Botao variante="secundario" disabled={pendente} onClick={() => setAberto({ tipo: "criar", linha: l })} className="!px-2.5 !py-1 !text-[13px]">
                            Criar lançamento
                          </Botao>
                          <Botao variante="fantasma" disabled={pendente} onClick={() => setAberto({ tipo: "ignorar", linha: l })} className="!px-2.5 !py-1 !text-[13px]">
                            Ignorar
                          </Botao>
                        </>
                      ) : (
                        <Botao variante="secundario" disabled={pendente} onClick={() => desfazer(l)} className="!px-2.5 !py-1 !text-[13px]">
                          Desfazer
                        </Botao>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {aberto?.tipo === "escolher" && <DialogoEscolher linha={aberto.linha} onFechar={() => setAberto(null)} onEscolher={(c) => { setAberto(null); confirmar(aberto.linha, c); }} />}
      {aberto?.tipo === "criar" && <DialogoCriar linha={aberto.linha} categorias={categorias} onFechar={() => setAberto(null)} />}
      {aberto?.tipo === "ignorar" && <DialogoIgnorar linha={aberto.linha} onFechar={() => setAberto(null)} />}
    </div>
  );
}

function Resumo({ l }: { l: LinhaConciliacao }) {
  return (
    <p className="mb-4 text-[13.5px] text-cinza">
      Extrato de {dataBr(l.transacao.data)} · <span className="num font-semibold text-texto">{comSinal(l.transacao.valor)}</span> · {l.transacao.descricao}
    </p>
  );
}

function DialogoEscolher({ linha, onFechar, onEscolher }: { linha: LinhaConciliacao; onFechar: () => void; onEscolher: (c: Candidata) => void }) {
  return (
    <Dialogo eyebrow="Conciliar" titulo="Escolher a baixa" onFechar={onFechar} rodape={<Botao variante="secundario" onClick={onFechar}>Cancelar</Botao>}>
      <div className="px-6 py-5">
        <Resumo l={linha} />
        <p className="mb-2 text-[13px] text-cinza">Baixas desta conta, do mesmo sentido e a até 10 dias, das mais parecidas para as menos.</p>
        <ul className="max-h-[360px] divide-y divide-linha overflow-y-auto rounded-[5px] border border-linha">
          {linha.opcoes.map((c) => (
            <li key={`${c.origem}:${c.id}`} className="flex items-center justify-between gap-4 px-4 py-3">
              <Par c={c} />
              <Botao variante="secundario" onClick={() => onEscolher(c)} className="!px-2.5 !py-1 !text-[13px]">
                Conciliar
              </Botao>
            </li>
          ))}
        </ul>
      </div>
    </Dialogo>
  );
}

function DialogoCriar({ linha, categorias, onFechar }: { linha: LinhaConciliacao; categorias: Grupo[]; onFechar: () => void }) {
  const t = linha.transacao;
  const acao = useAcao();
  const lado = t.valor < 0n ? "pagar" : "receber";
  const [categoriaId, setCategoriaId] = useState("");
  const [descricao, setDescricao] = useState(t.descricao.slice(0, MAX_DESCRICAO));
  const [centro, setCentro] = useState<"MT" | "RS">("MT");
  const invalido = (k: string) => (k in acao.campos ? "!border-ouro bg-ouro/15" : "");
  return (
    <Dialogo
      eyebrow={lado === "pagar" ? "Criar lançamento · saída" : "Criar lançamento · entrada"}
      titulo="Criar lançamento a partir do extrato"
      onFechar={onFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={onFechar}>Cancelar</Botao>
          <Botao disabled={acao.pendente} onClick={() => acao.executar(() => criarLancamentoDaTransacao(t.id, { categoriaId, descricao, centro }), onFechar)}>
            Criar e conciliar
          </Botao>
        </>
      }
    >
      <div className="px-6 py-5">
        <Resumo l={linha} />
        <p className="mb-4 text-[13px] text-cinza">O lançamento nasce já baixado, na conta do extrato, com a data e o valor da transação.</p>
        <div className="grid grid-cols-2 gap-4">
          <Campo label="Categoria financeira" className="col-span-2">
            <select className={`${inputCls} ${invalido("categoriaId")}`} value={categoriaId} onChange={(e) => setCategoriaId(e.target.value)}>
              <option value="">Escolha a categoria</option>
              {categorias
                .filter((g) => g.lado === lado && g.categorias.length > 0)
                .map((g) => (
                  <optgroup key={g.grupo} label={g.grupo}>
                    {g.categorias.map((c) => (
                      <option key={c.id} value={c.id}>{c.nome}</option>
                    ))}
                  </optgroup>
                ))}
            </select>
          </Campo>
          <Campo label="Descrição" className="col-span-2">
            <input className={`${inputCls} ${invalido("descricao")}`} maxLength={MAX_DESCRICAO} value={descricao} onChange={(e) => setDescricao(e.target.value)} />
          </Campo>
          <Campo label="Centro de custo">
            <select className={inputCls} value={centro} onChange={(e) => setCentro(e.target.value as "MT" | "RS")}>
              <option value="MT">MT (Rondonópolis)</option>
              <option value="RS">RS</option>
            </select>
          </Campo>
        </div>
        {acao.erro && (
          <p role="alert" className="mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
            {acao.erro}
            {[...new Set(Object.values(acao.campos))].length > 0 && `: ${[...new Set(Object.values(acao.campos))].join("; ")}`}
          </p>
        )}
      </div>
    </Dialogo>
  );
}

function DialogoIgnorar({ linha, onFechar }: { linha: LinhaConciliacao; onFechar: () => void }) {
  const acao = useAcao();
  const [motivo, setMotivo] = useState("");
  return (
    <Dialogo
      eyebrow="Ignorar transação"
      titulo="Ignorar esta transação do extrato"
      onFechar={onFechar}
      rodape={
        <>
          <Botao variante="secundario" onClick={onFechar}>Cancelar</Botao>
          <Botao disabled={acao.pendente} onClick={() => acao.executar(() => ignorarTransacao(linha.transacao.id, motivo), onFechar)}>
            Ignorar
          </Botao>
        </>
      }
    >
      <div className="px-6 py-5">
        <Resumo l={linha} />
        <Campo label="Motivo">
          <input className={`${inputCls} ${"motivo" in acao.campos ? "!border-ouro bg-ouro/15" : ""}`} maxLength={200} value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: transferência entre contas da própria empresa" />
        </Campo>
        {acao.erro && (
          <p role="alert" className="mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
            {acao.campos.motivo ?? acao.erro}
          </p>
        )}
      </div>
    </Dialogo>
  );
}
