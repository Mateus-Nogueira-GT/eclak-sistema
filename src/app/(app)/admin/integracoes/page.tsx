import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, CardHeader, Eyebrow, PageHeader } from "@/components/ui";
import { Grade } from "@/components/kit";
import { ROTULO_CLASSE_ERRO } from "@/domain/integracoes";
import { obterIntegracoes, type CartaoIntegracao, type EnvioLista } from "@/server/queries/integracoes";
import { Reenviar, TestarConexao } from "./acoes";

// Admin › Integrações: estado real (pelo ambiente; só nomes de variáveis, nunca valores), teste de conexão e fila.

const quando = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Cuiaba",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function dataHora(d: Date): string {
  const p = Object.fromEntries(quando.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} · ${p.hour}h${p.minute}`;
}

const INTEGRACAO: Record<EnvioLista["integracao"], string> = { trello: "Trello", drive: "Google Drive" };
const TIPO: Record<string, string> = {
  cartao_viagem: "Cartão da viagem",
  checklist_roteiro: "Checklist do roteiro",
  pasta_viagem: "Pastas da viagem",
};

function Variaveis({ nomes }: { nomes: string[] }) {
  return (
    <>
      {nomes.map((n, i) => (
        <span key={n}>
          {i > 0 && ", "}
          <code className="text-[13px] font-semibold text-verde">{n}</code>
        </span>
      ))}
    </>
  );
}

function Desligada({ faltam }: { faltam: string[] }) {
  return (
    <p className="text-[14px] leading-relaxed text-texto">
      Desligada. Para ligar, preencha no ambiente: <Variaveis nomes={faltam} />
    </p>
  );
}

function UltimoTeste({ t }: { t: CartaoIntegracao["ultimoTeste"] }) {
  if (!t) return <p className="text-[13px] text-cinza">Nenhum teste de conexão feito ainda.</p>;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-cinza">
      Último teste em {dataHora(t.em)}:
      {t.ok ? (
        <Badge tom="verde">funcionou</Badge>
      ) : (
        <Badge tom="ouro">falhou · {ROTULO_CLASSE_ERRO[t.classe ?? "servidor"]}</Badge>
      )}
    </p>
  );
}

function Rota({ metodo, caminho, quando: q, faz }: { metodo: string; caminho: string; quando: string; faz: string }) {
  return (
    <li className="rounded-[5px] border border-linha px-3 py-2.5">
      <p className="text-[14px] text-texto">
        <code className="text-[13px] font-semibold text-verde">
          {metodo} {caminho}
        </code>
      </p>
      <p className="mt-0.5 text-[13px] text-cinza">
        {q} · {faz}
      </p>
    </li>
  );
}

function CorpoDoCartao({ c, site }: { c: CartaoIntegracao; site: string }) {
  if (c.integracao === "hotelaria") {
    return (
      <p className="text-[14px] leading-relaxed text-texto">
        Desligada. Aguardando o contrato e a documentação da API da Expedia TAAP e da Infotera.
      </p>
    );
  }
  if (c.integracao === "agendador") {
    return (
      <div className="space-y-3">
        {c.estado.configurada ? (
          <p className="text-[14px] leading-relaxed text-texto">
            Ligado. O <Variaveis nomes={["CRON_SECRET"]} /> está preenchido no ambiente; o agendador chama as rotas
            abaixo com o cabeçalho <code className="text-[12.5px]">Authorization: Bearer</code> e o segredo.
          </p>
        ) : (
          <Desligada faltam={c.estado.faltam} />
        )}
        <ul className="space-y-2">
          <Rota metodo="POST" caminho={`${site}/api/cron/integracoes`} quando="A cada 10 minutos" faz="manda o que ficou na fila" />
          <Rota
            metodo="POST"
            caminho={`${site}/api/cron/dailies`}
            quando="Todo dia às 07:00 (Cuiabá)"
            faz="gera os dailies de hoje até daqui a 2 dias que ainda não têm texto"
          />
        </ul>
      </div>
    );
  }
  if (!c.estado.configurada) return <Desligada faltam={c.estado.faltam} />;
  const soLeitura = SO_LEITURA[c.integracao];
  return (
    <div className="space-y-3">
      <p className="text-[14px] leading-relaxed text-texto">Ligada. As variáveis estão preenchidas no ambiente.</p>
      {c.testavel && (
        <>
          <UltimoTeste t={c.ultimoTeste} />
          <TestarConexao integracao={c.integracao} />
          {soLeitura && <p className="text-[13px] leading-relaxed text-cinza">{soLeitura}</p>}
        </>
      )}
    </div>
  );
}

/** O "Testar conexão" do Trello e do Drive só lê: passar não prova que o envio (que escreve) vai funcionar. */
const SO_LEITURA: Partial<Record<CartaoIntegracao["integracao"], string>> = {
  trello:
    "O teste só lê a lista. Para os envios e ações pelo chat, o token do Trello precisa ter permissão de leitura e escrita (read,write) no quadro.",
  drive:
    "O teste só lê a pasta raiz. Para os envios e ações pelo chat, a conta de serviço precisa ser Editor (ou Gerente de conteúdo) do drive compartilhado.",
};

function Cartao({ c, site }: { c: CartaoIntegracao; site: string }) {
  const ligada = c.estado.configurada;
  return (
    <Card className="flex flex-col pb-5">
      <CardHeader
        title={c.nome}
        eyebrow={c.descricao}
        right={<Badge tom={ligada ? "verde" : "cinza"}>{ligada ? (c.integracao === "agendador" ? "Ligado" : "Ligada") : "Desligada"}</Badge>}
      />
      <div className="mt-4 px-6">
        <CorpoDoCartao c={c} site={site} />
      </div>
    </Card>
  );
}

function Viagem({ e }: { e: EnvioLista }) {
  if (!e.viagem) return <span className="text-cinza">Sem viagem</span>;
  return (
    <Link href={`/viagens/${e.viagem.id}`} className="font-semibold text-verde hover:underline">
      {e.viagem.codigo} <span className="font-normal text-texto">{e.viagem.cliente}</span>
    </Link>
  );
}

const envio = (e: EnvioLista): ReactNode => (
  <span>
    <b className="font-semibold">{INTEGRACAO[e.integracao]}</b> · {TIPO[e.tipo] ?? e.tipo}
  </span>
);

/** Rótulo do erro com o status HTTP, quando houver (ex.: "Credencial recusada · HTTP 401"). */
const textoErro = (e: EnvioLista): string =>
  `${e.erro ?? ROTULO_CLASSE_ERRO.servidor}${e.status !== null ? ` · HTTP ${e.status}` : ""}`;

const erroDe = (e: EnvioLista): ReactNode =>
  e.erro ? (
    <span>{textoErro(e)}</span>
  ) : (
    <span className="text-cinza">Nenhum</span>
  );

function Secao({ titulo, vazio, children, vazia }: { titulo: string; vazio: string; children: ReactNode; vazia: boolean }) {
  return (
    <div className="mt-5">
      <Eyebrow className="px-6">{titulo}</Eyebrow>
      {vazia ? <p className="px-6 pt-2 text-[14px] text-cinza">{vazio}</p> : children}
    </div>
  );
}

export default async function Pagina() {
  const { cartoes, fila } = await obterIntegracoes();
  const semAgendador = cartoes.some((c) => c.integracao === "agendador" && !c.estado.configurada);
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title="Integrações" subtitle="Ligações do sistema com as ferramentas que a equipe já usa." />

      <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
        {cartoes.map((c) => (
          <Cartao key={c.integracao} c={c} site={site} />
        ))}
      </div>

      <Card className="pb-6">
        <CardHeader
          title="Fila de envios"
          eyebrow="O que o sistema mandou ou ainda vai mandar ao Trello e ao Drive. Falha de envio aparece aqui e pode ser reenviada."
        />
        <Secao titulo="Com falha" vazio="Nenhum envio com falha." vazia={fila.falhas.length === 0}>
          <Grade
            className="mt-2"
            head={["Envio", "Viagem", "Erro", "Tentativas", "Criado em", ""]}
            right={[3]}
            rows={fila.falhas.map((e) => [
              envio(e),
              <Viagem key="v" e={e} />,
              <Badge key="e" tom="ouro">
                {textoErro(e)}
              </Badge>,
              e.tentativas,
              dataHora(e.criadoEm),
              <Reenviar key="r" envioId={e.id} rotulo="Reenviar" />,
            ])}
          />
        </Secao>
        <Secao titulo="Na fila" vazio="Nada esperando para sair." vazia={fila.pendentes.length === 0}>
          {semAgendador && (
            <p className="px-6 pt-2 text-[13px] leading-relaxed text-cinza">
              Sem o agendador, o que ficou na fila só sai no próximo evento ou pelo Reenviar.
            </p>
          )}
          <Grade
            className="mt-2"
            head={["Envio", "Viagem", "Situação", "Último erro", "Tentativas"]}
            right={[4]}
            rows={fila.pendentes.map((e) => [
              envio(e),
              <Viagem key="v" e={e} />,
              e.situacao === "enviando" ? "Enviando agora" : `Próxima tentativa ${dataHora(e.proximaEm)}`,
              erroDe(e),
              e.tentativas,
            ])}
          />
        </Secao>
        <Secao titulo="Enviados recentes" vazio="Nenhum envio feito ainda." vazia={fila.enviadosRecentes.length === 0}>
          <Grade
            className="mt-2"
            head={["Envio", "Viagem", "Enviado em", ""]}
            rows={fila.enviadosRecentes.map((e) => [
              envio(e),
              <Viagem key="v" e={e} />,
              e.enviadoEm ? dataHora(e.enviadoEm) : "",
              e.link ? (
                <a key="l" href={e.link} target="_blank" rel="noopener noreferrer" className="font-semibold text-verde hover:underline">
                  {e.integracao === "trello" ? "Abrir o cartão" : "Abrir a pasta"}
                </a>
              ) : null,
            ])}
          />
        </Secao>
      </Card>
    </div>
  );
}
