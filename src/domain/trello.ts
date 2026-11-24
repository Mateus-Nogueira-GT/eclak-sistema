import { ultimoSobrenome } from "./clientes";

// Trello (puro): nome e descrição do cartão da viagem, chaves da fila e nomes dos checklists. Nada de valor, custo,
// margem, comissão nem documento: só código, sobrenome do titular, destino, datas e o link da viagem no sistema.

export const CHECKLIST_VENDA = "Tarefas da venda";
export const CHECKLIST_ROTEIRO = "Tarefas do roteiro";

export const chaveVenda = (viagemId: string) => `venda:${viagemId}`;
export const chaveRoteiro = (viagemId: string) => `roteiro:${viagemId}`;

const diaMes = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const ano = (iso: string) => iso.slice(0, 4);

/** "14/08 a 01/09/2027"; quando a viagem vira o ano, os dois anos ("28/12/2026 a 04/01/2027"). Datas "AAAA-MM-DD". */
export function periodoDoCartao(inicio: string, fim: string): string {
  const deInicio = ano(inicio) === ano(fim) ? diaMes(inicio) : `${diaMes(inicio)}/${ano(inicio)}`;
  return `${deInicio} a ${diaMes(fim)}/${ano(fim)}`;
}

/** `ECL-0147-01 · SOUZA · Itália · 14/08 a 01/09/2027`. */
export function nomeDoCartao(v: { codigo: string; titular: string; destino: string; inicio: string; fim: string }): string {
  const sobrenome = ultimoSobrenome(v.titular).toLocaleUpperCase("pt-BR");
  return `${v.codigo} · ${sobrenome} · ${v.destino.trim()} · ${periodoDoCartao(v.inicio, v.fim)}`;
}

export function descricaoDoCartao(site: string, viagemId: string): string {
  return `Viagem no sistema: ${site}/viagens/${viagemId}`;
}
