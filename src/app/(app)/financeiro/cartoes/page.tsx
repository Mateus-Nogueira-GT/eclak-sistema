import { PageHeader } from "@/components/ui";
import { listarCartoes } from "@/server/queries/cartoes";
import { listarContasBancarias } from "@/server/queries/financeiro";
import { Cartoes } from "./cartoes";

export default async function Pagina() {
  const [cartoes, contas] = await Promise.all([listarCartoes(), listarContasBancarias({ ativas: true })]);
  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title="Cartões corporativos"
        subtitle="Compras no cartão entram na fatura do mês pela data da compra: até o dia de fechamento, na fatura do mês; depois dele, na do mês seguinte. A fatura é paga de uma vez, pela conta de débito."
      />
      <Cartoes
        contas={contas.map((c) => ({ id: c.id, nome: c.nome }))}
        cartoes={cartoes.map((k) => ({
          ...k,
          faturas: k.faturas.map((f) => ({
            ...f,
            total: f.total.toString(),
            valorPago: f.valorPago === null ? null : f.valorPago.toString(),
            compras: f.compras.map((c) => ({ ...c, valor: c.valor.toString() })),
          })),
        }))}
      />
    </div>
  );
}
