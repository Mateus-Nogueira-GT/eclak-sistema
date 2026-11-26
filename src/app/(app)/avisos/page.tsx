import { SETORES, type Setor } from "@/domain/avisos";
import { exigirPerfil } from "@/server/auth";
import { avisosDaCentral, avisosDispensados } from "@/server/avisos";
import { Avisos, type AbaAvisos, type VisaoAvisos } from "./avisos";

type Params = Record<string, string | string[] | undefined>;

const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

/**
 * Central de avisos (spec 5b §8.5). `?aba=dispensados` mostra as dispensas dos últimos 90 dias; `?setor=<setor>` ou
 * `?setor=todos` (só o Diretor) troca o "Para mim". Calculada sempre na hora.
 */
export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const usuario = await exigirPerfil();
  const aba: AbaAvisos = primeiro(sp.aba) === "dispensados" ? "dispensados" : "abertos";
  const pedido = primeiro(sp.setor);
  const visao: VisaoAvisos =
    usuario.perfil === "diretor" && pedido && (pedido === "todos" || (SETORES as readonly string[]).includes(pedido)) ? (pedido as Setor | "todos") : "mim";
  const [central, dispensados] = await Promise.all([avisosDaCentral(visao === "mim" ? {} : { setor: visao }), avisosDispensados()]);
  return (
    <div className="mx-auto max-w-[1080px]">
      <Avisos
        aba={aba}
        visao={visao}
        perfil={usuario.perfil}
        abertos={central.abertos}
        comunicados={central.comunicados}
        dispensados={dispensados}
      />
    </div>
  );
}
