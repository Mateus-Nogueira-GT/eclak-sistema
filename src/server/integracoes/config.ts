import "server-only";
import type { Integracao } from "@/domain/integracoes";

// Configuração das integrações. O ambiente é lido na chamada (nunca no import) e só os NOMES das variáveis que
// faltam saem daqui para a tela; valores ficam em process.env.

type Ambiente = Record<string, string | undefined>;

export const VARIAVEIS: Record<Integracao, readonly string[]> = {
  trello: ["TRELLO_API_KEY", "TRELLO_TOKEN", "TRELLO_LISTA_ID"],
  drive: ["GOOGLE_SA_EMAIL", "GOOGLE_SA_CHAVE", "GOOGLE_DRIVE_PASTA_RAIZ_ID"],
  ia: ["ANTHROPIC_API_KEY"],
  // Sem contrato nem documentação: nenhuma variável e sempre desligada.
  hotelaria: [],
  agendador: ["CRON_SECRET"],
};

export const IA_MODELO_PADRAO = "claude-opus-5-5";

function ler(env: Ambiente, nome: string): string | null {
  const v = env[nome]?.trim();
  return v ? v : null;
}

export function estadoIntegracao(
  i: Integracao,
  env: Ambiente = process.env,
): { configurada: boolean; faltam: string[] } {
  const nomes = VARIAVEIS[i];
  const faltam = nomes.filter((n) => ler(env, n) === null);
  return { configurada: nomes.length > 0 && faltam.length === 0, faltam };
}

export type ConfigTrello = { apiKey: string; token: string; listaId: string };
export type ConfigDrive = { email: string; chave: string; pastaRaizId: string };
export type ConfigIA = { apiKey: string; modelo: string };

export function configTrello(env: Ambiente = process.env): ConfigTrello | null {
  const apiKey = ler(env, "TRELLO_API_KEY");
  const token = ler(env, "TRELLO_TOKEN");
  const listaId = ler(env, "TRELLO_LISTA_ID");
  return apiKey && token && listaId ? { apiKey, token, listaId } : null;
}

export function configDrive(env: Ambiente = process.env): ConfigDrive | null {
  const email = ler(env, "GOOGLE_SA_EMAIL");
  const chave = ler(env, "GOOGLE_SA_CHAVE");
  const pastaRaizId = ler(env, "GOOGLE_DRIVE_PASTA_RAIZ_ID");
  // A chave PEM costuma vir numa linha só, com "\n" literais.
  return email && chave && pastaRaizId ? { email, chave: chave.replace(/\\n/g, "\n"), pastaRaizId } : null;
}

export function configIA(env: Ambiente = process.env): ConfigIA | null {
  const apiKey = ler(env, "ANTHROPIC_API_KEY");
  return apiKey ? { apiKey, modelo: ler(env, "IA_MODELO") ?? IA_MODELO_PADRAO } : null;
}
