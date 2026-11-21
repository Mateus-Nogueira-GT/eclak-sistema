import { notFound } from "next/navigation";
import { margemDaAprovacao, FORMA_REFERENCIA, FORMAS_SIMULADOR, resultadoDoPreco } from "@/domain/precificacao";
import { exigirPerfil } from "@/server/auth";
import { obterCliente } from "@/server/queries/clientes";
import { listarFornecedores } from "@/server/queries/fornecedores";
import { regrasVigentes } from "@/server/queries/regras";
import { obterPrecificacao } from "@/server/queries/viagens";
import { Painel, type Extras } from "./painel";

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await exigirPerfil();
  const ficha = await obterPrecificacao(id);
  if (!ficha) notFound();

  const [cliente, fornecedores] = await Promise.all([obterCliente(ficha.clienteId), listarFornecedores()]);
  const ativas = cliente?.pessoas ?? [];
  const idsAtivos = new Set(ativas.map((p) => p.id));
  const pessoas = ativas.map((p) => ({
    id: p.id,
    nome: p.nome,
    detalhe: p.titular ? (cliente?.tipo === "grupo" ? "Contato do grupo" : "Titular") : p.parentesco || "Acompanhante",
  }));
  const removidos = ficha.passageiros.filter((p) => !idsAtivos.has(p.id));

  // Só com a camada estratégica devolvida pelo servidor: conta auxiliar dos cartões e limite de diária.
  let extras: Extras | null = null;
  const est = ficha.estrategico && !("erro" in ficha.estrategico) ? ficha.estrategico : null;
  if (est) {
    const regras = (await regrasVigentes()).valores;
    const forma = FORMAS_SIMULADOR[FORMA_REFERENCIA].forma;
    const p = est.precificacao;
    const e: Extras = { semCompensacaoPct: null, diasCobertos: null, limiteDiaria: BigInt(regras.limiteDiariaSemReajuste) };
    try {
      e.semCompensacaoPct = resultadoDoPreco(p.somaVendas, p.custo, forma, regras).margemLiquidaPct;
      e.diasCobertos = margemDaAprovacao(p.porForma[FORMA_REFERENCIA].preco, p.custo, forma, ficha.dias, regras.rateio.metodo, regras).diasCobertos;
    } catch {
      // Parâmetros que não permitem a conta: os cartões mostram só o que já veio calculado.
    }
    extras = e;
  }

  return (
    <div className="mx-auto max-w-[1240px]">
      <Painel
        ficha={ficha}
        pessoas={pessoas}
        removidos={removidos}
        fornecedores={fornecedores.map((f) => ({ id: f.id, nome: f.nome, comissaoPct: f.comissaoPct, tarifaFixa: f.tarifaFixa }))}
        extras={extras}
      />
    </div>
  );
}
