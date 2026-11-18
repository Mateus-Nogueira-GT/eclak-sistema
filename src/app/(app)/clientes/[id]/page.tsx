import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Armchair, BedDouble, Cake, Mail, Pencil, Phone, ShieldAlert, StickyNote, UtensilsCrossed } from "lucide-react";
import { Badge, Card, CardHeader, Eyebrow, Td, Th } from "@/components/ui";
import { NOMES_TIPO_CLIENTE, hojeEmCuiaba, idade } from "@/domain/clientes";
import { exigirPerfil } from "@/server/auth";
import { obterCliente } from "@/server/queries/clientes";
import { ExcluirCliente } from "./acoes";

const dataBr = (iso: string) => iso.split("-").reverse().join("/");

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const usuario = await exigirPerfil();
  const c = await obterCliente(id);
  if (!c || c.excluidoEm) notFound();

  const hoje = hojeEmCuiaba();
  const docs = c.alertas.filter((a) => a.tipo !== "aniversario");
  const anivs = c.alertas.filter((a) => a.tipo === "aniversario");
  const titular = c.pessoas.find((p) => p.titular);

  return (
    <div className="mx-auto max-w-[1180px]">
      <Link href="/clientes" className="mb-5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-cinza hover:text-verde">
        <ArrowLeft size={15} /> Todos os clientes
      </Link>

      <div className="mb-6 flex flex-wrap items-end justify-between gap-6">
        <div>
          <Eyebrow>
            {c.codigo} · {NOMES_TIPO_CLIENTE[c.tipo]} · {c.filial === "RS" ? "Filial RS" : c.filial} · cliente desde {c.clienteDesde.slice(0, 4)}
          </Eyebrow>
          <h1 className="titulo mt-1.5 text-[36px] leading-tight text-texto">{c.grupo}</h1>
          {titular && (
            <p className="mt-0.5 text-[15px] text-cinza">
              {c.tipo === "grupo" ? `Contato: ${titular.nome}` : `Titular: ${titular.nome}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/clientes/${c.id}/editar`}
            className="inline-flex items-center gap-2 rounded-[5px] border border-[#C9CDD1] px-3.5 py-2 text-[14px] font-semibold text-texto hover:border-verde hover:text-verde"
          >
            <Pencil size={15} /> Editar
          </Link>
          {usuario.perfil === "diretor" && <ExcluirCliente id={c.id} />}
        </div>
      </div>

      {docs.length > 0 && (
        <div className="mb-5 rounded-[6px] border border-ouro bg-ouro/15 px-5 py-4">
          <p className="flex items-center gap-2 text-[14px] font-semibold text-texto"><ShieldAlert size={17} /> Resolver antes do embarque</p>
          <ul className="mt-1.5 space-y-0.5 pl-6 text-[14px] text-texto">
            {docs.map((a, i) => <li key={i} className="list-disc">{a.texto}</li>)}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.35fr]">
        <div className="space-y-5">
          <Card className="p-6">
            <Eyebrow>Contato</Eyebrow>
            <div className="mt-3 space-y-2.5 text-[14px]">
              <p className="flex items-center gap-2.5"><Phone size={15} className="text-cinza" /> <span className="num">{c.telefone}</span></p>
              <p className="flex items-center gap-2.5"><Mail size={15} className="text-cinza" /> {c.email || <span className="text-cinza">Sem e-mail</span>}</p>
            </div>
            {anivs.length > 0 && (
              <div className="mt-4 space-y-1 rounded-[5px] bg-ouro/15 px-3 py-2.5 text-[13px] text-texto">
                {anivs.map((a, i) => <p key={i} className="flex flex-wrap items-center gap-2"><Cake size={14} /> {a.texto}</p>)}
              </div>
            )}
          </Card>

          <Card className="p-6">
            <Eyebrow>Preferências</Eyebrow>
            <div className="mt-3 space-y-3 text-[14px]">
              {[
                { I: BedDouble, l: "Quarto", v: c.prefQuarto },
                { I: UtensilsCrossed, l: "Alimentação", v: c.prefAlimentacao },
                { I: Armchair, l: "Assento", v: c.prefAssento },
                { I: StickyNote, l: "Observações", v: c.observacoes },
              ].map((x) => (
                <div key={x.l} className="flex gap-3">
                  <x.I size={16} className="mt-0.5 shrink-0 text-cinza" />
                  <div>
                    <p className="text-[12px] font-semibold text-cinza">{x.l}</p>
                    <p className={x.v ? "whitespace-pre-line text-texto" : "text-cinza"}>{x.v || "Não informado"}</p>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader eyebrow={`${c.pessoas.length} ${c.pessoas.length === 1 ? "pessoa" : "pessoas"}`} title="Quem viaja" />
          <div className="overflow-x-auto">
            <table className="mt-3 w-full">
              <thead className="border-b border-linha">
                <tr>
                  <Th className="pl-6">Nome</Th>
                  <Th>Idade</Th>
                  <Th>CPF</Th>
                  <Th>Passaporte</Th>
                  <Th>Validade</Th>
                </tr>
              </thead>
              <tbody>
                {c.pessoas.map((p) => {
                  const aviso = docs.some((a) => a.pessoa === p.nome);
                  return (
                    <tr key={p.id} className={`border-b border-linha/70 last:border-0 ${aviso ? "bg-ouro/15" : ""}`}>
                      <Td className="pl-6">
                        <p className="font-semibold">{p.nome}</p>
                        <p className="text-[12px] text-cinza">{p.titular ? (c.tipo === "grupo" ? "Contato do grupo" : "Titular") : p.parentesco || "Acompanhante"}</p>
                      </Td>
                      <Td className="num text-cinza">{p.nascimento ? `${idade(p.nascimento, hoje)} anos` : "-"}</Td>
                      <Td className="num text-[13px]">{p.cpf ?? <span className="text-cinza">-</span>}</Td>
                      <Td className="num text-[13px]">{p.passaporte ?? <span className="text-cinza">Sem passaporte</span>}</Td>
                      <Td>
                        {p.validadePassaporte ? (
                          aviso ? <Badge tom="ouro">{dataBr(p.validadePassaporte)}</Badge> : <span className="num text-[13px] text-cinza">{dataBr(p.validadePassaporte)}</span>
                        ) : aviso ? (
                          <Badge tom="ouro">Cadastrar</Badge>
                        ) : (
                          <span className="text-[13px] text-cinza">-</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
