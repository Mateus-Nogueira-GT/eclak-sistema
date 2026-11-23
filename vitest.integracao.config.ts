import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

// Testes de integração: a configuração base mais a trava que impede duas execuções ao mesmo tempo no banco local.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/integracao/**/*.test.ts"],
      globalSetup: ["./tests/integracao/trava-global.ts"],
    },
  }),
);
