import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    passWithNoTests: true,
    // Testes de integração compartilham um único banco: sem paralelismo entre arquivos.
    fileParallelism: false,
    setupFiles: ["./tests/setup-env.ts"],
  },
});
