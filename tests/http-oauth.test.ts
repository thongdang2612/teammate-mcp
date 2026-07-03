import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { buildHttpApp } from "../src/index.js";
import type { AppConfig } from "../src/config.js";

const cfg = {
  diaflowApiBase: "https://api.diaflow.io",
  transport: "http",
  authMode: "oauth",
  oauthIssuerUrl: "https://teammate-mcp.onrender.com",
  oauthResourceUrl: "https://teammate-mcp.onrender.com/mcp",
} as unknown as AppConfig;

const staticCfg = {
  diaflowApiBase: "https://api.diaflow.io",
  transport: "http",
  authMode: "static",
} as unknown as AppConfig;

function start(config: AppConfig) {
  const app = buildHttpApp(config);
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() }));
  });
}

describe("http app (oauth mode)", () => {
  it("unauthenticated POST /mcp is 401 with resource_metadata in WWW-Authenticate", async () => {
    const { url, close } = await start(cfg);
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("resource_metadata=");
    close();
  });

  it("serves protected-resource metadata", async () => {
    const { url, close } = await start(cfg);
    const res = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect((await res.json()).resource).toBe("https://teammate-mcp.onrender.com/mcp");
    close();
  });
});

// --- Session-hijack regression: full OAuth dance (register -> authorize -> login -> token) so
// two *different* users can each hold a real, distinct access token against the real provider. ---

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Server-side calls to `cfg.diaflowApiBase` (magic-auth send/verify) are faked; everything else
 * (the test's own requests to the local express app) passes through to the real fetch. */
function stubDiaflowMagicAuth(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.diaflow.io")) {
      if (url.includes("/auth/magic-auth/send")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/auth/magic-auth/verify")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        return new Response(JSON.stringify({ session: `seal-${body.email}`, workspaceId: 1 }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return realFetch(input as any, init);
  });
}

async function obtainAccessToken(baseUrl: string, email: string): Promise<string> {
  const regRes = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://cb.example/done"], token_endpoint_auth_method: "none" }),
  });
  const client = await regRes.json();

  const { verifier, challenge } = pkcePair();
  const authorizeUrl = new URL(`${baseUrl}/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", "https://cb.example/done");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("state", "xyz");
  const authRes = await fetch(authorizeUrl, { redirect: "manual" });
  const loginLoc = new URL(authRes.headers.get("location")!, baseUrl);
  const loginId = loginLoc.searchParams.get("login_id")!;

  await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login_id: loginId, email }),
  });

  const codeRes = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login_id: loginId, email, code: "123456" }),
  });
  const redirectLoc = new URL(codeRes.headers.get("location")!);
  const authCode = redirectLoc.searchParams.get("code")!;

  const tokenRes = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: authCode,
      code_verifier: verifier,
      redirect_uri: "https://cb.example/done",
    }),
  });
  const tokens = await tokenRes.json();
  return tokens.access_token as string;
}

describe("http app (oauth mode) — stateless per-request isolation", () => {
  beforeEach(() => stubDiaflowMagicAuth());
  afterEach(() => vi.unstubAllGlobals());

  it("issues no Mcp-Session-Id and authenticates each request by its own token", async () => {
    const { url, close } = await start(cfg);
    try {
      const tokenA = await obtainAccessToken(url, "a@x.io");

      const initRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1.0" } },
        }),
      });
      expect(initRes.status).toBe(200);
      // Stateless: no session id is issued. This is what interoperates with clients that don't
      // thread a session across requests (e.g. Diaflow's agent runtime); the old stateful/session
      // model caused handshake churn so tool calls never landed. With no shared session there is
      // also no cross-session hijack surface — each request is isolated by its own token.
      expect(initRes.headers.get("mcp-session-id")).toBeNull();

      // A follow-up request with a valid token is handled on its own, with no prior session.
      const okRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${tokenA}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
      });
      expect(okRes.status).toBe(200);

      // A request with no token is rejected by requireBearerAuth (per-request auth).
      const noAuthRes = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      });
      expect(noAuthRes.status).toBe(401);

      // GET (server->client SSE stream) has no meaning without sessions -> 405.
      const getRes = await fetch(`${url}/mcp`, { method: "GET", headers: { authorization: `Bearer ${tokenA}` } });
      expect(getRes.status).toBe(405);
    } finally {
      close();
    }
  });
});

describe("http app (static mode)", () => {
  it("still builds and gates /mcp without a token (unauthenticated by default)", async () => {
    const { url, close } = await start(staticCfg);
    const res = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    // No MCP_INBOUND_TOKEN configured on staticCfg -> request is authorized and reaches the
    // session/initialize handling (not a 401 from the inbound-token gate).
    expect(res.status).not.toBe(401);
    close();
  });
});
