import { config } from "dotenv";

// Carrega as variáveis do banco local para os testes (não sobrescreve as já definidas).
config({ path: ".env.local" });
