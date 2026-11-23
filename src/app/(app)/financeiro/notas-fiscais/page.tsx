import { PageHeader } from "@/components/ui";
import { hojeEmCuiaba } from "@/domain/clientes";
import { filtroNotasDaUrl } from "@/domain/notas-fiscais";
import { listarAnexos } from "@/server/queries/anexos";
import { listarClientes } from "@/server/queries/clientes";
import { listarFornecedores } from "@/server/queries/fornecedores";
import { listarNotasFiscais, obterNotaFiscal, opcoesDeViagem } from "@/server/queries/notas-fiscais";
import { NotasFiscais } from "./notas";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const hoje = hojeEmCuiaba();
  const filtro = filtroNotasDaUrl(sp, hoje);
  const editar = primeiro(sp.editar);
  const nova = Boolean(primeiro(sp.nova));
  const painelAberto = Boolean(editar) || nova;
  const [lista, edicao, fornecedores, clientes, viagens] = await Promise.all([
    listarNotasFiscais(filtro),
    editar ? obterNotaFiscal(editar) : Promise.resolve(null),
    painelAberto ? listarFornecedores() : Promise.resolve([]),
    painelAberto ? listarClientes() : Promise.resolve([]),
    painelAberto ? opcoesDeViagem() : Promise.resolve([]),
  ]);
  const anexos = edicao ? await listarAnexos("nota_fiscal", edicao.id) : [];
  return (
    <div className="mx-auto max-w-[1280px]">
      <PageHeader
        title="Notas fiscais"
        subtitle="As notas emitidas, com o PDF de cada uma guardado aqui. Procure por período ou pelo nome de quem recebeu a nota."
      />
      <NotasFiscais
        key={JSON.stringify(filtro)}
        filtro={filtro}
        hoje={hoje}
        lista={lista}
        edicao={edicao}
        nova={nova && !edicao}
        anexos={anexos}
        fornecedores={fornecedores.map((x) => ({ id: x.id, nome: x.nome }))}
        clientes={clientes.map((x) => ({ id: x.id, nome: `${x.grupo} (${x.codigo})` }))}
        viagens={viagens}
      />
    </div>
  );
}
