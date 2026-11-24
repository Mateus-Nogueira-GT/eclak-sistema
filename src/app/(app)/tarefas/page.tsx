import { PageHeader } from "@/components/ui";
import { LIMITE_LISTA_TAREFAS, listarTarefas, responsaveisPossiveis, type FiltroTarefas } from "@/server/queries/operacao";
import { ListaTarefas } from "./lista";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/** Filtro a partir da URL: `?visao=todas&responsavel=…&situacao=vencidas&viagem=ECL-0001`. Padrão: minhas abertas. */
function filtroDaUrl(sp: Params): FiltroTarefas {
  const visao = primeiro(sp.visao) === "todas" ? "todas" : "minhas";
  const s = primeiro(sp.situacao);
  const situacao = s === "vencidas" || s === "concluidas" ? s : "abertas";
  const responsavel = visao === "todas" ? primeiro(sp.responsavel) : undefined;
  const viagem = primeiro(sp.viagem)?.trim().slice(0, 40) || undefined;
  return { visao, situacao, responsavel, viagem };
}

export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const filtro = filtroDaUrl(await searchParams);
  const [linhas, usuarios] = await Promise.all([listarTarefas(filtro), responsaveisPossiveis()]);
  return (
    <div className="mx-auto max-w-[1640px]">
      <PageHeader
        title="Tarefas"
        subtitle="As tarefas de operação de todas as viagens vendidas, por prazo. Controle interno, não enviar ao cliente."
      />
      <ListaTarefas key={JSON.stringify(filtro)} filtro={filtro} linhas={linhas} usuarios={usuarios} limite={LIMITE_LISTA_TAREFAS} />
    </div>
  );
}
