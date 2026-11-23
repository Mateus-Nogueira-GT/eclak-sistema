import Link from "next/link";
import { PageHeader } from "@/components/ui";

export default function SemAcesso() {
  return (
    <main className="mx-auto max-w-[720px] px-4 py-16 md:px-8">
      <PageHeader title="Sem acesso" subtitle="O seu perfil não tem permissão para abrir esta página." />
      <Link href="/" className="mt-6 inline-block text-[14px] font-semibold text-verde underline decoration-verde/30 underline-offset-[3px] hover:decoration-verde">
        Voltar ao início
      </Link>
    </main>
  );
}
