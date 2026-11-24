import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chavePasta, nomeDaPasta, SUBPASTA_INTERNA, SUBPASTA_PUBLICA } from "@/domain/drive";
import { configDrive } from "@/server/integracoes/config";
import {
  ESCOPO_DRIVE,
  GOOGLE_TOKEN_URL,
  esquecerTokensGoogle,
  jwtGoogle,
  tokenGoogle,
} from "@/server/integracoes/google";
import { ErroIntegracao } from "@/server/integracoes/http";

describe("nomeDaPasta", () => {
  it("o exemplo da spec: código do cliente, sobrenome, destino e datas", () => {
    expect(
      nomeDaPasta({ codigoCliente: "ECL-0147", titular: "Marcos Souza", destino: "Itália", inicio: "2027-08-14", fim: "2027-09-01" }),
    ).toBe("ECL-0147_SOUZA_ITALIA_20270814-20270901");
  });

  it("sem acento e sem espaço: 'São Paulo' → SAOPAULO, 'Conceição' → CONCEICAO", () => {
    expect(
      nomeDaPasta({
        codigoCliente: "ECL-0002",
        titular: "  Ana Maria da Conceição ",
        destino: " São Paulo ",
        inicio: "2026-12-28",
        fim: "2027-01-04",
      }),
    ).toBe("ECL-0002_CONCEICAO_SAOPAULO_20261228-20270104");
  });

  it("nada de pontuação solta no nome (apóstrofo, hífen, barra)", () => {
    expect(
      nomeDaPasta({ codigoCliente: "ECL-0003", titular: "João D'Ávila", destino: "Costa Amalfitana / Capri-Positano", inicio: "2027-05-01", fim: "2027-05-10" }),
    ).toBe("ECL-0003_DAVILA_COSTAAMALFITANACAPRIPOSITANO_20270501-20270510");
  });

  it("chave e subpastas", () => {
    expect(chavePasta("v1")).toBe("pasta:v1");
    expect(SUBPASTA_PUBLICA).toBe("Público");
    expect(SUBPASTA_INTERNA).toBe("Uso interno");
  });
});

// ---------------------------------------------------------------------------
// Token do Google por JWT (conta de serviço)
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const EMAIL = "eclak@projeto.iam.gserviceaccount.com";
const CFG = { email: EMAIL, chave: privateKey, pastaRaizId: "raiz" };
const agora = new Date("2027-01-10T12:00:00.000Z");
const IAT = Math.floor(agora.getTime() / 1000);

const b64url = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function decodificar(jwt: string) {
  const [h, c, assinatura] = jwt.split(".");
  return { header: JSON.parse(b64url(h)), claims: JSON.parse(b64url(c)), assinatura, assinado: `${h}.${c}` };
}

type Chamada = { url: string; metodo: string; tipo: string | null; corpo: string };

function googleFalso(resposta: () => Response = () => Response.json({ access_token: "tok-1", expires_in: 3600, token_type: "Bearer" })) {
  const chamadas: Chamada[] = [];
  const buscar = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({
      url: String(url),
      metodo: init?.method ?? "GET",
      tipo: new Headers(init?.headers).get("content-type"),
      corpo: String(init?.body ?? ""),
    });
    return resposta();
  }) as typeof fetch;
  return { buscar, chamadas };
}

describe("jwtGoogle", () => {
  it("header RS256/JWT, claims exatas e assinatura que a chave pública confere", () => {
    const jwt = jwtGoogle(CFG, agora);
    expect(jwt).not.toContain("=");
    expect(jwt).not.toMatch(/[+/]/);
    const d = decodificar(jwt);
    expect(d.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(d.claims).toEqual({
      iss: EMAIL,
      scope: "https://www.googleapis.com/auth/drive",
      aud: "https://oauth2.googleapis.com/token",
      iat: IAT,
      exp: IAT + 3600,
    });
    const v = createVerify("RSA-SHA256");
    v.update(d.assinado);
    expect(v.verify(publicKey, Buffer.from(d.assinatura, "base64url"))).toBe(true);
    // Outra chave não confere.
    const outra = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    const v2 = createVerify("RSA-SHA256");
    v2.update(d.assinado);
    expect(v2.verify(outra, Buffer.from(d.assinatura, "base64url"))).toBe(false);
  });

  it("GOOGLE_SA_CHAVE numa linha só, com \\n literais, assina igual", () => {
    const umaLinha = privateKey.replace(/\n/g, "\\n");
    expect(umaLinha).not.toContain("\n");
    const cfg = configDrive({ GOOGLE_SA_EMAIL: EMAIL, GOOGLE_SA_CHAVE: umaLinha, GOOGLE_DRIVE_PASTA_RAIZ_ID: "raiz" });
    expect(cfg).not.toBeNull();
    const d = decodificar(jwtGoogle(cfg!, agora));
    const v = createVerify("RSA-SHA256");
    v.update(d.assinado);
    expect(v.verify(publicKey, Buffer.from(d.assinatura, "base64url"))).toBe(true);
  });

  it("chave que não é PEM: autenticação (repetir não resolve), sem a chave na mensagem", () => {
    const e = (() => {
      try {
        jwtGoogle({ ...CFG, chave: "nao-e-uma-chave-segredo" }, agora);
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(ErroIntegracao);
    expect(e).toMatchObject({ classe: "autenticacao", status: null });
    expect(String((e as Error).message)).not.toContain("segredo");
  });
});

describe("tokenGoogle", () => {
  beforeEach(() => esquecerTokensGoogle());
  afterEach(() => vi.restoreAllMocks());

  it("POST form no endpoint de token com grant_type jwt-bearer e a asserção assinada", async () => {
    const g = googleFalso();
    expect(await tokenGoogle(CFG, g.buscar, agora)).toBe("tok-1");
    expect(g.chamadas).toHaveLength(1);
    const c = g.chamadas[0];
    expect(c.url).toBe(GOOGLE_TOKEN_URL);
    expect(c.url).toBe("https://oauth2.googleapis.com/token");
    expect(c.metodo).toBe("POST");
    expect(c.tipo).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(c.corpo);
    expect([...form.keys()]).toEqual(["grant_type", "assertion"]);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const d = decodificar(form.get("assertion")!);
    expect(d.claims).toMatchObject({ iss: EMAIL, scope: ESCOPO_DRIVE, iat: IAT });
  });

  it("reaproveita o token até 60 s antes de expirar; depois pede outro", async () => {
    let n = 0;
    const g = googleFalso(() => Response.json({ access_token: `tok-${++n}`, expires_in: 3600, token_type: "Bearer" }));
    const em = (s: number) => new Date(agora.getTime() + s * 1000);
    expect(await tokenGoogle(CFG, g.buscar, agora)).toBe("tok-1");
    expect(await tokenGoogle(CFG, g.buscar, em(1800))).toBe("tok-1");
    expect(await tokenGoogle(CFG, g.buscar, em(3539))).toBe("tok-1");
    expect(g.chamadas).toHaveLength(1);
    expect(await tokenGoogle(CFG, g.buscar, em(3540))).toBe("tok-2");
    expect(g.chamadas).toHaveLength(2);
  });

  it("usa o expires_in da resposta", async () => {
    let n = 0;
    const g = googleFalso(() => Response.json({ access_token: `tok-${++n}`, expires_in: 120, token_type: "Bearer" }));
    expect(await tokenGoogle(CFG, g.buscar, agora)).toBe("tok-1");
    expect(await tokenGoogle(CFG, g.buscar, new Date(agora.getTime() + 59_000))).toBe("tok-1");
    expect(await tokenGoogle(CFG, g.buscar, new Date(agora.getTime() + 60_000))).toBe("tok-2");
  });

  it("outra conta de serviço não usa o token da primeira", async () => {
    let n = 0;
    const g = googleFalso(() => Response.json({ access_token: `tok-${++n}`, expires_in: 3600 }));
    expect(await tokenGoogle(CFG, g.buscar, agora)).toBe("tok-1");
    expect(await tokenGoogle({ ...CFG, email: "outra@projeto.iam.gserviceaccount.com" }, g.buscar, agora)).toBe("tok-2");
  });

  it("erro do endpoint vira ErroIntegracao com classe e status; sem access_token é servidor; nada fica em cache", async () => {
    await expect(tokenGoogle(CFG, googleFalso(() => new Response("{}", { status: 401 })).buscar, agora)).rejects.toMatchObject({
      classe: "autenticacao",
      status: 401,
    });
    await expect(tokenGoogle(CFG, googleFalso(() => new Response("{}", { status: 400 })).buscar, agora)).rejects.toMatchObject({
      classe: "recusado",
      status: 400,
    });
    await expect(tokenGoogle(CFG, googleFalso(() => Response.json({ token_type: "Bearer" })).buscar, agora)).rejects.toMatchObject({
      classe: "servidor",
    });
    const g = googleFalso();
    expect(await tokenGoogle(CFG, g.buscar, agora)).toBe("tok-1");
    expect(g.chamadas).toHaveLength(1);
  });
});
