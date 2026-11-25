export const FORMAS_DEVOLUCAO = ["pix", "transferencia", "abatimento", "credito"] as const;
export type FormaDevolucao = (typeof FORMAS_DEVOLUCAO)[number];
