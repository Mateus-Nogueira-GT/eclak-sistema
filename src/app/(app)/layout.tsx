import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Shell } from "@/components/shell";
import { PERFIS } from "@/domain/perfis";
import { usuarioAtual } from "@/server/auth";

export default async function LayoutApp({ children }: { children: ReactNode }) {
  const u = await usuarioAtual();
  if (!u) redirect("/login");
  return (
    <Shell perfil={u.perfil} nome={u.nome} perfilNome={PERFIS[u.perfil].nome}>
      {children}
    </Shell>
  );
}
