import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDrive, clienteDrive, DRIVE_API, DRIVE_UPLOAD } from "@/server/integracoes/drive";
import { esquecerTokensGoogle, GOOGLE_TOKEN_URL, tokenGoogle } from "@/server/integracoes/google";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const CFG = { email: "eclak@projeto.iam.gserviceaccount.com", chave: privateKey, pastaRaizId: "raiz" };
const TOKEN = "ya29.token-falso";

type Chamada = {
  metodo: string;
  url: URL;
  auth: string | null;
  json: Record<string, unknown> | null;
};

function driveFalso(handler: (c: Chamada) => Response | null = () => null) {
  const chamadas: Chamada[] = [];
  const buscar = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const h = new Headers(init?.headers);
    const tipo = h.get("content-type");
    const c: Chamada = {
      metodo: init?.method ?? "GET",
      url: u,
      auth: h.get("authorization"),
      json: tipo?.startsWith("application/json") && typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    chamadas.push(c);
    const custom = handler(c);
    if (custom) return custom;
    if (u.href === GOOGLE_TOKEN_URL || u.pathname === "/token") {
      return Response.json({ access_token: TOKEN, expires_in: 3600 });
    }
    if (c.metodo === "GET" && u.pathname === "/drive/v3/files/f1") {
      if (u.searchParams.get("alt") === "media") {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }
      return Response.json({
        id: "f1",
        name: "voucher.pdf",
        mimeType: "application/pdf",
        parents: ["pasta-1"],
        modifiedTime: "2026-11-25T10:00:00.000Z",
        size: "2048",
        webViewLink: "https://drive.google.com/file/d/f1/view",
        trashed: false,
      });
    }
    if (c.metodo === "GET" && u.pathname === "/drive/v3/files/lixo") {
      return Response.json({
        id: "lixo",
        name: "velho.pdf",
        mimeType: "application/pdf",
        parents: ["pasta-1"],
        trashed: true,
      });
    }
    if (c.metodo === "GET" && u.pathname === "/drive/v3/files/doc1/export") {
      return new Response("Texto do Google Docs", { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    if (c.metodo === "GET" && u.pathname === "/drive/v3/files") {
      return Response.json({
        files: [
          {
            id: "sub1",
            name: "Vouchers",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["pasta-1"],
            modifiedTime: "2026-11-24T10:00:00.000Z",
            webViewLink: "https://drive.google.com/drive/folders/sub1",
          },
          {
            id: "f1",
            name: "voucher.pdf",
            mimeType: "application/pdf",
            parents: ["pasta-1"],
            modifiedTime: "2026-11-25T10:00:00.000Z",
            size: "1024",
            webViewLink: "https://drive.google.com/file/d/f1/view",
          },
        ],
      });
    }
    if (c.metodo === "PATCH" && u.pathname === "/drive/v3/files/f1") {
      return Response.json({ id: "f1" });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { buscar, chamadas, drive: () => chamadas.filter((c) => c.url.href !== GOOGLE_TOKEN_URL && c.url.pathname !== "/token") };
}

beforeEach(() => {
  esquecerTokensGoogle();
});
afterEach(() => {
  vi.unstubAllEnvs();
  esquecerTokensGoogle();
});

describe("baseDrive e GOOGLE_TOKEN_URL", () => {
  it("baseDrive só aceita loopback", () => {
    expect(baseDrive({})).toEqual({ api: DRIVE_API, upload: DRIVE_UPLOAD });
    expect(baseDrive({ DRIVE_API_URL: "https://evil.io" })).toEqual({ api: DRIVE_API, upload: DRIVE_UPLOAD });
    expect(baseDrive({ DRIVE_API_URL: "http://127.0.0.1:4010" })).toEqual({
      api: "http://127.0.0.1:4010/drive/v3",
      upload: "http://127.0.0.1:4010/upload/drive/v3",
    });
  });

  it("GOOGLE_TOKEN_URL passa por urlDeTeste", async () => {
    vi.stubEnv("GOOGLE_TOKEN_URL", "http://127.0.0.1:4010/token");
    const d = driveFalso();
    expect(await tokenGoogle(CFG, d.buscar)).toBe(TOKEN);
    expect(d.chamadas[0].url.href).toBe("http://127.0.0.1:4010/token");

    esquecerTokensGoogle();
    vi.stubEnv("GOOGLE_TOKEN_URL", "https://evil.io/token");
    const d2 = driveFalso();
    expect(await tokenGoogle(CFG, d2.buscar)).toBe(TOKEN);
    expect(d2.chamadas[0].url.href).toBe(GOOGLE_TOKEN_URL);
  });
});

describe("clienteDrive: leitura e escrita do agente", () => {
  it("obter devolve ItemDrive; 404 ou na lixeira vira null", async () => {
    const d = driveFalso();
    const cli = clienteDrive(CFG, d.buscar);
    expect(await cli.obter("f1")).toEqual({
      id: "f1",
      nome: "voucher.pdf",
      mime: "application/pdf",
      pais: ["pasta-1"],
      modificado: "2026-11-25T10:00:00.000Z",
      tamanho: 2048,
      link: "https://drive.google.com/file/d/f1/view",
    });
    expect(d.drive()[0].url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(await cli.obter("lixo")).toBeNull();
    expect(await cli.obter("nao-existe")).toBeNull();
  });

  it("listarItens e buscar mandam supportsAllDrives, includeItemsFromAllDrives e escapam q", async () => {
    const d = driveFalso();
    const cli = clienteDrive(CFG, d.buscar);
    const itens = await cli.listarItens("pasta'1");
    expect(itens).toHaveLength(2);
    expect(itens[1]).toMatchObject({ id: "f1", tamanho: 1024, pais: ["pasta-1"] });

    const achados = await cli.buscar("hotel'roma\\1");
    expect(achados).toHaveLength(2);
    const [listaC, buscaC] = d.drive();
    expect(listaC.url.searchParams.get("q")).toBe("'pasta\\'1' in parents and trashed = false");
    expect(listaC.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(listaC.url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
    expect(buscaC.url.searchParams.get("q")).toBe(
      "(fullText contains 'hotel\\'roma\\\\1' or name contains 'hotel\\'roma\\\\1') and trashed = false",
    );
    expect(buscaC.url.searchParams.get("pageSize")).toBe("50");
    expect(buscaC.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(buscaC.url.searchParams.get("includeItemsFromAllDrives")).toBe("true");
  });

  it("exportar e baixarBytes devolvem texto e bytes e renovam token uma vez em 401", async () => {
    let deu401 = false;
    const d = driveFalso((c) => {
      if (c.url.pathname === "/drive/v3/files/f1" && c.url.searchParams.get("alt") === "media" && !deu401) {
        deu401 = true;
        return new Response("expired", { status: 401 });
      }
      return null;
    });
    const cli = clienteDrive(CFG, d.buscar);
    expect(await cli.exportar("doc1", "text/plain")).toBe("Texto do Google Docs");
    const b = await cli.baixarBytes("f1");
    expect(b.mime).toBe("application/pdf");
    expect(b.bytes).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
    expect(d.chamadas.filter((c) => c.url.href === GOOGLE_TOKEN_URL)).toHaveLength(2);
  });

  it("renomear e mover mandam PATCH com name, addParents e removeParents", async () => {
    const d = driveFalso();
    const cli = clienteDrive(CFG, d.buscar);
    await cli.renomear("f1", "voucher-roma.pdf");
    await cli.mover("f1", "pasta-1", "pasta-2");
    const [ren, mov] = d.drive();
    expect(ren.metodo).toBe("PATCH");
    expect(ren.url.pathname).toBe("/drive/v3/files/f1");
    expect(ren.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(ren.json).toEqual({ name: "voucher-roma.pdf" });

    expect(mov.metodo).toBe("PATCH");
    expect(mov.url.pathname).toBe("/drive/v3/files/f1");
    expect(mov.url.searchParams.get("supportsAllDrives")).toBe("true");
    expect(mov.url.searchParams.get("addParents")).toBe("pasta-2");
    expect(mov.url.searchParams.get("removeParents")).toBe("pasta-1");
  });
});
