import Link from "next/link";
import { Cake, Plus, ShieldAlert } from "lucide-react";
import { Badge, Card, PageHeader, Td, Th } from "@/components/ui";
import { NOMES_TIPO_CLIENTE, TIPOS_CLIENTE, type TipoCliente } from "@/domain/clientes";
import { listarClientes } from "@/server/queries/clientes";
import { Filtros } from "./filtros";

type Busca = { busca?: string | string[]; tipo?: string | string[]; aviso?: string | string[] };
const um = (v?: string | string[]) => (Array.isArray(v) ? v[0] : v) ?? "";
const DOCUMENTOS = ["sem_passaporte", "passaporte_vencido", "passaporte_volta"];

export default async function Pagina({ searchParams }: { searchParams: Promise<Busca> }) {
  const sp = await searchParams;
  const busca = um(sp.busca);
  const tipo = (TIPOS_CLIENTE as readonly string[]).includes(um(sp.tipo)) ? (um(sp.tipo) as TipoCliente) : undefined;
  const aviso = um(sp.aviso) === "documentos" || um(sp.aviso) === "aniversario" ? (um(sp.aviso) as "documentos" | "aniversario") : undefined;
  const [todos, lista] = await Promise.all([listarClientes(), listarClientes({ busca, tipo, aviso })]);

  const comDocumentos = todos.filter((c) => c.alertas.some((a) => DOCUMENTOS.includes(a.tipo))).length;
  const comAniversario = todos.filter((c) => c.alertas.some((a) => a.tipo === "aniversario")).length;

  const href = (a?: string) => {
    const q = new URLSearchParams();
    if (busca) q.set("busca", busca);
    if (tipo) q.set("tipo", tipo);
    if (a) q.set("aviso", a);
    const s = q.toString();
    return s ? `/clientes?${s}` : "/clientes";
  };
  const chip = (k: "documentos" | "aniversario", rotulo: React.ReactNode, n: number) => (
    <Link
      href={href(aviso === k ? undefined : k)}
      aria-pressed={aviso === k}
      className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition-colors ${
        aviso === k ? "border-verde bg-verde text-white" : "border-linha bg-white text-texto hover:border-verde/40"
      }`}
    >
      {rotulo} <span className="num opacity-70">{n}</span>
    </Link>
  );

  return (
    <div className="mx-auto max-w-[1240px]">
      <PageHeader
        title={`${todos.length} ${todos.length === 1 ? "cliente" : "clientes"}`}
        subtitle="Quem viaja, com quem, o que prefere e o que precisa resolver antes do embarque."
        right={
          <Link href="/clientes/novo" className="inline-flex items-center gap-2 whitespace-nowrap rounded-[5px] bg-verde px-4 py-2.5 text-[14px] font-semibold text-white hover:bg-[#254B5C]">
            <Plus size={16} /> Novo cliente
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Filtros key={`${busca}|${tipo ?? ""}|${aviso ?? ""}`} busca={busca} tipo={tipo ?? ""} aviso={aviso ?? ""} />
        <span className="mx-1 hidden h-6 w-px bg-linha sm:block" />
        {chip("documentos", <><ShieldAlert size={14} /> Documentos pendentes</>, comDocumentos)}
        {chip("aniversario", <><Cake size={14} /> Aniversário em 30 dias</>, comAniversario)}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="border-b border-linha">
              <tr>
                <Th className="pl-6">Cliente</Th>
                <Th>Contato</Th>
                <Th>Atenção</Th>
              </tr>
            </thead>
            <tbody>
              {lista.map((c) => {
                const doc = c.alertas.filter((a) => DOCUMENTOS.includes(a.tipo)).length;
                const aniv = c.alertas.some((a) => a.tipo === "aniversario");
                return (
                  <tr key={c.id} className="border-b border-linha/70 last:border-0 hover:bg-fundo">
                    <Td className="pl-6">
                      <Link href={`/clientes/${c.id}`} className="font-semibold text-texto hover:text-verde">{c.grupo}</Link>
                      <p className="text-[12px] text-cinza">
                        {NOMES_TIPO_CLIENTE[c.tipo]} · {c.tipo === "grupo" ? `Contato: ${c.titular}` : c.titular}
                        {c.acompanhantes > 0 && ` + ${c.acompanhantes}`} · {c.filial === "RS" ? "Filial RS" : c.filial} · {c.codigo}
                      </p>
                    </Td>
                    <Td className="text-[13px]">
                      <p className="num">{c.telefone}</p>
                      <p className="text-cinza">{c.email}</p>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {doc > 0 && <Badge tom="ouro"><ShieldAlert size={12} className="mr-1" /> {doc === 1 ? "Passaporte" : `${doc} passaportes`}</Badge>}
                        {aniv && <Badge tom="ouro"><Cake size={12} className="mr-1" /> Aniversário</Badge>}
                      </div>
                    </Td>
                  </tr>
                );
              })}
              {lista.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-12 text-center text-[14px] text-cinza">
                    Nenhum cliente encontrado.{" "}
                    <Link href="/clientes/novo" className="font-semibold text-verde hover:underline">Cadastrar novo cliente</Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
