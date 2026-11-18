// Next com output "standalone" não copia public/ nem .next/static: copia para .next/standalone.
import { cpSync, existsSync } from "node:fs";

if (existsSync("public")) cpSync("public", ".next/standalone/public", { recursive: true });
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
