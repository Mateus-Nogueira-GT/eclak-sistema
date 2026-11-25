import "server-only";
import { PASSO_AVISO_CENTRAL, perfisDoSetor, SETOR_DO_TIPO, type AvisoCentral, type TipoAvisoCentral } from "@/domain/avisos";
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarReais } from "@/domain/dinheiro";
import { dataBr } from "@/domain/tarefas";
import { somarDias } from "@/domain/venda";
import { exigirPerfil } from "@/server/auth";
import { listarReembolsos } from "@/server/queries/reembolsos";

const DIAS_PRAZO_CLIENTE = 3;

function aviso(tipo: TipoAvisoCentral, casoId: string, titulo: string, detalhe: string): AvisoCentral {
  return { chave: `${tipo}:${casoId}`, tipo, titulo, detalhe, passo: PASSO_AVISO_CENTRAL[tipo], setor: SETOR_DO_TIPO[tipo], href: "/financeiro/reembolsos", dispensavel: true };
}

/**
 * Avisos do setor Financeiro sobre os casos abertos de reembolso (spec 5b §8.3), lidos como a tela os monta (o estado
 * de cada lado vem da conta ligada): pedir ao fornecedor (valor a cobrar, sem pedido), cobrar o fornecedor (pedido
 * feito, não recebido, previsto vencido) e reembolsar o cliente (não reembolsado, prazo em até 3 dias ou vencido). Um
 * caso pode dar dois avisos; os do fornecedor primeiro.
 */
export async function avisosDeReembolsos(): Promise<AvisoCentral[]> {
  await exigirPerfil(...perfisDoSetor("Financeiro"));
  const hoje = hojeEmCuiaba();
  const limiteCliente = somarDias(hoje, DIAS_PRAZO_CLIENTE);
  const { casos } = await listarReembolsos("abertos");
  const fornecedor: AvisoCentral[] = [];
  const cliente: AvisoCentral[] = [];
  for (const c of casos) {
    const f = c.ladoFornecedor;
    const de = f.fornecedor ? ` de ${f.fornecedor}` : "";
    if (f.valor > 0n && !f.recebidoEm) {
      if (!f.pedidoEm) {
        fornecedor.push(aviso("reembolso_pedir", c.id, `Reembolso a pedir ao fornecedor: ${c.viagemCodigo}`, `${c.servico}: ${formatarReais(f.valor)} a cobrar${de}`));
      } else if (f.previsto && f.previsto < hoje) {
        fornecedor.push(
          aviso(
            "reembolso_fornecedor",
            c.id,
            `Fornecedor não pagou o reembolso: ${c.viagemCodigo}`,
            `${c.servico}: ${formatarReais(f.valor)} a receber${de}, previsto para ${dataBr(f.previsto)}`,
          ),
        );
      }
    }
    const cl = c.ladoCliente;
    if (cl.valor > 0n && !cl.reembolsadoEm && cl.prazo <= limiteCliente) {
      cliente.push(
        aviso(
          "reembolso_cliente",
          c.id,
          `Reembolsar o cliente: ${c.viagemCodigo}`,
          `${c.clienteNome}: ${formatarReais(cl.valor)} a devolver por ${c.rotuloForma}, prazo ${dataBr(cl.prazo)}`,
        ),
      );
    }
  }
  return [...fornecedor, ...cliente];
}
