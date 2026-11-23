import { z } from "zod";
import { FILIAIS } from "./perfis";
import { cpfValido, hojeEmCuiaba, normalizarCpf, normalizarTelefone, telefoneValido, TIPOS_CLIENTE } from "./clientes";

export const MAX_ACOMPANHANTES = 60;

const texto = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "Texto muito longo")
    .optional()
    .transform((v) => (v ? v : null));

/** `AAAA-MM-DD` que existe no calendário. */
export function dataReal(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(a, mes - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === mes - 1 && dt.getUTCDate() === d;
}

const data = (hojeMax?: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      if (!dataReal(v) || (hojeMax !== undefined && v > hojeMax)) {
        ctx.addIssue({ code: "custom", message: "Data inválida" });
        return z.NEVER;
      }
      return v;
    });

const cpf = z
  .string()
  .trim()
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    const d = normalizarCpf(v);
    if (!cpfValido(d)) {
      ctx.addIssue({ code: "custom", message: "CPF inválido" });
      return z.NEVER;
    }
    return d;
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MSG_PESSOA_ALHEIA = "Pessoa não encontrada neste cliente";

const pessoa = (msgNome: string, hoje: string, msgAusente?: string) =>
  z.strictObject(
    {
      /** Id de uma pessoa já gravada deste cliente (edição); sem id, é pessoa nova. */
      id: z.string({ error: MSG_PESSOA_ALHEIA }).regex(UUID, MSG_PESSOA_ALHEIA).optional(),
      nome: z.string({ error: msgNome }).trim().min(1, msgNome).max(200, "Texto muito longo"),
      parentesco: texto(80),
      nascimento: data(hoje),
      cpf,
      passaporte: texto(40),
      validadePassaporte: data(),
    },
    msgAusente ? { error: msgAusente } : undefined,
  );

const telefone = z
  .string({ error: "Informe o telefone" })
  .trim()
  .transform((v, ctx) => {
    if (!v) {
      ctx.addIssue({ code: "custom", message: "Informe o telefone" });
      return z.NEVER;
    }
    const d = normalizarTelefone(v);
    if (!telefoneValido(d)) {
      ctx.addIssue({ code: "custom", message: "Telefone inválido" });
      return z.NEVER;
    }
    return d;
  });

const email = z
  .string()
  .trim()
  .max(254, "Texto muito longo")
  .optional()
  .transform((v, ctx) => {
    if (!v) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
      ctx.addIssue({ code: "custom", message: "E-mail inválido" });
      return z.NEVER;
    }
    return v;
  });

/** Entrada do formulário. Whitelist: id, codigo, clienteDesde, excluidoEm do cliente nunca entram. */
export function clienteSchema(hoje: string = hojeEmCuiaba()) {
  return z.strictObject({
    tipo: z.enum(TIPOS_CLIENTE, { error: "Tipo inválido" }),
    grupo: texto(200),
    filial: z.enum(FILIAIS, { error: "Filial inválida" }),
    telefone,
    email,
    prefQuarto: texto(500),
    prefAlimentacao: texto(500),
    prefAssento: texto(500),
    observacoes: texto(4000),
    titular: pessoa("Informe o nome do titular", hoje, "Informe o nome do titular"),
    acompanhantes: z
      .array(pessoa("Informe o nome do acompanhante", hoje), { error: "Acompanhantes inválidos" })
      .max(MAX_ACOMPANHANTES, "Acompanhantes demais")
      .default([]),
  });
}
