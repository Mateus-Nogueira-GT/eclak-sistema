"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { Grade } from "@/components/kit";
import { Badge, Botao, Campo, Card, CardHeader, Select, Stat, cx, inputCls } from "@/components/ui";
import { formatarReais, lerReais } from "@/domain/dinheiro";
import { ROTULO_USO, USOS_ESTOQUE, type TipoMovimento, type UsoEstoque } from "@/domain/estoque";
import { CENTROS, FORMAS_FINANCEIRO, type Centro } from "@/domain/financeiro";
import { ajustarEstoque, desativarProduto, desfazerEntradaDeEstoque, registrarEntrada, registrarSaida, salvarProduto } from "@/server/actions/estoque";
import type { MovimentoLinha, ProdutoLinha } from "@/server/queries/estoque";
import { useAcao } from "../../viagens/[id]/acao";
import { dataHora } from "../../viagens/formatos";
import { Dialogo } from "../lancamentos/baixa";

export type FiltroTela = { uso: UsoEstoque | null; filial: Centro | null; soAbaixo: boolean };
type Opcao = { id: string; nome: string };
type CartaoOpcao = { id: string; nome: string; final: string };
type Acao = ReturnType<typeof useAcao>;

const ROTULO_TIPO: Record<TipoMovimento, string> = {
  entrada: "Entrada",
  saida: "Saída",
  ajuste: "Ajuste",
  caixa: "Caixa de experiência",
  devolucao_caixa: "Devolução da caixa",
};

const reais = (c: bigint) => formatarReais(c);
/** Campo de número inteiro: vazio ou ilegível chega ao servidor como inválido (o schema responde no campo). */
const inteiro = (t: string) => (/^\s*\d+\s*$/.test(t) ? Number.parseInt(t, 10) : Number.NaN);
const link = "cursor-pointer text-[13px] font-semibold text-verde hover:underline";

function urlDe(f: FiltroTela, historico?: string) {
  const q = new URLSearchParams();
  if (f.uso) q.set("uso", f.uso);
  if (f.filial) q.set("filial", f.filial);
  if (f.soAbaixo) q.set("abaixo", "1");
  if (historico) q.set("historico", historico);
  const t = q.toString();
  return t ? `/financeiro/estoque?${t}` : "/financeiro/estoque";
}

/**
 * Campo com o erro do servidor embaixo (borda e fundo em ouro); `chaves` são as chaves de erro que o marcam. Mexer no
 * campo tira o erro dele.
 */
function CampoErro({ acao, chaves, label, className, children }: { acao: Acao; chaves: string[]; label: string; className?: string; children: (marca: string) => ReactNode }) {
  const msg = chaves.map((k) => acao.campos[k]).find(Boolean);
  return (
    <Campo label={label} className={className}>
      <span className="block" onChange={() => chaves.forEach(acao.limparCampo)}>{children(msg ? "!border-ouro bg-ouro/15" : "")}</span>
      {msg && <span className="mt-1 block text-[12px] text-texto">{msg}</span>}
    </Campo>
  );
}

function MsgAcao({ acao }: { acao: Acao }) {
  if (!acao.erro) return null;
  return (
    <p role="alert" className="mt-4 rounded-[5px] border border-ouro bg-ouro/15 px-3 py-2 text-[13px] text-texto">
      {acao.erro}
    </p>
  );
}

type Aberto =
  | { tipo: "produto"; produto: ProdutoLinha | null }
  | { tipo: "entrada" | "saida" | "ajuste"; produto: ProdutoLinha }
  | null;

/**
 * Estoque por filial: cartões (valor em estoque e produtos abaixo do mínimo, sempre das duas filiais), filtros na URL,
 * a tabela dos produtos e, por produto, Entrada, Saída, Ajustar, Histórico e Editar. `historicoDe` (`?historico=`)
 * abre os movimentos do produto.
 */
export function Estoque({
  filtro,
  hoje,
  produtos,
  valorTotal,
  abaixoDoMinimo,
  fornecedores,
  cartoes,
  historicoDe,
  movimentos,
}: {
  filtro: FiltroTela;
  hoje: string;
  produtos: ProdutoLinha[];
  valorTotal: bigint;
  abaixoDoMinimo: number;
  fornecedores: Opcao[];
  cartoes: CartaoOpcao[];
  historicoDe: string | null;
  movimentos: MovimentoLinha[];
}) {
  const [aberto, setAberto] = useState<Aberto>(null);
  const fechar = () => setAberto(null);
  const filialPadrao: Centro = filtro.filial ?? "MT";
  const doHistorico = historicoDe ? produtos.find((p) => p.id === historicoDe) : undefined;

  const quantidade = (s: ProdutoLinha["mt"]) => (
    <span className="inline-flex flex-col items-end">
      <span className={cx("num", s.abaixo && "rounded-[3px] bg-ouro/30 px-1.5 font-semibold")}>{s.quantidade}</span>
      <span className="whitespace-nowrap text-[12px] text-cinza">{s.minimo > 0 ? `mín. ${s.minimo}` : "sem mínimo"}</span>
    </span>
  );
  const repor = (p: ProdutoLinha) => [p.mt.abaixo && "MT", p.rs.abaixo && "RS"].filter(Boolean).join(" e ");

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Card className="p-5">
          <Stat label="Valor em estoque" value={reais(valorTotal)} sub="MT e RS somados, pelo custo médio" />
        </Card>
        <Card className="p-5">
          <Stat
            label="Abaixo do mínimo"
            value={<span className={cx(abaixoDoMinimo > 0 && "rounded-[3px] bg-ouro/30 px-1.5 text-texto")}>{abaixoDoMinimo}</span>}
            sub={abaixoDoMinimo === 1 ? "produto para repor" : abaixoDoMinimo > 1 ? "produtos para repor" : "Nenhum produto para repor"}
          />
        </Card>
      </div>

      <Card className="pb-2">
        <CardHeader
          title="Produtos"
          eyebrow="Quantidade e mínimo por filial. Os itens saem sozinhos quando a caixa de experiência de uma viagem é confirmada."
          right={
            <Botao onClick={() => setAberto({ tipo: "produto", produto: null })}>
              <Plus size={16} /> Novo produto
            </Botao>
          }
        />
        <Filtros key={urlDe(filtro)} filtro={filtro} />
        {produtos.length === 0 ? (
          <p className="px-6 pb-5 pt-4 text-[14px] text-cinza">
            {filtro.uso || filtro.filial || filtro.soAbaixo ? "Nenhum produto com estes filtros." : "Nenhum produto cadastrado ainda."}
          </p>
        ) : (
          <Grade
            className="mt-4"
            right={[2, 3, 4, 5]}
            head={["Produto", "Uso", "MT", "RS", "Custo médio", filtro.filial ? `Valor (${filtro.filial})` : "Valor total", ""]}
            rows={produtos.map((p) => [
              <span key="n" className="block min-w-[170px]">
                <b className="font-semibold">{p.nome}</b>
                {!p.ativo && <Badge className="ml-2">Desativado</Badge>}
                {(p.mt.abaixo || p.rs.abaixo) && (
                  <span className="mt-0.5 block">
                    <Badge tom="ouro">Repor {repor(p)}</Badge>
                  </span>
                )}
              </span>,
              <span key="u" className="whitespace-nowrap">{ROTULO_USO[p.uso]}</span>,
              quantidade(p.mt),
              quantidade(p.rs),
              <span key="c" className="inline-flex flex-col items-end whitespace-nowrap">
                <span>MT {reais(p.custoMedioMt)}</span>
                <span>RS {reais(p.custoMedioRs)}</span>
              </span>,
              <b key="v" className="whitespace-nowrap font-semibold">{reais(p.valor)}</b>,
              <span key="a" className="flex min-w-[180px] flex-wrap justify-end gap-x-4 gap-y-1">
                {p.ativo && (
                  <>
                    <button className={link} onClick={() => setAberto({ tipo: "entrada", produto: p })}>Entrada</button>
                    <button className={link} onClick={() => setAberto({ tipo: "saida", produto: p })}>Saída</button>
                    <button className={link} onClick={() => setAberto({ tipo: "ajuste", produto: p })}>Ajustar</button>
                  </>
                )}
                <Link href={urlDe(filtro, p.id)} scroll={false} className={link}>Histórico</Link>
                {p.ativo && <button className={link} onClick={() => setAberto({ tipo: "produto", produto: p })}>Editar</button>}
              </span>,
            ])}
          />
        )}
      </Card>

      {aberto?.tipo === "produto" && <DialogoProduto produto={aberto.produto} onFechar={fechar} />}
      {aberto?.tipo === "entrada" && <DialogoEntrada produto={aberto.produto} filialInicial={filialPadrao} hoje={hoje} fornecedores={fornecedores} cartoes={cartoes} onFechar={fechar} />}
      {(aberto?.tipo === "saida" || aberto?.tipo === "ajuste") && <DialogoSaidaOuAjuste tipo={aberto.tipo} produto={aberto.produto} filialInicial={filialPadrao} onFechar={fechar} />}
      {historicoDe && <DialogoHistorico nome={doHistorico?.nome ?? "Produto"} movimentos={movimentos} voltar={urlDe(filtro)} />}
    </div>
  );
}

/** Uso, filial e "só abaixo do mínimo"; cada mudança vai para a URL. */
function Filtros({ filtro }: { filtro: FiltroTela }) {
  const router = useRouter();
  const [f, setF] = useState(filtro);
  const aplicar = (novo: FiltroTela) => {
    setF(novo);
    router.push(urlDe(novo));
  };
  return (
    <div className="flex flex-wrap items-center gap-3 px-6 pt-4">
      <Select value={f.uso ?? ""} onChange={(v) => aplicar({ ...f, uso: (v || null) as UsoEstoque | null })}>
        <option value="">Todos os usos</option>
        {USOS_ESTOQUE.map((u) => (
          <option key={u} value={u}>{ROTULO_USO[u]}</option>
        ))}
      </Select>
      <Select value={f.filial ?? ""} onChange={(v) => aplicar({ ...f, filial: (v || null) as Centro | null })}>
        <option value="">MT e RS</option>
        {CENTROS.map((c) => (
          <option key={c} value={c}>Só {c}</option>
        ))}
      </Select>
      <label className="flex cursor-pointer items-center gap-2 text-[14px]">
        <input type="checkbox" className="accent-verde" checked={f.soAbaixo} onChange={(e) => aplicar({ ...f, soAbaixo: e.target.checked })} />
        Só abaixo do mínimo
      </label>
    </div>
  );
}

function Rodape({ acao, rotulo, onFechar, onSalvar, extra }: { acao: Acao; rotulo: string; onFechar: () => void; onSalvar: () => void; extra?: ReactNode }) {
  return (
    <>
      {extra}
      <Botao variante="secundario" onClick={onFechar}>Fechar</Botao>
      <Botao disabled={acao.pendente} onClick={onSalvar}>{rotulo}</Botao>
    </>
  );
}

/** Novo produto ou edição (nome, uso, mínimos por filial); na edição, "Desativar" (só com saldo 0 nas duas filiais). */
function DialogoProduto({ produto, onFechar }: { produto: ProdutoLinha | null; onFechar: () => void }) {
  const acao = useAcao();
  const [nome, setNome] = useState(produto?.nome ?? "");
  const [uso, setUso] = useState<string>(produto?.uso ?? "caixa_experiencia");
  const [minimoMt, setMinimoMt] = useState(produto ? String(produto.mt.minimo) : "0");
  const [minimoRs, setMinimoRs] = useState(produto ? String(produto.rs.minimo) : "0");

  function salvar() {
    const dados = { nome, uso, minimoMt: inteiro(minimoMt), minimoRs: inteiro(minimoRs) };
    acao.executar(() => salvarProduto(dados, produto?.id), onFechar);
  }
  function desativar() {
    if (!produto || !window.confirm(`Desativar ${produto.nome}? Ele some das escolhas; o histórico fica.`)) return;
    acao.executar(() => desativarProduto(produto.id), onFechar);
  }

  return (
    <Dialogo
      eyebrow="Estoque"
      titulo={produto ? `Editar ${produto.nome}` : "Novo produto"}
      onFechar={onFechar}
      rodape={
        <Rodape
          acao={acao}
          rotulo={produto ? "Salvar alterações" : "Adicionar produto"}
          onFechar={onFechar}
          onSalvar={salvar}
          extra={
            produto && (
              <Botao variante="fantasma" className="mr-auto" disabled={acao.pendente} onClick={desativar}>
                Desativar
              </Botao>
            )
          }
        />
      }
    >
      <div className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-2">
        <CampoErro acao={acao} chaves={["nome"]} label="Nome" className="sm:col-span-2">
          {(m) => <input autoFocus className={`${inputCls} ${m}`} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: Caderno de viagem" />}
        </CampoErro>
        <CampoErro acao={acao} chaves={["uso"]} label="Uso" className="sm:col-span-2">
          {(m) => (
            <select className={`${inputCls} ${m}`} value={uso} onChange={(e) => setUso(e.target.value)}>
              {USOS_ESTOQUE.map((u) => (
                <option key={u} value={u}>{ROTULO_USO[u]}</option>
              ))}
            </select>
          )}
        </CampoErro>
        <CampoErro acao={acao} chaves={["minimoMt"]} label="Mínimo em MT">
          {(m) => <input inputMode="numeric" className={`${inputCls} num text-right ${m}`} value={minimoMt} onChange={(e) => setMinimoMt(e.target.value)} />}
        </CampoErro>
        <CampoErro acao={acao} chaves={["minimoRs"]} label="Mínimo em RS">
          {(m) => <input inputMode="numeric" className={`${inputCls} num text-right ${m}`} value={minimoRs} onChange={(e) => setMinimoRs(e.target.value)} />}
        </CampoErro>
        <p className="text-[13px] text-cinza sm:col-span-2">Abaixo do mínimo, a quantidade aparece em destaque com &quot;Repor&quot;. Mínimo 0 é sem aviso.</p>
      </div>
      <div className="px-6 pb-2">
        <MsgAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

type TipoPessoa = "texto" | "fornecedor";

/** Compra: filial, quantidade, valor unitário, onde foi comprado, vencimento e forma (com o cartão, se for crédito). */
function DialogoEntrada({
  produto,
  filialInicial,
  hoje,
  fornecedores,
  cartoes,
  onFechar,
}: {
  produto: ProdutoLinha;
  filialInicial: Centro;
  hoje: string;
  fornecedores: Opcao[];
  cartoes: CartaoOpcao[];
  onFechar: () => void;
}) {
  const acao = useAcao();
  const [filial, setFilial] = useState<Centro>(filialInicial);
  const [quantidade, setQuantidade] = useState("");
  const [unitario, setUnitario] = useState("");
  const [tipoPessoa, setTipoPessoa] = useState<TipoPessoa>("texto");
  const [fornecedorId, setFornecedorId] = useState("");
  const [fornecedorTexto, setFornecedorTexto] = useState("");
  const [forma, setForma] = useState("");
  const [cartaoId, setCartaoId] = useState("");
  const [vencimento, setVencimento] = useState(hoje);
  const noCartao = forma === "Cartão de crédito";

  let total: bigint | null = null;
  try {
    const q = inteiro(quantidade);
    if (Number.isInteger(q) && unitario.trim()) total = BigInt(q) * lerReais(unitario);
  } catch {
    total = null;
  }

  function salvar() {
    const dados = {
      produtoId: produto.id,
      filial,
      quantidade: inteiro(quantidade),
      valorUnitario: unitario,
      fornecedorId: tipoPessoa === "fornecedor" ? fornecedorId : "",
      fornecedorTexto: tipoPessoa === "texto" ? fornecedorTexto : "",
      vencimento,
      forma,
      cartaoId: noCartao ? cartaoId : "",
    };
    acao.executar(() => registrarEntrada(dados), onFechar);
  }

  return (
    <Dialogo
      eyebrow={`Entrada de estoque · ${ROTULO_USO[produto.uso]}`}
      titulo={produto.nome}
      largura="max-w-[720px]"
      onFechar={onFechar}
      rodape={<Rodape acao={acao} rotulo="Registrar entrada" onFechar={onFechar} onSalvar={salvar} />}
    >
      <div className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-6">
        <CampoErro acao={acao} chaves={["filial"]} label="Filial" className="sm:col-span-2">
          {(m) => (
            <select className={`${inputCls} ${m}`} value={filial} onChange={(e) => setFilial(e.target.value as Centro)}>
              {CENTROS.map((c) => (
                <option key={c} value={c}>{c} (tem {c === "MT" ? produto.mt.quantidade : produto.rs.quantidade})</option>
              ))}
            </select>
          )}
        </CampoErro>
        <CampoErro acao={acao} chaves={["quantidade"]} label="Quantidade" className="sm:col-span-2">
          {(m) => <input autoFocus inputMode="numeric" className={`${inputCls} num text-right ${m}`} value={quantidade} onChange={(e) => setQuantidade(e.target.value)} />}
        </CampoErro>
        <CampoErro acao={acao} chaves={["valorUnitario"]} label="Valor unitário" className="sm:col-span-2">
          {(m) => <input inputMode="decimal" placeholder="0,00" className={`${inputCls} num text-right ${m}`} value={unitario} onChange={(e) => setUnitario(e.target.value)} />}
        </CampoErro>
        <Campo label="Onde foi comprado" className="sm:col-span-2">
          <select className={inputCls} value={tipoPessoa} onChange={(e) => setTipoPessoa(e.target.value as TipoPessoa)}>
            <option value="texto">Nome livre</option>
            <option value="fornecedor">Fornecedor do cadastro</option>
          </select>
        </Campo>
        {tipoPessoa === "texto" ? (
          <CampoErro acao={acao} chaves={["fornecedorTexto", "fornecedor"]} label="Loja ou pessoa" className="sm:col-span-4">
            {(m) => <input className={`${inputCls} ${m}`} value={fornecedorTexto} onChange={(e) => setFornecedorTexto(e.target.value)} placeholder="Ex.: Papelaria do centro (opcional)" />}
          </CampoErro>
        ) : (
          <CampoErro acao={acao} chaves={["fornecedorId", "fornecedor"]} label="Fornecedor" className="sm:col-span-4">
            {(m) => (
              <select className={`${inputCls} ${m}`} value={fornecedorId} onChange={(e) => setFornecedorId(e.target.value)}>
                <option value="">Escolha</option>
                {fornecedores.map((f) => (
                  <option key={f.id} value={f.id}>{f.nome}</option>
                ))}
              </select>
            )}
          </CampoErro>
        )}
        <CampoErro acao={acao} chaves={["forma"]} label="Forma de pagamento" className="sm:col-span-2">
          {(m) => (
            <select className={`${inputCls} ${m}`} value={forma} onChange={(e) => setForma(e.target.value)}>
              <option value="">Escolha</option>
              {FORMAS_FINANCEIRO.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          )}
        </CampoErro>
        {noCartao && (
          <CampoErro acao={acao} chaves={["cartaoId"]} label="Cartão corporativo" className="sm:col-span-2">
            {(m) => (
              <select className={`${inputCls} ${m}`} value={cartaoId} onChange={(e) => setCartaoId(e.target.value)}>
                <option value="">{cartoes.length === 0 ? "Nenhum cartão ativo" : "Escolha o cartão"}</option>
                {cartoes.map((k) => (
                  <option key={k.id} value={k.id}>{k.nome} (final {k.final})</option>
                ))}
              </select>
            )}
          </CampoErro>
        )}
        <CampoErro acao={acao} chaves={["vencimento"]} label={noCartao ? "Data da compra" : "Vencimento"} className="sm:col-span-2">
          {(m) => <input type="date" className={`${inputCls} ${m}`} value={vencimento} onChange={(e) => setVencimento(e.target.value)} />}
        </CampoErro>
        <p className="text-[13px] text-cinza sm:col-span-6">
          {total !== null && total > 0n ? (
            <>
              Total <b className="num text-texto">{reais(total)}</b>: entra em Lançamentos como conta a pagar, na categoria {ROTULO_USO[produto.uso]}, centro {filial}.
              {noCartao && " No cartão, a conta vai para a fatura do ciclo da data da compra."}
            </>
          ) : total === 0n ? (
            "Valor 0 (doação, brinde recebido): entra no estoque sem conta a pagar."
          ) : (
            "A compra entra em Lançamentos como conta a pagar, ligada a esta entrada: ela se desfaz aqui, não na lista."
          )}
        </p>
      </div>
      <div className="px-6 pb-2">
        <MsgAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

/** Saída manual (quantidade que sai, ao custo médio) ou ajuste de contagem (quantidade nova da filial), com motivo. */
function DialogoSaidaOuAjuste({ tipo, produto, filialInicial, onFechar }: { tipo: "saida" | "ajuste"; produto: ProdutoLinha; filialInicial: Centro; onFechar: () => void }) {
  const acao = useAcao();
  const [filial, setFilial] = useState<Centro>(filialInicial);
  const [quantidade, setQuantidade] = useState("");
  const [motivo, setMotivo] = useState("");
  const saida = tipo === "saida";
  const tem = filial === "MT" ? produto.mt.quantidade : produto.rs.quantidade;
  const chave = saida ? "quantidade" : "quantidadeNova";

  function salvar() {
    acao.executar(
      () =>
        saida
          ? registrarSaida({ produtoId: produto.id, filial, quantidade: inteiro(quantidade), motivo })
          : ajustarEstoque({ produtoId: produto.id, filial, quantidadeNova: inteiro(quantidade), motivo }),
      onFechar,
    );
  }

  return (
    <Dialogo
      eyebrow={saida ? "Saída de estoque" : "Ajuste de estoque (contagem)"}
      titulo={produto.nome}
      onFechar={onFechar}
      rodape={<Rodape acao={acao} rotulo={saida ? "Registrar saída" : "Ajustar"} onFechar={onFechar} onSalvar={salvar} />}
    >
      <div className="grid grid-cols-1 gap-4 px-6 py-5 sm:grid-cols-2">
        <CampoErro acao={acao} chaves={["filial"]} label="Filial">
          {(m) => (
            <select className={`${inputCls} ${m}`} value={filial} onChange={(e) => setFilial(e.target.value as Centro)}>
              {CENTROS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          )}
        </CampoErro>
        <CampoErro acao={acao} chaves={[chave]} label={saida ? "Quantidade que sai" : "Quantidade contada"}>
          {(m) => <input autoFocus inputMode="numeric" className={`${inputCls} num text-right ${m}`} value={quantidade} onChange={(e) => setQuantidade(e.target.value)} />}
        </CampoErro>
        <p className="text-[13px] text-cinza sm:col-span-2">
          Hoje em {filial}: <b className="num text-texto">{tem}</b>.{" "}
          {saida
            ? "Sai ao custo médio; não gera lançamento."
            : "O movimento guarda a diferença ao custo médio; não gera lançamento."}
        </p>
        <CampoErro acao={acao} chaves={["motivo"]} label="Motivo" className="sm:col-span-2">
          {(m) => (
            <input
              className={`${inputCls} ${m}`}
              value={motivo}
              onChange={(e) => setMotivo(e.target.value)}
              placeholder={saida ? "Ex.: brinde avulso para cliente" : "Ex.: contagem do fim do mês"}
            />
          )}
        </CampoErro>
      </div>
      <div className="px-6 pb-2">
        <MsgAcao acao={acao} />
      </div>
    </Dialogo>
  );
}

/** Movimentos do produto, mais recentes primeiro; a entrada que é o último movimento da filial se desfaz daqui. */
function DialogoHistorico({ nome, movimentos, voltar }: { nome: string; movimentos: MovimentoLinha[]; voltar: string }) {
  const router = useRouter();
  const acao = useAcao();
  const fechar = () => router.push(voltar, { scroll: false });

  function desfazer(m: MovimentoLinha) {
    if (!window.confirm(`Desfazer a entrada de ${m.quantidade} em ${m.filial}? A conta a pagar dela é cancelada e o saldo volta ao de antes.`)) return;
    acao.executar(() => desfazerEntradaDeEstoque(m.id));
  }

  const sinal = (q: number) => (q > 0 ? `+${q}` : `−${-q}`);
  const detalhe = (m: MovimentoLinha) => {
    if (m.viagemId) {
      return (
        <Link href={`/viagens/${m.viagemId}`} className="font-semibold text-verde hover:underline">
          Viagem {m.viagemDestino}
        </Link>
      );
    }
    if (m.tipo === "entrada") return m.fornecedor ? `Comprado em ${m.fornecedor}` : "";
    return m.motivo ?? "";
  };

  return (
    <Dialogo eyebrow="Histórico do estoque" titulo={nome} largura="max-w-[980px]" onFechar={fechar} rodape={<Botao variante="secundario" onClick={fechar}>Fechar</Botao>}>
      <div className="pb-2 pt-3">
        {movimentos.length === 0 ? (
          <p className="px-6 pb-3 text-[14px] text-cinza">Nenhum movimento ainda.</p>
        ) : (
          <Grade
            compacta
            right={[3, 4]}
            head={["Data", "Tipo", "Filial", "Quantidade", "Custo unitário", "Quem", "Motivo ou viagem", ""]}
            rows={movimentos.map((m) => [
              <span key="d" className="num">{dataHora(m.criadoEm)}</span>,
              ROTULO_TIPO[m.tipo],
              m.filial,
              sinal(m.quantidade),
              reais(m.custoUnitario),
              m.usuario,
              <span key="m" className="block max-w-[260px] truncate" title={m.motivo ?? m.fornecedor ?? undefined}>{detalhe(m)}</span>,
              m.desfazivel ? (
                <button key="x" className={link} disabled={acao.pendente} onClick={() => desfazer(m)}>Desfazer entrada</button>
              ) : (
                ""
              ),
            ])}
          />
        )}
        <div className="px-6">
          <MsgAcao acao={acao} />
        </div>
      </div>
    </Dialogo>
  );
}
