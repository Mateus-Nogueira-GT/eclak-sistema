import { Card, CardHeader } from "@/components/ui";
import { Grade } from "@/components/kit";
import { historicoRegras, regrasVigentes } from "@/server/queries/regras";
import { Formulario } from "./formulario";

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

export default async function Pagina() {
  const [vigentes, historico] = await Promise.all([regrasVigentes(), historicoRegras()]);
  const desde = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba" }).format(vigentes.vigenteDesde);

  return (
    <div className="mx-auto max-w-[1180px]">
      <Formulario valores={vigentes.valores} desde={desde} />
      <Card>
        <CardHeader eyebrow="Quem mudou, quando e o valor anterior" title="Histórico de alterações" />
        {historico.length === 0 ? (
          <p className="px-6 pb-5 pt-3 text-[14px] text-cinza">Nenhuma alteração registrada ainda.</p>
        ) : (
          <Grade
            className="mt-3"
            right={[3, 4]}
            head={["Data", "Quem", "Parâmetro", "Valor anterior", "Valor novo"]}
            rows={historico.slice(0, 200).map((h) => [
              <span key="d" className="text-cinza">{dataHora(h.em)}</span>,
              h.usuario,
              <b key="p" className="font-semibold">{h.campo}</b>,
              h.antes,
              <b key="n" className="text-verde">{h.depois}</b>,
            ])}
          />
        )}
      </Card>
    </div>
  );
}
