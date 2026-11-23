import { config } from "dotenv";
import postgres from "postgres";

/**
 * Global setup dos testes de integração: todos os arquivos truncam o mesmo banco local, então duas execuções ao mesmo
 * tempo (dois terminais, dois agentes) se atrapalham e falham ao acaso. A execução pega um advisory lock de sessão
 * numa conexão própria, aberta até o fim; se outra execução já o tem, falha logo com uma mensagem clara.
 */
const CHAVE_DA_TRAVA = 5_202_611; // número fixo, só desta trava

export default async function travarExecucao(): Promise<() => Promise<void>> {
  config({ path: ".env.local" });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definida (crie o .env.local, ver README)");
  const conexao = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const [{ ok }] = await conexao<{ ok: boolean }[]>`select pg_try_advisory_lock(${CHAVE_DA_TRAVA}) as ok`;
  if (!ok) {
    await conexao.end();
    throw new Error(
      "Outra execução dos testes de integração está usando o banco local agora. Espere ela terminar e rode de novo " +
        "(os testes truncam as tabelas; duas execuções juntas falham ao acaso).",
    );
  }
  return async () => {
    await conexao`select pg_advisory_unlock(${CHAVE_DA_TRAVA})`;
    await conexao.end();
  };
}
