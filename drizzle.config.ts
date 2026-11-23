import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

// Migração em produção usa o Session pooler (porta 5432); o pooler de transação não serve para DDL.
const url = process.env.DATABASE_URL_MIGRACAO || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL não definida (nem DATABASE_URL_MIGRACAO)");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
