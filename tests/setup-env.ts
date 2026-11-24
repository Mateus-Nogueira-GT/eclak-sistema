import { config } from "dotenv";

// Carrega as variáveis do banco local para os testes (não sobrescreve as já definidas).
config({ path: ".env.local" });

/**
 * Integrações começam DESLIGADAS em todo arquivo de teste: a shell (ou o .env.local) pode ter chaves de verdade, e
 * nenhum teste chama serviço real. Roda antes de cada arquivo; quem precisa de uma integração ligada usa
 * `vi.stubEnv` no próprio arquivo (e `vi.unstubAllEnvs` volta para o vazio daqui). `tests/domain/integracoes.test.ts`
 * confere que a lista cobre todas as variáveis de `VARIAVEIS` (config.ts).
 */
export const VARIAVEIS_DE_INTEGRACAO = [
  "CRON_SECRET",
  "TRELLO_API_KEY",
  "TRELLO_TOKEN",
  "TRELLO_LISTA_ID",
  "GOOGLE_SA_EMAIL",
  "GOOGLE_SA_CHAVE",
  "GOOGLE_DRIVE_PASTA_RAIZ_ID",
  "ANTHROPIC_API_KEY",
  "IA_MODELO",
  // O SDK usa `baseURL || https://api.anthropic.com`: vazio é o endereço padrão (e os testes usam `fetch` falso).
  "ANTHROPIC_BASE_URL",
] as const;

for (const nome of VARIAVEIS_DE_INTEGRACAO) process.env[nome] = "";
