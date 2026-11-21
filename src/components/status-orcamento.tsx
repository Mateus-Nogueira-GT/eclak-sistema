import { Badge } from "@/components/ui";
import { ROTULOS_STATUS_ORCAMENTO, type StatusOrcamento } from "@/domain/viagens";

const TOM: Record<StatusOrcamento, "cinza" | "ouro" | "agua"> = {
  em_edicao: "cinza",
  aguardando_aprovacao: "ouro",
  aprovado: "agua",
  devolvido: "cinza",
};

export function StatusOrcamentoBadge({ status }: { status: StatusOrcamento }) {
  return <Badge tom={TOM[status]}>{ROTULOS_STATUS_ORCAMENTO[status]}</Badge>;
}
