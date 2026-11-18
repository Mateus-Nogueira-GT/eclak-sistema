import { redirect } from "next/navigation";
import { ROTAS_POR_PERFIL } from "@/domain/perfis";
import { usuarioAtual } from "@/server/auth";

export default async function Inicio() {
  const u = await usuarioAtual();
  if (!u) redirect("/login");
  redirect(ROTAS_POR_PERFIL[u.perfil][0]);
}
