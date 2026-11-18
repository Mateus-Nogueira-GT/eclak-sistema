import { exigirPerfil } from "@/server/auth";
import { FormularioFornecedor } from "../formulario";
import { VALORES_VAZIOS } from "../valores";

export default async function Pagina() {
  await exigirPerfil();
  return <FormularioFornecedor inicial={VALORES_VAZIOS} />;
}
