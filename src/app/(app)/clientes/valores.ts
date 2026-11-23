import { nomeDoGrupo, type TipoCliente } from "@/domain/clientes";
import type { Filial } from "@/domain/perfis";
import type { ClienteEntrada, PessoaEntrada } from "@/server/actions/clientes";
import type { ClienteFicha, PessoaFicha } from "@/server/queries/clientes";

export type ValoresPessoa = {
  /** Id da pessoa já gravada; ausente em pessoa nova. */
  id?: string;
  /** Chave local da linha no formulário (pessoas novas não têm id). Não vai para o servidor. */
  chave?: string;
  nome: string;
  parentesco: string;
  nascimento: string;
  cpf: string;
  passaporte: string;
  validadePassaporte: string;
};

export type ValoresCliente = {
  tipo: TipoCliente;
  grupo: string;
  filial: Filial;
  telefone: string;
  email: string;
  prefQuarto: string;
  prefAlimentacao: string;
  prefAssento: string;
  observacoes: string;
  titular: ValoresPessoa;
  acompanhantes: ValoresPessoa[];
};

export const PESSOA_VAZIA: ValoresPessoa = {
  nome: "",
  parentesco: "",
  nascimento: "",
  cpf: "",
  passaporte: "",
  validadePassaporte: "",
};

export const VALORES_VAZIOS: ValoresCliente = {
  tipo: "familia",
  grupo: "",
  filial: "Rondonópolis",
  telefone: "",
  email: "",
  prefQuarto: "",
  prefAlimentacao: "",
  prefAssento: "",
  observacoes: "",
  titular: PESSOA_VAZIA,
  acompanhantes: [],
};

const pessoaDe = (p: PessoaFicha): ValoresPessoa => ({
  id: p.id,
  nome: p.nome,
  parentesco: p.parentesco ?? "",
  nascimento: p.nascimento ?? "",
  cpf: p.cpf ?? "",
  passaporte: p.passaporte ?? "",
  validadePassaporte: p.validadePassaporte ?? "",
});

export function valoresDe(c: ClienteFicha): ValoresCliente {
  const titular = c.pessoas.find((p) => p.titular);
  // Nome derivado (igual à sugestão) volta vazio, para continuar acompanhando tipo e titular.
  const derivado = titular ? c.grupo === nomeDoGrupo(c.tipo, titular.nome) : false;
  return {
    tipo: c.tipo,
    grupo: derivado ? "" : c.grupo,
    filial: c.filial,
    telefone: c.telefone,
    email: c.email ?? "",
    prefQuarto: c.prefQuarto ?? "",
    prefAlimentacao: c.prefAlimentacao ?? "",
    prefAssento: c.prefAssento ?? "",
    observacoes: c.observacoes ?? "",
    titular: titular ? pessoaDe(titular) : PESSOA_VAZIA,
    acompanhantes: c.pessoas.filter((p) => !p.titular).map(pessoaDe),
  };
}

function pessoaEntrada({ id, chave: _chave, ...resto }: ValoresPessoa): PessoaEntrada {
  void _chave;
  return id ? { id, ...resto } : resto;
}

export function paraEntrada(v: ValoresCliente): ClienteEntrada {
  return { ...v, titular: pessoaEntrada(v.titular), acompanhantes: v.acompanhantes.map(pessoaEntrada) };
}
