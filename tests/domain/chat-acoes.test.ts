import { describe, expect, it } from "vitest";
import {
  ENTRADAS_ACAO,
  EXECUTANDO_PRESO_MIN,
  linhasDaAcao,
  MAX_ANEXOS_ESPERANDO,
  MAX_PROPOSTAS_POR_PERGUNTA,
  MSG_TAMANHO_ANEXO_CHAT,
  nomeNoDrive,
  prazoParaUtc,
  resumoDaAcao,
  semAcento,
  SITUACOES_ACAO_CHAT,
  TAMANHO_MAXIMO_ANEXO_CHAT,
  TIPOS_ACAO_CHAT,
  tituloDaAcao,
  VALIDADE_ANEXO_MIN,
  VALIDADE_PROPOSTA_MIN,
} from "@/domain/chat-acoes";

describe("constantes de chat-acoes", () => {
  it("limites e enums seguem o spec", () => {
    expect(TIPOS_ACAO_CHAT).toEqual([
      "trello_comentar",
      "trello_marcar_item",
      "trello_adicionar_item",
      "trello_mover_cartao",
      "trello_definir_prazo",
      "trello_criar_cartao",
      "drive_enviar_arquivo",
      "drive_criar_pasta",
      "drive_renomear",
      "drive_mover",
    ]);
    expect(SITUACOES_ACAO_CHAT).toEqual(["pendente", "executando", "feita", "falhou", "cancelada", "expirada"]);
    expect(VALIDADE_PROPOSTA_MIN).toBe(15);
    expect(VALIDADE_ANEXO_MIN).toBe(60);
    expect(EXECUTANDO_PRESO_MIN).toBe(2);
    expect(MAX_PROPOSTAS_POR_PERGUNTA).toBe(3);
    expect(MAX_ANEXOS_ESPERANDO).toBe(3);
    expect(TAMANHO_MAXIMO_ANEXO_CHAT).toBe(5 * 1024 * 1024);
    expect(MSG_TAMANHO_ANEXO_CHAT).toBe("O arquivo passa de 5 MB");
  });
});

describe("nomeNoDrive", () => {
  it("apara espaços e aceita nome válido", () => {
    expect(nomeNoDrive("  Voucher.pdf ")).toBe("Voucher.pdf");
    expect(nomeNoDrive("Hotel Roma — 2026.pdf")).toBe("Hotel Roma — 2026.pdf");
  });

  it.each(["a/b", "a\\b", "", "   ", "a\u0000", "a\nb", "a\tb", "a\u007fb", ".", ".."])(
    "recusa %j",
    (valor) => {
      expect(nomeNoDrive(valor)).toBeNull();
    },
  );
});

describe("prazoParaUtc", () => {
  it("converte data ISO para 12h de Cuiabá (UTC-4)", () => {
    expect(prazoParaUtc("2026-12-01")).toBe("2026-12-01T16:00:00.000Z");
    expect(prazoParaUtc("2027-08-14")).toBe("2027-08-14T16:00:00.000Z");
  });
});

describe("semAcento", () => {
  it("remove diacríticos e passa para minúsculas", () => {
    expect(semAcento("Emissão")).toBe("emissao");
    expect(semAcento("Coração — Rondonópolis")).toBe("coracao — rondonopolis");
  });
});

describe("ENTRADAS_ACAO", () => {
  it("trello_comentar recusa texto vazio, texto com 2.001 caracteres e chave extra", () => {
    expect(ENTRADAS_ACAO.trello_comentar.safeParse({ cartao: "ECL-0021-01", texto: "Voucher chegou" }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_comentar.safeParse({ cartao: "ECL-0021-01", texto: "" }).success).toBe(false);
    expect(ENTRADAS_ACAO.trello_comentar.safeParse({ cartao: "ECL-0021-01", texto: "   " }).success).toBe(false);
    expect(ENTRADAS_ACAO.trello_comentar.safeParse({ cartao: "ECL-0021-01", texto: "a".repeat(2000) }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_comentar.safeParse({ cartao: "ECL-0021-01", texto: "a".repeat(2001) }).success).toBe(false);
    expect(ENTRADAS_ACAO.trello_comentar.safeParse({ cartao: "ECL-0021-01", texto: "ok", extra: 1 }).success).toBe(false);
  });

  it("trello_definir_prazo aceita '' e '2026-12-01', recusa '01/12/2026' e data inexistente", () => {
    expect(ENTRADAS_ACAO.trello_definir_prazo.safeParse({ cartao: "ECL-0021-01", prazo: "" }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_definir_prazo.safeParse({ cartao: "ECL-0021-01", prazo: "2026-12-01" }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_definir_prazo.safeParse({ cartao: "ECL-0021-01", prazo: "01/12/2026" }).success).toBe(false);
    expect(ENTRADAS_ACAO.trello_definir_prazo.safeParse({ cartao: "ECL-0021-01", prazo: "2026-02-30" }).success).toBe(false);
  });

  it("valida as demais ações e recusa chaves extras", () => {
    expect(ENTRADAS_ACAO.trello_marcar_item.safeParse({ cartao: "c1", item: "i1", feito: true }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_adicionar_item.safeParse({ cartao: "c1", checklist: "k1", nome: "Comprar seguro" }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_adicionar_item.safeParse({ cartao: "c1", checklist: "k1", nome: "a".repeat(201) }).success).toBe(false);
    expect(ENTRADAS_ACAO.trello_mover_cartao.safeParse({ cartao: "c1", lista: "l1" }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_criar_cartao.safeParse({ lista: "", nome: "Ligar hotel", descricao: "" }).success).toBe(true);
    expect(ENTRADAS_ACAO.trello_criar_cartao.safeParse({ lista: "", nome: "x", descricao: "d".repeat(2001) }).success).toBe(false);
    expect(ENTRADAS_ACAO.drive_enviar_arquivo.safeParse({ viagem: "ECL-0001-01", anexo: "a1", destino: "publico", nome: "" }).success).toBe(true);
    expect(ENTRADAS_ACAO.drive_enviar_arquivo.safeParse({ viagem: "ECL-0001-01", anexo: "a1", destino: "interno" }).success).toBe(true);
    expect(ENTRADAS_ACAO.drive_criar_pasta.safeParse({ viagem: "ECL-0001-01", dentroDe: "publico", nome: "Vouchers" }).success).toBe(true);
    expect(ENTRADAS_ACAO.drive_criar_pasta.safeParse({ viagem: "ECL-0001-01", dentroDe: "publico", nome: "a".repeat(121) }).success).toBe(false);
    expect(ENTRADAS_ACAO.drive_criar_pasta.safeParse({ viagem: "ECL-0001-01", dentroDe: "publico", nome: "a/b" }).success).toBe(false);
    expect(ENTRADAS_ACAO.drive_renomear.safeParse({ arquivo: "f1", nome: "Novo.pdf" }).success).toBe(true);
    expect(ENTRADAS_ACAO.drive_renomear.safeParse({ arquivo: "f1", nome: "a\\b" }).success).toBe(false);
    expect(ENTRADAS_ACAO.drive_mover.safeParse({ arquivo: "f1", destino: "interno" }).success).toBe(true);
    expect(ENTRADAS_ACAO.drive_mover.safeParse({ arquivo: "f1", destino: "interno", extra: true }).success).toBe(false);
  });
});

describe("tituloDaAcao, linhasDaAcao e resumoDaAcao", () => {
  it("monta linhas da confirmação para trello_mover_cartao", () => {
    expect(
      linhasDaAcao(
        "trello_mover_cartao",
        { cartao: "ECL-0021-01 · Casal Vasconcelos", de: "Emissão", para: "Concluído" },
        {},
      ),
    ).toEqual([
      ["Cartão", "ECL-0021-01 · Casal Vasconcelos"],
      ["De", "Emissão"],
      ["Para", "Concluído"],
    ]);
  });

  it("monta título, linhas e resumo para todas as 10 ações", () => {
    expect(tituloDaAcao("trello_comentar")).toBe("Comentar no cartão");
    expect(tituloDaAcao("trello_mover_cartao")).toBe("Mover cartão");
    expect(linhasDaAcao("trello_comentar", { cartao: "ECL-0021-01" }, { texto: "Voucher chegou" })).toEqual([
      ["Cartão", "ECL-0021-01"],
      ["Comentário", "Voucher chegou"],
    ]);
    expect(resumoDaAcao("trello_comentar", { cartao: "ECL-0021-01" })).toBe("Comentário publicado no cartão ECL-0021-01");

    expect(
      linhasDaAcao("trello_marcar_item", { cartao: "ECL-0021-01", checklist: "Tarefas da venda", item: "Emitir seguro" }, { feito: true }),
    ).toEqual([
      ["Cartão", "ECL-0021-01"],
      ["Checklist", "Tarefas da venda"],
      ["Item", "Emitir seguro"],
      ["Marcar como", "Concluído"],
    ]);

    expect(
      linhasDaAcao("trello_adicionar_item", { cartao: "ECL-0021-01", checklist: "Tarefas da venda" }, { nome: "Conferir transfer" }),
    ).toEqual([
      ["Cartão", "ECL-0021-01"],
      ["Checklist", "Tarefas da venda"],
      ["Novo item", "Conferir transfer"],
    ]);

    expect(linhasDaAcao("trello_definir_prazo", { cartao: "ECL-0021-01", prazoAtual: "" }, { prazo: "2026-12-01" })).toEqual([
      ["Cartão", "ECL-0021-01"],
      ["Prazo atual", "Sem prazo"],
      ["Novo prazo", "01/12/2026"],
    ]);
    expect(linhasDaAcao("trello_definir_prazo", { cartao: "ECL-0021-01", prazoAtual: "01/12/2026" }, { prazo: "" })).toEqual([
      ["Cartão", "ECL-0021-01"],
      ["Prazo atual", "01/12/2026"],
      ["Novo prazo", "Sem prazo"],
    ]);

    expect(linhasDaAcao("trello_criar_cartao", { lista: "Emissão" }, { nome: "Ligar hotel", descricao: "Confirmar berço" })).toEqual([
      ["Lista", "Emissão"],
      ["Nome", "Ligar hotel"],
      ["Descrição", "Confirmar berço"],
    ]);

    expect(
      linhasDaAcao("drive_enviar_arquivo", { viagem: "ECL-0021-01", pasta: "Público", tamanho: "120 KB" }, { nome: "voucher.pdf" }),
    ).toEqual([
      ["Viagem", "ECL-0021-01"],
      ["Pasta", "Público"],
      ["Arquivo", "voucher.pdf"],
      ["Tamanho", "120 KB"],
    ]);

    expect(linhasDaAcao("drive_criar_pasta", { viagem: "ECL-0021-01", dentroDe: "Público" }, { nome: "Vouchers" })).toEqual([
      ["Viagem", "ECL-0021-01"],
      ["Dentro de", "Público"],
      ["Nova pasta", "Vouchers"],
    ]);

    expect(linhasDaAcao("drive_renomear", { viagem: "ECL-0021-01", arquivo: "doc.pdf" }, { nome: "voucher-roma.pdf" })).toEqual([
      ["Viagem", "ECL-0021-01"],
      ["Arquivo", "doc.pdf"],
      ["Novo nome", "voucher-roma.pdf"],
    ]);

    expect(
      linhasDaAcao("drive_mover", { viagem: "ECL-0021-01", arquivo: "voucher.pdf", de: "Uso interno", para: "Público" }, {}),
    ).toEqual([
      ["Viagem", "ECL-0021-01"],
      ["Arquivo", "voucher.pdf"],
      ["De", "Uso interno"],
      ["Para", "Público"],
    ]);

    for (const tipo of TIPOS_ACAO_CHAT) {
      expect(tituloDaAcao(tipo).length).toBeGreaterThan(0);
      expect(resumoDaAcao(tipo, { cartao: "ECL-0021-01", lista: "Emissão", viagem: "ECL-0021-01", pasta: "Público", dentroDe: "Público", para: "Público" }).length).toBeGreaterThan(0);
    }
  });
});
