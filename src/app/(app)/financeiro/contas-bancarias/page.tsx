import { PageHeader } from "@/components/ui";
import { listarContasBancarias } from "@/server/queries/financeiro";
import { ContasBancarias } from "./contas";

export default async function Pagina() {
  const contas = await listarContasBancarias();
  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title="Contas bancárias" subtitle="Onde o dinheiro entra e sai: toda baixa pede a conta. O saldo inicial vale a partir da data informada; o saldo atual soma o que foi baixado na conta desde então." />
      <ContasBancarias
        contas={contas.map((c) => ({ id: c.id, nome: c.nome, banco: c.banco ?? "", saldoInicial: c.saldoInicial.toString(), saldoInicialEm: c.saldoInicialEm, saldoAtual: c.saldoAtual.toString(), ativa: c.ativa }))}
      />
    </div>
  );
}
