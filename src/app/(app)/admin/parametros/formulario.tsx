"use client";

import { useState, useTransition } from "react";
import { Botao, Card, CardHeader, PageHeader, Select } from "@/components/ui";
import { Grade, SoGestao } from "@/components/kit";
import { lerPercentual, lerReais } from "@/domain/dinheiro";
import {
  CAMPOS,
  METODOS_RATEIO,
  ROTULO_METODO,
  formatarValor,
  valorNoCaminho,
  type CampoRegra,
  type Regras,
} from "@/domain/regras";
import { salvarRegras } from "@/server/actions/regras";

const campoCls =
  "w-[150px] rounded-[4px] border bg-white px-2.5 py-1.5 text-right text-[14px] font-semibold text-texto outline-none focus:border-verde";

function textosDe(valores: Regras): Record<string, string> {
  return Object.fromEntries(
    CAMPOS.map((c) => [c.caminho, c.tipo === "metodo" ? String(valorNoCaminho(valores, c.caminho)) : formatarValor(c.tipo, valorNoCaminho(valores, c.caminho))]),
  );
}

/** Converte o texto digitado no valor canônico; lança "Valor inválido". */
function lerCampo(c: CampoRegra, texto: string): string | number {
  switch (c.tipo) {
    case "reais":
      return lerReais(texto).toString();
    case "pct":
      return lerPercentual(texto);
    case "inteiro":
      if (!/^\d+$/.test(texto.trim())) throw new Error("Valor inválido");
      return Number(texto.trim());
    default:
      return texto;
  }
}

function montar(textos: Record<string, string>): { valores: Regras | null; erros: Record<string, string> } {
  const erros: Record<string, string> = {};
  const obj: Record<string, unknown> = {};
  for (const c of CAMPOS) {
    try {
      const v = lerCampo(c, textos[c.caminho] ?? "");
      const partes = c.caminho.split(".");
      let alvo = obj;
      for (const p of partes.slice(0, -1)) alvo = (alvo[p] ??= {}) as Record<string, unknown>;
      alvo[partes.at(-1)!] = v;
    } catch {
      erros[c.caminho] = "Valor inválido";
    }
  }
  return { valores: Object.keys(erros).length ? null : (obj as Regras), erros };
}

export function Formulario({ valores, desde }: { valores: Regras; desde: string }) {
  const [textos, setTextos] = useState(() => textosDe(valores));
  const [erros, setErros] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [pendente, iniciar] = useTransition();

  function mudar(caminho: string, v: string) {
    setTextos((t) => ({ ...t, [caminho]: v }));
    setErros((e) => {
      if (!(caminho in e)) return e;
      const resto = { ...e };
      delete resto[caminho];
      return resto;
    });
  }

  function salvar() {
    setMsg(null);
    const { valores: v, erros: locais } = montar(textos);
    setErros(locais);
    if (!v) {
      setMsg({ tipo: "erro", texto: "Corrija os campos indicados" });
      return;
    }
    iniciar(async () => {
      const r = await salvarRegras(v);
      if (r.ok) {
        setTextos(textosDe(v));
        setMsg({ tipo: "ok", texto: "Parâmetros salvos. Propostas já aprovadas não mudam" });
      } else {
        setErros(r.campos ?? {});
        setMsg({ tipo: "erro", texto: r.campos ? "Corrija os campos indicados" : r.erro });
      }
    });
  }

  function entrada(c: CampoRegra, extra = "") {
    const erro = erros[c.caminho];
    const id = `campo-${c.caminho}`;
    return (
      <div className="flex flex-col items-end gap-1">
        {c.tipo === "metodo" ? (
          <Select value={textos[c.caminho]} onChange={(x) => mudar(c.caminho, x)}>
            {METODOS_RATEIO.map((m) => (
              <option key={m} value={m}>{ROTULO_METODO[m]}</option>
            ))}
          </Select>
        ) : (
          <input
            id={id}
            aria-label={c.rotulo}
            aria-invalid={erro ? true : undefined}
            className={`${campoCls} ${erro ? "border-ouro bg-ouro/15" : "border-linha"} ${extra}`}
            value={textos[c.caminho] ?? ""}
            onChange={(e) => mudar(c.caminho, e.target.value)}
            inputMode="decimal"
          />
        )}
        {erro && <span className="text-[12px] text-texto">{erro}</span>}
      </div>
    );
  }

  const por = (g: string) => CAMPOS.filter((c) => c.grupo === g);
  const cambio = por("cambio")[0];

  return (
    <>
      <PageHeader
        title="Parâmetros"
        subtitle="Regras de preço, taxas e câmbio. Todos os valores são editáveis pela gestão, com histórico."
        right={
          <div className="flex flex-wrap items-center gap-3">
            <SoGestao />
            <Botao onClick={salvar} disabled={pendente}>Salvar alterações</Botao>
          </div>
        }
      />

      {msg && (
        <p
          role="status"
          className={`mb-5 rounded-[5px] border px-4 py-3 text-[14px] ${msg.tipo === "ok" ? "border-verde/30 bg-verde/[0.06] text-texto" : "border-ouro bg-ouro/15 text-texto"}`}
        >
          {msg.texto}
        </p>
      )}

      <Card className="mb-5">
        <CardHeader eyebrow={`Vigentes desde ${desde}`} title="Regras de precificação" />
        <Grade
          className="mt-3"
          right={[1]}
          head={["Parâmetro", "Valor atual", "Onde é usado", "Observação"]}
          rows={por("regras").map((c) => [
            <b key="p" className="font-semibold">{c.rotulo}</b>,
            entrada(c),
            c.onde,
            <span key="o" className="text-cinza">{c.obs}</span>,
          ])}
        />
      </Card>

      <div className="mb-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Card>
          <CardHeader title="Taxas de pagamento" />
          <Grade
            className="mt-3"
            right={[1]}
            head={["Forma", "Taxa", "Observação"]}
            rows={por("taxas").map((c) => [
              <b key="f" className="font-semibold">{c.rotulo}</b>,
              entrada(c, "!w-[110px]"),
              <span key="o" className="text-cinza">{c.obs}</span>,
            ])}
          />
        </Card>
        <Card>
          <CardHeader eyebrow="Regra: câmbio comercial mais o acréscimo" title="Câmbio" right={entrada(cambio, "!w-[90px]")} />
          <p className="px-6 pb-5 pt-3 text-[13px] text-cinza">
            Valores em moeda estrangeira aparecem sempre com a conversão em reais, o câmbio usado e a data do câmbio.
          </p>
        </Card>
      </div>
    </>
  );
}
