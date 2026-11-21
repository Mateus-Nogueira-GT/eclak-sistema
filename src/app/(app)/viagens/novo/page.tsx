import Link from "next/link";
import { Search } from "lucide-react";
import { Card, PageHeader, inputCls } from "@/components/ui";
import { exigirPerfil } from "@/server/auth";
import { listarClientes, obterCliente } from "@/server/queries/clientes";
import { FormularioOrcamento } from "../formulario";

type Busca = { cliente?: string | string[]; busca?: string | string[] };
const um = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) ?? "";

export default async function Pagina({ searchParams }: { searchParams: Promise<Busca> }) {
  const sp = await searchParams;
  await exigirPerfil();
  const clienteId = um(sp.cliente);

  if (clienteId) {
    const c = await obterCliente(clienteId);
    if (c && !c.excluidoEm) {
      const pessoas = c.pessoas.map((p) => ({
        id: p.id,
        nome: p.nome,
        detalhe: p.titular ? (c.tipo === "grupo" ? "Contato do grupo" : "Titular") : p.parentesco || "Acompanhante",
      }));
      return (
        <div className="mx-auto max-w-[1180px]">
          <PageHeader title="Novo orçamento" subtitle={`Cliente: ${c.grupo} (${c.codigo}). O código da viagem é gerado ao salvar.`} />
          <FormularioOrcamento
            clienteId={c.id}
            pessoas={pessoas}
            inicial={{ destino: "", inicio: "", fim: "", observacoes: "", passageiros: c.pessoas.map((p) => p.id) }}
          />
        </div>
      );
    }
  }

  const busca = um(sp.busca);
  const clientes = await listarClientes({ busca });
  return (
    <div className="mx-auto max-w-[900px]">
      <PageHeader
        title="Novo orçamento"
        subtitle={clienteId ? "Cliente não encontrado. Escolha outro." : "Escolha o cliente que vai viajar."}
      />
      <form method="get" className="mb-4 flex items-center gap-3">
        <label className="flex flex-1 items-center gap-2 rounded-[5px] border border-[#C9CDD1] bg-white px-3 py-2 focus-within:border-verde">
          <Search size={16} className="text-cinza" />
          <input name="busca" aria-label="Buscar cliente" defaultValue={busca} placeholder="Nome, CPF, telefone ou código" className={`${inputCls} !border-0 !p-0`} />
        </label>
        <button type="submit" className="cursor-pointer rounded-[5px] border border-[#C9CDD1] px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde">Buscar</button>
      </form>
      <Card>
        <ul>
          {clientes.slice(0, 50).map((c) => (
            <li key={c.id} className="border-b border-linha/70 last:border-0">
              <Link href={`/viagens/novo?cliente=${c.id}`} className="block px-6 py-3 hover:bg-fundo">
                <span className="font-semibold text-texto">{c.grupo}</span>
                <span className="block text-[12px] text-cinza">{c.titular} · {c.codigo}</span>
              </Link>
            </li>
          ))}
          {clientes.length === 0 && <li className="py-10 text-center text-[14px] text-cinza">Nenhum cliente encontrado.</li>}
        </ul>
      </Card>
    </div>
  );
}
