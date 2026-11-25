#!/usr/bin/env node
// Servidor falso local para verificação visual do agente do chat (Trello, Google Drive, Token do Google e Anthropic).
// Fora do build. Escuta só em 127.0.0.1 (porta padrão 4010). Nunca chama serviços reais.

import { createServer } from "node:http";

const PORTA = Number(process.env.PORT ?? 4010);
const CODIGO_PADRAO = process.env.VIAGEM_TESTE ?? "ECL-0001-01";
const CARTAO_ID = "card-falso-1";
const PASTA_VIAGEM_ID = "pasta-viagem-1";
const PUBLICO_ID = "pub-falso-1";
const INTERNO_ID = "int-falso-1";

const listas = [
  { id: "lista-op", name: "Operações" },
  { id: "lista-em", name: "Emissão" },
  { id: "lista-ok", name: "Concluído" },
];

const arvoreDrive = {
  "raiz-falsa": { id: "raiz-falsa", name: "Viagens ECLAK", mimeType: "application/vnd.google-apps.folder", parents: [] },
  [PASTA_VIAGEM_ID]: {
    id: PASTA_VIAGEM_ID,
    name: "ECL-0001_RIBEIRO_ITALIA_20270814-20270901",
    mimeType: "application/vnd.google-apps.folder",
    parents: ["raiz-falsa"],
    webViewLink: `https://drive.google.com/drive/folders/${PASTA_VIAGEM_ID}`,
  },
  [PUBLICO_ID]: {
    id: PUBLICO_ID,
    name: "Público",
    mimeType: "application/vnd.google-apps.folder",
    parents: [PASTA_VIAGEM_ID],
    webViewLink: `https://drive.google.com/drive/folders/${PUBLICO_ID}`,
  },
  [INTERNO_ID]: {
    id: INTERNO_ID,
    name: "Uso interno",
    mimeType: "application/vnd.google-apps.folder",
    parents: [PASTA_VIAGEM_ID],
    webViewLink: `https://drive.google.com/drive/folders/${INTERNO_ID}`,
  },
};

function lerCorpo(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function responderAnthropic(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const ultima = msgs[msgs.length - 1];
  const ehToolResult = Array.isArray(ultima?.content) && ultima.content.some((b) => b.type === "tool_result");

  if (ehToolResult) {
    const erro = ultima.content.find((b) => b.is_error);
    const texto = erro
      ? `Não consegui registrar a ação: ${erro.content}`
      : "Registrei a proposta acima. Confira os dados e clique em Confirmar e executar para aplicar.";
    return {
      id: "msg_falso_2",
      type: "message",
      role: "assistant",
      model: body.model ?? "claude-opus-5-5",
      stop_reason: "end_turn",
      content: [{ type: "text", text: texto }],
      usage: { input_tokens: 120, output_tokens: 24 },
    };
  }

  const textoUser = typeof ultima?.content === "string" ? ultima.content : "";
  const codigoMatch = /ECL-\d{4}-\d{2}/i.exec(textoUser);
  const codigo = codigoMatch ? codigoMatch[0].toUpperCase() : CODIGO_PADRAO;
  const anexoMatch = /referência\s+([0-9a-f-]{36})/i.exec(textoUser);

  if (anexoMatch) {
    return {
      id: "msg_falso_upload",
      type: "message",
      role: "assistant",
      model: body.model ?? "claude-opus-5-5",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_upload_1",
          name: "drive_enviar_arquivo",
          input: { viagem: codigo, anexo: anexoMatch[1], destino: "publico", nome: "" },
        },
      ],
      usage: { input_tokens: 150, output_tokens: 30 },
    };
  }

  if (/erro/i.test(textoUser)) {
    return {
      id: "msg_falso_erro",
      type: "message",
      role: "assistant",
      model: body.model ?? "claude-opus-5-5",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_comentar_erro",
          name: "trello_comentar",
          input: { cartao: codigo, texto: "FORCAR_ERRO voucher pendente de confirmação" },
        },
      ],
      usage: { input_tokens: 140, output_tokens: 28 },
    };
  }

  if (/coment|trello|voucher|cancela/i.test(textoUser)) {
    return {
      id: "msg_falso_comentar",
      type: "message",
      role: "assistant",
      model: body.model ?? "claude-opus-5-5",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "tool_comentar_1",
          name: "trello_comentar",
          input: { cartao: codigo, texto: "Voucher do hotel de Roma recebido e conferido pela equipe." },
        },
      ],
      usage: { input_tokens: 140, output_tokens: 28 },
    };
  }

  return {
    id: "msg_falso_texto",
    type: "message",
    role: "assistant",
    model: body.model ?? "claude-opus-5-5",
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: `Cartão da viagem ${codigo}: https://trello.com/c/${CARTAO_ID} e pasta no Drive: https://drive.google.com/drive/folders/${PASTA_VIAGEM_ID}`,
      },
    ],
    usage: { input_tokens: 100, output_tokens: 25 },
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTA}`);
  const metodo = req.method ?? "GET";
  const raw = await lerCorpo(req);
  const path = url.pathname;

  // 1) Anthropic Messages API
  if (metodo === "POST" && path.endsWith("/v1/messages")) {
    const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    return json(res, 200, responderAnthropic(body));
  }

  // 2) Google OAuth Token
  if (metodo === "POST" && (path === "/token" || path === "/")) {
    return json(res, 200, { access_token: "ya29.token-falso-visual", expires_in: 3600, token_type: "Bearer" });
  }

  // 3) Google Drive API
  if (path.startsWith("/upload/drive/v3/files") && metodo === "POST") {
    return json(res, 200, {
      id: "arq-enviado-1",
      webViewLink: "https://drive.google.com/file/d/arq-enviado-1/view",
    });
  }
  if (path.startsWith("/drive/v3/files")) {
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
    if (m && metodo === "GET") {
      const id = decodeURIComponent(m[1]);
      return arvoreDrive[id] ? json(res, 200, arvoreDrive[id]) : json(res, 404, { error: "not found" });
    }
    if (m && metodo === "PATCH") {
      return json(res, 200, { id: decodeURIComponent(m[1]) });
    }
    if (path === "/drive/v3/files" && metodo === "GET") {
      return json(res, 200, { files: Object.values(arvoreDrive).filter((x) => x.id !== "raiz-falsa") });
    }
    if (path === "/drive/v3/files" && metodo === "POST") {
      return json(res, 200, { id: "pasta-nova-1", webViewLink: "https://drive.google.com/drive/folders/pasta-nova-1" });
    }
  }

  // 4) Trello API (aceita /1/... ou sem /1)
  const trelloPath = path.startsWith("/1/") ? path.slice(2) : path;
  if (metodo === "GET" && trelloPath === "/lists/lista-op") {
    return json(res, 200, { id: "lista-op", idBoard: "board-1", name: "Operações" });
  }
  if (metodo === "GET" && trelloPath === "/boards/board-1/lists") {
    return json(res, 200, listas);
  }
  if (metodo === "GET" && trelloPath === "/boards/board-1/cards/open") {
    return json(res, 200, [
      {
        id: CARTAO_ID,
        name: `${CODIGO_PADRAO} · RIBEIRO · Itália`,
        idList: "lista-op",
        due: null,
        dueComplete: false,
        shortUrl: `https://trello.com/c/${CARTAO_ID}`,
      },
    ]);
  }
  if (metodo === "GET" && trelloPath === `/cards/${CARTAO_ID}`) {
    return json(res, 200, {
      id: CARTAO_ID,
      idBoard: "board-1",
      name: `${CODIGO_PADRAO} · RIBEIRO · Itália`,
      desc: "Viagem de exemplo para verificação visual.",
      idList: "lista-op",
      due: null,
      dueComplete: false,
      shortUrl: `https://trello.com/c/${CARTAO_ID}`,
      checklists: [{ id: "chk-1", name: "Tarefas da venda", checkItems: [{ id: "it-1", name: "Reservar hotel", state: "incomplete" }] }],
      actions: [],
    });
  }
  if (metodo === "POST" && trelloPath === `/cards/${CARTAO_ID}/actions/comments`) {
    const body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    if (String(body.text ?? "").includes("FORCAR_ERRO")) {
      return json(res, 500, { error: "falha simulada" });
    }
    return json(res, 200, { id: "act-1" });
  }
  if (metodo === "POST" && trelloPath === "/cards") {
    return json(res, 200, { id: "card-novo", shortUrl: "https://trello.com/c/card-novo" });
  }
  if (metodo === "PUT" && trelloPath.startsWith("/cards/")) {
    return json(res, 200, { id: CARTAO_ID });
  }

  json(res, 404, { error: "rota não simulada", metodo, path });
});

server.listen(PORTA, "127.0.0.1", () => {
  console.log(`Servidor falso de integrações ouvindo em http://127.0.0.1:${PORTA}`);
});
