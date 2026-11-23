import { pgEnum } from "drizzle-orm/pg-core";
import { CENTROS, FORMAS_FINANCEIRO_SLUG, LADOS, STATUS_LANCAMENTO } from "@/domain/financeiro";

// Enums do financeiro num módulo sem dependências: `financeiro.ts` e `cartoes.ts` se referenciam (FKs), e os enums
// são usados na avaliação dos dois módulos; aqui eles existem antes de qualquer um. `financeiro.ts` os reexporta.
export const ladoFinanceiroEnum = pgEnum("lado_financeiro", LADOS);
export const centroCustoEnum = pgEnum("centro_custo", CENTROS);
export const formaFinanceiroEnum = pgEnum("forma_financeiro", FORMAS_FINANCEIRO_SLUG);
export const statusLancamentoEnum = pgEnum("status_lancamento", STATUS_LANCAMENTO);
