import { notFound } from "next/navigation";
import { exigirPerfil } from "@/server/auth";
import { obterCliente } from "@/server/queries/clientes";
import { FormularioCliente } from "../../formulario";
import { valoresDe } from "../../valores";

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await exigirPerfil();
  const c = await obterCliente(id);
  if (!c || c.excluidoEm) notFound();
  return <FormularioCliente key={c.atualizadoEm} id={id} inicial={valoresDe(c)} atualizadoEm={c.atualizadoEm} />;
}
