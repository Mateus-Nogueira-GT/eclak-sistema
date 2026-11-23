import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import type { Modalidade, TipoServico } from "@/domain/fornecedores";

export type ValoresFornecedor = {
  nome: string;
  tipos: TipoServico[];
  cidade: string;
  modalidade: Modalidade;
  comissaoPct: string;
  tarifaFixa: string;
  descontoAVista: string;
  operacaoFinanceiraOperadora: string;
  contatoNome: string;
  contatoTelefone: string;
  contatoEmail: string;
  plantao: string;
  observacoes: string;
};

export const VALORES_VAZIOS: ValoresFornecedor = {
  nome: "",
  tipos: [],
  cidade: "",
  modalidade: "net",
  comissaoPct: "0",
  tarifaFixa: "",
  descontoAVista: "",
  operacaoFinanceiraOperadora: "",
  contatoNome: "",
  contatoTelefone: "",
  contatoEmail: "",
  plantao: "",
  observacoes: "",
};

type Linha = {
  nome: string; tipos: TipoServico[]; cidade: string | null; modalidade: Modalidade; comissaoPct: string;
  tarifaFixa: bigint; descontoAVista: string | null; operacaoFinanceiraOperadora: string | null;
  contatoNome: string | null; contatoTelefone: string | null; contatoEmail: string | null;
  plantao: string | null; observacoes: string | null;
};

export function valoresDe(f: Linha): ValoresFornecedor {
  return {
    nome: f.nome,
    tipos: f.tipos,
    cidade: f.cidade ?? "",
    modalidade: f.modalidade,
    comissaoPct: formatarPercentual(f.comissaoPct).replace("%", ""),
    tarifaFixa: f.tarifaFixa === 0n ? "" : formatarReais(f.tarifaFixa),
    descontoAVista: f.descontoAVista ?? "",
    operacaoFinanceiraOperadora: f.operacaoFinanceiraOperadora ?? "",
    contatoNome: f.contatoNome ?? "",
    contatoTelefone: f.contatoTelefone ?? "",
    contatoEmail: f.contatoEmail ?? "",
    plantao: f.plantao ?? "",
    observacoes: f.observacoes ?? "",
  };
}
