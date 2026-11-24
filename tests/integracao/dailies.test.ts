import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/supabase", async () => (await import("../helpers/db")).mockSupabase());
import { ENCERRAMENTO_INICIAL } from "@/domain/regras";
import type { ConteudoRoteiro, HotelRoteiro } from "@/domain/roteiro";
import { db } from "@/server/db/client";
import { auditoria, dailies, roteiros, usuarios } from "@/server/db/schema";
import { salvarRegras } from "@/server/actions/regras";
import { aprovarRoteiro, criarRoteiro, salvarRoteiro } from "@/server/actions/roteiros";
import {
  desfazerEnvio,
  gerarDaily,
  marcarEnviado,
  marcarRevisado,
  salvarInterno,
  salvarTextoDaily,
} from "@/server/actions/dailies";
import { dailiesDaViagem, listarDailies, roteiroDaViagem } from "@/server/queries/operacao";
import { regrasVigentes } from "@/server/queries/regras";
import { comSessao, criarUsuarioTeste, limparBanco } from "../helpers/db";
import { vendida, type Fixture } from "../helpers/venda";

const CONFLITO = { ok: false, conflito: true, erro: "Este daily foi alterado por outra pessoa. Recarregue a página." };
const JA_ENVIADO = { ok: false, erro: "Daily já enviado: desfaça o envio para editar" };
const NOVO_ENCERRAMENTO = "Boa viagem!\nEquipe ECLAK Viagens";

const hoteis: HotelRoteiro[] = [
  { cidade: "Veneza", nome: "Palazzo Barocci", entrada: "2027-08-14", saida: "2027-08-16", horaCheckin: null, horaCheckout: "11:00", mapa: null },
  {
    cidade: "Florença",
    nome: "Orto de' Medici",
    entrada: "2027-08-16",
    saida: "2027-08-19",
    horaCheckin: "16:00",
    horaCheckout: null,
    mapa: "https://maps.google.com/?q=Orto+de+Medici+Firenze",
  },
];

let f: Fixture;
let op: { id: string };
let roteiroId: string;

beforeEach(async () => {
  await limparBanco();
  f = await vendida();
  op = await criarUsuarioTeste("operacional");
  const c = await comSessao(op.id, () => criarRoteiro(f.viagemId, { idioma: "italiano", fuso: "Europe/Rome" }));
  if (!c.ok || !("id" in c)) throw new Error(c.ok ? "sem id" : c.erro);
  roteiroId = c.id;
  await salvarConteudo((cont) => ({
    ...cont,
    hoteis,
    dias: cont.dias.map((d) =>
      d.data === "2027-08-16"
        ? {
            ...d,
            itens: [
              {
                hora: "13:26",
                titulo: "Partida do trem de alta velocidade para Florença, da estação Venezia Santa Lucia",
                texto: "Recomendamos chegar com 30 minutos de antecedência.",
                mapa: null,
              },
              { hora: "16:00", titulo: "Check-in no Orto de' Medici", texto: "", mapa: null },
            ],
          }
        : d.data === "2027-08-17"
          ? { ...d, itens: [{ hora: "10:00", titulo: "Galleria degli Uffizi", texto: "", mapa: null }] }
          : d,
    ),
  }));
});

afterEach(() => {
  vi.useRealTimers();
});

async function salvarConteudo(fn: (c: ConteudoRoteiro) => ConteudoRoteiro) {
  const r = (await comSessao(op.id, () => roteiroDaViagem(f.viagemId)))!.roteiro!;
  const s = await comSessao(op.id, () =>
    salvarRoteiro(r.id, { idioma: r.idioma, fuso: r.fuso, abertura: r.abertura, conteudo: fn(r.conteudo) }, r.atualizadoEm),
  );
  if (!s.ok) throw new Error(s.erro);
}

async function tela(uid = op.id) {
  const t = await comSessao(uid, () => dailiesDaViagem(f.viagemId));
  if (!t) throw new Error("sem viagem");
  return t;
}
const dia = async (data: string, uid = op.id) => (await tela(uid)).dias.find((d) => d.data === data)!;

async function gerar(data = "2027-08-16", uid = op.id, esperado?: string) {
  const r = await comSessao(uid, () => gerarDaily(roteiroId, data, esperado));
  if (!r.ok) throw new Error(r.erro);
  return r;
}

describe("gerar", () => {
  it("espera um salvarRoteiro em andamento (lê o roteiro for share) e gera com o conteúdo novo", async () => {
    // Já regenera a regra vigente antes, para gerarDaily não abrir outra transação no meio do teste.
    await comSessao(op.id, () => regrasVigentes());
    let pronto = false;
    let geracao!: Promise<unknown>;
    await db.transaction(async (tx) => {
      const [r] = await tx.select().from(roteiros).where(eq(roteiros.id, roteiroId)).for("update");
      geracao = gerar().then(() => (pronto = true));
      await new Promise((ok) => setTimeout(ok, 400));
      expect(pronto).toBe(false);
      const conteudo = {
        ...r.conteudo,
        dias: r.conteudo.dias.map((d) => (d.data === "2027-08-16" ? { ...d, itens: [{ hora: "09:00", titulo: "Visita à Accademia", texto: "", mapa: null }] } : d)),
      };
      await tx.update(roteiros).set({ conteudo, atualizadoEm: new Date() }).where(eq(roteiros.id, roteiroId));
    });
    await geracao;
    expect(pronto).toBe(true);
    const d = await dia("2027-08-16");
    expect(d.daily?.texto).toContain("Visita à Accademia");
    expect(d.roteiroMudou).toBe(false);
  });

  it("monta o texto do modelo, estado 'Gerado, a revisar' e os 6 indicadores ok", async () => {
    const antes = await dia("2027-08-16");
    expect(antes.daily).toBeNull();
    expect(antes.indicadores).toBeNull();
    expect(antes).toMatchObject({ troca: true, cidade: "Florença", dataEnvio: "2027-08-15" });
    const r = await gerar();
    expect(r.id).toBeTruthy();
    const d = await dia("2027-08-16");
    expect(d.daily!.texto!.startsWith("Buongiorno, Marcos e Júlia!\n\nProgramação de amanhã, segunda-feira, 16/08.")).toBe(true);
    expect(d.daily!.texto!.endsWith(ENCERRAMENTO_INICIAL)).toBe(true);
    expect(d.daily!.estado).toBe("gerado");
    expect(d.estado.rotulo).toBe("Gerado, a revisar");
    expect(d.indicadores).toHaveLength(6);
    expect(d.indicadores!.every((i) => i.ok)).toBe(true);
    expect(d.roteiroMudou).toBe(false);
    expect((await tela()).encerramento).toBe(ENCERRAMENTO_INICIAL);
    const aud = await db.select().from(auditoria).where(eq(auditoria.registroId, r.id));
    expect(aud.map((a) => [a.tabela, a.acao])).toEqual([["dailies", "criar"]]);
  });

  it("Review Focus 4: com o encerramento alterado em Parâmetros, o daily novo passa no indicador 6", async () => {
    await gerar();
    const v = await comSessao(f.d.id, () => regrasVigentes());
    const s = await comSessao(f.d.id, () => salvarRegras({ ...v.valores, encerramentoDaily: NOVO_ENCERRAMENTO }));
    expect(s.ok).toBe(true);
    const t = await tela();
    expect(t.encerramento).toBe(NOVO_ENCERRAMENTO);
    const antigo = t.dias.find((d) => d.data === "2027-08-16")!;
    expect(antigo.indicadores![5]).toMatchObject({ nome: "Encerramento padrão da ECLAK", ok: false });
    await gerar("2027-08-17");
    const novo = await dia("2027-08-17");
    expect(novo.daily!.texto!.endsWith(NOVO_ENCERRAMENTO)).toBe(true);
    expect(novo.indicadores![5].ok).toBe(true);
  });

  it("gerar de novo exige o atualizadoEm; antes de D-2 também gera (D26); fora do roteiro recusa", async () => {
    const r = await gerar();
    expect(await comSessao(op.id, () => gerarDaily(roteiroId, "2027-08-16"))).toEqual(CONFLITO);
    expect(await comSessao(op.id, () => gerarDaily(roteiroId, "2027-08-16", "2020-01-01T00:00:00.000Z"))).toEqual(CONFLITO);
    const de = await comSessao(op.id, () => gerarDaily(roteiroId, "2027-08-16", r.atualizadoEm));
    expect(de.ok).toBe(true);
    expect(await comSessao(op.id, () => gerarDaily(roteiroId, "2027-09-02"))).toEqual({ ok: false, erro: "Dia fora do roteiro" });
    expect(await comSessao(op.id, () => gerarDaily("00000000-0000-4000-8000-000000000000", "2027-08-16"))).toEqual({
      ok: false,
      erro: "Crie o roteiro antes dos dailies",
    });
  });
});

describe("estados", () => {
  it("duas gerações simultâneas do mesmo dia novo: uma cria, a outra é conflito", async () => {
    const rs = await comSessao(op.id, () => Promise.all([gerarDaily(roteiroId, "2027-08-18"), gerarDaily(roteiroId, "2027-08-18")]));
    expect(rs.filter((x) => x.ok)).toHaveLength(1);
    expect(rs.filter((x) => !x.ok)).toEqual([CONFLITO]);
    expect(await db.select().from(dailies).where(eq(dailies.data, "2027-08-18"))).toHaveLength(1);
  });

  it("revisado, enviado (com quem), edição recusada, desfazer envio", async () => {
    const g = await gerar();
    const s = await comSessao(op.id, () => salvarTextoDaily(g.id, "Buongiorno!\n\nTexto novo", g.atualizadoEm));
    expect(s.ok).toBe(true);
    expect((await dia("2027-08-16")).estado.rotulo).toBe("Gerado, a revisar");
    expect(await comSessao(op.id, () => marcarRevisado(g.id))).toEqual({ ok: true });
    expect((await dia("2027-08-16")).estado.rotulo).toBe("Pronto para enviar");
    // Salvar o texto revisado mantém "Pronto para enviar" (D17).
    const atual = (await dia("2027-08-16")).daily!.atualizadoEm;
    expect((await comSessao(op.id, () => salvarTextoDaily(g.id, "Buongiorno!\n\nTexto revisado", atual))).ok).toBe(true);
    expect((await dia("2027-08-16")).estado.rotulo).toBe("Pronto para enviar");

    // fin_operacional marca enviado.
    expect(await comSessao(f.fin.id, () => marcarEnviado(g.id))).toEqual({ ok: true });
    const e = await dia("2027-08-16");
    expect(e.estado.rotulo).toBe("Enviado");
    expect(e.daily!.enviadoPor).toBe("Teste fin_operacional");
    expect(e.daily!.enviadoEm).not.toBeNull();
    expect(await comSessao(op.id, () => salvarTextoDaily(g.id, "Outro", e.daily!.atualizadoEm))).toEqual(JA_ENVIADO);
    expect(await comSessao(op.id, () => gerarDaily(roteiroId, "2027-08-16", e.daily!.atualizadoEm))).toEqual(JA_ENVIADO);

    expect(await comSessao(op.id, () => desfazerEnvio(g.id))).toEqual({ ok: true });
    const d = await dia("2027-08-16");
    expect(d.estado.rotulo).toBe("Pronto para enviar");
    expect(d.daily!.enviadoEm).toBeNull();
    expect(d.daily!.enviadoPor).toBeNull();
  });

  it("concorrência: salvar com atualizadoEm velho → conflito", async () => {
    const g = await gerar();
    const s = await comSessao(op.id, () => salvarTextoDaily(g.id, "Buongiorno!\n\nA", g.atualizadoEm));
    expect(s.ok).toBe(true);
    expect(await comSessao(op.id, () => salvarTextoDaily(g.id, "Buongiorno!\n\nB", g.atualizadoEm))).toEqual(CONFLITO);
    const [linha] = await db.select().from(dailies).where(eq(dailies.id, g.id));
    expect(linha.texto).toBe("Buongiorno!\n\nA");
  });

  it("texto vazio ou longo demais é recusado", async () => {
    const g = await gerar();
    expect(await comSessao(op.id, () => salvarTextoDaily(g.id, "   ", g.atualizadoEm))).toMatchObject({ ok: false, erro: "Escreva a mensagem" });
    expect(await comSessao(op.id, () => salvarTextoDaily(g.id, "x".repeat(8001), g.atualizadoEm))).toMatchObject({
      ok: false,
      erro: "Texto muito longo",
    });
  });

  it("roteiroMudou: aprovar não muda; salvar o conteúdo muda", async () => {
    await gerar();
    expect((await comSessao(op.id, () => aprovarRoteiro(roteiroId))).ok).toBe(true);
    expect((await dia("2027-08-16")).roteiroMudou).toBe(false);
    await salvarConteudo((c) => ({ ...c, dias: c.dias.map((d) => (d.data === "2027-08-20" ? { ...d, titulo: "Siena" } : d)) }));
    expect((await dia("2027-08-16")).roteiroMudou).toBe(true);
  });
});

describe("interno", () => {
  it("salvar antes de gerar cria pendente; revisar recusa; gerar mantém o interno", async () => {
    const s = await comSessao(op.id, () => salvarInterno(roteiroId, "2027-08-16", { plantaoId: f.u.id, interno: "Localizador ABC123" }));
    if (!s.ok) throw new Error(s.erro);
    const p = await dia("2027-08-16");
    expect(p.daily).toMatchObject({ estado: "pendente", texto: null, interno: "Localizador ABC123", plantao: { id: f.u.id, nome: "Teste consultor" } });
    expect(p.estado.rotulo).not.toBe("Gerado, a revisar");
    expect(p.indicadores).toBeNull();
    expect(await comSessao(op.id, () => marcarRevisado(s.id))).toEqual({ ok: false, erro: "Gere o texto antes de marcar como revisado" });
    expect(await comSessao(op.id, () => marcarEnviado(s.id))).toEqual({ ok: false, erro: "Gere o texto antes de marcar como enviado" });

    // Linha existente: salvar de novo exige o atualizadoEm.
    expect(await comSessao(op.id, () => salvarInterno(roteiroId, "2027-08-16", { plantaoId: null, interno: "" }))).toEqual(CONFLITO);
    const g = await gerar("2027-08-16", op.id, s.atualizadoEm);
    expect(g.id).toBe(s.id);
    expect((await dia("2027-08-16")).daily).toMatchObject({ estado: "gerado", interno: "Localizador ABC123", plantao: { id: f.u.id } });
  });

  it("plantão precisa ser usuário ativo; fora do roteiro recusa", async () => {
    const inativo = await criarUsuarioTeste("consultor", { ativo: false });
    expect(await comSessao(op.id, () => salvarInterno(roteiroId, "2027-08-16", { plantaoId: inativo.id, interno: "" }))).toMatchObject({
      ok: false,
      erro: "Escolha um usuário ativo para o plantão",
    });
    expect(await comSessao(op.id, () => salvarInterno(roteiroId, "2027-09-02", { plantaoId: null, interno: "" }))).toEqual({
      ok: false,
      erro: "Dia fora do roteiro",
    });
  });

  it("plantão que ficou inativo e não mudou não impede salvar; trocar para inativo recusa", async () => {
    const plantao = await criarUsuarioTeste("consultor");
    const s = await comSessao(op.id, () => salvarInterno(roteiroId, "2027-08-16", { plantaoId: plantao.id, interno: "" }));
    if (!s.ok) throw new Error(s.erro);
    await db.update(usuarios).set({ ativo: false }).where(eq(usuarios.id, plantao.id));
    const s2 = await comSessao(op.id, () =>
      salvarInterno(roteiroId, "2027-08-16", { plantaoId: plantao.id, interno: "Localizador XYZ789" }, s.atualizadoEm),
    );
    if (!s2.ok) throw new Error(s2.erro);
    expect((await dia("2027-08-16")).daily).toMatchObject({ interno: "Localizador XYZ789", plantao: { id: plantao.id } });

    const outroInativo = await criarUsuarioTeste("consultor", { ativo: false });
    expect(
      await comSessao(op.id, () => salvarInterno(roteiroId, "2027-08-16", { plantaoId: outroInativo.id, interno: "" }, s2.atualizadoEm)),
    ).toMatchObject({ ok: false, erro: "Escolha um usuário ativo para o plantão" });
  });

  it("horários do item convertidos para Mato Grosso e Brasília (Europe/Rome)", async () => {
    const d = await dia("2027-08-16");
    expect(d.horarios[0]).toEqual({ hora: "13:26", titulo: expect.stringContaining("Partida do trem"), destino: "13h26", mt: "07h26", brasilia: "08h26" });
    expect(d.horarios).toHaveLength(2);
  });
});

describe("listas e perfis", () => {
  it("listarDailies: de hoje até hoje + 3, com o estado; consultor e operacional sem nada estratégico", async () => {
    await gerar("2027-08-16", f.u.id);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-08-15T15:00:00Z"));
    const l = await comSessao(op.id, () => listarDailies());
    const t = await comSessao(f.u.id, () => dailiesDaViagem(f.viagemId));
    vi.useRealTimers();
    expect(l.map((x) => x.data)).toEqual(["2027-08-15", "2027-08-16", "2027-08-17", "2027-08-18"]);
    expect(l[0].viagem).toMatchObject({ id: f.viagemId, cliente: "Família Souza" });
    expect(l[0].viagem.codigo).toMatch(/^ECL-\d{4}-01$/);
    expect(l[1].estado.rotulo).toBe("Gerado, a revisar");
    expect(l[2].estado.rotulo).toBe("A gerar");
    for (const json of [JSON.stringify(l), JSON.stringify(t)]) {
      for (const proibido of ["valorBrl", "valorOriginal", "margem", "custo", "comissao"]) expect(json).not.toContain(`"${proibido}":`);
    }
  });

  it("dias antes de D-2 aparecem como 'Gera em dd/mm'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-08-01T15:00:00Z"));
    const d = await dia("2027-08-20");
    vi.useRealTimers();
    expect(d.estado).toMatchObject({ rotulo: "Gera em 18/08", tom: "cinza" });
  });
});
