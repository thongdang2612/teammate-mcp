import { describe, it, expect } from "vitest";
import type { AddressInfo } from "node:net";
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
