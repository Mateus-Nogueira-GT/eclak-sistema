import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalParaDb = globalThis as unknown as { __sql?: ReturnType<typeof postgres> };

function conectar() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL não definida");
  return postgres(url, { prepare: false, max: 5 });
}

const sql = globalParaDb.__sql ?? conectar();

if (process.env.NODE_ENV !== "production") globalParaDb.__sql = sql;

export const db = drizzle(sql, { schema });
export { sql };

/** Tipo do `tx` recebido em `db.transaction(async (tx) => …)`. */
export type Transacao = Parameters<Parameters<typeof db.transaction>[0]>[0];
