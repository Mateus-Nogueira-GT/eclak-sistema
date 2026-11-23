import { PageHeader } from "@/components/ui";
import { hojeEmCuiaba } from "@/domain/clientes";
import { ehUuid } from "@/server/acesso";
import { listarCartoes } from "@/server/queries/cartoes";
import { listarContasBancarias } from "@/server/queries/financeiro";
import { Cartoes } from "./cartoes";

type Params = Record<string, string | string[] | undefined>;

/** `?fatura=<id>` abre o detalhe da fatura (compras, "Dar baixa", "Desfazer baixa"); a linha da lista aponta para cá. */
export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const bruto = Array.isArray(sp.fatura) ? sp.fatura[0] : sp.fatura;
  const fatura = bruto && ehUuid(bruto) ? bruto : null;
  const [cartoes, contas] = await Promise.all([listarCartoes(), listarContasBancarias({ ativas: true })]);
  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title="Cartões corporativos"
        subtitle="Compras no cartão entram na fatura do mês pela data da compra: até o dia de fechamento, na fatura do mês; depois dele, na do mês seguinte. A fatura é paga de uma vez, pela conta de débito."
      />
      <Cartoes
        hoje={hojeEmCuiaba()}
        faturaAberta={fatura}
        contas={contas.map((c) => ({ id: c.id, nome: c.nome }))}
        cartoes={cartoes.map((k) => ({
          ...k,
          faturas: k.faturas.map((f) => ({
            ...f,
            total: f.total.toString(),
            valorPago: f.valorPago === null ? null : f.valorPago.toString(),
            compras: f.compras.map((c) => ({
              ...c,
              valor: c.valor.toString(),
              valorOriginal: c.valorOriginal.toString(),
              valorPago: c.valorPago === null ? null : c.valorPago.toString(),
            })),
          })),
        }))}
      />
    </div>
  );
}
