import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` lança fora do bundler do Next; nos testes vira no-op.
      "server-only": fileURLToPath(new URL("./tests/helpers/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    passWithNoTests: true,
    // Testes de integração compartilham um único banco: sem paralelismo entre arquivos.
    fileParallelism: false,
    setupFiles: ["./tests/setup-env.ts"],
  },
});
