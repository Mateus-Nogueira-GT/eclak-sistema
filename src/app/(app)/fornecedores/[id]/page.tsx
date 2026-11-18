import { notFound } from "next/navigation";
import { exigirPerfil } from "@/server/auth";
import { obterFornecedor } from "@/server/queries/fornecedores";
import { FormularioFornecedor } from "../formulario";
import { valoresDe } from "../valores";

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const usuario = await exigirPerfil();
  const f = await obterFornecedor(id);
  if (!f || f.excluidoEm) notFound();
  return <FormularioFornecedor key={id} id={id} inicial={valoresDe(f)} podeExcluir={usuario.perfil === "diretor"} />;
}
