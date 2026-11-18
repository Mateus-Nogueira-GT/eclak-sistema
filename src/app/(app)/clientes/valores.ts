import type { TipoCliente } from "@/domain/clientes";
import type { Filial } from "@/domain/perfis";
import type { ClienteEntrada } from "@/server/actions/clientes";
import type { ClienteFicha, PessoaFicha } from "@/server/queries/clientes";

export type ValoresPessoa = {
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
  nome: p.nome,
  parentesco: p.parentesco ?? "",
  nascimento: p.nascimento ?? "",
  cpf: p.cpf ?? "",
  passaporte: p.passaporte ?? "",
  validadePassaporte: p.validadePassaporte ?? "",
});

export function valoresDe(c: ClienteFicha): ValoresCliente {
  const titular = c.pessoas.find((p) => p.titular);
  return {
    tipo: c.tipo,
    grupo: c.grupo,
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

export function paraEntrada(v: ValoresCliente): ClienteEntrada {
  return v;
}
