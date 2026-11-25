import { notFound } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { alertasDoCliente, hojeEmCuiaba } from "@/domain/clientes";
import { margemDaAprovacao, FORMA_REFERENCIA, FORMAS_SIMULADOR, resultadoDoPreco } from "@/domain/precificacao";
import { podeAcessar, veCamadaEstrategica } from "@/domain/perfis";
import { exigirPerfil } from "@/server/auth";
import { obterCliente } from "@/server/queries/clientes";
import { listarCartoesAtivos } from "@/server/queries/cartoes";
import { listarContasBancarias } from "@/server/queries/financeiro";
import { listarFornecedores } from "@/server/queries/fornecedores";
import { regrasVigentes } from "@/server/queries/regras";
import { cabecalhoDaViagem } from "@/server/queries/operacao";
import { obterViagemVendida } from "@/server/queries/vendas";
import { obterPrecificacao } from "@/server/queries/viagens";
import { Painel, type Extras } from "./painel";
import { Trilha } from "./trilha";
import { ViagemVendidaView } from "./viagem-vendida";

/** Passaporte dos passageiros × volta (só orçamento aprovado ou viagem vendida, internacional). */
async function avisosDeEmbarque(ficha: NonNullable<Awaited<ReturnType<typeof obterPrecificacao>>>) {
  if (!ficha.internacional || (ficha.status !== "aprovado" && ficha.status !== "vendida")) return [];
  const cliente = await obterCliente(ficha.clienteId);
  if (!cliente) return [];
  const ids = ficha.passageiros.map((p) => p.id);
  const pessoas = cliente.pessoas.filter((p) => ids.includes(p.id)).map((p) => ({ ...p, validadePassaporte: p.validadePassaporte }));
  return alertasDoCliente(
    { tipo: cliente.tipo, pessoas },
    hojeEmCuiaba(),
    [{ destino: ficha.destino, fim: ficha.fim, internacional: true, passageiros: ids }],
  ).filter((a) => a.tipo !== "aniversario");
}

function BlocoEmbarque({ avisos }: { avisos: { texto: string }[] }) {
  if (avisos.length === 0) return null;
  return (
    <div className="mb-5 rounded-[6px] border border-ouro bg-ouro/15 px-5 py-4">
      <p className="flex items-center gap-2 text-[14px] font-semibold text-texto"><ShieldAlert size={17} /> Resolver antes do embarque</p>
      <ul className="mt-1.5 space-y-0.5 pl-6 text-[14px] text-texto">
        {avisos.map((a, i) => <li key={i} className="list-disc">{a.texto}</li>)}
      </ul>
    </div>
  );
}

export default async function Pagina({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const usuario = await exigirPerfil();
  const ficha = await obterPrecificacao(id);
  if (!ficha) notFound();
  const avisos = await avisosDeEmbarque(ficha);

  if (ficha.status === "vendida") {
    const vendida = await obterViagemVendida(id);
    const cabecalho = vendida ? await cabecalhoDaViagem(id) : null;
    if (vendida) {
      const estrategico = veCamadaEstrategica(usuario.perfil);
      const regras = estrategico ? (await regrasVigentes()).valores : null;
      // Só quem age (Diretor e financeiros) recebe as contas bancárias das baixas.
      const contas = estrategico ? (await listarContasBancarias({ ativas: true })).map((c) => ({ id: c.id, nome: c.nome })) : [];
      const cartoes = estrategico ? await listarCartoesAtivos() : [];
      return (
        <div className="mx-auto max-w-[1240px]">
          <BlocoEmbarque avisos={avisos} />
          {cabecalho && <Trilha viagem={cabecalho} ativa="viagem" />}
          <ViagemVendidaView
            v={vendida}
            ficha={ficha}
            podeAgir={estrategico}
            ehDiretor={usuario.perfil === "diretor"}
            margem={regras ? { alvoPct: regras.margemAlvoPct, referenciaPct: regras.margemReferenciaPct } : null}
            hoje={hojeEmCuiaba()}
            contasBancarias={contas}
            cartoes={cartoes}
          />
        </div>
      );
    }
  }

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
    const e: Extras = {
      semCompensacaoPct: null,
      diasCobertos: null,
      limiteDiaria: BigInt(regras.limiteDiariaSemReajuste),
      margemAlvoPct: regras.margemAlvoPct,
      margemReferenciaPct: regras.margemReferenciaPct,
    };
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
      <BlocoEmbarque avisos={avisos} />
      <Painel
        ficha={ficha}
        pessoas={pessoas}
        removidos={removidos}
        fornecedores={fornecedores.map((f) => ({ id: f.id, nome: f.nome, comissaoPct: f.comissaoPct, tarifaFixa: f.tarifaFixa }))}
        extras={extras}
        podeFecharVenda={podeAcessar(usuario.perfil, "/vendas")}
      />
    </div>
  );
}
