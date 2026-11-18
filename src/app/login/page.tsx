import { FormularioLogin } from "./formulario";

const ERROS: Record<string, string> = {
  link: "Link inválido ou expirado. Use “Esqueci minha senha” ou peça um novo convite ao Diretor.",
};

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string | string[] }>;
}) {
  const { erro } = await searchParams;
  const aviso = typeof erro === "string" ? (ERROS[erro] ?? null) : null;
  return <FormularioLogin aviso={aviso} />;
}
