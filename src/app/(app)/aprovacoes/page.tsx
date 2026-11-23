import Link from "next/link";
import { redirect } from "next/navigation";
import { Badge, PageHeader } from "@/components/ui";
import { SoGestao } from "@/components/kit";
import { formatarReais } from "@/domain/dinheiro";
import { ErroAcesso, exigirPerfil } from "@/server/auth";
import { listarPedidosAprovacao, obterPedido, type PedidoLista } from "@/server/queries/viagens";
import { dataHora, pct1 } from "../viagens/formatos";
import { rotuloSituacao, tomSituacao } from "./situacao";
import { Painel } from "./painel";

type Busca = { v?: string | string[] };

// Defesa em profundidade: o proxy já barra, mas a tela não depende só dele.
export default async function Pagina({ searchParams }: { searchParams: Promise<Busca> }) {
  try {
    await exigirPerfil("diretor");
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }
  const sp = await searchParams;
  const { aguardando, decididos } = await listarPedidosAprovacao();
  const todos = [...aguardando, ...decididos];
  const pedidoV = Array.isArray(sp.v) ? sp.v[0] : sp.v;
  const escolhido = todos.find((p) => p.versaoId === pedidoV) ?? todos[0];
  const pedido = escolhido ? await obterPedido(escolhido.versaoId) : null;

  return (
    <div>
      <PageHeader
        title="Aprovações"
        subtitle="Abra a viagem, veja a margem já com o custo fixo, simule valores, comissões e forma de pagamento e decida. A proposta só vai ao cliente depois da aprovação."
        right={<SoGestao>Somente o Diretor aprova</SoGestao>}
      />
      {todos.length === 0 ? (
        <p className="border-y border-linha py-8 text-[14.5px] text-cinza">Nenhum pedido de aprovação por enquanto.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[320px_1fr]">
          <div className="self-start">
            <p className="mb-2 text-[13px] text-cinza">
              {aguardando.length === 0 ? "Nenhum pedido aguardando" : aguardando.length === 1 ? "1 pedido aguardando" : `${aguardando.length} pedidos aguardando`}
            </p>
            <ul className="divide-y divide-linha border-y border-linha">
              {aguardando.map((p) => <Item key={p.versaoId} p={p} ativo={p.versaoId === escolhido?.versaoId} />)}
            </ul>
            {decididos.length > 0 && (
              <>
                <p className="mb-2 mt-6 text-[13px] text-cinza">Decididos nos últimos 30 dias</p>
                <ul className="divide-y divide-linha border-y border-linha">
                  {decididos.map((p) => <Item key={p.versaoId} p={p} ativo={p.versaoId === escolhido?.versaoId} />)}
                </ul>
              </>
            )}
          </div>
          {pedido ? <Painel key={pedido.versaoId} pedido={pedido} /> : <p className="text-[14px] text-cinza">Pedido não encontrado.</p>}
        </div>
      )}
    </div>
  );
}

function Item({ p, ativo }: { p: PedidoLista; ativo: boolean }) {
  return (
    <li>
      <Link
        href={`/aprovacoes?v=${p.versaoId}`}
        aria-current={ativo ? "true" : undefined}
        className={`block w-full px-3 py-3.5 text-left transition-colors ${ativo ? "bg-verde/[0.07]" : "hover:bg-fundo"}`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="num text-[12.5px] font-bold text-verde">{p.codigo} · versão {p.numero}</span>
          <Badge tom={tomSituacao(p)}>{rotuloSituacao(p)}</Badge>
        </span>
        <span className="mt-1 block text-[15px] font-bold text-texto">{p.cliente}</span>
        <span className="block text-[13px] text-cinza">{p.destino} · {p.enviadoPor} · {dataHora(p.enviadoEm)}</span>
        <span className="num mt-0.5 block text-[12.5px] text-cinza">{formatarReais(p.preco)} · {p.forma} · margem {pct1(p.margemFinalPct)}</span>
      </Link>
    </li>
  );
}
