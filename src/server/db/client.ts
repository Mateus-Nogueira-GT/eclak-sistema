import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalParaDb = globalThis as unknown as { __sql?: ReturnType<typeof postgres> };

const sql =
  globalParaDb.__sql ??
  postgres(process.env.DATABASE_URL!, { prepare: false, max: 5 });

if (process.env.NODE_ENV !== "production") globalParaDb.__sql = sql;

export const db = drizzle(sql, { schema });
export { sql };

/** Tipo do `tx` recebido em `db.transaction(async (tx) => …)`. */
export type Transacao = Parameters<Parameters<typeof db.transaction>[0]>[0];
