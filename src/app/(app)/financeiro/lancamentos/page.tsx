import { PageHeader } from "@/components/ui";
import { hojeEmCuiaba } from "@/domain/clientes";
import { filtroDaUrl } from "@/domain/financeiro-entrada";
import { ORIGENS, type Origem } from "@/domain/financeiro";
import { ehUuid } from "@/server/acesso";
import { listarAnexos } from "@/server/queries/anexos";
import { listarCartoesAtivos } from "@/server/queries/cartoes";
import { listarClientes } from "@/server/queries/clientes";
import { listarCategorias, listarContasBancarias, listarLancamentos, obterLancamento } from "@/server/queries/financeiro";
import { listarFornecedores } from "@/server/queries/fornecedores";
import { ListaLancamentos } from "./lista";
import type { LancamentoForm } from "./formulario";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** `?anexos=origem:id` abre os anexos de uma linha da lista. */
function linhaDosAnexos(v: string | undefined): { origem: Origem; id: string } | null {
  const [origem, id] = (v ?? "").split(":");
  return (ORIGENS as readonly string[]).includes(origem) && id && ehUuid(id) ? { origem: origem as Origem, id } : null;
}

export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const hoje = hojeEmCuiaba();
  const filtro = filtroDaUrl(sp, hoje);
  const editar = primeiro(sp.editar);
  const novo = primeiro(sp.novo);
  const formularioAberto = Boolean(editar || novo);
  const anexosDe = editar ? null : linhaDosAnexos(primeiro(sp.anexos));
  const [lista, categorias, contas, edicao, fornecedores, clientes, anexos, cartoes] = await Promise.all([
    listarLancamentos(filtro),
    listarCategorias(),
    listarContasBancarias(),
    editar ? obterLancamento(editar) : Promise.resolve(null),
    formularioAberto ? listarFornecedores() : Promise.resolve([]),
    formularioAberto ? listarClientes() : Promise.resolve([]),
    editar ? listarAnexos("manual", editar) : anexosDe ? listarAnexos(anexosDe.origem, anexosDe.id) : Promise.resolve([]),
    formularioAberto ? listarCartoesAtivos() : Promise.resolve([]),
  ]);
  const lancamento: LancamentoForm | null =
    edicao && edicao.status === "em_aberto"
      ? {
          id: edicao.id,
          lado: edicao.lado,
          descricao: edicao.descricao,
          fornecedorId: edicao.fornecedorId,
          clienteId: edicao.clienteId,
          pessoaTexto: edicao.pessoaTexto,
          categoriaId: edicao.categoriaId,
          centro: edicao.centro,
          competencia: edicao.competencia,
          emissao: edicao.emissao,
          vencimento: edicao.vencimento,
          valor: edicao.valor,
          forma: edicao.forma,
          contaBancariaId: edicao.contaBancariaId,
          observacao: edicao.observacao,
          cartaoId: edicao.cartaoId,
          parcelaNumero: edicao.parcelaNumero,
          parcelaTotal: edicao.parcelaTotal,
          status: edicao.status,
        }
      : null;
  return (
    <div className="mx-auto max-w-[1640px]">
      <PageHeader
        title="Lançamentos"
        subtitle="Tudo o que a ECLAK tem a pagar e a receber: o que vem das viagens entra sozinho, ligado a ela; aqui você lança as contas da empresa e dá baixa no que foi pago ou recebido."
      />
      <ListaLancamentos
        key={JSON.stringify(filtro)}
        filtro={filtro}
        hoje={hoje}
        linhas={lista.linhas}
        totalLinhas={lista.totalLinhas}
        totais={lista.totais}
        categorias={categorias}
        contas={contas.map((c) => ({ id: c.id, nome: c.nome, ativa: c.ativa }))}
        fornecedores={fornecedores.map((x) => ({ id: x.id, nome: x.nome }))}
        clientes={clientes.map((x) => ({ id: x.id, nome: `${x.grupo} (${x.codigo})` }))}
        cartoes={cartoes}
        edicao={lancamento}
        novo={!lancamento && (novo === "pagar" || novo === "receber") ? novo : null}
        anexosDe={anexosDe}
        anexos={anexos}
      />
    </div>
  );
}
