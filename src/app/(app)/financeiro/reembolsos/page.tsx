import { hojeEmCuiaba } from "@/domain/clientes";
import { ehUuid } from "@/server/acesso";
import { contarAnexosDe, listarAnexos } from "@/server/queries/anexos";
import { listarContasBancarias } from "@/server/queries/financeiro";
import { listarReembolsos, servicosDaViagem, viagensParaReembolso } from "@/server/queries/reembolsos";
import { Reembolsos, type AbaReembolsos } from "./reembolsos";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const uuidOuNulo = (v: string | undefined) => (v && ehUuid(v) ? v : null);

/**
 * `?aba=concluidos` mostra os concluídos e cancelados; `?nova=1` abre o registro (`&viagem=<id>` carrega os serviços
 * da viagem escolhida); `?editar=<caso>` abre o caso para editar; `?anexos=<caso>` abre os comprovantes do caso.
 */
export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const aba: AbaReembolsos = primeiro(sp.aba) === "concluidos" ? "concluidos" : "abertos";
  const editar = uuidOuNulo(primeiro(sp.editar));
  const nova = !editar && primeiro(sp.nova) === "1";
  const viagem = nova ? uuidOuNulo(primeiro(sp.viagem)) : null;
  const anexosDe = uuidOuNulo(primeiro(sp.anexos));
  const [lista, contas, viagens, servicos, anexos] = await Promise.all([
    listarReembolsos(aba),
    listarContasBancarias({ ativas: true }),
    nova ? viagensParaReembolso() : Promise.resolve([]),
    viagem ? servicosDaViagem(viagem) : Promise.resolve([]),
    anexosDe ? listarAnexos("reembolso", anexosDe) : Promise.resolve([]),
  ]);
  const contagem = await contarAnexosDe(lista.casos.map((c) => ({ donoTipo: "reembolso" as const, donoId: c.id })));
  const edicao = editar ? (lista.casos.find((c) => c.id === editar && !c.canceladoEm) ?? null) : null;
  return (
    <div className="mx-auto max-w-[1080px]">
      <Reembolsos
        aba={aba}
        hoje={hojeEmCuiaba()}
        casos={lista.casos.map((c) => ({ ...c, anexos: contagem.get(`reembolso:${c.id}`) ?? 0 }))}
        resumo={lista.resumo}
        contas={contas.map((c) => ({ id: c.id, nome: c.nome }))}
        registro={nova ? { viagens, viagemId: viagem && viagens.some((v) => v.id === viagem) ? viagem : null, servicos } : null}
        edicao={edicao}
        anexosDe={anexosDe && lista.casos.some((c) => c.id === anexosDe) ? anexosDe : null}
        anexos={anexos}
      />
    </div>
  );
}
