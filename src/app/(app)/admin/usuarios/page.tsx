import { Check } from "lucide-react";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { Grade, SoGestao } from "@/components/kit";
import { PERFIS, PERFIS_VALORES } from "@/domain/perfis";
import { listarUsuarios } from "@/server/queries/usuarios";
import { Equipe } from "./equipe";

// Decisão da gestão de 13/11/2026; precificação (custos, margens e compensação) revista em 18/11/2026.
const D = [1, 0, 0, 0, 0];
const T = [1, 1, 1, 1, 1];
const F = [1, 0, 0, 1, 1];
const DE = [1, 0, 0, 0, 1];
const matriz: [string, number[]][] = [
  ["Visão geral", DE],
  ["Precificação (dados da cotação)", T],
  ["Precificação (custos, margens e compensação)", F],
  ["Aprovar precificação", D],
  ["Clientes", T],
  ["Viagens", T],
  ["Fornecedores", T],
  ["Fluxo de caixa", F],
  ["Custos operacionais", F],
  ["Conferência Planilha x Sistema", F],
  ["Relatórios", F],
  ["Notas fiscais", F],
  ["Autorizar compras", D],
  ["Parâmetros e usuários", D],
  ["Chat com IA", T],
];

const data = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba" });

export default async function Pagina() {
  const lista = await listarUsuarios();
  const linhas = lista.map((u) => ({
    id: u.id,
    nome: u.nome,
    email: u.email,
    perfil: u.perfil,
    filial: u.filial,
    ativo: u.ativo,
    convitePendente: u.convitePendente,
    cadastro: data.format(u.criadoEm),
  }));

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader
        title="Usuários e acessos"
        subtitle="Quem entra no sistema e o que cada nível pode ver."
      />
      <Equipe usuarios={linhas} />

      <Card>
        <CardHeader
          eyebrow="Definido pela gestão em 13/11/2026, revisto em 18/11/2026"
          title="O que cada nível acessa"
          right={<SoGestao>Só o Diretor altera</SoGestao>}
        />
        <Grade
          className="mt-3"
          head={["Área", ...PERFIS_VALORES.map((p) => PERFIS[p].nome)]}
          rows={matriz.map(([area, v]) => [
            <b key="a" className="font-semibold">{area}</b>,
            ...v.map((x, i) =>
              x ? (
                <Check key={i} size={17} className="text-verde" strokeWidth={2.6} />
              ) : (
                <span key={i} className="text-cinza">Sem acesso</span>
              ),
            ),
          ])}
        />
        <p className="px-6 pb-5 pt-3 text-[13px] text-cinza">
          Esta matriz é informativa: as telas ainda não construídas passam a respeitá-la quando forem
          entregues. Custos, margens e compensação ficam restritos à gestão (Diretor e Financeiros).
        </p>
      </Card>
    </div>
  );
}
