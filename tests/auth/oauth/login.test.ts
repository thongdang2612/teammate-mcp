import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { buildLoginRouter } from "../../../src/auth/oauth/login.js";
import { OAuthTokenStore } from "../../../src/auth/oauth/token-store.js";
import { InMemoryClientStore } from "../../../src/auth/oauth/client-store.js";

function startApp(store: OAuthTokenStore, fetchImpl: typeof fetch, clients: InMemoryClientStore = new InMemoryClientStore()) {
  const app = express();
  app.use(buildLoginRouter({ store, baseUrl: "https://api.diaflow.io", fetchImpl, clients }));
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => srv.close() });
    });
  });
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("login router", () => {
  it("POST without code sends the magic code and renders the code form", async () => {
    const store = new OAuthTokenStore();
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) => okJson({ status: "ok" })) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl);
    const id = store.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: ["teammate"] });
    const res = await fetch(`${url}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login_id: id, email: "u@x.io" }),
    });
    const html = await res.text();
    expect((fetchImpl as any).mock.calls[0][0]).toContain("/auth/magic-auth/send");
    expect(html).toContain('name="code"');
    close();
  });

  it("POST with a valid code mints an auth code and 302-redirects to the client redirect_uri with state", async () => {
    const store = new OAuthTokenStore();
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) =>
      okJson({ session: "gAAAA-seal", workspaceId: 1564 })) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl);
    const id = store.createLogin({ clientId: "c1", redirectUri: "https://cb.example/done", state: "xyz", codeChallenge: "ch", scopes: ["teammate"] });
    const res = await fetch(`${url}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login_id: id, email: "u@x.io", code: "123456" }),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://cb.example/done");
    expect(loc.searchParams.get("state")).toBe("xyz");
    const mintedCode = loc.searchParams.get("code")!;
    expect(store.peekAuthCode(mintedCode)?.seal).toBe("gAAAA-seal");
    close();
  });

  it("POST with an invalid code re-renders the code form and mints nothing", async () => {
    const store = new OAuthTokenStore();
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ message: "bad code" }), { status: 400, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl);
    const id = store.createLogin({ clientId: "c1", redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
    const res = await fetch(`${url}/login`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login_id: id, email: "u@x.io", code: "000000" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="code"');
    close();
  });

  it("GET renders the resolved, escaped client name when a pending login + client exist", async () => {
    const store = new OAuthTokenStore();
    const clients = new InMemoryClientStore();
    const client = clients.registerClient({ redirect_uris: ["https://cb"], client_name: "Ann & Co <script>" });
    const id = store.createLogin({ clientId: client.client_id, redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
    const fetchImpl = vi.fn(async () => okJson({})) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl, clients);

    const res = await fetch(`${url}/login?login_id=${encodeURIComponent(id)}`);
    const html = await res.text();
    expect(html).toContain("is requesting access to your Diaflow account");
    expect(html).toContain("Ann &amp; Co &lt;script&gt;");
    expect(html).not.toContain("<script>"); // escaped, not raw markup
    close();
  });

  it("GET falls back to the redirect_uri host when the client has no client_name", async () => {
    const store = new OAuthTokenStore();
    const clients = new InMemoryClientStore();
    const client = clients.registerClient({ redirect_uris: ["https://consumer.example/cb"] });
    const id = store.createLogin({ clientId: client.client_id, redirectUri: "https://consumer.example/cb", codeChallenge: "ch", scopes: [] });
    const fetchImpl = vi.fn(async () => okJson({})) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl, clients);

    const res = await fetch(`${url}/login?login_id=${encodeURIComponent(id)}`);
    const html = await res.text();
    expect(html).toContain("consumer.example");
    close();
  });

  it("GET renders the form without a consent line and without crashing when login_id is missing", async () => {
    const store = new OAuthTokenStore();
    const fetchImpl = vi.fn(async () => okJson({})) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl);

    const res = await fetch(`${url}/login`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('name="email"');
    expect(html).not.toContain("is requesting access");
    close();
  });

  it("POST (no code) also renders the resolved client name on the code form", async () => {
    const store = new OAuthTokenStore();
    const clients = new InMemoryClientStore();
    const client = clients.registerClient({ redirect_uris: ["https://cb"], client_name: "Acme Inc" });
    const id = store.createLogin({ clientId: client.client_id, redirectUri: "https://cb", codeChallenge: "ch", scopes: [] });
    const fetchImpl = vi.fn(async (_url?: string | URL | Request, _init?: RequestInit) => okJson({ status: "ok" })) as unknown as typeof fetch;
    const { url, close } = await startApp(store, fetchImpl, clients);

    const res = await fetch(`${url}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login_id: id, email: "u@x.io" }),
    });
    const html = await res.text();
    expect(html).toContain("Acme Inc");
    expect(html).toContain("is requesting access to your Diaflow account");
    close();
  });
});
