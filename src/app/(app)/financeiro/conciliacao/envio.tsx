"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Upload } from "lucide-react";
import { Botao, Card, Eyebrow } from "@/components/ui";
import { importarExtrato } from "@/server/actions/conciliacao";
import { MSG_FALHA } from "../../viagens/[id]/acao";
import { dataBr } from "../../viagens/formatos";

type Resumo = { novas: number; repetidas: number; ajustadas: number; inicio: string | null; fim: string | null };

/** Envio do arquivo OFX do banco para a conta aberta, com o resumo do que entrou. */
export function EnvioExtrato({ contaId, contaNome, ativa }: { contaId: string; contaNome: string; ativa: boolean }) {
  const router = useRouter();
  const [pendente, iniciar] = useTransition();
  const [erro, setErro] = useState<string | null>(null);
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [nome, setNome] = useState("");
  /** O servidor achou o arquivo de outra conta: o mesmo arquivo pode ir de novo com a confirmação. */
  const [pedeConfirmacao, setPedeConfirmacao] = useState(false);
  const arquivo = useRef<HTMLInputElement>(null);
  const formulario = useRef<HTMLFormElement>(null);

  function importar(confirmarOutraConta: boolean) {
    if (!formulario.current) return;
    const dados = new FormData(formulario.current);
    if (confirmarOutraConta) dados.set("confirmarOutraConta", "1");
    setErro(null);
    setResumo(null);
    setPedeConfirmacao(false);
    iniciar(async () => {
      try {
        const r = await importarExtrato(dados);
        if (r.ok) {
          setResumo({ novas: r.novas, repetidas: r.repetidas, ajustadas: r.ajustadas, inicio: r.inicio, fim: r.fim });
          setNome("");
          if (arquivo.current) arquivo.current.value = "";
          router.refresh();
        } else {
          setErro(r.erro);
          setPedeConfirmacao("outraConta" in r && r.outraConta === true);
        }
      } catch {
        setErro(MSG_FALHA);
      }
    });
  }

  function enviar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    importar(false);
  }

  return (
    <Card className="mb-5 p-5">
      <Eyebrow>Importar extrato</Eyebrow>
      {!ativa ? (
        <p className="mt-2 text-[14px] text-cinza">A conta {contaNome} está desativada: reative-a em Contas bancárias para importar um extrato.</p>
      ) : (
        <form ref={formulario} onSubmit={enviar} className="mt-2 flex flex-wrap items-center gap-3">
          <input type="hidden" name="contaBancariaId" value={contaId} />
          <input
            ref={arquivo}
            type="file"
            name="arquivo"
            accept=".ofx,.OFX"
            aria-label="Arquivo OFX"
            onChange={(e) => {
              setNome(e.target.files?.[0]?.name ?? "");
              setErro(null);
              setPedeConfirmacao(false);
            }}
            className="max-w-[420px] cursor-pointer text-[14px] text-texto file:mr-3 file:cursor-pointer file:rounded-[5px] file:border file:border-[#C9CDD1] file:bg-white file:px-3 file:py-2 file:text-[14px] file:font-semibold file:text-texto"
          />
          <Botao type="submit" disabled={pendente || !nome}>
            <Upload size={16} /> {pendente ? "Importando…" : `Importar em ${contaNome}`}
          </Botao>
          <span className="text-[13px] text-cinza">Arquivo OFX do banco, até 5 MB. Reenviar um extrato com lançamentos já importados não duplica nada.</span>
        </form>
      )}
      {erro && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
          <span>{erro}</span>
          {pedeConfirmacao && nome && (
            <Botao variante="secundario" disabled={pendente} onClick={() => importar(true)} className="!px-2.5 !py-1 !text-[13px]">
              Importar mesmo assim
            </Botao>
          )}
        </div>
      )}
      {resumo && (
        <p role="status" className="mt-3 rounded-[5px] border border-linha bg-fundo px-3 py-2 text-[13.5px] text-texto">
          Extrato importado
          {resumo.inicio && resumo.fim ? ` (${dataBr(resumo.inicio)} a ${dataBr(resumo.fim)})` : ""}: <strong>{resumo.novas}</strong>{" "}
          {resumo.novas === 1 ? "transação nova" : "transações novas"}
          {resumo.repetidas > 0 && (
            <>
              , <strong>{resumo.repetidas}</strong> {resumo.repetidas === 1 ? "já estava importada" : "já estavam importadas"}
            </>
          )}
          .
          {resumo.ajustadas > 0 && (
            <>
              {" "}
              <strong>{resumo.ajustadas}</strong>{" "}
              {resumo.ajustadas === 1
                ? "transação com identificador repetido no banco foi importada separada."
                : "transações com identificador repetido no banco foram importadas separadas."}
            </>
          )}
        </p>
      )}
    </Card>
  );
}
