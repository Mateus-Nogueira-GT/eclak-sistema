import { exigirPerfil } from "@/server/auth";
import { FormularioCliente } from "../formulario";
import { VALORES_VAZIOS } from "../valores";

export default async function Pagina() {
  await exigirPerfil();
  return <FormularioCliente inicial={VALORES_VAZIOS} />;
}
