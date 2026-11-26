/**
 * Fatia 5b do seed local: os 11 produtos do protótipo (eclak-mockup/src/lib/estoque.ts, o mesmo mínimo nas duas
 * filiais) com o saldo de cada filial vindo de uma entrada (cada entrada gera a sua conta a pagar; a do Caderno em
 * MT é no cartão corporativo); a caixa de experiência confirmada da Família Ribeiro (MT, em viagem) e a caixa em
 * rascunho da Família Teixeira (RS, embarque em 20 dias); três reembolsos ("Pedir ao fornecedor", "Reembolsar o
 * cliente" e "Concluído", na viagem conciliada dos Vasconcelos); e dois comunicados (Operacional e Geral).
 *
 * As escritas seguem o corpo das Server Actions (que não rodam fora do Next: `cookies()` e `revalidatePath`), com o
 * mesmo núcleo: `travarSaldo`/`gravarMovimento`/`gravarSaldo`, `criarLancamentosNa`, `baixarLancamentoNa`,
 * `naViagemVendidaNa` e a auditoria na mesma transação. Entradas validadas pelos mesmos schemas das actions. Nada de
 * `insert` cru em tabela de dinheiro. Uma transação por unidade semeada.
 * Idempotente: produto pelo nome (ativo), entrada por produto + filial com algum movimento, caixa pela viagem
 * (não cancelada), reembolso por viagem + serviço, comunicado pelo texto.
 */
import { hojeEmCuiaba } from "../src/domain/clientes";
import { somarDias } from "../src/domain/venda";
import type { Sql } from "./seed-orcamentos";

type Uso = "caixa_experiencia" | "papelaria";

// Dados do protótipo (produtosIniciais): nome, uso, onde foi comprado, unitário (reais), MT, RS, mínimo.
const PRODUTOS: [nome: string, uso: Uso, fornecedor: string, unitario: string, mt: number, rs: number, minimo: number][] = [
  ["Caderno de viagem ECLAK", "caixa_experiencia", "Gráfica Rondon", "38,00", 24, 10, 10],
  ["Necessaire de couro", "caixa_experiencia", "Couros do Cerrado", "89,90", 8, 3, 5],
  ["Tag de mala personalizada", "caixa_experiencia", "Gráfica Rondon", "24,50", 40, 18, 12],
  ["Garrafa térmica 500 ml", "caixa_experiencia", "Loja Termos & Cia", "72,00", 6, 2, 4],
  ["Chocolates artesanais (caixa com 6)", "caixa_experiencia", "Cacau Pantanal", "45,00", 12, 6, 6],
  ["Porta-passaporte de couro", "caixa_experiencia", "Couros do Cerrado", "64,00", 3, 4, 5],
  ["Cartão escrito à mão", "caixa_experiencia", "Gráfica Rondon", "3,20", 120, 60, 30],
  ["Caixa presente com fita", "caixa_experiencia", "Embalagens Rondonópolis", "18,00", 20, 9, 8],
  ["Envelope de documentos", "papelaria", "Gráfica Rondon", "12,40", 50, 25, 15],
  ["Caneta ECLAK", "papelaria", "Brindes Mato Grosso", "6,80", 80, 35, 20],
  ["Papel A4 (resma)", "papelaria", "Kalunga", "29,90", 7, 4, 3],
];

/** Caixa confirmada da Ribeiro (MT): a entrada em MT soma estas quantidades, e o saldo final fica o do protótipo. */
const CAIXA_RIBEIRO: [produto: string, quantidade: number][] = [
  ["Caderno de viagem ECLAK", 4],
  ["Tag de mala personalizada", 4],
  ["Chocolates artesanais (caixa com 6)", 1],
  ["Cartão escrito à mão", 1],
  ["Caixa presente com fita", 1],
];

/** Rascunho da Teixeira (RS): não mexe no estoque. */
const CAIXA_TEIXEIRA: [produto: string, quantidade: number][] = [
  ["Caderno de viagem ECLAK", 5],
  ["Tag de mala personalizada", 5],
  ["Garrafa térmica 500 ml", 2],
  ["Cartão escrito à mão", 1],
  ["Caixa presente com fita", 1],
];

const CARTAO_SEED = "Visa Corporativo";
const CONTA_BAIXAS = "Banco do Brasil";

type Usuarios = { diretor: string; consultor: string; operacional: string; finOperacional: string; finEstrategico: string };

async function usuariosDoSeed(sql: Sql): Promise<Usuarios> {
  const linhas = await sql`select id, email from usuarios where email like '%@eclak.local'`;
  const de = (email: string) => {
    const u = linhas.find((l) => l.email === email);
    if (!u) throw new Error(`Falta o usuário do seed ${email}`);
    return u.id as string;
  };
  return {
    diretor: de("diretor@eclak.local"),
    consultor: de("consultor@eclak.local"),
    operacional: de("operacional@eclak.local"),
    finOperacional: de("fin.operacional@eclak.local"),
    finEstrategico: de("fin.estrategico@eclak.local"),
  };
}

async function viagemDoSeed(sql: Sql, grupo: string, destino: string): Promise<string> {
  const [v] = await sql`
    select v.id from viagens v join clientes c on c.id = v.cliente_id
    where c.grupo = ${grupo} and v.destino = ${destino} and v.excluido_em is null and v.status = 'vendida'`;
  if (!v) throw new Error(`Falta a viagem vendida do seed: ${grupo}, ${destino}`);
  return v.id as string;
}

export async function semear5b(sql: Sql): Promise<{ produtos: number; entradas: number; caixas: number; reembolsos: number; comunicados: number }> {
  // Imports dinâmicos: o cliente do app lê DATABASE_URL no carregamento e `server-only` exige `react-server`.
  const { and, asc, eq, inArray, isNull } = await import("drizzle-orm");
  const { aposEntrada, aposSaida, CATEGORIA_DO_USO } = await import("../src/domain/estoque");
  const { caixaItensSchema, entradaSchema, produtoSchema } = await import("../src/domain/estoque-entrada");
  const { centroDaFilial, ROTULO_FORMA_FINANCEIRO } = await import("../src/domain/financeiro");
  const { baixaLancamentoSchema } = await import("../src/domain/financeiro-entrada");
  const { comunicadoSchema } = await import("../src/domain/avisos");
  const { geraContaAPagar } = await import("../src/domain/reembolsos");
  const { pedidoSchema, reembolsadoEmSchema, reembolsoSchema } = await import("../src/domain/reembolsos-entrada");
  const { formatarCodigoViagem } = await import("../src/domain/viagens");
  const { registrarAuditoria } = await import("../src/server/auditoria");
  const { db } = await import("../src/server/db/client");
  const s = await import("../src/server/db/schema");
  const { auditarAlteracao, gravarMovimento, gravarSaldo, saldoDe, travarSaldo } = await import("../src/server/estoque/movimentos");
  const { baixarLancamentoNa, criarLancamentosNa, Desfazer } = await import("../src/server/financeiro/lancamentos");
  const { naViagemVendidaNa } = await import("../src/server/financeiro/baixas-viagem");

  const u = await usuariosDoSeed(sql);
  const hoje = hojeEmCuiaba();
  const exigir = (r: { ok: boolean; erro?: string }, onde: string) => {
    if (!r.ok) throw new Error(`Seed 5b recusado (${onde}): ${r.erro}`);
  };
  const [cartao] = await sql`select id from cartoes_corporativos where nome = ${CARTAO_SEED} and ativo`;
  const [contaBaixas] = await sql`select id from contas_bancarias where nome = ${CONTA_BAIXAS} and ativa and excluido_em is null`;
  if (!cartao || !contaBaixas) throw new Error("Falta o cartão ou a conta bancária do seed financeiro");

  // Produtos (como `salvarProduto`, pelo Financeiro estratégico).
  let produtosNovos = 0;
  const ids = new Map<string, string>();
  for (const [nome, uso, , , , , minimo] of PRODUTOS) {
    const [existe] = await sql`select id from produtos_estoque where nome = ${nome} and ativo`;
    if (existe) {
      ids.set(nome, existe.id as string);
      continue;
    }
    const v = produtoSchema.parse({ nome, uso, minimoMt: minimo, minimoRs: minimo });
    const id = await db.transaction(async (tx) => {
      const [novo] = await tx.insert(s.produtosEstoque).values(v).returning();
      await registrarAuditoria(tx, { usuarioId: u.finEstrategico, tabela: "produtos_estoque", registroId: novo.id, acao: "criar", depois: novo });
      return novo.id;
    });
    ids.set(nome, id);
    produtosNovos++;
  }
  const produtoId = (nome: string) => ids.get(nome)!;

  // Entradas (como `registrarEntrada`): uma por produto e filial, com a conta a pagar pelo núcleo.
  let entradas = 0;
  for (const [nome, uso, fornecedor, unitario, mt, rs] of PRODUTOS) {
    for (const filial of ["MT", "RS"] as const) {
      const pid = produtoId(nome);
      const [movido] = await sql`select 1 from estoque_movimentos where produto_id = ${pid} and filial = ${filial} limit 1`;
      if (movido) continue;
      const daCaixa = filial === "MT" ? (CAIXA_RIBEIRO.find(([p]) => p === nome)?.[1] ?? 0) : 0;
      const noCartao = filial === "MT" && nome === "Caderno de viagem ECLAK";
      const v = entradaSchema.parse({
        produtoId: pid,
        filial,
        quantidade: (filial === "MT" ? mt : rs) + daCaixa,
        valorUnitario: unitario,
        fornecedorId: "",
        fornecedorTexto: fornecedor,
        vencimento: noCartao ? hoje : somarDias(hoje, 20),
        forma: noCartao ? "Cartão de crédito" : "Boleto bancário",
        cartaoId: noCartao ? (cartao.id as string) : "",
      });
      await db.transaction(async (tx) => {
        await tx.select({ id: s.produtosEstoque.id }).from(s.produtosEstoque).where(eq(s.produtosEstoque.id, pid)).for("share");
        const saldo = await travarSaldo(tx, u.finOperacional, pid, filial);
        const valor = BigInt(v.quantidade) * v.valorUnitario;
        const sistema = CATEGORIA_DO_USO[uso];
        const [cat] = await tx.select({ id: s.categoriasFinanceiras.id }).from(s.categoriasFinanceiras).where(eq(s.categoriasFinanceiras.sistema, sistema));
        if (!cat) throw new Error(`Categoria de sistema ausente: ${sistema}`);
        const [conta] = await criarLancamentosNa(tx, u.finOperacional, {
          lado: "pagar",
          descricao: `Estoque: ${v.quantidade} × ${nome}`,
          fornecedorId: v.fornecedorId,
          clienteId: null,
          pessoaTexto: v.fornecedorTexto,
          categoriaId: cat.id,
          centro: v.filial,
          competencia: hoje.slice(0, 7),
          emissao: hoje,
          vencimento: v.vencimento,
          valor,
          forma: v.forma,
          contaBancariaId: null,
          observacao: null,
          repeticao: { tipo: "unica" },
          cartaoId: v.cartaoId,
        });
        const mov = await gravarMovimento(tx, u.finOperacional, saldo, {
          tipo: "entrada",
          quantidade: v.quantidade,
          custoUnitario: v.valorUnitario,
          fornecedorId: v.fornecedorId,
          fornecedorTexto: v.fornecedorTexto,
          lancamentoId: conta.id,
        });
        await tx.update(s.lancamentos).set({ estoqueMovimentoId: mov.id }).where(eq(s.lancamentos.id, conta.id));
        await registrarAuditoria(tx, { usuarioId: u.finOperacional, tabela: "lancamentos", registroId: conta.id, acao: "alterar", antes: { estoqueMovimentoId: null }, depois: { estoqueMovimentoId: mov.id } });
        await gravarSaldo(tx, u.finOperacional, saldo, aposEntrada(saldoDe(saldo), v.quantidade, v.valorUnitario));
      });
      entradas++;
    }
  }

  // Caixas de experiência (como `salvarCaixa` e `confirmarCaixa`), na viagem travada pelo núcleo.
  const montarCaixa = async (viagemId: string, autor: string, lista: [string, number][], confirmar: boolean): Promise<boolean> => {
    const [existe] = await sql`select 1 from caixas_experiencia where viagem_id = ${viagemId} and situacao <> 'cancelada'`;
    if (existe) return false;
    const itens = caixaItensSchema.parse(lista.map(([p, quantidade]) => ({ produtoId: produtoId(p), quantidade })));
    const r = await db.transaction((tx) =>
      naViagemVendidaNa(tx, async () => viagemId, { ok: false, erro: "Viagem não encontrada" }, async (t, v) => {
        const [caixa] = await t.insert(s.caixasExperiencia).values({ viagemId: v.id, filial: centroDaFilial(v.filial), criadoPor: autor }).returning();
        await registrarAuditoria(t, { usuarioId: autor, tabela: "caixas_experiencia", registroId: caixa.id, acao: "criar", depois: caixa });
        const gravados = await t
          .insert(s.caixaItens)
          .values(itens.map((i) => ({ caixaId: caixa.id, produtoId: i.produtoId, quantidade: i.quantidade })))
          .returning();
        for (const i of gravados) await registrarAuditoria(t, { usuarioId: autor, tabela: "caixa_itens", registroId: i.id, acao: "criar", depois: i });
        if (!confirmar) return { ok: true };
        const ordenados = [...gravados].sort((a, b) => (a.produtoId < b.produtoId ? -1 : 1));
        const pids = ordenados.map((i) => i.produtoId);
        await t.select({ id: s.produtosEstoque.id }).from(s.produtosEstoque).where(inArray(s.produtosEstoque.id, pids)).orderBy(asc(s.produtosEstoque.id)).for("share");
        let total = 0n;
        for (const i of ordenados) {
          const saldo = await travarSaldo(t, autor, i.produtoId, caixa.filial);
          const novo = aposSaida(saldoDe(saldo), i.quantidade);
          if (!novo) throw new Desfazer({ ok: false, erro: `Estoque insuficiente em ${caixa.filial}` });
          await gravarMovimento(t, autor, saldo, { tipo: "caixa", quantidade: -i.quantidade, custoUnitario: saldo.custoMedio, caixaId: caixa.id });
          await gravarSaldo(t, autor, saldo, novo);
          const depoisItem = { custoUnitario: saldo.custoMedio };
          await t.update(s.caixaItens).set(depoisItem).where(eq(s.caixaItens.id, i.id));
          await auditarAlteracao(t, autor, "caixa_itens", i.id, i, depoisItem);
          total += BigInt(i.quantidade) * saldo.custoMedio;
        }
        // Um só UPDATE: o CHECK da confirmação exige custo, data e quem juntos.
        const depois = { situacao: "confirmada" as const, custoTotal: total, confirmadaEm: new Date(), confirmadaPor: autor, atualizadoEm: new Date() };
        await t.update(s.caixasExperiencia).set(depois).where(eq(s.caixasExperiencia.id, caixa.id));
        await auditarAlteracao(t, autor, "caixas_experiencia", caixa.id, caixa, depois);
        return { ok: true };
      }),
    );
    exigir(r, "caixa de experiência");
    return true;
  };
  const ribeiro = await viagemDoSeed(sql, "Família Ribeiro", "Portugal e Espanha");
  const teixeira = await viagemDoSeed(sql, "Família Teixeira", "Orlando");
  const vasconcelos = await viagemDoSeed(sql, "Casal Vasconcelos", "Roma e Amalfi");
  let caixas = 0;
  if (await montarCaixa(ribeiro, u.consultor, CAIXA_RIBEIRO, true)) caixas++;
  if (await montarCaixa(teixeira, u.operacional, CAIXA_TEIXEIRA, false)) caixas++;

  // Reembolsos (como `registrarReembolso`, `marcarPedido`, `fornecedorPagou` e `clienteReembolsado`), pelo Financeiro
  // operacional. O caso lê as contas: os marcos de dinheiro são a baixa da conta pelo núcleo.
  type Caso = {
    viagemId: string;
    servico: string;
    ocorridoEm: string;
    ocorrido: string;
    valorCobrar: string;
    valorDevolver: string;
    formaDevolucao: "pix" | "transferencia" | "abatimento" | "credito";
    prazoCliente: string;
    previstoFornecedor: string;
    pedido?: { pedidoEm: string; protocolo: string };
    fornecedorPagouEm?: string;
    clienteReembolsadoEm?: string;
  };
  const CASOS: Caso[] = [
    {
      viagemId: ribeiro,
      servico: "Passeio privativo Sintra e Cascais",
      ocorridoEm: somarDias(hoje, -4),
      ocorrido: "O guia não apareceu no ponto de encontro em Sintra. A família contratou um passeio de última hora e pagou o táxi até Cascais por conta própria.",
      valorCobrar: "1.490,00",
      valorDevolver: "1.640,00",
      formaDevolucao: "pix",
      prazoCliente: somarDias(hoje, 5),
      previstoFornecedor: somarDias(hoje, 15),
    },
    {
      viagemId: ribeiro,
      servico: "Hotel Miradouro Sete",
      ocorridoEm: somarDias(hoje, -5),
      ocorrido: "O hotel não liberou os quartos conjugados combinados na primeira noite em Lisboa. Devolveu uma diária de um dos quartos.",
      valorCobrar: "650,00",
      valorDevolver: "650,00",
      formaDevolucao: "abatimento",
      prazoCliente: somarDias(hoje, 6),
      previstoFornecedor: somarDias(hoje, 2),
      pedido: { pedidoEm: somarDias(hoje, -4), protocolo: "HMS-2231" },
      fornecedorPagouEm: somarDias(hoje, -1),
    },
    {
      viagemId: vasconcelos,
      servico: "Passeio de barco pela Costa Amalfitana",
      ocorridoEm: "2026-05-08",
      ocorrido: "O passeio de barco foi cancelado por causa do mar agitado e não houve outra data antes da volta. O fornecedor reteve 10% de taxa.",
      valorCobrar: "1.620,00",
      valorDevolver: "1.800,00",
      formaDevolucao: "pix",
      prazoCliente: somarDias(hoje, -3),
      previstoFornecedor: somarDias(hoje, -8),
      pedido: { pedidoEm: somarDias(hoje, -14), protocolo: "MBB-7781" },
      fornecedorPagouEm: somarDias(hoje, -9),
      clienteReembolsadoEm: somarDias(hoje, -4),
    },
  ];
  let reembolsosNovos = 0;
  for (const c of CASOS) {
    const [existe] = await sql`select 1 from reembolsos where viagem_id = ${c.viagemId} and servico = ${c.servico} and cancelado_em is null`;
    if (existe) continue;
    const [servico] = await sql`
      select id from contas_pagar where viagem_id = ${c.viagemId} and descricao = ${c.servico} and excluido_em is null`;
    if (!servico) throw new Error(`Falta o serviço do reembolso do seed: ${c.servico}`);
    const e = reembolsoSchema.parse({
      viagemId: c.viagemId,
      contaPagarId: servico.id,
      servico: c.servico,
      ocorridoEm: c.ocorridoEm,
      ocorrido: c.ocorrido,
      valorCobrar: c.valorCobrar,
      valorDevolver: c.valorDevolver,
      formaDevolucao: c.formaDevolucao,
      prazoCliente: c.prazoCliente,
      previstoFornecedor: c.previstoFornecedor,
    });
    const autor = u.finOperacional;
    await db.transaction(async (tx) => {
      const [v] = await tx
        .select({ id: s.viagens.id, filial: s.viagens.filial, clienteId: s.viagens.clienteId, seq: s.viagens.seq, codigoCliente: s.clientes.codigo })
        .from(s.viagens)
        .innerJoin(s.clientes, eq(s.clientes.id, s.viagens.clienteId))
        .where(eq(s.viagens.id, e.viagemId));
      const codigo = formatarCodigoViagem(v.codigoCliente, v.seq);
      const [conta] = await tx
        .select({ fornecedorId: s.contasPagar.fornecedorId })
        .from(s.contasPagar)
        .where(and(eq(s.contasPagar.id, e.contaPagarId!), isNull(s.contasPagar.excluidoEm)));
      const [caso] = await tx
        .insert(s.reembolsos)
        .values({
          viagemId: e.viagemId,
          contaPagarId: e.contaPagarId,
          servico: e.servico,
          fornecedorId: conta.fornecedorId,
          ocorridoEm: e.ocorridoEm,
          ocorrido: e.ocorrido,
          valorCobrar: e.valorCobrar,
          valorDevolver: e.valorDevolver,
          formaDevolucao: e.formaDevolucao,
          prazoCliente: e.prazoCliente,
          previstoFornecedor: e.previstoFornecedor,
          criadoPor: autor,
        })
        .returning();
      await registrarAuditoria(tx, { usuarioId: autor, tabela: "reembolsos", registroId: caso.id, acao: "criar", depois: caso });
      const contas: Partial<Record<"receber" | "pagar", string>> = {};
      for (const lado of ["receber", "pagar"] as const) {
        const pede = lado === "receber" ? caso.valorCobrar > 0n : caso.valorDevolver > 0n && geraContaAPagar(caso.formaDevolucao);
        if (!pede) continue;
        const sistema = lado === "receber" ? "reembolso_fornecedor" : "reembolso_cliente";
        const [cat] = await tx.select({ id: s.categoriasFinanceiras.id }).from(s.categoriasFinanceiras).where(eq(s.categoriasFinanceiras.sistema, sistema));
        if (!cat) throw new Error(`Categoria de sistema ausente: ${sistema}`);
        const [l] = await criarLancamentosNa(tx, autor, {
          lado,
          descricao: `Reembolso ${codigo}: ${caso.servico}`.slice(0, 200),
          fornecedorId: lado === "receber" ? caso.fornecedorId : null,
          clienteId: lado === "pagar" ? v.clienteId : null,
          pessoaTexto: null,
          categoriaId: cat.id,
          centro: centroDaFilial(v.filial),
          competencia: hoje.slice(0, 7),
          emissao: hoje,
          vencimento: lado === "receber" ? caso.previstoFornecedor! : caso.prazoCliente,
          valor: lado === "receber" ? caso.valorCobrar : caso.valorDevolver,
          forma: ROTULO_FORMA_FINANCEIRO[lado === "receber" || caso.formaDevolucao !== "pix" ? "transferencia" : "pix"],
          contaBancariaId: null,
          observacao: null,
          repeticao: { tipo: "unica" },
          cartaoId: null,
        });
        await tx.update(s.lancamentos).set({ reembolsoId: caso.id }).where(eq(s.lancamentos.id, l.id));
        await registrarAuditoria(tx, { usuarioId: autor, tabela: "lancamentos", registroId: l.id, acao: "alterar", antes: { reembolsoId: null }, depois: { reembolsoId: caso.id } });
        contas[lado] = l.id;
      }
      let atual = caso;
      const gravarCaso = async (depois: Partial<typeof caso>) => {
        const antes = Object.fromEntries(Object.keys(depois).map((k) => [k, atual[k as keyof typeof caso]]));
        await tx.update(s.reembolsos).set({ ...depois, atualizadoEm: new Date() }).where(eq(s.reembolsos.id, caso.id));
        await registrarAuditoria(tx, { usuarioId: autor, tabela: "reembolsos", registroId: caso.id, acao: "alterar", antes, depois });
        atual = { ...atual, ...depois };
      };
      if (c.pedido) await gravarCaso(pedidoSchema(hoje).parse(c.pedido));
      const baixa = (data: string, valor: string) =>
        baixaLancamentoSchema(hoje).parse({ data, valorPago: valor, juros: "", desconto: "", contaBancariaId: contaBaixas.id, observacao: "" });
      if (c.fornecedorPagouEm) exigir(await baixarLancamentoNa(tx, autor, contas.receber!, baixa(c.fornecedorPagouEm, c.valorCobrar)), "fornecedor pagou");
      if (c.clienteReembolsadoEm) {
        if (geraContaAPagar(caso.formaDevolucao)) exigir(await baixarLancamentoNa(tx, autor, contas.pagar!, baixa(c.clienteReembolsadoEm, c.valorDevolver)), "cliente reembolsado");
        else await gravarCaso({ reembolsadoEm: reembolsadoEmSchema(hoje).parse({ data: c.clienteReembolsadoEm }).data });
      }
    });
    reembolsosNovos++;
  }

  // Comunicados (como `criarComunicado`).
  const COMUNICADOS: { autor: string; setor: "Operacional" | "Geral"; texto: string; passo: string }[] = [
    {
      autor: u.diretor,
      setor: "Operacional",
      texto: "Conferir as caixas de experiência das viagens que embarcam em dezembro antes do recesso.",
      passo: "Montar e confirmar a caixa na página de cada viagem",
    },
    {
      autor: u.finOperacional,
      setor: "Geral",
      texto: "O escritório fecha de 24/12 a 01/01 e reabre no dia 02/01.",
      passo: "Programar pagamentos e cobranças antes do recesso",
    },
  ];
  let comunicados = 0;
  for (const c of COMUNICADOS) {
    const [existe] = await sql`select 1 from avisos_comunicados where texto = ${c.texto}`;
    if (existe) continue;
    const v = comunicadoSchema.parse({ setor: c.setor, texto: c.texto, passo: c.passo });
    await db.transaction(async (tx) => {
      const [novo] = await tx.insert(s.avisosComunicados).values({ ...v, criadoPor: c.autor }).returning();
      await registrarAuditoria(tx, { usuarioId: c.autor, tabela: "avisos_comunicados", registroId: novo.id, acao: "criar", depois: novo });
    });
    comunicados++;
  }
  return { produtos: produtosNovos, entradas, caixas, reembolsos: reembolsosNovos, comunicados };
}
