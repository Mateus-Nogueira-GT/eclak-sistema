import { PageHeader } from "@/components/ui";
import { FormularioSenha } from "./formulario";

export default function Pagina() {
  return (
    <div className="mx-auto max-w-[520px]">
      <PageHeader
        title="Definir senha"
        subtitle="Crie a senha que você vai usar para entrar no sistema."
      />
      <FormularioSenha />
    </div>
  );
}
