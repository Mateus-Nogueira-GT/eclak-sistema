import "server-only";
import { z } from "zod";
import { hojeEmCuiaba } from "@/domain/clientes";
import { formatarPercentual, formatarReais } from "@/domain/dinheiro";
import { protegerTexto } from "@/domain/ia-privacidade";
import { veCamadaEstrategica } from "@/domain/perfis";
import { FORMA_REFERENCIA } from "@/domain/precificacao";
import { ROTULO_CATEGORIA, ROTULO_SITUACAO_TAREFA } from "@/domain/tarefas";
import { somarDias } from "@/domain/venda";
import { ROTULOS_STATUS_ORCAMENTO } from "@/domain/viagens";
import { ErroAcesso, type UsuarioAtual } from "@/server/auth";
import type { FerramentaIA } from "@/server/integracoes/ia";
import { cabecalhoDaViagem, listarDailies, listarTarefas, tarefasDaViagem } from "@/server/queries/operacao";
import { obterViagemVendida } from "@/server/queries/vendas";
import { listarOrcamentos, obterPrecificacao, type OrcamentoLista } from "@/server/queries/viagens";

// Ferramentas do chat, SÓ DE LEITURA. Cada uma chama as queries existentes (que fazem `exigirPerfil` com a sessão de
// quem pergunta); nada aqui lê o banco direto. A saída é montada campo a campo (nunca o objeto da query inteiro): sem
// ids, sem CPF, passaporte, nascimento, telefone, documento da fatura, observações nem texto do daily. Sai texto
// livre curto que a equipe digita: o item e o "o que fazer" das tarefas (`tarefas.item`, `tarefas.fazer`) e o nome
// do serviço dos itens da viagem (`servico`); por isso o JSON inteiro passa por `protegerTexto` antes de sair (CPF,
// passaporte, telefone etc. digitados ali viram marcadores; rede de segurança, não o controle). A camada estratégica
// (custo, preço do pacote, margem, pagamentos a fornecedores) só entra quando `veCamadaEstrategica(perfil)`, e sempre
// a partir do campo `estrategico` que a própria query já restringe.

const MAX_VIAGENS = 20;
const MAX_TAREFAS = 30;
const MAX_DAILIES = 40;

/**
 * Schemas no subconjunto aceito pelo modo estrito: só `type`, `properties`, `required` e `additionalProperties`. As
 * ferramentas sem parâmetro não levam `strict: true`: não há entrada a garantir (o Zod confere o objeto vazio) e um
 * schema sem propriedades no modo estrito é o caso mais provável de o serviço recusar a lista inteira (400 em toda
 * pergunta). Ficam `properties: {}` e `additionalProperties: false`.
 */
export const FERRAMENTAS_CHAT: FerramentaIA[] = [
  {
    name: "buscar_viagens",
    description:
      "Busca viagens e orçamentos (não excluídos), mais recentes primeiro, pelo código (ECL-0001 ou ECL-0001-02) ou por " +
      `parte do nome do cliente, do destino ou de um passageiro. Devolve até ${MAX_VIAGENS} e o total encontrado.`,
    input_schema: {
      type: "object",
      properties: { busca: { type: "string", description: "Código, cliente, destino ou passageiro." } },
      required: ["busca"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "resumo_da_viagem",
    description:
      "Resumo de uma viagem pelo código completo (ECL-0001-02): cliente, datas, passageiros, consultor, situação, " +
      "serviços, valor de referência ao cliente e, se vendida, a venda e as tarefas.",
    input_schema: {
      type: "object",
      properties: { codigo: { type: "string", description: "Código da viagem, como ECL-0001-02." } },
      required: ["codigo"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "minhas_tarefas",
    description: `Tarefas abertas de quem pergunta (é a pessoa responsável), por prazo; até ${MAX_TAREFAS} e o total.`,
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "dailies_da_semana",
    description: "Dailies (mensagens do dia ao cliente) de hoje até daqui a 3 dias, das viagens vendidas com roteiro: dia, viagem, cidade e situação.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** Erro com mensagem para o modelo (vira `tool_result` com `is_error`). */
class ErroFerramenta extends Error {}

const textoCurto = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0 && s.length <= 100, "texto entre 1 e 100 caracteres");
const ENTRADAS = {
  buscar_viagens: z.object({ busca: textoCurto }).strict(),
  resumo_da_viagem: z.object({ codigo: textoCurto }).strict(),
  minhas_tarefas: z.object({}).strict(),
  dailies_da_semana: z.object({}).strict(),
};
type Nome = keyof typeof ENTRADAS;

const reais = (c: bigint | string) => formatarReais(typeof c === "string" ? BigInt(c) : c);
const pct = (p: string) => formatarPercentual(p);

/** Campos estratégicos de uma linha da lista (só chamar para quem vê a camada estratégica). */
function estrategicoDaLista(l: OrcamentoLista) {
  const e = l.estrategico;
  return {
    ...(e && "erro" in e ? { erroDeCalculo: e.erro } : {}),
    ...(e && !("erro" in e) && e.preco !== null ? { precoPacote: reais(e.preco) } : {}),
    ...(e && !("erro" in e) && e.margemPct !== null ? { margemLiquidaPct: pct(e.margemPct) } : {}),
    ...(l.margemVendida ? { margemPlanejadaPct: pct(l.margemVendida.planejadaPct), margemRealPct: l.margemVendida.realPct ? pct(l.margemVendida.realPct) : null } : {}),
  };
}

async function buscarViagens(usuario: UsuarioAtual, { busca }: { busca: string }) {
  const lista = await listarOrcamentos({ busca });
  const estrategico = veCamadaEstrategica(usuario.perfil);
  return {
    total: lista.length,
    viagens: lista.slice(0, MAX_VIAGENS).map((l) => ({
      codigo: l.codigo,
      cliente: l.cliente,
      destino: l.destino,
      inicio: l.inicio,
      fim: l.fim,
      passageiros: l.passageiros,
      consultor: l.consultor,
      situacao: l.statusViagem?.rotulo ?? ROTULOS_STATUS_ORCAMENTO[l.status],
      ...(estrategico ? estrategicoDaLista(l) : {}),
    })),
  };
}

async function resumoDaViagem(usuario: UsuarioAtual, { codigo }: { codigo: string }) {
  const achadas = await listarOrcamentos({ busca: codigo });
  const alvo = codigo.toUpperCase();
  const l = achadas.find((x) => x.codigo === alvo) ?? (achadas.length === 1 ? achadas[0] : null);
  if (!l) {
    if (achadas.length > 1) throw new ErroFerramenta(`Há ${achadas.length} viagens com esse código de cliente; use o código completo, como ${achadas[0].codigo}.`);
    throw new ErroFerramenta(`Viagem ${codigo} não encontrada (ou excluída).`);
  }
  const vendida = l.status === "vendida";
  const [ficha, cab, venda, tarefas] = await Promise.all([
    obterPrecificacao(l.id),
    cabecalhoDaViagem(l.id),
    vendida ? obterViagemVendida(l.id) : null,
    vendida ? tarefasDaViagem(l.id) : null,
  ]);
  if (!ficha || !cab) throw new ErroFerramenta(`Viagem ${codigo} não encontrada (ou excluída).`);
  const estrategico = veCamadaEstrategica(usuario.perfil);

  const resumo: Record<string, unknown> = {
    codigo: l.codigo,
    cliente: l.cliente,
    titular: cab.titular,
    destino: l.destino,
    inicio: l.inicio,
    fim: l.fim,
    noites: cab.noites,
    internacional: ficha.internacional,
    passageiros: cab.passageiros.map((p) => p.nome),
    consultor: l.consultor,
    situacao: l.statusViagem?.rotulo ?? ROTULOS_STATUS_ORCAMENTO[l.status],
    versaoAprovada: l.versaoAprovada,
    servicos: ficha.itens
      .filter((i) => !i.automatico)
      .map((i) => ({
        tipo: i.tipo,
        servico: i.servico,
        cidade: i.cidade,
        checkin: i.checkin,
        checkout: i.checkout,
        diarias: i.diarias,
        cotado: i.cotacoes.length > 0,
      })),
    aereo: ficha.aereo.map((i) => ({ servico: i.servico, cotado: i.cotacoes.length > 0 })),
    servicosSemCotacao: ficha.itensSemCotacao.map((i) => i.servico),
    valorDeReferenciaAoCliente: ficha.referencia
      ? { total: reais(ficha.referencia.precoCliente), porPessoa: reais(ficha.referencia.porPessoa), forma: ficha.referencia.forma }
      : null,
  };
  if (venda) {
    resumo.venda = {
      aceiteEm: venda.venda.aceiteEm,
      forma: venda.venda.forma,
      parcelas: venda.venda.parcelas,
      valorVendido: reais(venda.resumo.valorVendido),
      recebido: reais(venda.resumo.recebido),
      aReceber: reais(venda.resumo.aReceber),
      ...(estrategico ? { pagoAFornecedores: reais(venda.resumo.pagoFornecedores), aPagarAFornecedores: reais(venda.resumo.aPagar) } : {}),
    };
  }
  if (tarefas) {
    resumo.tarefas = {
      abertas: tarefas.tarefas.filter((t) => t.situacao !== "concluida").length,
      vencidas: tarefas.tarefas.filter((t) => t.situacao === "vencida").length,
      concluidas: tarefas.tarefas.filter((t) => t.situacao === "concluida").length,
    };
  }
  if (estrategico) {
    const e = ficha.estrategico;
    if (e && "erro" in e) resumo.camadaEstrategica = { erroDeCalculo: e.erro };
    else if (e) {
      const ref = e.precificacao.porForma[FORMA_REFERENCIA];
      resumo.camadaEstrategica = {
        observacao: "Pelo pior custo de cada item cotado, na forma de referência.",
        formaDeReferencia: ref.rotulo,
        custo: reais(e.precificacao.custo),
        custoComAsCotacoesEscolhidas: reais(e.custoEscolhidas),
        margemExtraDasEscolhidas: reais(e.margemExtra),
        precoPacote: reais(ref.preco),
        margemLiquida: reais(ref.margemLiquida),
        margemLiquidaPct: pct(ref.margemLiquidaPct),
        ...(l.margemVendida
          ? { margemPlanejadaPct: pct(l.margemVendida.planejadaPct), margemRealPct: l.margemVendida.realPct ? pct(l.margemVendida.realPct) : null }
          : {}),
      };
    }
  }
  return resumo;
}

async function minhasTarefas() {
  const lista = await listarTarefas({ visao: "minhas", situacao: "abertas" });
  return {
    total: lista.length,
    tarefas: lista.slice(0, MAX_TAREFAS).map((t) => ({
      viagem: t.viagem.codigo,
      destino: t.viagem.destino,
      categoria: ROTULO_CATEGORIA[t.categoria],
      dia: t.dia,
      item: t.item,
      fazer: t.fazer,
      prazo: t.rotuloPrazo,
      prazoEm: t.prazoEfetivo,
      situacao: ROTULO_SITUACAO_TAREFA[t.situacao],
    })),
  };
}

async function dailiesDaSemana() {
  const lista = await listarDailies();
  const hoje = hojeEmCuiaba();
  return {
    de: hoje,
    ate: somarDias(hoje, 3),
    total: lista.length,
    dailies: lista.slice(0, MAX_DAILIES).map((d) => ({
      data: d.data,
      dia: d.rotuloDia,
      viagem: d.viagem.codigo,
      cliente: d.viagem.cliente,
      cidade: d.cidade,
      trocaDeHotel: d.troca,
      enviarEm: d.dataEnvio,
      situacao: d.estado.rotulo,
      plantao: d.daily?.plantao?.nome ?? null,
    })),
  };
}

/**
 * Roda uma ferramenta pedida pelo modelo com a sessão de quem pergunta. Nunca lança: erro vira `{ erro: true }` com
 * uma mensagem curta em pt-BR (o modelo segue a conversa).
 */
export async function executarFerramenta(nome: string, entrada: unknown, usuario: UsuarioAtual): Promise<{ conteudo: string; erro: boolean }> {
  if (!(nome in ENTRADAS)) return { conteudo: `Ferramenta ${nome} não existe. O chat só lê: viagens, tarefas e dailies.`, erro: true };
  const n = nome as Nome;
  const v = ENTRADAS[n].safeParse(entrada);
  if (!v.success) return { conteudo: `Entrada inválida para ${nome}.`, erro: true };
  try {
    const saida =
      n === "buscar_viagens"
        ? await buscarViagens(usuario, v.data as { busca: string })
        : n === "resumo_da_viagem"
          ? await resumoDaViagem(usuario, v.data as { codigo: string })
          : n === "minhas_tarefas"
            ? await minhasTarefas()
            : await dailiesDaSemana();
    return { conteudo: protegerTexto(JSON.stringify(saida)), erro: false };
  } catch (e) {
    if (e instanceof ErroFerramenta) return { conteudo: protegerTexto(e.message), erro: true };
    if (e instanceof ErroAcesso) return { conteudo: "Sem permissão para esta consulta.", erro: true };
    console.error("Erro na ferramenta do chat", { ferramenta: nome, code: (e as { code?: string } | null)?.code });
    return { conteudo: "Não foi possível consultar agora.", erro: true };
  }
}
