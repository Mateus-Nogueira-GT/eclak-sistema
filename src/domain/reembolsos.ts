import { dataEmCuiaba } from "@/domain/clientes";

export const FORMAS_DEVOLUCAO = ["pix", "transferencia", "abatimento", "credito"] as const;
export type FormaDevolucao = (typeof FORMAS_DEVOLUCAO)[number];

export const ROTULO_FORMA_DEVOLUCAO: Record<FormaDevolucao, string> = {
  pix: "PIX",
  transferencia: "Transferência",
  abatimento: "Abatimento na próxima parcela",
  credito: "Crédito para a próxima viagem",
};

/** Só PIX e transferência tiram dinheiro da ECLAK: abatimento e crédito não geram conta a pagar. */
export function geraContaAPagar(forma: FormaDevolucao): boolean {
  return forma === "pix" || forma === "transferencia";
}

// Reembolso: a ECLAK cobra o fornecedor (lado do fornecedor) e devolve ao cliente (lado do cliente). O caso não copia
// o estado das contas: quem monta estes lados lê a conta a receber e a conta a pagar (spec §14). Datas ISO.

/** `recebidoEm`: a baixa da conta a receber; `pedidoEm`: o pedido feito ao fornecedor. */
export type LadoFornecedor = { valor: bigint; pedidoEm: string | null; recebidoEm: string | null };
/** `reembolsadoEm`: a baixa da conta a pagar, ou a data do caso nas formas sem conta (abatimento e crédito). */
export type LadoCliente = { valor: bigint; reembolsadoEm: string | null };

export type SituacaoReembolso =
  | "Pedir ao fornecedor"
  | "Aguardando fornecedor e cliente"
  | "Aguardando o fornecedor"
  | "Reembolsar o cliente"
  | "Concluído"
  | "Cancelado";

/** Situação exibida. Um lado com valor 0 não tem o que esperar: conta como fechado. */
export function situacaoDoReembolso(c: { canceladoEm: string | null; fornecedor: LadoFornecedor; cliente: LadoCliente }): SituacaoReembolso {
  if (c.canceladoEm) return "Cancelado";
  const fornecedorAberto = c.fornecedor.valor > 0n && !c.fornecedor.recebidoEm;
  const clienteAberto = c.cliente.valor > 0n && !c.cliente.reembolsadoEm;
  if (!fornecedorAberto && !clienteAberto) return "Concluído";
  if (!fornecedorAberto) return "Reembolsar o cliente";
  if (!c.fornecedor.pedidoEm) return "Pedir ao fornecedor";
  return clienteAberto ? "Aguardando fornecedor e cliente" : "Aguardando o fornecedor";
}

/** As datas de um caso que mexem na margem real: o caso e as baixas (AAAA-MM-DD) das contas ligadas não canceladas. */
export type DatasDoCaso = { criadoEm: Date; atualizadoEm: Date; canceladoEm: Date | null; baixas: string[] };

/**
 * A margem real da viagem conciliada mudou por reembolso depois da conciliação: algum caso foi criado, atualizado ou
 * cancelado depois de `conciliadaEm`, ou uma conta ligada a ele foi baixada a partir do dia da conciliação (em Cuiabá;
 * a baixa só tem a data). Não conciliada: nunca.
 */
export function margemAlteradaDepoisDaConciliacao(conciliadaEm: Date | null, casos: DatasDoCaso[]): boolean {
  if (!conciliadaEm) return false;
  const dia = dataEmCuiaba(conciliadaEm);
  return casos.some(
    (c) => c.criadoEm > conciliadaEm || c.atualizadoEm > conciliadaEm || (c.canceladoEm !== null && c.canceladoEm > conciliadaEm) || c.baixas.some((b) => b >= dia),
  );
}
