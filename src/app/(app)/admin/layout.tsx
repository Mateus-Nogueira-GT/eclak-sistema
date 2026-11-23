import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ErroAcesso, exigirPerfil } from "@/server/auth";

// Defesa em profundidade: o proxy já barra, mas o admin não depende só dele.
export default async function LayoutAdmin({ children }: { children: ReactNode }) {
  try {
    await exigirPerfil("diretor");
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }
  return children;
}
