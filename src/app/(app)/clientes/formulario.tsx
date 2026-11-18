"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Botao, Campo, Card, CardHeader, PageHeader, Select, inputCls } from "@/components/ui";
import { NOMES_TIPO_CLIENTE, TIPOS_CLIENTE, nomeDoGrupo, type TipoCliente } from "@/domain/clientes";
import { FILIAIS, type Filial } from "@/domain/perfis";
import { salvarCliente } from "@/server/actions/clientes";
import { PESSOA_VAZIA, paraEntrada, type ValoresCliente, type ValoresPessoa } from "./valores";

const PARENTESCOS = ["Cônjuge", "Filho(a)", "Pai", "Mãe", "Irmão(ã)", "Avô(ó)", "Amigo(a)", "Outro"];

export function FormularioCliente({
  inicial,
  id,
  atualizadoEm,
}: {
  inicial: ValoresCliente;
  id?: string;
  atualizadoEm?: string;
}) {
  const router = useRouter();
  const [v, setV] = useState(inicial);
  const [erros, setErros] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [conflito, setConflito] = useState(false);
  const [pendente, iniciar] = useTransition();

  function limpar(chave: string) {
    setErros((e) => {
      if (!(chave in e)) return e;
      const r = { ...e };
      delete r[chave];
      return r;
    });
  }

  function mudar<K extends keyof ValoresCliente>(k: K, valor: ValoresCliente[K]) {
    setV((x) => ({ ...x, [k]: valor }));
    limpar(k);
  }

  function mudarTitular(k: keyof ValoresPessoa, valor: string) {
    setV((x) => ({ ...x, titular: { ...x.titular, [k]: valor } }));
    limpar(`titular.${k}`);
  }

  function mudarAcompanhante(i: number, k: keyof ValoresPessoa, valor: string) {
    setV((x) => ({ ...x, acompanhantes: x.acompanhantes.map((p, n) => (n === i ? { ...p, [k]: valor } : p)) }));
    limpar("acompanhantes");
  }

  function salvar() {
    setMsg(null);
    setConflito(false);
    iniciar(async () => {
      const r = await salvarCliente(paraEntrada(v), id, atualizadoEm);
      if (r.ok) {
        router.push(`/clientes/${r.id}`);
        router.refresh();
      } else {
        setErros(r.campos ?? {});
        setConflito(!r.campos && r.erro.includes("Recarregue"));
        setMsg(r.campos ? "Corrija os campos indicados" : r.erro);
      }
    });
  }

  const sugerido = v.titular.nome.trim() ? nomeDoGrupo(v.tipo, v.titular.nome) : "";
  const marca = (chave: string) => (erros[chave] ? "!border-ouro bg-ouro/15" : "");
  const erro = (chave: string) =>
    erros[chave] ? <span className="mt-1 block text-[12px] text-texto">{erros[chave]}</span> : null;

  const campoPessoa = (
    rotulo: string,
    valor: string,
    aoMudar: (x: string) => void,
    chave: string,
    extra?: { type?: string; placeholder?: string; lista?: string; className?: string },
  ) => (
    <Campo label={rotulo} className={extra?.className}>
      <input
        type={extra?.type}
        list={extra?.lista}
        placeholder={extra?.placeholder}
        className={`${inputCls} ${marca(chave)}`}
        aria-invalid={erros[chave] ? true : undefined}
        value={valor}
        onChange={(e) => aoMudar(e.target.value)}
      />
      {erro(chave)}
    </Campo>
  );

  const texto = (k: "telefone" | "email" | "prefQuarto" | "prefAlimentacao" | "prefAssento", rotulo: string, placeholder?: string) => (
    <Campo label={rotulo}>
      <input
        className={`${inputCls} ${marca(k)}`}
        aria-invalid={erros[k] ? true : undefined}
        placeholder={placeholder}
        value={v[k]}
        onChange={(e) => mudar(k, e.target.value)}
      />
      {erro(k)}
    </Campo>
  );

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title={id ? `Editar ${inicial.grupo || "cliente"}` : "Novo cliente"}
        subtitle="O código do cliente é gerado ao salvar e passa a identificar viagens, faturas, vouchers e pastas do Drive."
        right={
          <div className="flex flex-wrap gap-2">
            <Link
              href={id ? `/clientes/${id}` : "/clientes"}
              className="inline-flex items-center rounded-[5px] border border-[#C9CDD1] px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde"
            >
              Cancelar
            </Link>
            <Botao onClick={salvar} disabled={pendente}>{id ? "Salvar alterações" : "Salvar cliente"}</Botao>
          </div>
        }
      />
      {msg && (
        <div role="alert" className="mb-5 rounded-[5px] border border-ouro bg-ouro/15 px-4 py-3 text-[14px] text-texto">
          <p className={conflito ? "font-semibold" : undefined}>{msg}</p>
          {conflito && id && (
            <a href={`/clientes/${id}/editar`} className="mt-1 inline-block font-semibold text-verde underline">
              Recarregar
            </a>
          )}
        </div>
      )}

      <div className="space-y-5">
        <Card className="pb-6">
          <CardHeader title="Cliente" eyebrow="Como ele aparece nas viagens e em qual filial é atendido." />
          <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
            <Campo label="Tipo de cliente">
              <Select value={v.tipo} onChange={(x) => mudar("tipo", x as TipoCliente)} className="w-full">
                {TIPOS_CLIENTE.map((t) => <option key={t} value={t}>{NOMES_TIPO_CLIENTE[t]}</option>)}
              </Select>
            </Campo>
            <Campo label="Nome do grupo (opcional)">
              <input
                className={`${inputCls} ${marca("grupo")}`}
                placeholder={sugerido ? `Sugestão: ${sugerido}` : "Ex.: Família Ribeiro"}
                value={v.grupo}
                onChange={(e) => mudar("grupo", e.target.value)}
              />
              {erro("grupo")}
            </Campo>
            <Campo label="Filial">
              <Select value={v.filial} onChange={(x) => mudar("filial", x as Filial)} className="w-full">
                {FILIAIS.map((f) => <option key={f} value={f}>{f === "RS" ? "Filial RS" : f}</option>)}
              </Select>
            </Campo>
            {texto("telefone", "Telefone (WhatsApp)", "(66) 9 0000-0000")}
            {texto("email", "E-mail")}
          </div>
        </Card>

        <Card className="pb-6">
          <CardHeader title="Titular" eyebrow={v.tipo === "grupo" ? "Contato do grupo." : "Quem contrata a viagem e recebe as mensagens."} />
          <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
            {campoPessoa("Nome completo", v.titular.nome, (x) => mudarTitular("nome", x), "titular.nome", { className: "sm:col-span-2" })}
            {campoPessoa("Nascimento", v.titular.nascimento, (x) => mudarTitular("nascimento", x), "titular.nascimento", { type: "date" })}
            {campoPessoa("CPF", v.titular.cpf, (x) => mudarTitular("cpf", x), "titular.cpf", { placeholder: "000.000.000-00" })}
            {campoPessoa("Passaporte", v.titular.passaporte, (x) => mudarTitular("passaporte", x), "titular.passaporte")}
            {campoPessoa("Validade do passaporte", v.titular.validadePassaporte, (x) => mudarTitular("validadePassaporte", x), "titular.validadePassaporte", { type: "date" })}
          </div>
        </Card>

        <Card className="pb-6">
          <CardHeader
            title="Quem viaja junto"
            eyebrow="O sistema avisa quando falta passaporte, quando está vencido e quando há aniversário chegando."
            right={
              <Botao variante="secundario" onClick={() => mudar("acompanhantes", [...v.acompanhantes, { ...PESSOA_VAZIA }])}>
                <Plus size={15} /> Adicionar pessoa
              </Botao>
            }
          />
          {erros.acompanhantes && (
            <p role="status" className="mx-6 mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
              {erros.acompanhantes}
            </p>
          )}
          {v.acompanhantes.length === 0 && (
            <p className="mx-6 mt-4 rounded-[5px] bg-fundo px-4 py-3 text-[13px] text-cinza">
              Ninguém cadastrado. Adicione cônjuge, filhos ou acompanhantes frequentes.
            </p>
          )}
          <datalist id="parentescos">{PARENTESCOS.map((p) => <option key={p} value={p} />)}</datalist>
          <div className="mt-4 space-y-4 px-6">
            {v.acompanhantes.map((p, i) => (
              <div key={i} className="grid grid-cols-1 gap-3 rounded-[6px] border border-linha p-4 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr_1fr_1fr_auto]">
                {campoPessoa("Nome completo", p.nome, (x) => mudarAcompanhante(i, "nome", x), "")}
                {campoPessoa("Parentesco", p.parentesco, (x) => mudarAcompanhante(i, "parentesco", x), "", { lista: "parentescos" })}
                {campoPessoa("Nascimento", p.nascimento, (x) => mudarAcompanhante(i, "nascimento", x), "", { type: "date" })}
                {campoPessoa("CPF", p.cpf, (x) => mudarAcompanhante(i, "cpf", x), "", { placeholder: "000.000.000-00" })}
                {campoPessoa("Passaporte", p.passaporte, (x) => mudarAcompanhante(i, "passaporte", x), "")}
                {campoPessoa("Validade", p.validadePassaporte, (x) => mudarAcompanhante(i, "validadePassaporte", x), "", { type: "date" })}
                <button
                  type="button"
                  onClick={() => mudar("acompanhantes", v.acompanhantes.filter((_, n) => n !== i))}
                  aria-label={`Remover ${p.nome || "pessoa"}`}
                  className="cursor-pointer self-end rounded-[5px] p-2.5 text-cinza hover:bg-fundo hover:text-texto"
                >
                  <Trash2 size={17} />
                </button>
              </div>
            ))}
          </div>
        </Card>

        <Card className="pb-6">
          <CardHeader title="Preferências" eyebrow="Aparecem na cotação e no roteiro." />
          <div className="mt-4 grid grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
            {texto("prefQuarto", "Quarto", "King, andar alto")}
            {texto("prefAlimentacao", "Alimentação", "Sem glúten")}
            {texto("prefAssento", "Assento", "Janela")}
            <Campo label="Observações" className="sm:col-span-2 lg:col-span-3">
              <textarea rows={3} className={inputCls} value={v.observacoes} onChange={(e) => mudar("observacoes", e.target.value)} />
              {erro("observacoes")}
            </Campo>
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-[16px] font-bold text-texto">Documentos</h2>
          <p className="mt-0.5 text-[13px] text-cinza">Cópias de passaporte e RG ficam na pasta de uso interno do cliente, no Drive.</p>
        </Card>
      </div>
    </div>
  );
}
