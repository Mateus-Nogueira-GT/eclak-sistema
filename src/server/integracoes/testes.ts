import "server-only";
import type { ClasseErro, Integracao } from "@/domain/integracoes";
import { configDrive, configIA, configTrello } from "./config";
import { clienteDrive } from "./drive";
import type { Buscar } from "./http";
import { testarIA } from "./ia";
import { clienteTrello } from "./trello";

// "Testar conexão" de Admin › Integrações: uma chamada de leitura ao serviço, com a configuração lida na hora.
// Só sai daqui `{ ok, classe }` (nem nome de lista ou pasta, nem segredo). Integração sem entrada aqui não tem botão
// de teste (hotelaria, agendador).

export type ResultadoTeste = { ok: true; classe: null } | { ok: false; classe: ClasseErro };

/** null = a configuração sumiu entre a conferência e a chamada (vale como desligada). */
type Testador = (buscar: Buscar) => Promise<ResultadoTeste | null>;

const resumo = (r: { ok: true } | { ok: false; classe: ClasseErro }): ResultadoTeste =>
  r.ok ? { ok: true, classe: null } : { ok: false, classe: r.classe };

export const TESTES_CONEXAO: Partial<Record<Integracao, Testador>> = {
  trello: async (buscar) => {
    const cfg = configTrello();
    return cfg ? resumo(await clienteTrello(cfg, buscar).testar()) : null;
  },
  drive: async (buscar) => {
    const cfg = configDrive();
    return cfg ? resumo(await clienteDrive(cfg, buscar).testar()) : null;
  },
  // Um pedido mínimo ao modelo configurado (esforço baixo, poucos tokens); não grava `ia_usos` (é do Diretor, raro).
  ia: async (buscar) => {
    const cfg = configIA();
    return cfg ? resumo(await testarIA(cfg, buscar)) : null;
  },
};

export function temTesteDeConexao(i: Integracao): boolean {
  return TESTES_CONEXAO[i] !== undefined;
}
