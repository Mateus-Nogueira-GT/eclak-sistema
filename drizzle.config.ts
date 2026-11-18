import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  // Migração em produção usa a conexão direta (porta 5432); o pooler de transação não serve para DDL.
  dbCredentials: { url: (process.env.DATABASE_URL_MIGRACAO || process.env.DATABASE_URL)! },
});
