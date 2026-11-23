-- Achados da revisão final da fatia 4a (a 0021 não é editada; esta substitui a view com as mesmas 24 colunas, na
-- mesma ordem e tipos):
-- 1. Repasse do cartão direto recebido: `valor_baixado` = valor repassado (o que entrou no banco), não o valor
--    cheio da parcela (que o cliente pagou ao fornecedor). = valor_previsto da linha − coalesce(taxa_efetiva, 0).
-- 2. `cartao_direto` ignora parcela cancelada (cartão direto cancelado: os pagamentos do fornecedor voltam ao caixa
--    e à baixa normal). A mesma condição está em TS em `vendaCartaoDireto` (src/server/financeiro/baixas-viagem.ts);
--    tests/integracao/financeiro.test.ts ("achado 4") fixa as duas no mesmo cenário.
-- security_invoker e o REVOKE são reaplicados.
CREATE OR REPLACE VIEW "lancamentos_financeiros" WITH (security_invoker = true) AS
WITH
  -- Dados da viagem comuns às linhas de viagem. "Cartão direto no fornecedor" é definido só aqui (cartao_direto).
  viagem_info AS NOT MATERIALIZED (
    SELECT
      vi.id AS viagem_id,
      (CASE WHEN vi.filial = 'RS' THEN 'RS' ELSE 'MT' END)::centro_custo AS centro,
      'ECL-' || lpad(cl.codigo::text, greatest(4, length(cl.codigo::text)), '0')
        || '-' || lpad(vi.seq::text, greatest(2, length(vi.seq::text)), '0') AS codigo,
      vi.destino,
      ve.id AS venda_id,
      ve.fatura_nome,
      ve.fornecedor_cartao_id,
      fc.nome AS fornecedor_cartao_nome,
      fa.numero AS fatura_numero,
      EXISTS (
        SELECT 1 FROM parcelas_receber pr
        WHERE pr.venda_id = ve.id AND pr.meio = 'cartao_fornecedor' AND pr.status <> 'cancelada'
      ) AS cartao_direto
    FROM viagens vi
    JOIN clientes cl ON cl.id = vi.cliente_id
    LEFT JOIN vendas ve ON ve.viagem_id = vi.id
    LEFT JOIN fornecedores fc ON fc.id = ve.fornecedor_cartao_id
    LEFT JOIN faturas fa ON fa.venda_id = ve.id
  )

-- Manual: os campos do lançamento.
SELECT
  'manual'::text AS origem,
  l.id,
  l.lado,
  l.vencimento,
  l.competencia,
  l.valor AS valor_previsto,
  l.valor_pago AS valor_baixado,
  l.baixado_em,
  l.status AS status_base,
  l.categoria_id,
  l.centro,
  coalesce(l.baixa_conta_bancaria_id, l.conta_bancaria_id) AS conta_bancaria_id,
  coalesce(f.nome, c.grupo, l.pessoa_texto, '') AS pessoa,
  l.descricao,
  l.parcela_numero,
  l.parcela_total,
  NULL::uuid AS viagem_id,
  NULL::text AS viagem_codigo,
  NULL::integer AS fatura_numero,
  true AS transita_caixa,
  0::bigint AS taxa,
  l.forma::text AS forma,
  false AS exige_individual,
  false AS repasse
FROM lancamentos l
LEFT JOIN fornecedores f ON f.id = l.fornecedor_id
LEFT JOIN clientes c ON c.id = l.cliente_id

UNION ALL

-- Parcela do cliente: Vendas de viagem, pessoa = nome da fatura. Cartão direto no fornecedor: vira "Repasse de
-- <fornecedor>" pelo valor da parcela menos o custo das contas ativas desse fornecedor na viagem (pago em BRL se
-- pago, senão previsto); sem fornecedor escolhido, pede a escolha e exige baixa individual.
SELECT
  'parcela'::text,
  p.id,
  'receber'::lado_financeiro,
  p.vencimento,
  to_char(p.vencimento, 'YYYY-MM'),
  CASE WHEN vi.cartao_direto AND vi.fornecedor_cartao_id IS NOT NULL THEN (p.valor - custo.cartao)::bigint ELSE p.valor END,
  -- Repasse recebido: o que entrou no banco é o valor repassado (esperado − o que o fornecedor reteve a mais).
  (CASE
    WHEN vi.cartao_direto AND vi.fornecedor_cartao_id IS NOT NULL AND p.status = 'recebida'
      THEN p.valor - custo.cartao - coalesce(p.taxa_efetiva, 0)
    ELSE p.valor_recebido
  END)::bigint,
  p.recebida_em,
  (CASE p.status WHEN 'recebida' THEN 'baixado' WHEN 'cancelada' THEN 'cancelado' ELSE 'em_aberto' END)::status_lancamento,
  (SELECT id FROM categorias_financeiras WHERE sistema = 'vendas_viagem'),
  vi.centro,
  p.conta_bancaria_id,
  vi.fatura_nome,
  CASE
    WHEN NOT vi.cartao_direto THEN 'Venda · ' || vi.destino
    WHEN vi.fornecedor_cartao_id IS NULL THEN 'Repasse: escolha o fornecedor na viagem'
    ELSE 'Repasse de ' || vi.fornecedor_cartao_nome
  END,
  p.numero,
  p.total_parcelas,
  p.viagem_id,
  vi.codigo,
  vi.fatura_numero,
  true,
  CASE WHEN p.status = 'recebida' THEN coalesce(p.taxa_efetiva, p.taxa_prevista) ELSE p.taxa_prevista END,
  p.meio::text,
  vi.cartao_direto AND vi.fornecedor_cartao_id IS NULL,
  vi.cartao_direto
FROM parcelas_receber p
JOIN viagem_info vi ON vi.viagem_id = p.viagem_id
CROSS JOIN LATERAL (
  SELECT coalesce(sum(coalesce(CASE WHEN pf.status = 'pago' THEN pf.valor_brl_pago END, pf.valor_brl_previsto)), 0)::bigint AS cartao
  FROM pagamentos_fornecedor pf
  JOIN contas_pagar cp ON cp.id = pf.conta_id
  WHERE vi.cartao_direto
    AND cp.viagem_id = p.viagem_id
    AND cp.fornecedor_id = vi.fornecedor_cartao_id
    AND cp.excluido_em IS NULL
    AND cp.status <> 'cancelada'
) custo

UNION ALL

-- Pagamento a fornecedor: Fornecedores de viagem, pessoa = fornecedor (sem fornecedor, a descrição da conta).
-- Conta cancelada ou excluída: o que está em aberto sai como cancelado. Contas do fornecedor do cartão direto não
-- transitam pelo caixa (quitadas pelo repasse). Moeda estrangeira exige baixa individual (câmbio efetivo).
SELECT
  'pagamento'::text,
  pf.id,
  'pagar'::lado_financeiro,
  pf.vencimento,
  to_char(pf.vencimento, 'YYYY-MM'),
  pf.valor_brl_previsto,
  pf.valor_brl_pago,
  pf.pago_em,
  (CASE
    WHEN pf.status = 'pago' THEN 'baixado'
    WHEN cp.excluido_em IS NOT NULL OR cp.status = 'cancelada' THEN 'cancelado'
    ELSE 'em_aberto'
  END)::status_lancamento,
  (SELECT id FROM categorias_financeiras WHERE sistema = 'fornecedores_viagem'),
  vi.centro,
  pf.conta_bancaria_id,
  coalesce(f.nome, cp.descricao),
  cp.descricao || CASE WHEN z.no_cartao THEN ' (pago pelo cliente no cartão do fornecedor)' ELSE '' END,
  pf.numero,
  (SELECT count(*) FROM pagamentos_fornecedor x WHERE x.conta_id = pf.conta_id)::integer,
  cp.viagem_id,
  vi.codigo,
  vi.fatura_numero,
  NOT z.no_cartao,
  0::bigint,
  -- fecharVenda cria toda conta à vista; a coluna é anulável só por histórico.
  coalesce(cp.forma::text, 'a_vista'),
  cp.moeda <> 'BRL',
  false
FROM pagamentos_fornecedor pf
JOIN contas_pagar cp ON cp.id = pf.conta_id
JOIN viagem_info vi ON vi.viagem_id = cp.viagem_id
LEFT JOIN fornecedores f ON f.id = cp.fornecedor_id
CROSS JOIN LATERAL (
  SELECT coalesce(vi.cartao_direto AND cp.fornecedor_id = vi.fornecedor_cartao_id, false) AS no_cartao
) z

UNION ALL

-- Comissão a receber (a tabela só tem as `a_receber`): Comissões de operadora se o fornecedor tem o tipo
-- "Operadora", senão Comissões de hotel; vence na data prevista. Não recebida ou cancelada sai como cancelado.
SELECT
  'comissao'::text,
  co.id,
  'receber'::lado_financeiro,
  co.prevista_para,
  to_char(co.prevista_para, 'YYYY-MM'),
  co.valor_previsto,
  co.valor_recebido,
  co.recebida_em,
  (CASE
    WHEN co.status = 'recebida' THEN 'baixado'
    WHEN co.status = 'prevista' THEN 'em_aberto'
    ELSE 'cancelado'
  END)::status_lancamento,
  CASE
    WHEN 'Operadora' = ANY (f.tipos) THEN (SELECT id FROM categorias_financeiras WHERE sistema = 'comissoes_operadora')
    ELSE (SELECT id FROM categorias_financeiras WHERE sistema = 'comissoes_hotel')
  END,
  vi.centro,
  co.conta_bancaria_id,
  coalesce(f.nome, cp.descricao),
  'Comissão · ' || cp.descricao,
  NULL::integer,
  NULL::integer,
  co.viagem_id,
  vi.codigo,
  vi.fatura_numero,
  true,
  0::bigint,
  'transferencia',
  false,
  false
FROM comissoes co
JOIN contas_pagar cp ON cp.id = co.conta_id
JOIN viagem_info vi ON vi.viagem_id = co.viagem_id
LEFT JOIN fornecedores f ON f.id = co.fornecedor_id;--> statement-breakpoint
REVOKE ALL ON "lancamentos_financeiros" FROM anon, authenticated;
