import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, PageHeader } from "@/components/ui";
import { formatarReais } from "@/domain/dinheiro";
import { ErroAcesso, exigirPerfil } from "@/server/auth";
import { listarPropostas, type PropostaLista } from "@/server/queries/vendas";
import { dataBr } from "../viagens/formatos";
import { Painel } from "./painel";
import { ROTULO_ESTADO, TOM_ESTADO } from "./estado";

type Busca = { viagem?: string | string[]; aviso?: string | string[] };

const AVISOS: Record<string, string> = {
  "nova-forma": "Nova forma enviada ao Diretor. A venda segue depois da aprovação.",
};

// Defesa em profundidade: o proxy já barra, mas a tela não depende só dele.
export default async function Pagina({ searchParams }: { searchParams: Promise<Busca> }) {
  try {
    await exigirPerfil("consultor", "operacional", "diretor");
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }
  const sp = await searchParams;
  const propostas = await listarPropostas();
  const id = Array.isArray(sp.viagem) ? sp.viagem[0] : sp.viagem;
  const aviso = AVISOS[(Array.isArray(sp.aviso) ? sp.aviso[0] : sp.aviso) ?? ""];
  const escolhida = propostas.find((p) => p.id === id) ?? propostas[0];

  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader
        title="Fechamento da venda"
        subtitle="Quando o cliente aceita a proposta, o consultor registra aqui. A venda segue com o preço e a forma de pagamento aprovados pela gestão: o sistema marca a viagem como vendida e lança as parcelas a receber e as contas a pagar. O financeiro acompanha em Viagens."
      />
      {aviso && (
        <p role="status" className="mb-5 rounded-[5px] border border-linha bg-fundo px-4 py-3 text-[14px] text-texto">
          {aviso}
        </p>
      )}
      {propostas.length === 0 ? (
        <p className="border-y border-linha py-8 text-[14.5px] text-cinza">
          Nenhuma proposta aprovada aguardando a resposta do cliente.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
          <nav aria-label="Propostas" className="self-start rounded-[6px] border border-linha bg-white p-2">
            <p className="px-4 pb-1 pt-3 text-[13px] text-cinza">Propostas enviadas ao cliente</p>
            {propostas.map((p) => (
              <Item key={p.id} p={p} ativo={p.id === escolhida?.id} />
            ))}
          </nav>
          {escolhida && <Painel key={escolhida.id} p={escolhida} />}
        </div>
      )}
    </div>
  );
}

function Item({ p, ativo }: { p: PropostaLista; ativo: boolean }) {
  return (
    <Link
      href={`/vendas?viagem=${p.id}`}
      aria-current={ativo ? "true" : undefined}
      className={`block w-full rounded-[5px] px-4 py-3.5 text-left ${ativo ? "bg-verde/[0.08]" : "hover:bg-fundo"}`}
    >
      <span className="block text-[12.5px] text-cinza">
        {p.codigo} · versão {p.numeroVersao}
        {p.aprovadoEm ? ` · aprovada em ${dataBr(p.aprovadoEm.toISOString().slice(0, 10))}` : ""}
      </span>
      <span className="mt-0.5 block text-[15px] font-semibold text-texto">{p.cliente}</span>
      <span className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <Badge tom={TOM_ESTADO[p.estado]}>{ROTULO_ESTADO[p.estado]}</Badge>
        <b className="num text-[13.5px] text-verde">{formatarReais(BigInt(p.precoCliente))}</b>
      </span>
    </Link>
  );
}
