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
