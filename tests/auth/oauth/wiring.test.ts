import { describe, it, expect } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildOAuthWiring } from "../../../src/auth/oauth/wiring.js";
import type { AppConfig } from "../../../src/config.js";

const cfg = {
  diaflowApiBase: "https://api.diaflow.io",
  authMode: "oauth",
  oauthIssuerUrl: "https://teammate-mcp.onrender.com",
  oauthResourceUrl: "https://teammate-mcp.onrender.com/mcp",
} as unknown as AppConfig;

function start() {
  const app = express();
  const w = buildOAuthWiring(cfg);
  app.use(w.authRouter);
  app.get("/mcp", w.bearer, (_req, res) => res.json({ ok: true }));
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => srv.close() }));
  });
}

describe("buildOAuthWiring", () => {
  it("advertises protected-resource metadata with resource + authorization_servers", async () => {
    const { url, close } = await start();
    const res = await fetch(`${url}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe("https://teammate-mcp.onrender.com/mcp");
    // The SDK derives `issuer` from `issuerUrl.href`; WHATWG URL normalizes a
    // bare-origin URL (no path) to include a trailing slash, so that's what the
    // authorization server identifier looks like on the wire.
    expect(body.authorization_servers).toContain("https://teammate-mcp.onrender.com/");
    close();
  });

  it("a protected route returns 401 with WWW-Authenticate carrying resource_metadata", async () => {
    const { url, close } = await start();
    const res = await fetch(`${url}/mcp`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("resource_metadata=");
    close();
  });
});
