import { PageHeader } from "@/components/ui";
import { hojeEmCuiaba } from "@/domain/clientes";
import { USOS_ESTOQUE, type UsoEstoque } from "@/domain/estoque";
import { CENTROS, type Centro } from "@/domain/financeiro";
import { ehUuid } from "@/server/acesso";
import { caixasProximas } from "@/server/queries/caixa-experiencia";
import { listarCartoesAtivos } from "@/server/queries/cartoes";
import { historicoDoProduto, listarEstoque } from "@/server/queries/estoque";
import { listarFornecedores } from "@/server/queries/fornecedores";
import { AbasEstoque, Caixas } from "./caixas";
import { Estoque, type FiltroTela } from "./estoque";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** Filtros da URL (`?uso=`, `?filial=`, `?abaixo=1`); valor desconhecido vale "sem filtro". */
function filtroDaUrl(sp: Params): FiltroTela {
  const uso = primeiro(sp.uso);
  const filial = primeiro(sp.filial);
  return {
    uso: uso && (USOS_ESTOQUE as readonly string[]).includes(uso) ? (uso as UsoEstoque) : null,
    filial: filial && (CENTROS as readonly string[]).includes(filial) ? (filial as Centro) : null,
    soAbaixo: primeiro(sp.abaixo) === "1",
  };
}

/**
 * `?historico=<produto>` abre os movimentos do produto, com "Desfazer entrada" na que ainda se desfaz. `?aba=caixas`
 * mostra as caixas de experiência das próximas viagens.
 */
export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const titulo = (
    <PageHeader
      title="Estoque"
      subtitle="Itens da caixa de experiência e de papelaria em cada filial, pelo custo médio. A compra registrada como entrada vira uma conta a pagar; saídas e ajustes mexem só no estoque."
    />
  );
  if (primeiro(sp.aba) === "caixas") {
    const caixas = await caixasProximas();
    return (
      <div className="mx-auto max-w-[1240px]">
        {titulo}
        <AbasEstoque aba="caixas" />
        <Caixas caixas={caixas} />
      </div>
    );
  }
  const filtro = filtroDaUrl(sp);
  const bruto = primeiro(sp.historico);
  const historicoDe = bruto && ehUuid(bruto) ? bruto : null;
  const [estoque, fornecedores, cartoes, movimentos] = await Promise.all([
    listarEstoque({ uso: filtro.uso ?? undefined, filial: filtro.filial ?? undefined, soAbaixo: filtro.soAbaixo }),
    listarFornecedores(),
    listarCartoesAtivos(),
    historicoDe ? historicoDoProduto(historicoDe) : Promise.resolve([]),
  ]);
  return (
    <div className="mx-auto max-w-[1240px]">
      {titulo}
      <AbasEstoque aba="produtos" />
      <Estoque
        filtro={filtro}
        hoje={hojeEmCuiaba()}
        produtos={estoque.produtos}
        valorTotal={estoque.valorTotal}
        abaixoDoMinimo={estoque.abaixoDoMinimo}
        fornecedores={fornecedores.map((f) => ({ id: f.id, nome: f.nome }))}
        cartoes={cartoes}
        historicoDe={historicoDe}
        movimentos={movimentos}
      />
    </div>
  );
}
