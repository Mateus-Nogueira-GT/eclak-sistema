import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardHeader, PageHeader, Td, Th } from "@/components/ui";
import { dataEmCuiaba, hojeEmCuiaba } from "@/domain/clientes";
import { formatarReais } from "@/domain/dinheiro";
import { lerData } from "@/domain/venda";
import { ehUuid } from "@/server/acesso";
import { ErroAcesso } from "@/server/auth";
import { obterConciliacao, type Conciliacao } from "@/server/queries/conciliacao";
import { listarCategorias, listarContasBancarias } from "@/server/queries/financeiro";
import { dataBr } from "../../viagens/formatos";
import { DesfazerImportacao } from "./desfazer-importacao";
import { EnvioExtrato } from "./envio";
import { ListaConciliacao } from "./lista";

// Constantes locais: não importar valores de módulos "use client" numa página de servidor.
const campoCls = "rounded-[5px] border border-[#C9CDD1] bg-white px-3 py-2 text-[14px] text-texto outline-none focus:border-verde";
const SITUACOES = [
  { id: "nao_conciliado", rotulo: "Não conciliado" },
  { id: "confere", rotulo: "Confere" },
  { id: "diferenca", rotulo: "Diferença" },
  { id: "baixa_mudou", rotulo: "A baixa mudou" },
  { id: "ignorado", rotulo: "Ignorado" },
] as const;
type IdSituacao = (typeof SITUACOES)[number]["id"];

type Params = Record<string, string | string[] | undefined>;
const primeiro = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

function dataReal(v: string | undefined): string | null {
  if (!v) return null;
  try {
    lerData(v);
    return v;
  } catch {
    return null;
  }
}

/** Mês corrente quando a URL não traz um período válido (datas reais, `de` ≤ `ate`). */
function periodoDaUrl(sp: Params, hoje: string): { de: string; ate: string } {
  const inicio = `${hoje.slice(0, 8)}01`;
  const de = dataReal(primeiro(sp.de));
  const ate = dataReal(primeiro(sp.ate));
  if (de && ate && de <= ate) return { de, ate };
  return { de: inicio, ate: fimDoMes(inicio) };
}

function fimDoMes(inicio: string): string {
  const [a, m] = lerData(inicio);
  return new Date(Date.UTC(a, m, 0)).toISOString().slice(0, 10);
}

const comSinal = (c: bigint) => (c < 0n ? `− ${formatarReais(-c)}` : formatarReais(c));

function urlDe(conta: string, de: string, ate: string, situacao?: string): string {
  const q = new URLSearchParams({ conta, de, ate });
  if (situacao) q.set("situacao", situacao);
  return `/financeiro/conciliacao?${q.toString()}`;
}

// Defesa em profundidade: o proxy já barra, mas a tela não depende só dele.
export default async function Pagina({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const hoje = hojeEmCuiaba();
  let contas, categorias;
  try {
    [contas, categorias] = await Promise.all([listarContasBancarias(), listarCategorias()]);
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }
  const cabecalho = <PageHeader title="Conciliação" subtitle="Confira o extrato do banco com as baixas do sistema." />;
  const ativas = contas.filter((c) => c.ativa);
  if (contas.length === 0) {
    return (
      <div className="mx-auto max-w-[1280px]">
        {cabecalho}
        <Card className="p-8 text-center">
          <p className="text-[15px] text-texto">Cadastre uma conta bancária para importar extratos.</p>
          <Link href="/financeiro/contas-bancarias" className="mt-3 inline-block text-[14px] font-semibold text-verde underline underline-offset-[3px]">
            Ir para Contas bancárias
          </Link>
        </Card>
      </div>
    );
  }

  const pedida = primeiro(sp.conta);
  const conta = contas.find((c) => c.id === pedida && ehUuid(pedida)) ?? ativas[0] ?? contas[0];
  const { de, ate } = periodoDaUrl(sp, hoje);
  const situacao = SITUACOES.find((s) => s.id === primeiro(sp.situacao))?.id as IdSituacao | undefined;

  let dados: Conciliacao | null;
  try {
    dados = await obterConciliacao({ contaBancariaId: conta.id, de, ate, situacao });
  } catch (e) {
    if (e instanceof ErroAcesso) redirect("/sem-acesso");
    throw e;
  }
  if (!dados) redirect("/financeiro/conciliacao");

  const total = SITUACOES.reduce((n, s) => n + dados.totais[s.id].qtd, 0);
  const opcoesCategoria = categorias.map((g) => ({
    lado: g.lado,
    grupo: g.grupo,
    categorias: g.categorias.filter((c) => c.ativa && !c.sistema).map((c) => ({ id: c.id, nome: c.nome })),
  }));

  return (
    <div className="mx-auto max-w-[1640px]">
      {cabecalho}

      <form method="get" className="mb-5 flex flex-wrap items-end gap-3">
        <label className="text-[13px] text-cinza">
          Conta
          <select name="conta" defaultValue={conta.id} className={`${campoCls} mt-1 block`}>
            {contas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nome}
                {c.ativa ? "" : " (desativada)"}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[13px] text-cinza">
          De
          <input type="date" name="de" defaultValue={de} className={`${campoCls} mt-1 block`} />
        </label>
        <label className="text-[13px] text-cinza">
          Até
          <input type="date" name="ate" defaultValue={ate} className={`${campoCls} mt-1 block`} />
        </label>
        <label className="text-[13px] text-cinza">
          Situação
          <select name="situacao" defaultValue={situacao ?? ""} className={`${campoCls} mt-1 block`}>
            <option value="">Todas</option>
            {SITUACOES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.rotulo}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="cursor-pointer rounded-[5px] bg-verde px-3.5 py-2 text-[14px] font-semibold text-white hover:bg-[#254B5C]">
          Aplicar
        </button>
      </form>

      <div className="mb-5 grid grid-cols-5 gap-3">
        {SITUACOES.map((s) => {
          const t = dados.totais[s.id];
          const pendencia = (s.id === "nao_conciliado" || s.id === "diferenca" || s.id === "baixa_mudou") && t.qtd > 0;
          const ativo = situacao === s.id;
          return (
            <Link
              key={s.id}
              href={urlDe(conta.id, de, ate, ativo ? undefined : s.id)}
              aria-current={ativo ? "true" : undefined}
              className={`rounded-[6px] border bg-white p-4 hover:border-verde ${ativo ? "border-verde" : pendencia ? "border-ouro" : "border-linha"}`}
            >
              <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-cinza">{s.rotulo}</p>
              <p className="num mt-1 text-[21px] font-bold text-verde">
                {pendencia && <span className="mr-2 inline-block h-2 w-2 -translate-y-1 rounded-full bg-ouro" aria-hidden />}
                {t.qtd}
              </p>
              <p className="num text-[13px] text-cinza">{comSinal(t.valor)}</p>
            </Link>
          );
        })}
      </div>

      <EnvioExtrato contaId={conta.id} contaNome={conta.nome} ativa={conta.ativa} />

      <ListaConciliacao
        key={`${conta.id}${de}${ate}${situacao ?? ""}`}
        linhas={dados.linhas}
        categorias={opcoesCategoria}
        vazio={total === 0 ? "Nenhuma transação do extrato neste período. Importe o arquivo OFX do banco." : "Nenhuma transação com esta situação."}
      />

      <Card className="mt-6 overflow-hidden">
        <CardHeader title="Importações desta conta" eyebrow="Os arquivos já enviados, do mais recente para o mais antigo." />
        {dados.importacoes.length === 0 ? (
          <p className="px-6 py-5 text-[14px] text-cinza">Nenhum extrato importado nesta conta ainda.</p>
        ) : (
          <table className="mt-4 w-full text-left">
            <thead>
              <tr>
                <Th>Importado em</Th>
                <Th>Arquivo</Th>
                <Th>Banco</Th>
                <Th>Final da conta</Th>
                <Th>Período do extrato</Th>
                <Th className="text-right">Novas</Th>
                <Th className="text-right">Repetidas</Th>
                <Th>Por</Th>
                <Th className="text-right">Ações</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-linha">
              {dados.importacoes.map((i) => (
                <tr key={i.id}>
                  <Td>{dataBr(dataEmCuiaba(i.importadoEm))}</Td>
                  <Td className="[overflow-wrap:anywhere]">{i.arquivoNome}</Td>
                  <Td className="num">{i.bancoOfx ?? "—"}</Td>
                  <Td className="num">{i.contaOfx ?? "—"}</Td>
                  <Td>{i.inicio && i.fim ? `${dataBr(i.inicio)} a ${dataBr(i.fim)}` : "—"}</Td>
                  <Td className="num text-right">{i.transacoes}</Td>
                  <Td className="num text-right">{i.repetidas}</Td>
                  <Td>{i.importadoPorNome}</Td>
                  <Td className="text-right">
                    <DesfazerImportacao id={i.id} arquivoNome={i.arquivoNome} transacoes={i.transacoes} tratadas={i.tratadas} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
