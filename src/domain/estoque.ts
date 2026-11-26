// Domínio do estoque e da caixa de experiência (fatia 5b): listas e custo médio. Dinheiro em centavos (bigint).

export const USOS_ESTOQUE = ["caixa_experiencia", "papelaria"] as const;
export type UsoEstoque = (typeof USOS_ESTOQUE)[number];

export const TIPOS_MOVIMENTO = ["entrada", "saida", "ajuste", "caixa", "devolucao_caixa"] as const;
export type TipoMovimento = (typeof TIPOS_MOVIMENTO)[number];

export const SITUACOES_CAIXA = ["rascunho", "confirmada", "cancelada"] as const;
export type SituacaoCaixa = (typeof SITUACOES_CAIXA)[number];

export const ROTULO_USO: Record<UsoEstoque, string> = {
  caixa_experiencia: "Caixa de experiência",
  papelaria: "Papelaria",
};

/** Slug da categoria de sistema do financeiro em que a compra do uso é lançada. */
export const CATEGORIA_DO_USO: Record<UsoEstoque, "caixa_experiencia" | "papelaria"> = {
  caixa_experiencia: "caixa_experiencia",
  papelaria: "papelaria",
};

export type Saldo = { quantidade: number; custoMedio: bigint };

/** Média ponderada pelo custo médio, arredondada ao centavo (meio para cima). */
export function aposEntrada(s: Saldo, quantidade: number, unitario: bigint): Saldo {
  const nova = s.quantidade + quantidade;
  const total = BigInt(s.quantidade) * s.custoMedio + BigInt(quantidade) * unitario;
  const divisor = BigInt(nova);
  return { quantidade: nova, custoMedio: (2n * total + divisor) / (2n * divisor) };
}

/** Saída ao custo médio: ele não muda; `null` se passa do saldo; saldo zerado leva o custo a 0. */
export function aposSaida(s: Saldo, quantidade: number): Saldo | null {
  if (quantidade > s.quantidade) return null;
  const resto = s.quantidade - quantidade;
  return { quantidade: resto, custoMedio: resto === 0 ? 0n : s.custoMedio };
}

/** Desfaz uma entrada: volta ao custo médio gravado antes dela; `null` se passa do saldo; saldo zerado leva o custo a 0. */
export function desfazerEntrada(s: Saldo, quantidade: number, custoMedioAntes: bigint): Saldo | null {
  if (quantidade > s.quantidade) return null;
  const resto = s.quantidade - quantidade;
  return { quantidade: resto, custoMedio: resto === 0 ? 0n : custoMedioAntes };
}

/** Mínimo 0 = sem aviso. */
export function abaixoDoMinimo(quantidade: number, minimo: number): boolean {
  return minimo > 0 && quantidade < minimo;
}

export function valorEmEstoque(saldos: Saldo[]): bigint {
  return saldos.reduce((soma, s) => soma + BigInt(s.quantidade) * s.custoMedio, 0n);
}
