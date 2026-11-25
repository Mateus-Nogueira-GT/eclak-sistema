import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { classificarStatus } from "@/domain/integracoes";
import { configIA, type ConfigIA } from "./config";
import { ErroIntegracao, type Buscar } from "./http";

// IA atrás de uma interface (R-C4): as telas e actions falam com `ProvedorIA`; trocar de provedor é trocar o adaptador.
// O adaptador do Claude usa o SDK oficial, com o cliente montado a cada chamada a partir da configuração lida na hora
// (nada em cache, nada lido no import). Erros saem como `ErroIntegracao` (classe e status, nunca a mensagem do SDK,
// que pode trazer o corpo da resposta).

/** Mensagens e ferramentas no formato do SDK (o chat da Task 6 devolve `conteudo` inteiro na volta seguinte). */
export type MensagemIA = Anthropic.Beta.BetaMessageParam;
export type FerramentaIA = Anthropic.Beta.BetaTool;
export type EsforcoIA = "low" | "medium";

export type PedidoIA = {
  sistema: string;
  mensagens: MensagemIA[];
  ferramentas?: FerramentaIA[];
  esforco: EsforcoIA;
  /** Padrão `MAX_TOKENS_IA` (16000): o pensamento conta no limite. */
  maxTokens?: number;
  /** Prazo deste pedido em ms; nunca passa de `PRAZO_IA_MS` (o chat usa para caber no prazo da conversa). */
  prazoMs?: number;
};

export type RespostaIA = {
  /** `refusal`: o modelo (e a cadeia de fallback) recusou; `texto` não deve ser usado. */
  parada: Anthropic.Beta.BetaStopReason | null;
  /** Só os blocos de texto, juntos (pensamento e marcas de fallback ficam de fora). */
  texto: string;
  /** Conteúdo da resposta como veio, para devolver ao modelo sem edição numa conversa com ferramentas. */
  conteudo: Anthropic.Beta.BetaContentBlock[];
  /** Modelo que respondeu (pode ser o de fallback). */
  modelo: string;
  tokensEntrada: number;
  tokensSaida: number;
};

export interface ProvedorIA {
  /** Modelo configurado (o pedido); a resposta traz o que de fato respondeu. */
  readonly modelo: string;
  responder(p: PedidoIA): Promise<RespostaIA>;
}

export const BETA_FALLBACK = "server-side-fallback-2026-07-01";
/**
 * Teto de saída do reescrever e do chat. O modelo sempre pensa e o pensamento conta no limite: com 4000 a resposta
 * cortava (`max_tokens`) antes do texto. 16000 ainda cabe num pedido sem streaming (o SDK só recusa os que passariam
 * de 10 min). O "Testar conexão" pede 256.
 */
export const MAX_TOKENS_IA = 16_000;
/**
 * Chamada interativa (alguém espera na tela). O modelo sempre pensa, então os 15 s das outras integrações não bastam:
 * 60 s por pedido, nenhuma nova tentativa (um 429 com `retry-after` longo não segura a tela) e prazo total de 90 s
 * (`AbortSignal.timeout`, que cobre também a leitura da resposta). Ou seja, ninguém espera mais de 90 s; estourado o
 * prazo, o erro é `rede`.
 */
export const TIMEOUT_IA_MS = 60_000;
export const PRAZO_IA_MS = 90_000;

function classeDoErro(e: unknown): ErroIntegracao {
  if (e instanceof ErroIntegracao) return e;
  // Antes de APIError: a falha de conexão (e o timeout) é um APIError sem status.
  if (e instanceof Anthropic.APIConnectionError) return new ErroIntegracao("rede", null);
  // Prazo total estourado (o sinal de `AbortSignal.timeout` abortou o pedido): também é `rede`.
  if (e instanceof Anthropic.APIUserAbortError) return new ErroIntegracao("rede", null);
  // O sinal abortou durante a leitura do corpo (cabeçalhos já chegaram): o SDK repassa o erro cru do stream.
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return new ErroIntegracao("rede", null);
  if (e instanceof Anthropic.APIError && typeof e.status === "number") return new ErroIntegracao(classificarStatus(e.status), e.status);
  return new ErroIntegracao("servidor", null);
}

/** Adaptador do Claude. `fetch` injetável (testes e "Testar conexão"). */
export function provedorClaude(cfg: ConfigIA, opcoes: { fetch?: Buscar; timeoutMs?: number; prazoMs?: number } = {}): ProvedorIA {
  return {
    modelo: cfg.modelo,
    async responder(p) {
      const cliente = new Anthropic({
        apiKey: cfg.apiKey,
        // Com `apiKey` passado aqui, o SDK já ignora as credenciais do ambiente; `authToken: null` só deixa isso
        // explícito. `ANTHROPIC_BASE_URL` e `ANTHROPIC_CUSTOM_HEADERS` do ambiente continuam valendo (a configuração
        // não tem base URL própria; o teste no navegador usa isso para apontar a um servidor falso local).
        authToken: null,
        fetch: opcoes.fetch,
        maxRetries: 0,
        timeout: opcoes.timeoutMs ?? TIMEOUT_IA_MS,
      });
      let r: Anthropic.Beta.BetaMessage;
      try {
        // Sem `thinking` (no Opus 5.5 ele está sempre ligado; desligar dá 400), sem temperatura e sem prefill: a
        // profundidade vem de `effort`. `fallbacks: "default"` refaz no servidor um pedido recusado por política.
        r = await cliente.beta.messages.create(
          {
            model: cfg.modelo,
            max_tokens: p.maxTokens ?? MAX_TOKENS_IA,
            betas: [BETA_FALLBACK],
            fallbacks: "default",
            output_config: { effort: p.esforco },
            system: p.sistema,
            messages: p.mensagens,
            ...(p.ferramentas?.length ? { tools: p.ferramentas, tool_choice: { type: "auto" as const } } : {}),
          },
          { signal: AbortSignal.timeout(Math.min(p.prazoMs ?? PRAZO_IA_MS, opcoes.prazoMs ?? PRAZO_IA_MS)) },
        );
      } catch (e) {
        const erro = classeDoErro(e);
        // Só a classe e o status (a mensagem do SDK pode ecoar o corpo da resposta).
        console.error("Falha na IA", { classe: erro.classe, status: erro.status });
        throw erro;
      }
      const u = r.usage;
      // Com server-side fallback, blocos anteriores ao último marcador `fallback` pertencem à tentativa descartada.
      let corte = -1;
      for (let i = r.content.length - 1; i >= 0; i--) {
        if ((r.content[i] as { type?: string }).type === "fallback") {
          corte = i;
          break;
        }
      }
      const ativos = corte >= 0 ? r.content.slice(corte + 1) : r.content;
      return {
        parada: r.stop_reason,
        texto: r.stop_reason === "refusal" ? "" : ativos.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(""),
        conteudo: r.content,
        modelo: r.model,
        tokensEntrada: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        tokensSaida: u.output_tokens,
      };
    },
  };
}

let substituto: ProvedorIA | null = null;

/** Só em testes: um provedor falso no lugar do Claude (null volta ao normal). */
export function definirProvedorIAParaTestes(p: ProvedorIA | null): void {
  if (process.env.NODE_ENV === "production") throw new Error("Só em testes");
  substituto = p;
}

/** Provedor da IA, ou null quando desligada (sem `ANTHROPIC_API_KEY`). Configuração lida na chamada. */
export function provedorIA(): ProvedorIA | null {
  if (substituto) return substituto;
  const cfg = configIA();
  return cfg ? provedorClaude(cfg) : null;
}

/** "Testar conexão": um pedido mínimo; qualquer resposta 200 conta como funcionando (o texto não importa). */
export async function testarIA(cfg: ConfigIA, buscar: Buscar): Promise<{ ok: true } | { ok: false; classe: ErroIntegracao["classe"] }> {
  try {
    await provedorClaude(cfg, { fetch: buscar }).responder({
      sistema: "Responda apenas: ok",
      mensagens: [{ role: "user", content: "Teste de conexão." }],
      esforco: "low",
      maxTokens: 256,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, classe: classeDoErro(e).classe };
  }
}
